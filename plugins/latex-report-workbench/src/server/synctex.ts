import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, PdfLocation, PdfLocateRequest, SourceLocateRequest, SourceTarget } from '../shared/contracts.js';
import { WorkbenchError } from '../shared/errors.js';
import type { SyncTexPort } from '../shared/ports.js';
import type { Compiler } from './compiler.js';
import { normalizeRelativePath } from './path-policy.js';
import { sha256 } from './store.js';
import { decodeText } from './files.js';
import { decodeProcessOutput } from './process-output.js';
import type { Workspace } from './workspace.js';

const ANCHOR_LENGTH = 120;

export type SyncTexBox = { page: number; x: number; y: number; h: number; v: number; width: number; height: number };
export type SyncTexEditHit = SyncTexBox & { input: string; line: number; column: number | null; offset: number | null };

type SyncTexBlock = { output: string | null; boxes: SyncTexBox[]; hits: { input: string; line: number; column: number | null; offset: number | null }[] };

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** Splits a `synctex` stdout stream into result blocks without ever splitting on path colons. */
export function splitSyncTexBlocks(stdout: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^SyncTeX result begin\s*$/.test(line)) {
      current = [];
      continue;
    }
    if (/^SyncTeX result end\s*$/.test(line)) {
      if (current) blocks.push(current.join('\n'));
      current = null;
      continue;
    }
    if (current) current.push(line);
  }
  return blocks;
}

function parseBlock(block: string): SyncTexBlock {
  const result: SyncTexBlock = { output: null, boxes: [], hits: [] };
  let pending: SyncTexBox | null = null;
  let input: string | null = null;
  let line: number | null = null;
  let column: number | null = null;
  let offset: number | null = null;
  const flushHit = () => {
    if (input === null || line === null) return;
    result.hits.push({ input, line, column, offset });
  };
  for (const raw of block.split('\n')) {
    const line0 = raw.trim();
    const separator = line0.indexOf(':');
    if (separator < 0) continue;
    const rawKey = line0.slice(0, separator).trim();
    // SyncTeX uses `h`/`v` for the top-left coordinates and upper-case `W`/`H` for
    // width/height, so the key case must survive one round of normalization.
    const key = rawKey === 'W' ? 'width' : rawKey === 'H' ? 'height' : rawKey.toLowerCase();
    const value = line0.slice(separator + 1);
    switch (key) {
      case 'output':
        result.output = value.trim();
        break;
      case 'page': {
        if (pending) result.boxes.push(pending);
        const page = toNumber(value);
        if (page !== null) pending = { page: Math.trunc(page), x: 0, y: 0, h: 0, v: 0, width: 0, height: 0 };
        break;
      }
      case 'x': { const parsed = toNumber(value); if (pending && parsed !== null) pending.x = parsed; break; }
      case 'y': { const parsed = toNumber(value); if (pending && parsed !== null) pending.y = parsed; break; }
      case 'h': { const parsed = toNumber(value); if (pending && parsed !== null) pending.h = parsed; break; }
      case 'v': { const parsed = toNumber(value); if (pending && parsed !== null) pending.v = parsed; break; }
      case 'width': { const parsed = toNumber(value); if (pending && parsed !== null) pending.width = parsed; break; }
      case 'height': { const parsed = toNumber(value); if (pending && parsed !== null) pending.height = parsed; break; }
      case 'input':
        flushHit();
        input = value.trim();
        line = null;
        column = null;
        offset = null;
        break;
      case 'line': { const parsed = toNumber(value); if (parsed !== null) line = Math.trunc(parsed); break; }
      case 'column': { const parsed = toNumber(value); column = parsed === null ? null : Math.trunc(parsed); break; }
      case 'offset': { const parsed = toNumber(value); offset = parsed === null ? null : Math.trunc(parsed); break; }
      default:
        break;
    }
  }
  if (pending) result.boxes.push(pending);
  flushHit();
  return result;
}

/** Parses `synctex edit` output into source hits (page/x/y from top-left in big points). */
export function parseSyncTexEdit(stdout: string): SyncTexEditHit[] {
  const hits: SyncTexEditHit[] = [];
  for (const block of splitSyncTexBlocks(stdout)) {
    const parsed = parseBlock(block);
    for (const hit of parsed.hits) {
      const geometry = parsed.boxes[0] ?? { page: 1, x: 0, y: 0, h: 0, v: 0, width: 0, height: 0 };
      hits.push({ ...geometry, input: hit.input, line: hit.line, column: hit.column, offset: hit.offset });
    }
  }
  return hits.filter(hit => hit.line > 0 && hit.input.length > 0 && hit.page >= 1);
}

/** Parses `synctex view` output into page rectangles. */
export function parseSyncTexView(stdout: string): SyncTexBox[] {
  const boxes: SyncTexBox[] = [];
  for (const block of splitSyncTexBlocks(stdout)) {
    const parsed = parseBlock(block);
    boxes.push(...parsed.boxes);
  }
  return boxes.filter(box => box.page >= 1);
}

/** Converts a synctex-recorded input path (absolute or relative) into a frozen source relative path. */
export function mapSyncTexInput(input: string, sourceDirectory: string, knownPaths: Iterable<string>): string | null {
  const normalizedSource = path.resolve(sourceDirectory);
  const known = new Set([...knownPaths].map(candidate => normalizeRelativePath(candidate)));
  const cleaned = input.replaceAll('\\', '/');
  const asPath = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(normalizedSource, cleaned);
  const relative = path.relative(normalizedSource, asPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const normalized = normalizeRelativePath(relative);
  return known.has(normalized) ? normalized : null;
}

export function boxToLocation(box: SyncTexBox): PdfLocation {
  const x = box.h;
  const y = box.v;
  const width = box.width > 0 ? box.width : 12;
  const height = box.height > 0 ? box.height : 12;
  return { page: Math.max(1, box.page), rect: [x, y - height, x + width, y] };
}

export function lineRangeAt(text: string, line: number): { start: number; end: number } {
  const target = Math.max(1, Math.trunc(line));
  let currentLine = 1;
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index === text.length || text[index] === '\n') {
      if (currentLine === target) return { start, end: index };
      currentLine += 1;
      start = index + 1;
    }
  }
  return { start: Math.max(0, text.length), end: text.length };
}

export type SyncTexRunner = (args: string[], cwd: string) => Promise<{ code: number | null; stdout: string; stderr: string; missing?: boolean }>;

const defaultRunner: SyncTexRunner = async (args, cwd) => {
  return await new Promise(resolve => {
    const child = spawn('synctex', args, { cwd, windowsHide: true, shell: false });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout?.on('data', chunk => { output.push(Buffer.from(chunk)); });
    child.stderr?.on('data', chunk => { errors.push(Buffer.from(chunk)); });
    const timer = setTimeout(() => { child.kill(); }, 10_000);
    child.once('error', error => {
      clearTimeout(timer);
      resolve({ code: null, stdout: decodeProcessOutput(Buffer.concat(output)), stderr: error.message, missing: (error as NodeJS.ErrnoException).code === 'ENOENT' });
    });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout: decodeProcessOutput(Buffer.concat(output)), stderr: decodeProcessOutput(Buffer.concat(errors)) }); });
  });
};

export type SyncTexDependencies = { workspace: Workspace; compiler: Compiler; runSyncTex?: SyncTexRunner };

/** SyncTeX queries against the immutable build snapshot, never against live report files. */
export function createSyncTex(dependencies: SyncTexDependencies): SyncTexPort {
  const runSyncTex = dependencies.runSyncTex ?? defaultRunner;

  async function loadBuild(reportId: string, buildId: string) {
    const manifest = await dependencies.compiler.readManifest(reportId, buildId);
    if (!manifest) throw new WorkbenchError('FILE_NOT_FOUND', '找不到该构建，无法定位。', false, { buildId });
    if (manifest.status !== 'succeeded') throw new WorkbenchError('BUILD_FAILED', '该构建没有成功产物，不能用于定位。', false, { buildId, status: manifest.status });
    const synctex = Object.values(manifest.assets).find(asset => asset.kind === 'synctex');
    if (!synctex) throw new WorkbenchError('SYNCTEX_NOT_FOUND', '该构建缺少 SyncTeX 文件。', false, { buildId });
    const paths = dependencies.compiler.pathsFor(reportId, buildId);
    return { manifest, paths, synctex };
  }

  return {
    async locatePdfTarget(input: PdfLocateRequest) {
      const { manifest, paths } = await loadBuild(input.reportId, input.buildId);
      const pdf = Object.values(manifest.assets).find(asset => asset.kind === 'pdf');
      if (!pdf) throw new WorkbenchError('BUILD_FAILED', '该构建没有 PDF 产物。', false, { buildId: input.buildId });
      const pdfName = path.basename(pdf.fileName);
      const point = input.point;
      const result = await runSyncTex(['edit', '-o', `${input.page}:${point.x}:${point.y}:${pdfName}`], paths.out);
      if (result.missing) throw new WorkbenchError('SYNCTEX_NOT_FOUND', '本机找不到 synctex 命令。', false, { tool: 'synctex' });
      const hits = parseSyncTexEdit(result.stdout);
      const diagnostics: Diagnostic[] = [];
      if (hits.length === 0) {
        diagnostics.push({ severity: 'info', code: 'SYNCTEX_NO_RESULT', message: '该位置没有对应的源码（可能位于图片、页码或浮动体内）。' });
        return { confidence: 'unmapped', candidates: [], diagnostics };
      }
      const knownPaths = Object.keys(manifest.inputVersions);
      const candidates: SourceTarget[] = [];
      const unmatched = new Set<string>();
      for (const hit of hits) {
        const relativePath = mapSyncTexInput(hit.input, paths.source, knownPaths);
        if (!relativePath) {
          unmatched.add(hit.input);
          continue;
        }
        const bytes = await readFile(path.join(paths.source, relativePath)).catch(() => null);
        if (!bytes) continue;
        const fileVersion = sha256(bytes);
        if (manifest.inputVersions[relativePath] !== fileVersion) {
          diagnostics.push({ severity: 'warning', code: 'SYNCTEX_SNAPSHOT_MISMATCH', message: `${relativePath} 与构建快照不一致，已忽略。`, relativePath });
          continue;
        }
        const text = decodeText(relativePath, bytes).text;
        const line = Math.max(1, hit.line);
        const range = lineRangeAt(text, line);
        const candidate: SourceTarget = {
          relativePath,
          range,
          fileVersion,
          exactText: text.slice(range.start, range.end),
          prefix: text.slice(Math.max(0, range.start - ANCHOR_LENGTH), range.start),
          suffix: text.slice(range.end, Math.min(text.length, range.end + ANCHOR_LENGTH)),
        };
        if (!candidates.some(existing => existing.relativePath === candidate.relativePath && existing.range.start === candidate.range.start)) candidates.push(candidate);
      }
      for (const input0 of unmatched) diagnostics.push({ severity: 'warning', code: 'SYNCTEX_INPUT_OUTSIDE_REPORT', message: `定位结果超出报告范围：${path.basename(input0)}` });
      if (candidates.length === 0) return { confidence: 'unmapped', candidates: [], diagnostics };
      const distinct = new Set(candidates.map(candidate => `${candidate.relativePath}:${candidate.range.start}`));
      let confidence: 'exact' | 'nearby' | 'ambiguous' = distinct.size > 1 ? 'ambiguous' : 'nearby';
      if (input.selectedText && candidates.some(candidate => candidate.exactText.includes(input.selectedText!))) confidence = candidates.length === 1 ? 'exact' : 'ambiguous';
      return { confidence, candidates, diagnostics };
    },

    async locateSourceTarget(input: SourceLocateRequest) {
      const { manifest, paths } = await loadBuild(input.reportId, input.buildId);
      const relativePath = normalizeRelativePath(input.relativePath);
      if (!Object.hasOwn(manifest.inputVersions, relativePath)) throw new WorkbenchError('FILE_NOT_FOUND', '该文件不属于此构建的冻结输入。', false, { relativePath });
      const pdf = Object.values(manifest.assets).find(asset => asset.kind === 'pdf');
      if (!pdf) throw new WorkbenchError('BUILD_FAILED', '该构建没有 PDF 产物。', false, { buildId: input.buildId });
      const absolute = path.join(paths.source, relativePath);
      const column = input.column ?? 0;
      const result = await runSyncTex(['view', '-i', `${input.line}:${column}:${absolute}`, '-o', path.basename(pdf.fileName)], paths.out);
      if (result.missing) throw new WorkbenchError('SYNCTEX_NOT_FOUND', '本机找不到 synctex 命令。', false, { tool: 'synctex' });
      return parseSyncTexView(result.stdout).map(boxToLocation);
    },
  };
}

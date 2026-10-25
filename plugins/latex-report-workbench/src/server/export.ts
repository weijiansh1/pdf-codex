import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdir, readdir, readFile, stat, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ExportRequest, ExportResult } from '../shared/contracts.js';
import { PRIVATE_DIRECTORIES, INTERMEDIATE_FILE } from '../shared/config.js';
import { WorkbenchError } from '../shared/errors.js';
import type { ExportPort, HtmlPort } from '../shared/ports.js';
import { htmlAttribute, htmlElements, isHtmlReport } from '../shared/html-report.js';
import { renderStatic } from './static-renderer.js';
import type { Compiler } from './compiler.js';
import { nowIso, readLedger, writeBytesAtomic, writeLedger } from './store.js';
import type { Workspace } from './workspace.js';
import { isInside } from './path-policy.js';

export type ExportDependencies = { workspace: Workspace; compiler: Compiler; html: HtmlPort };
export type { ExportPort } from '../shared/ports.js';

type ZipEntry = { name: string; data: Uint8Array };

function dosDateTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const stamp = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: stamp };
}

/** Minimal ZIP writer; avoids a runtime dependency and keeps UTF-8 file names flagged. */
export function buildZip(entries: ZipEntry[], modified = new Date()): Uint8Array {
  const { time, date } = dosDateTime(modified);
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll('\\', '/'), 'utf8');
    const crc = crc32(Buffer.from(entry.data));
    const raw = Buffer.from(entry.data);
    const compressed = deflateRawSync(raw);
    const useDeflate = compressed.length < raw.length;
    const body = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt16LE(time, 12);
    directory.writeUInt16LE(date, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(body.length, 20);
    directory.writeUInt32LE(raw.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(0, 30);
    directory.writeUInt32LE(0, 34);
    directory.writeUInt32LE(0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + body.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, centralBuffer, end]));
}

function skippedExportPath(relativePath: string): boolean {
  const parts = relativePath.replaceAll('\\', '/').split('/');
  return parts.some(part => PRIVATE_DIRECTORIES.has(part) || INTERMEDIATE_FILE.test(part));
}

async function collectSourceEntries(root: string, relative = ''): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const next = relative ? `${relative}/${item.name}` : item.name;
    if (skippedExportPath(next)) continue;
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) entries.push(...await collectSourceEntries(root, next));
    else if (item.isFile()) {
      const info = await stat(path.join(root, next));
      if (!info.isFile() || info.size > 20_971_520) continue;
      entries.push({ name: next, data: await readFile(path.join(root, next)) });
    }
  }
  return entries;
}

function stamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Copies the immutable build PDF or packages the live sources. The source package always
 * reports the revision it was taken from, so a PDF and a ZIP from different revisions are
 * distinguishable by the caller.
 */
export function createExporter(dependencies: ExportDependencies): ExportPort {
  return {
    async exportReport(input: ExportRequest): Promise<ExportResult> {
      const existing = await readLedger(dependencies.workspace.layout, input.operationId, 'export');
      if (existing) return existing.result as ExportResult;
      const report = await dependencies.workspace.getReport(input.reportId);
      const root = await dependencies.workspace.getReportRoot(input.reportId);
      const exportDirectory = path.join(root, 'exports');
      const existingDirectory = await lstat(exportDirectory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
      if (existingDirectory && (!existingDirectory.isDirectory() || existingDirectory.isSymbolicLink())) throw new WorkbenchError('PATH_OUTSIDE_WORKSPACE', '导出目录不能是符号链接或 junction。');
      await mkdir(exportDirectory, { recursive: true });
      if (!isInside(await realpath(root), await realpath(exportDirectory))) throw new WorkbenchError('PATH_OUTSIDE_WORKSPACE', '导出目录超出报告。');
      if (input.format === 'web-pdf') {
        if (!isHtmlReport(report.mainFile) || input.buildId) throw new WorkbenchError('INVALID_INPUT', '网页样式 PDF 仅适用于当前 HTML 原稿。');
        const preview = await dependencies.html.preview(input.reportId);
        if ((await dependencies.workspace.getReport(input.reportId)).reportRevision !== report.reportRevision) throw new WorkbenchError('FILE_VERSION_CONFLICT', '导出读取期间原稿已更新，请重试。', true);
        const elements = htmlElements(preview.text);
        const page = elements.find(node => htmlAttribute(node, 'data-page-width'));
        const slide = elements.some(node => htmlAttribute(node, 'data-report-layout') === 'slide');
        const bytes = await renderStatic(preview.html, 'pdf', { slide, width: Number(page && htmlAttribute(page, 'data-page-width')) || 1280, height: Number(page && htmlAttribute(page, 'data-page-height')) || 720 });
        if ((await dependencies.workspace.getReport(input.reportId)).reportRevision !== report.reportRevision) throw new WorkbenchError('FILE_VERSION_CONFLICT', '导出期间原稿已更新，请重试以包含最新修改。', true);
        const fileName = `${path.basename(report.mainFile, path.extname(report.mainFile))}-web-${stamp()}-${input.operationId.slice(0, 8)}.pdf`;
        await writeBytesAtomic(path.join(exportDirectory, fileName), bytes);
        const result: ExportResult = { relativePath: `exports/${fileName}`, reportRevision: report.reportRevision };
        await writeLedger(dependencies.workspace.layout, { operationId: input.operationId, kind: 'export', reportId: input.reportId, createdAt: nowIso(), result });
        return result;
      }
      if (input.format === 'pdf') {
        const buildId = input.buildId ?? await dependencies.compiler.currentBuildId(input.reportId);
        if (!buildId) throw new WorkbenchError('BUILD_FAILED', '还没有成功构建，无法导出 PDF。');
        const manifest = await dependencies.compiler.readManifest(input.reportId, buildId);
        if (!manifest || manifest.status !== 'succeeded') throw new WorkbenchError('BUILD_FAILED', '该构建没有成功的 PDF 产物。', false, { buildId });
        const asset = Object.values(manifest.assets).find(candidate => candidate.kind === 'pdf');
        if (!asset) throw new WorkbenchError('BUILD_FAILED', '该构建没有 PDF 资产。', false, { buildId });
        const paths = dependencies.compiler.pathsFor(input.reportId, buildId);
        const bytes = await readFile(path.resolve(paths.directory, asset.fileName));
        const fileName = `${path.basename(report.mainFile, path.extname(report.mainFile))}-${stamp()}-${input.operationId.slice(0, 8)}.pdf`;
        await writeBytesAtomic(path.join(exportDirectory, fileName), bytes);
        const result: ExportResult = { relativePath: `exports/${fileName}`, reportRevision: manifest.reportRevision, buildId };
        await writeLedger(dependencies.workspace.layout, { operationId: input.operationId, kind: 'export', reportId: input.reportId, createdAt: nowIso(), result });
        return result;
      }
      const manifest = input.buildId ? await dependencies.compiler.readManifest(input.reportId, input.buildId) : null;
      if (input.buildId && (!manifest || manifest.status !== 'succeeded')) throw new WorkbenchError('BUILD_FAILED', '该构建没有成功的源码快照。');
      const entries = await collectSourceEntries(input.buildId ? dependencies.compiler.pathsFor(input.reportId, input.buildId).source : root);
      if (!input.buildId && (await dependencies.workspace.getReport(input.reportId)).reportRevision !== report.reportRevision) throw new WorkbenchError('FILE_VERSION_CONFLICT', '导出时源码发生变化，请重试。', true);
      const bytes = buildZip(entries);
      const fileName = `${path.basename(report.mainFile, path.extname(report.mainFile))}-source-${stamp()}-${input.operationId.slice(0, 8)}.zip`;
      await writeBytesAtomic(path.join(exportDirectory, fileName), bytes);
      const result: ExportResult = { relativePath: `exports/${fileName}`, reportRevision: manifest?.reportRevision ?? report.reportRevision, ...(input.buildId ? { buildId: input.buildId } : {}) };
      await writeLedger(dependencies.workspace.layout, { operationId: input.operationId, kind: 'export', reportId: input.reportId, createdAt: nowIso(), result });
      return result;
    },
  };
}

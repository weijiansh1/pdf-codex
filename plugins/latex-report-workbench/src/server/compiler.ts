import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BuildAsset, BuildManifest, BuildRecord, Diagnostic, ReportRecord } from '../shared/contracts.js';
import { DEFAULTS, INTERMEDIATE_FILE, PRIVATE_DIRECTORIES } from '../shared/config.js';
import { WorkbenchError } from '../shared/errors.js';
import { newId, nowIso, readJson, sha256, writeJsonAtomic } from './store.js';
import { resolveSafePath } from './path-policy.js';
import { reportManifestSchema } from '../shared/contracts.js';
import type { Workspace } from './workspace.js';
import { isHtmlReport } from '../shared/html-report.js';
import { generateHtmlLatex } from './html-export.js';

export type BuildPaths = { directory: string; source: string; out: string; manifest: string };

export function buildPaths(layoutRoot: string, reportId: string, buildId: string): BuildPaths {
  const directory = path.join(layoutRoot, 'builds', reportId, buildId);
  return { directory, source: path.join(directory, 'source'), out: path.join(directory, 'out'), manifest: path.join(directory, 'manifest.json') };
}

async function copyTree(from: string, to: string, skip: (name: string) => boolean, onFile: (relativePath: string) => Promise<void>, relative = ''): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const sourcePath = path.join(from, entry.name);
    const targetPath = path.join(to, entry.name);
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await copyTree(sourcePath, targetPath, skip, onFile, relativePath);
    else if (entry.isFile()) {
      await copyFile(sourcePath, targetPath);
      await onFile(relativePath);
    }
  }
}

export type CompilerOptions = { latexmkPath?: string; timeoutMs?: number };

export type RunHooks = {
  signal: AbortSignal;
  onStatus(status: BuildRecord['status']): Promise<void>;
};

export class Compiler {
  constructor(private readonly workspace: Workspace, private readonly options: CompilerOptions = {}) {}

  pathsFor(reportId: string, buildId: string): BuildPaths {
    return buildPaths(this.workspace.layout.dir, reportId, buildId);
  }

  /** Single-shot build used by tests and by the port contract; the queue calls `run` directly. */
  async runBuild(reportId: string, buildId: string): Promise<BuildRecord> {
    const report = await this.workspace.getReport(reportId);
    return this.run(report, buildId, { signal: new AbortController().signal, onStatus: async () => undefined });
  }

  async readManifest(reportId: string, buildId: string): Promise<BuildManifest | null> {
    return readJson<BuildManifest>(this.pathsFor(reportId, buildId).manifest);
  }

  async currentBuildId(reportId: string): Promise<string | null> {
    const current = await readJson<{ buildId: string }>(path.join(this.workspace.layout.builds, reportId, 'current.json'));
    return current?.buildId ?? null;
  }

  async listBuildIds(reportId: string): Promise<string[]> {
    try {
      const entries = await readdir(path.join(this.workspace.layout.builds, reportId), { withFileTypes: true });
      return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  /** Freezes the report, compiles it with latexmk and publishes immutable artifacts. */
  async run(report: ReportRecord, buildId: string, hooks: RunHooks): Promise<BuildRecord> {
    const paths = this.pathsFor(report.reportId, buildId);
    const timeoutMs = this.options.timeoutMs ?? DEFAULTS.compileTimeoutMs;
    const startedAt = nowIso();
    const base: BuildRecord = { reportId: report.reportId, buildId, reportRevision: report.reportRevision, status: 'snapshotting', startedAt, inputVersions: {}, diagnostics: [] };
    await mkdir(paths.out, { recursive: true });
    await writeJsonAtomic(paths.manifest, { ...base, protocolVersion: 1, inputPaths: {}, assets: {} } satisfies BuildManifest);
    await hooks.onStatus('snapshotting');
    const reportRoot = await this.workspace.getReportRoot(report.reportId);
    const inputVersions: Record<string, string> = {};
    let capturedRevision = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await rm(paths.source, { recursive: true, force: true });
      inputVersionsClear(inputVersions);
      await mkdir(paths.source, { recursive: true });
      const copyNodes = async (nodes: Awaited<ReturnType<Workspace['tree']>>): Promise<void> => {
        for (const node of nodes) {
          if (node.kind === 'directory') { await copyNodes(node.children ?? []); continue; }
          const source = await resolveSafePath(reportRoot, node.relativePath);
          const target = path.join(paths.source, node.relativePath);
          await mkdir(path.dirname(target), { recursive: true });
          await copyFile(source, target);
          inputVersions[node.relativePath] = sha256(await readFile(target));
        }
      };
      await copyNodes(await this.workspace.tree(reportRoot));
      capturedRevision = (await this.workspace.getReport(report.reportId)).reportRevision;
      const config = reportManifestSchema.parse(JSON.parse(await readFile(path.join(reportRoot, '.latex-report.json'), 'utf8')));
      const frozenRevision = await this.workspace.hashReport(paths.source, JSON.stringify(config));
      if (capturedRevision === report.reportRevision && frozenRevision === capturedRevision) break;
      if (attempt === 3) throw new WorkbenchError('FILE_VERSION_CONFLICT', '报告在快照期间持续变化，已取消本次编译。', true);
      report = await this.workspace.getReport(report.reportId);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const running: BuildRecord = { ...base, status: 'running', inputVersions };
    await writeJsonAtomic(paths.manifest, { ...running, protocolVersion: 1, inputPaths: inputVersions, assets: {} } satisfies BuildManifest);
    await hooks.onStatus('running');
    const mainFile = isHtmlReport(report.mainFile) ? await generateHtmlLatex(paths.source, report.mainFile, hooks.signal) : report.mainFile.replaceAll('\\', '/');
    const outRelative = path.relative(paths.directory, paths.out);
    const engineFlag = report.engine === 'pdflatex' ? '-pdf' : report.engine === 'lualatex' ? '-lualatex' : '-xelatex';
    const args = [
      '-norc',
      '-latexoption=-no-shell-escape',
      engineFlag,
      ...(report.bibliography === 'bibtex' ? ['-bibtex'] : []),
      '-synctex=1',
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-file-line-error',
      '-recorder',
      `-outdir=${paths.out}`,
      mainFile,
    ];
    const environment = { ...process.env };
    delete environment.SYNCTEX_EDITOR;
    delete environment.SYNCTEX_VIEWER;
    environment.openin_any = 'p';
    environment.openout_any = 'p';
    if (hooks.signal.aborted) throw new WorkbenchError('BUILD_FAILED', '编译已取消。');
    let child: ChildProcess | null = null;
    let timedOut = false;
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      child = spawn(this.options.latexmkPath ?? 'latexmk', args, { cwd: paths.source, windowsHide: true, shell: false, env: environment });
      let stdout = '';
      let stderr = '';
      const append = (current: string, chunk: Buffer): string => (current.length > 4_000_000 ? current : current + chunk.toString('utf8'));
      child.stdout?.on('data', chunk => { stdout = append(stdout, chunk as Buffer); });
      child.stderr?.on('data', chunk => { stderr = append(stderr, chunk as Buffer); });
      const timer = setTimeout(() => { timedOut = true; void killProcessTree(child); }, timeoutMs);
      const abort = () => { void killProcessTree(child); };
      hooks.signal.addEventListener('abort', abort, { once: true });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        hooks.signal.removeEventListener('abort', abort);
        resolve({ code, signal, stdout, stderr });
      });
    }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkbenchError('BUILD_FAILED', '找不到 latexmk，请先安装 TeX Live 或检查 PATH。', false, { tool: 'latexmk' });
      throw error;
    });
    const diagnostics = await this.collectDiagnostics(paths, mainFile, outcome.stdout + outcome.stderr);
    const pdfPath = await findOutput(paths.out, mainFile);
    const synctexPath = await findSyncTex(paths.out, mainFile);
    const cancelled = hooks.signal.aborted;
    const status: BuildRecord['status'] = cancelled ? 'cancelled' : timedOut ? 'failed' : outcome.code === 0 && pdfPath ? 'succeeded' : 'failed';
    if (status === 'failed' && !diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
      diagnostics.push({
        severity: 'error',
        code: timedOut ? 'BUILD_TIMEOUT' : 'BUILD_FAILED',
        message: timedOut ? `编译超过 ${Math.round(timeoutMs / 1000)} 秒，已终止编译进程。` : `latexmk 退出码 ${outcome.code ?? 'null'}，没有生成可用 PDF。`,
      });
    }
    const assets: Record<string, BuildAsset> = {};
    if (status === 'succeeded' && pdfPath) {
      const pdfAssetId = newId();
      const pdfBytes = await readFile(pdfPath);
      if (pdfBytes.length === 0) throw new WorkbenchError('BUILD_FAILED', '生成的 PDF 为空，未发布为成功构建。');
      assets[pdfAssetId] = { assetId: pdfAssetId, kind: 'pdf', fileName: path.relative(paths.directory, pdfPath).replaceAll('\\', '/'), bytes: pdfBytes.length, sha256: sha256(pdfBytes) };
      if (synctexPath) {
        const synctexAssetId = newId();
        const synctexBytes = await readFile(synctexPath);
        assets[synctexAssetId] = { assetId: synctexAssetId, kind: 'synctex', fileName: path.relative(paths.directory, synctexPath).replaceAll('\\', '/'), bytes: synctexBytes.length, sha256: sha256(synctexBytes) };
      } else {
        diagnostics.push({ severity: 'warning', code: 'SYNCTEX_NOT_FOUND', message: 'PDF 已生成，但缺少 SyncTeX 文件，无法做双向定位。' });
      }
    }
    const manifest: BuildManifest = {
      reportId: report.reportId,
      buildId,
      reportRevision: capturedRevision || report.reportRevision,
      status,
      startedAt,
      finishedAt: nowIso(),
      inputVersions,
      diagnostics,
      protocolVersion: 1,
      inputPaths: { mainFile: `source/${mainFile}`, out: outRelative.replaceAll('\\', '/') },
      assets,
      ...(status === 'succeeded' ? {} : { detail: diagnostics.find(diagnostic => diagnostic.severity === 'error')?.message ?? '构建未成功。' }),
      ...(Object.values(assets).find(asset => asset.kind === 'pdf') ? { pdfAssetId: Object.values(assets).find(asset => asset.kind === 'pdf')!.assetId } : {}),
      ...(Object.values(assets).find(asset => asset.kind === 'synctex') ? { synctexAssetId: Object.values(assets).find(asset => asset.kind === 'synctex')!.assetId } : {}),
    };
    await writeJsonAtomic(paths.manifest, manifest);
    if (status === 'succeeded') {
      await writeJsonAtomic(path.join(this.workspace.layout.builds, report.reportId, 'current.json'), { buildId, reportRevision: manifest.reportRevision, pdfAssetId: manifest.pdfAssetId, synctexAssetId: manifest.synctexAssetId, finishedAt: manifest.finishedAt });
    }
    await hooks.onStatus(status);
    return manifest;
  }

  private async collectDiagnostics(paths: BuildPaths, mainFile: string, output: string): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    const logPath = path.join(paths.out, `${mainFile.replace(/\.tex$/i, '')}.log`);
    const log = await readFile(logPath, 'utf8').catch(() => null);
    const source = log ?? output;
    for (const match of source.matchAll(/^(?<file>[^:\r\n]+?):(?<line>\d+):\s*(?<message>.+)$/gm)) {
      const message = match.groups?.message?.trim() ?? '';
      if (!message) continue;
      if (/^warning/i.test(message)) diagnostics.push({ severity: 'warning', code: 'TEX_WARNING', message, ...(match.groups?.file ? { relativePath: normalizeDiagnosticPath(match.groups.file) } : {}), ...(match.groups?.line ? { line: Number(match.groups.line) } : {}) });
      else diagnostics.push({ severity: 'error', code: 'TEX_ERROR', message, ...(match.groups?.file ? { relativePath: normalizeDiagnosticPath(match.groups.file) } : {}), ...(match.groups?.line ? { line: Number(match.groups.line) } : {}) });
      if (diagnostics.length > 200) break;
    }
    if (!diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
      for (const match of source.matchAll(/^!\s*(.+)$/gm)) diagnostics.push({ severity: 'error', code: 'TEX_ERROR', message: match[1]!.trim() });
      for (const match of source.matchAll(/LaTeX Warning:\s*(.+)$/gm)) diagnostics.push({ severity: 'warning', code: 'TEX_WARNING', message: match[1]!.trim() });
      for (const match of source.matchAll(/^Package (\S+) (?:Error|Warning):\s*(.+)$/gm)) diagnostics.push({ severity: /Error/.test(match[0]) ? 'error' : 'warning', code: 'TEX_PACKAGE', message: `${match[1]}: ${match[2]}` });
    }
    return diagnostics.slice(0, 200);
  }
}

function inputVersionsClear(target: Record<string, string>): void {
  for (const key of Object.keys(target)) delete target[key];
}

function normalizeDiagnosticPath(file: string): string {
  return file.replaceAll('\\', '/').replace(/^\.\//, '');
}

async function findOutput(outDirectory: string, mainFile: string): Promise<string | null> {
  const base = path.basename(mainFile).replace(/\.tex$/i, '');
  for (const candidate of [`${base}.pdf`]) {
    const file = path.join(outDirectory, candidate);
    const info = await stat(file).catch(() => null);
    if (info?.isFile() && info.size > 0) return file;
  }
  return null;
}

async function findSyncTex(outDirectory: string, mainFile: string): Promise<string | null> {
  const base = path.basename(mainFile).replace(/\.tex$/i, '');
  for (const candidate of [`${base}.synctex`, `${base}.synctex.gz`]) {
    const file = path.join(outDirectory, candidate);
    const info = await stat(file).catch(() => null);
    if (info?.isFile() && info.size > 0) return file;
  }
  return null;
}

export async function killProcessTree(child: ChildProcess | null): Promise<void> {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false });
      killer.once('close', () => resolve());
      killer.once('error', () => resolve());
    });
    return;
  }
  child.kill('SIGKILL');
}

export async function writeBuildManifest(workspace: Workspace, manifest: BuildManifest): Promise<void> {
  await writeJsonAtomic(buildPaths(workspace.layout.dir, manifest.reportId, manifest.buildId).manifest, manifest);
}

export async function writeBuildFile(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, 'utf8');
}

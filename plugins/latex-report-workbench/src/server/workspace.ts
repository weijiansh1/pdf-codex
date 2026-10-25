import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { reportManifestSchema, type Diagnostic, type FileTreeNode, type ReportRecord } from '../shared/contracts.js';
import { DEFAULTS, INTERMEDIATE_FILE, PRIVATE_DIRECTORIES } from '../shared/config.js';
import { WorkbenchError } from '../shared/errors.js';
import type { WorkspacePort } from '../shared/ports.js';
import { normalizeRelativePath, resolveSafePath } from './path-policy.js';
import { ensureLayout, newId, nowIso, readJson, readJsonState, readLedger, shortId, workspaceLayout, writeJsonAtomic, writeLedger, type OperationLedgerRecord, type WorkspaceLayout } from './store.js';

const TEMPLATE_ROOT = fileURLToPath(new URL('../../templates/', import.meta.url));
const CONFIG_FILE_NAME = '.latex-report.json';

export type WorkspaceConfigFile = {
  schemaVersion: 1;
  workspaceId: string;
  root: string;
  defaultTemplateId: string;
  createdAt: string;
};

function isValidConfig(value: unknown): value is WorkspaceConfigFile {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1 && typeof record.workspaceId === 'string' && /^[0-9a-f-]{36}$/i.test(record.workspaceId) && typeof record.root === 'string';
}

function slugifyTitle(title: string): string {
  const cleaned = title
    .replaceAll(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replaceAll(/\s+/g, '-')
    .replaceAll(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40);
  return cleaned || '报告';
}

function dateStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function copyTemplate(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTemplate(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else throw new WorkbenchError('INVALID_INPUT', '模板包含不支持的文件类型。');
  }
}

/** The single local service: reports are discovered from disk and the workspace identity is persistent. */
export class Workspace implements WorkspacePort {
  readonly layout: WorkspaceLayout;
  private readonly scannedFiles = new Map<string, { revision: string; versions: Map<string, string> }>();
  private lastRegistryWrite = 0;
  private constructor(
    public readonly root: string,
    public readonly workspaceId: string,
    private readonly config: WorkspaceConfigFile,
  ) {
    this.layout = workspaceLayout(root);
  }

  static async open(root: string): Promise<Workspace> {
    const canonical = await realpath(path.resolve(root));
    const layout = workspaceLayout(canonical);
    await ensureLayout(layout);
    await mkdir(path.join(canonical, 'reports'), { recursive: true });
    await resolveSafePath(canonical, 'reports');
    const state = await readJsonState<WorkspaceConfigFile>(layout.config);
    if (state.state === 'ok' && typeof state.value?.schemaVersion === 'number' && state.value.schemaVersion > 1) throw new WorkbenchError('INVALID_INPUT', '工作区配置版本较新，请升级插件；配置没有被覆盖。');
    if (state.state === 'ok' && isValidConfig(state.value) && state.value.root === canonical) return new Workspace(canonical, state.value.workspaceId, state.value);
    if (state.state === 'corrupt') {
      await writeFile(path.join(layout.diagnostics, `config-corrupt-${Date.now()}.json`), state.raw, 'utf8');
    }
    const config: WorkspaceConfigFile = {
      schemaVersion: 1,
      workspaceId: state.state === 'ok' && isValidConfig(state.value) ? state.value.workspaceId : newId(),
      root: canonical,
      defaultTemplateId: 'chinese-report',
      createdAt: state.state === 'ok' && typeof state.value.createdAt === 'string' ? state.value.createdAt : nowIso(),
    };
    await writeJsonAtomic(layout.config, config);
    return new Workspace(canonical, config.workspaceId, config);
  }

  /** Records the stable UUIDs used by create/import so retries return the original result. */
  private async readOperation(operationId: string, kind: string): Promise<OperationLedgerRecord | null> {
    return readLedger(this.layout, operationId, kind);
  }

  private async writeOperation(record: OperationLedgerRecord): Promise<void> {
    await writeLedger(this.layout, record);
  }

  async listReports(): Promise<ReportRecord[]> {
    let reportsRoot: string;
    try {
      reportsRoot = await resolveSafePath(this.root, 'reports');
    } catch (error) {
      if (error instanceof WorkbenchError && error.code === 'FILE_NOT_FOUND') return [];
      throw error;
    }
    const records: ReportRecord[] = [];
    const diagnostics: Diagnostic[] = [];
    const imports = await readJson<{ roots: string[] }>(path.join(this.layout.dir, 'imports.json'));
    const roots = new Set((await readdir(reportsRoot, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => `reports/${entry.name}`));
    for (const imported of imports?.roots ?? []) roots.add(imported);
    for (const relativeRoot of [...roots].sort()) {
      let manifestPath: string;
      try {
        manifestPath = await resolveSafePath(this.root, `${relativeRoot}/${CONFIG_FILE_NAME}`);
      } catch (error) {
        if (error instanceof WorkbenchError && error.code === 'FILE_NOT_FOUND') continue;
        throw error;
      }
      const size = (await lstat(manifestPath)).size;
      if (size > 65_536) {
        diagnostics.push({ severity: 'error', code: 'INVALID_REPORT_CONFIG', message: '报告配置超过 64 KiB，已跳过。', relativePath: `${relativeRoot}/${CONFIG_FILE_NAME}` });
        continue;
      }
      let manifest;
      try {
        manifest = reportManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
      } catch {
        diagnostics.push({ severity: 'error', code: 'INVALID_REPORT_CONFIG', message: '报告配置缺少合法 ID、入口或编译设置，已跳过。', relativePath: `${relativeRoot}/${CONFIG_FILE_NAME}` });
        continue;
      }
      if (records.some(record => record.reportId === manifest.reportId)) throw new WorkbenchError('INVALID_REPORT_CONFIG', '多个报告使用了同一个 reportId。');
      const reportRoot = await resolveSafePath(this.root, relativeRoot);
      try {
        await resolveSafePath(reportRoot, manifest.mainFile);
        if (manifest.generatedFrom) await resolveSafePath(reportRoot, manifest.generatedFrom);
      } catch (error) {
        if (error instanceof WorkbenchError) {
          diagnostics.push({ severity: 'error', code: error.code, message: `主文件不可用：${error.message}`, relativePath: `${relativeRoot}/${manifest.mainFile}` });
          continue;
        }
        throw error;
      }
      const { schemaVersion: _, ...metadata } = manifest;
      records.push({ ...metadata, workspaceId: this.workspaceId, rootRelativePath: relativeRoot, reportRevision: await this.hashReport(reportRoot, JSON.stringify(manifest)) });
    }
    await this.writeRegistry(records, diagnostics);
    return records;
  }

  private async writeRegistry(reports: ReportRecord[], diagnostics: Diagnostic[]): Promise<void> {
    const now = Date.now();
    if (now - this.lastRegistryWrite < 5_000 && diagnostics.length === 0) return;
    this.lastRegistryWrite = now;
    try {
      await writeJsonAtomic(this.layout.registry, { schemaVersion: 1, workspaceId: this.workspaceId, generatedAt: nowIso(), reports, diagnostics });
    } catch {
      // The registry is a rebuildable cache; a failed cache write must not break report listing.
    }
  }

  async getReport(reportId: string): Promise<ReportRecord> {
    const report = (await this.listReports()).find(record => record.reportId === reportId);
    if (!report) throw new WorkbenchError('REPORT_NOT_FOUND', '工作区中没有该报告。');
    return report;
  }

  async getReportRoot(reportId: string): Promise<string> {
    return resolveSafePath(this.root, (await this.getReport(reportId)).rootRelativePath);
  }

  async tree(root: string): Promise<FileTreeNode[]> {
    let count = 0;
    const walk = async (relative: string, depth: number): Promise<FileTreeNode[]> => {
      if (depth > DEFAULTS.maxTreeDepth) throw new WorkbenchError('FILE_TOO_LARGE', '报告目录嵌套过深。');
      const directory = relative ? await resolveSafePath(root, relative) : root;
      const nodes: FileTreeNode[] = [];
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (PRIVATE_DIRECTORIES.has(entry.name.toLowerCase()) || entry.name === CONFIG_FILE_NAME || INTERMEDIATE_FILE.test(entry.name)) continue;
        if (++count > DEFAULTS.maxFiles) throw new WorkbenchError('FILE_TOO_LARGE', '报告文件数超过扫描上限。');
        const file = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        await resolveSafePath(root, file);
        if (entry.isDirectory()) nodes.push({ relativePath: file, name: entry.name, kind: 'directory', children: await walk(file, depth + 1) });
        else if (entry.isFile()) nodes.push({ relativePath: file, name: entry.name, kind: 'file' });
      }
      return nodes;
    };
    return walk('', 0);
  }

  async createReport(title: string, templateId: string, operationId: string): Promise<ReportRecord> {
    const existing = await this.readOperation(operationId, 'report-create');
    if (existing?.reportId) return this.getReport(existing.reportId);
    const template = templateId.replaceAll(/[^a-zA-Z0-9-_]/g, '');
    if (!template) throw new WorkbenchError('INVALID_INPUT', '模板标识不合法。');
    const templateDirectory = path.join(TEMPLATE_ROOT, template);
    const templateInfo = await stat(templateDirectory).catch(() => null);
    if (!templateInfo?.isDirectory()) throw new WorkbenchError('INVALID_INPUT', '找不到该报告模板。', false, { templateId: template });
    const reportId = newId();
    const directoryName = `${dateStamp()}-${slugifyTitle(title)}-${shortId(reportId)}`;
    const relativeRoot = `reports/${directoryName}`;
    const reportRoot = await resolveSafePath(this.root, relativeRoot, { allowMissingLeaf: true });
    await mkdir(reportRoot, { recursive: false });
    try {
      await copyTemplate(templateDirectory, reportRoot);
      await rm(path.join(reportRoot, '.latex-report.example.json'), { force: true });
      await writeJsonAtomic(path.join(reportRoot, CONFIG_FILE_NAME), {
        schemaVersion: 1,
        reportId,
        title: title.trim(),
        mainFile: template.startsWith('html-') ? 'main.html' : 'main.tex',
        engine: 'xelatex',
        bibliography: 'auto',
      });
    } catch (error) {
      await rm(reportRoot, { recursive: true, force: true });
      throw error;
    }
    await this.writeOperation({ operationId, kind: 'report-create', reportId, createdAt: nowIso() });
    return this.getReport(reportId);
  }

  async importReport(rootRelativePath: string, mainFile: string, operationId: string, generatedFrom?: string): Promise<ReportRecord> {
    const existing = await this.readOperation(operationId, 'report-import');
    if (existing?.reportId) return this.getReport(existing.reportId);
    const reportRoot = await resolveSafePath(this.root, rootRelativePath);
    if (!(await stat(reportRoot)).isDirectory()) throw new WorkbenchError('INVALID_INPUT', '导入目标必须是工作区内的目录。');
    await resolveSafePath(reportRoot, mainFile);
    const manifestPath = path.join(reportRoot, CONFIG_FILE_NAME);
    let reportId: string;
    const state = await readJsonState<unknown>(manifestPath);
    if (state.state === 'ok') {
      const parsed = reportManifestSchema.safeParse(state.value);
      if (!parsed.success) throw new WorkbenchError('INVALID_REPORT_CONFIG', '现有报告配置不合法，导入中止。');
      if (generatedFrom && normalizeRelativePath(generatedFrom).toLowerCase() !== normalizeRelativePath(parsed.data.generatedFrom ?? '').toLowerCase()) throw new WorkbenchError('INVALID_REPORT_CONFIG', '已有配置中的生成源与本次登记不同，请先在报告配置中明确设置 generatedFrom。原配置没有改写。');
      reportId = parsed.data.reportId;
    } else if (state.state === 'corrupt') {
      throw new WorkbenchError('INVALID_REPORT_CONFIG', '现有报告配置损坏，导入中止。');
    } else {
      reportId = newId();
      if (generatedFrom) await resolveSafePath(reportRoot, generatedFrom);
      const manifest = reportManifestSchema.parse({ schemaVersion: 1, reportId, title: path.basename(reportRoot), mainFile, ...(generatedFrom ? { generatedFrom } : {}), engine: 'xelatex', bibliography: 'auto' });
      await writeJsonAtomic(manifestPath, manifest);
    }
    await this.writeOperation({ operationId, kind: 'report-import', reportId, createdAt: nowIso() });
    const importsPath = path.join(this.layout.dir, 'imports.json');
    const imports = await readJson<{ roots: string[] }>(importsPath);
    await writeJsonAtomic(importsPath, { roots: [...new Set([...(imports?.roots ?? []), normalizeRelativePath(rootRelativePath)])] });
    return this.getReport(reportId);
  }

  async hashReport(root: string, manifest: string): Promise<string> {
    const hash = createHash('sha256').update(manifest).update('\0');
    const versions = new Map<string, string>();
    let bytes = 0;
    const visit = async (nodes: FileTreeNode[]): Promise<void> => {
      for (const node of nodes) {
        if (node.kind === 'directory') await visit(node.children ?? []);
        else {
          const file = await resolveSafePath(root, node.relativePath);
          const size = (await lstat(file)).size;
          bytes += size;
          if (bytes > DEFAULTS.maxBuildInputBytes) throw new WorkbenchError('FILE_TOO_LARGE', '报告超过扫描大小上限。');
          const digest = createHash('sha256').update(await readFile(file)).digest();
          versions.set(node.relativePath.replaceAll('\\', '/'), digest.toString('hex'));
          hash.update(node.relativePath).update('\0').update(digest).update('\0');
        }
      }
    };
    await visit(await this.tree(root));
    const revision = hash.digest('hex');
    this.scannedFiles.delete(root); this.scannedFiles.set(root, { revision, versions });
    while (this.scannedFiles.size > 32) this.scannedFiles.delete(this.scannedFiles.keys().next().value!);
    return revision;
  }

  scannedVersion(root: string, revision: string, relative: string): string | undefined {
    const scanned = this.scannedFiles.get(root);
    return scanned?.revision === revision ? scanned.versions.get(relative.replaceAll('\\', '/')) : undefined;
  }

  get configFile(): WorkspaceConfigFile {
    return this.config;
  }
}

export type { WorkspaceLayout } from './store.js';

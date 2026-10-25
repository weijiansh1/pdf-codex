import type { z } from 'zod';
import path from 'node:path';
import { toolInputs, PROTOCOL_VERSION, type Diagnostic, type ToolName, type ToolResults, type FeatureStatus, type WorkspaceEvent } from '../shared/contracts.js';
import { FEATURES } from '../shared/features.js';
import { WorkbenchError } from '../shared/errors.js';
import type { WorkbenchServices, WriteGuard } from '../shared/ports.js';
import { Workspace } from './workspace.js';
import { FileService } from './files.js';
import { createOutline } from './outline.js';
import { createContexts } from './contexts.js';
import { HistoryStore, createHistory } from './history.js';
import { Compiler, type CompilerOptions } from './compiler.js';
import { BuildQueue } from './build-queue.js';
import { createSyncTex } from './synctex.js';
import { createAssets } from './assets.js';
import { createTextProjection } from './text-projection.js';
import { createPdfEdit } from './pdf-edit.js';
import { createObjectTargets } from './object-targets.js';
import { createExporter } from './export.js';
import { createCleanup } from './cleanup.js';
import { createWatcher } from './watcher.js';
import { KeyedMutex } from './store.js';
import { isHtmlReport } from '../shared/html-report.js';
import { createHtmlPreview } from './html-preview.js';
import { DEFAULTS } from '../shared/config.js';

type Invocation = { validateWrite?: WriteGuard };
type Handlers = { [N in ToolName]: (input: z.output<(typeof toolInputs)[N]>, invocation?: Invocation) => Promise<ToolResults[N]> };

export type ApplicationOptions = { compiler?: CompilerOptions };

export interface Application {
  readonly services: WorkbenchServices;
  readonly workspace: Workspace;
  features(): FeatureStatus[];
  /** Recovers unfinished journals of every known report. Safe to call repeatedly. */
  recover(): Promise<Diagnostic[]>;
  /** In-process event stream; the HTTP and stdio entries of one process share it. */
  subscribe(listener: (event: WorkspaceEvent) => void): () => void;
  call<N extends ToolName>(name: N, input: unknown, invocation?: Invocation): Promise<ToolResults[N]>;
  close(): Promise<void>;
}

export async function createApplication(root: string, options: ApplicationOptions = {}): Promise<Application> {
  const workspace = await Workspace.open(root);
  const historyStore = new HistoryStore(workspace);
  const lock = new KeyedMutex();
  const listeners = new Set<(event: WorkspaceEvent) => void>();
  let sequence = 0;
  const emit = (reportId: string, kind: WorkspaceEvent['kind'], extra: Partial<WorkspaceEvent> = {}) => {
    sequence += 1;
    const event: WorkspaceEvent = { workspaceId: workspace.workspaceId, reportId, sequence, kind, ...extra };
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never break a committed write.
      }
    }
  };

  // The file service and the context service reference each other: contexts need current file
  // bytes, and patch commits remap the active selection. Both closures resolve lazily.
  let files: FileService;
  const contexts = createContexts({
    workspace,
    readTextFile: (reportId, relativePath) => files.readTextFile(reportId, relativePath),
  });
  let buildQueue: BuildQueue;
  files = new FileService(workspace, historyStore, lock, {
    afterCommit: async info => {
      await contexts.remapAfterPatch(info);
      emit(info.reportId, 'operation-committed', { operationId: info.record.operationId });
      emit(info.reportId, 'files-changed');
    },
  });
  files.setSelectionResolver((contextId, selectionId) => contexts.getContext(contextId, selectionId));
  files.setContextResolver(contextId => contexts.reportIdFor(contextId));

  const compiler = new Compiler(workspace, options.compiler ?? {});
  buildQueue = new BuildQueue({
    workspace,
    compiler,
    onEvent: event => emit(event.reportId, 'build-changed', { buildId: event.buildId }),
  });
  const synctex = createSyncTex({ workspace, compiler });
  const projection = createTextProjection();
  const pdfEdit = createPdfEdit({ workspace, compiler, files, contexts, synctex, projection, buildQueue, history: historyStore });
  const objects = createObjectTargets({ workspace, compiler, synctex, files });
  const htmlPreview = createHtmlPreview({ workspace, files, contexts, history: historyStore });
  const exporter = createExporter({ workspace, compiler, html: htmlPreview });
  const cleanup = createCleanup({ workspace, compiler, history: historyStore });
  const watcher = createWatcher({ workspace, onEvent: event => {
    emit(event.reportId, event.kind, event);
    void automaticBuild(event.reportId).catch(() => undefined);
  } });
  async function automaticBuild(reportId: string): Promise<{ buildId: string } | null> {
    return isHtmlReport((await workspace.getReport(reportId)).mainFile) ? null : buildQueue.enqueueBuild(reportId);
  }
  const services: WorkbenchServices = {
    workspace,
    files,
    outline: createOutline({ workspace, files }),
    contexts,
    html: htmlPreview,
    history: createHistory(historyStore, () => ({
      assertWritable: (reportId, relativePaths) => files.assertWritable(reportId, relativePaths),
      restoreFile: (reportId, relativePath, bytes, expectedVersion) => files.restoreFile(reportId, relativePath, bytes, expectedVersion),
      readVersion: async (reportId, relativePath) => (await files.readTextFile(reportId, relativePath)).fileVersion,
      removeFile: (reportId, relativePath, expectedVersion) => files.removeFile(reportId, relativePath, expectedVersion),
      recoverTransactions: reportId => files.recoverTransactions(reportId),
      withReportLock: (reportId, work) => files.withReportLock(reportId, work),
    })),
    compiler,
    buildQueue,
    synctex,
    assets: createAssets(compiler),
    projection,
    pdfEdit,
    objects,
    exporter,
    cleanup,
    watcher,
  };
  const features = () => FEATURES.map(feature => ({ ...feature }));

  const handlers: Handlers = {
    probe_echo: async p => ({ nonce: p.nonce, workspaceId: workspace.workspaceId, protocolVersion: PROTOCOL_VERSION }),
    workspace_status: async () => ({ workspaceId: workspace.workspaceId, root: workspace.root, protocolVersion: PROTOCOL_VERSION, features: features() }),
    workbench_open: async p => ({ workspaceId: workspace.workspaceId, report: p.reportId ? await workspace.getReport(p.reportId) : null, features: features() }),
    report_list: async () => ({ reports: await workspace.listReports() }),
    report_open: async p => ({ report: await workspace.getReport(p.reportId) }),
    report_create: async p => ({ report: await workspace.createReport(p.title, p.templateId, p.operationId) }),
    report_import: async p => ({ report: await workspace.importReport(p.rootRelativePath, p.mainFile, p.operationId, p.generatedFrom) }),
    report_tree: async p => p.kind === 'files' ? { kind: 'files', nodes: await services.files.listFileTree(p.reportId) } : { kind: 'outline', ...await services.outline.buildOutline(p.reportId) },
    report_read: async p => {
      const file = await services.files.readTextFile(p.reportId, p.relativePath);
      if (!p.range) return file;
      if (p.range.end > file.text.length) throw new WorkbenchError('INVALID_INPUT', '请求范围超出实际源码。');
      return { ...file, text: file.text.slice(p.range.start, p.range.end), returnedRange: p.range };
    },
    report_preview: async p => services.html.preview(p.reportId),
    html_select: async p => services.html.select(p),
    html_edit: async p => services.html.edit(p),
    report_context_get: async p => ({ selection: await services.contexts.getContext(p.contextId, p.selectionId) }),
    report_apply_patch: async (p, invocation) => {
      const operation = await services.files.applyPatch(p, invocation?.validateWrite);
      const changed = Object.entries(operation.afterVersions).some(([file, version]) => operation.beforeVersions[file] !== version);
      return { operation, buildId: changed ? (await automaticBuild(p.reportId))?.buildId ?? null : null };
    },
    report_compile: async p => services.buildQueue.enqueueBuild(p.reportId, p.force === undefined ? undefined : { force: p.force }),
    report_build_status: async p => ({ build: await services.buildQueue.getBuildStatus(p.reportId, p.buildId) }),
    report_locate_pdf: async p => services.synctex.locatePdfTarget({ reportId: p.reportId, buildId: p.buildId, page: p.page, point: p.point, ...(p.selectedText === undefined ? {} : { selectedText: p.selectedText }) }),
    report_locate_source: async p => ({ locations: await services.synctex.locateSourceTarget({ reportId: p.reportId, buildId: p.buildId, relativePath: p.relativePath, line: p.line, ...(p.column === undefined ? {} : { column: p.column }) }) }),
    report_history: async p => services.history.list(p.reportId, p.cursor, p.limit),
    report_undo: async p => {
      const operation = await services.history.undoOperation(p);
      emit(p.reportId, 'operation-committed', { operationId: operation.operationId });
      emit(p.reportId, 'files-changed');
      await automaticBuild(p.reportId);
      return { operation };
    },
    report_export: async p => {
      let buildId = p.buildId;
      const html = isHtmlReport((await workspace.getReport(p.reportId)).mainFile);
      if ((html && p.format === 'pdf' && !buildId) || p.format === 'latex-zip') {
        const queued = await buildQueue.enqueueBuild(p.reportId);
        const deadline = Date.now() + DEFAULTS.compileTimeoutMs + 25_000;
        while (true) {
          const build = await buildQueue.getBuildStatus(p.reportId, queued.buildId);
          if (build.status === 'succeeded') {
            if (build.reportRevision !== (await workspace.getReport(p.reportId)).reportRevision) throw new WorkbenchError('FILE_VERSION_CONFLICT', '导出期间原稿已更新，请重试以包含最新修改。', true);
            buildId = build.buildId; break;
          }
          if (build.status === 'failed' || build.status === 'cancelled') throw new WorkbenchError('BUILD_FAILED', build.detail ?? build.diagnostics.find(d => d.severity === 'error')?.message ?? '导出编译失败。');
          if (Date.now() > deadline) throw new WorkbenchError('BUILD_TIMEOUT', '导出编译等待超时。', true);
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }
      return services.exporter.exportReport({ reportId: p.reportId, format: p.format === 'latex-zip' ? 'source-zip' : p.format, operationId: p.operationId, ...(buildId === undefined ? {} : { buildId }) });
    },
    context_bind: async p => services.contexts.bindContext(p),
    selection_set: async p => ({ selection: await services.contexts.setSelection(p) }),
    selection_clear: async p => { await services.contexts.clearSelection(p.contextId); return { cleared: true }; },
    draft_save: async p => {
      const operation = await services.files.saveDraft(p);
      const changed = Object.entries(operation.afterVersions).some(([file, version]) => operation.beforeVersions[file] !== version);
      return { operation, buildId: changed ? (await automaticBuild(p.reportId))?.buildId ?? null : null };
    },
    workspace_asset_read: async p => services.assets.readAssetChunk(p),
    session_keepalive: async p => services.contexts.keepAlive(p.contextId, p.viewId),
    pdf_edit_open: async p => ({ session: await services.pdfEdit.openPdfEdit(p) }),
    pdf_edit_commit: async p => services.pdfEdit.commitPdfEdit(p),
    pdf_edit_cancel: async p => { await services.pdfEdit.cancelPdfEdit(p.editSessionId, p.contextId); return { cancelled: true }; },
    objects_resolve_region: async p => services.objects.resolveRegionTargets({ reportId: p.reportId, buildId: p.buildId, regions: p.regions }),
    objects_attach_image: async p => services.objects.attachSelectedRegionImage(p.selectionId),
  };

  return {
    services,
    workspace,
    features,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async recover() {
      const diagnostics: Diagnostic[] = [];
      for (const report of await workspace.listReports()) {
        try {
          diagnostics.push(...await files.recoverTransactions(report.reportId));
        } catch (error) {
          diagnostics.push({ severity: 'warning', code: 'RECOVERY_FAILED', message: error instanceof Error ? error.message : '恢复未完成事务失败。' });
        }
      }
      return diagnostics;
    },
    async call<N extends ToolName>(name: N, input: unknown, invocation?: Invocation): Promise<ToolResults[N]> {
      const schema = toolInputs[name];
      if (!schema) throw new WorkbenchError('INVALID_INPUT', '未知工具。');
      const parsed = schema.safeParse(input);
      if (!parsed.success) throw new WorkbenchError('INVALID_INPUT', '工具参数不符合契约。', false, { issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
      return handlers[name](parsed.data as never, invocation);
    },
    async close() {
      listeners.clear();
      await watcher.stop().catch(() => undefined);
      await buildQueue.shutdown();
    },
  };
}

const sharedApplications = new Map<string, Promise<Application>>();

/**
 * One application per workspace root inside a process. The HTTP entry and the stdio entry
 * must never hold separate transactions, queues or selection state for the same workspace.
 */
export function getSharedApplication(root: string, options: ApplicationOptions = {}): Promise<Application> {
  const key = path.resolve(root).toLowerCase();
  let application = sharedApplications.get(key);
  if (!application) {
    application = createApplication(path.resolve(root), options);
    sharedApplications.set(key, application);
    void application.catch(() => { sharedApplications.delete(key); });
  }
  return application;
}

export async function closeSharedApplication(root?: string): Promise<void> {
  if (root === undefined) {
    const entries = [...sharedApplications.entries()];
    sharedApplications.clear();
    await Promise.all(entries.map(async ([, promise]) => (await promise).close()));
    return;
  }
  const key = path.resolve(root).toLowerCase();
  const application = sharedApplications.get(key);
  sharedApplications.delete(key);
  if (application) await (await application).close();
}

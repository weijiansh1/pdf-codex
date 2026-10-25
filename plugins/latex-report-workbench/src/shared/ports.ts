import type * as C from './contracts.js';
export interface WorkspacePort { readonly workspaceId: string; readonly root: string; listReports(): Promise<C.ReportRecord[]>; getReport(reportId: string): Promise<C.ReportRecord>; createReport(title: string, templateId: string, operationId: string): Promise<C.ReportRecord>; importReport(rootRelativePath: string, mainFile: string, operationId: string, generatedFrom?: string): Promise<C.ReportRecord>; }
export type WriteGuard = () => void;
export interface FilesPort { readTextFile(reportId: string, relativePath: string): Promise<C.FileSnapshot>; listFileTree(reportId: string): Promise<C.FileTreeNode[]>; applyPatch(request: C.PatchRequest, validateWrite?: WriteGuard): Promise<C.OperationRecord>; saveDraft(request: C.DraftSave): Promise<C.OperationRecord>; recoverTransactions(reportId: string): Promise<C.Diagnostic[]>; }
export interface OutlinePort { buildOutline(reportId: string): Promise<C.OutlineResult>; }
export interface HtmlPort {
  preview(reportId: string): Promise<C.HtmlPreview>;
  select(input: C.ToolArguments<'html_select'>): Promise<{ selection: C.SelectionRecord }>;
  edit(input: C.ToolArguments<'html_edit'>): Promise<{ operation: C.OperationRecord; buildId: null }>;
}
export interface ContextsPort { bindContext(input: { workspaceId: string; reportId: string; viewId: string }): Promise<{ contextId: string }>; validateBinding(input: { contextId: string; reportId: string; viewId: string }): Promise<void>; setSelection(input: C.SelectionInput): Promise<C.SelectionRecord>; getContext(contextId: string, selectionId?: string): Promise<C.SelectionRecord | null>; clearSelection(contextId: string): Promise<void>; keepAlive(contextId: string, viewId: string): Promise<{ expiresAt: string }>; }
export interface HistoryPort { list(reportId: string, cursor?: string, limit?: number): Promise<C.HistoryPage>; undoOperation(input: C.UndoRequest): Promise<C.OperationRecord>; }
export interface CompilerPort { runBuild(reportId: string, buildId: string): Promise<C.BuildRecord>; }
export interface BuildQueuePort { enqueueBuild(reportId: string, options?: { force?: boolean }): Promise<{ buildId: string }>; getBuildStatus(reportId: string, buildId?: string): Promise<C.BuildManifest>; cancelBuild(reportId: string, buildId: string): Promise<void>; hasActiveWork(): boolean; }
export interface SyncTexPort { locatePdfTarget(input: C.PdfLocateRequest): Promise<C.LocateResult>; locateSourceTarget(input: C.SourceLocateRequest): Promise<C.PdfLocation[]>; }
export interface AssetsPort { readAssetChunk(input: C.AssetRequest): Promise<C.AssetChunk>; }
export interface TextProjectionPort { buildTextProjection(snapshot: C.FileSnapshot, sourceRange: C.TextRange): C.TextProjection; }
export interface PdfEditPort { openPdfEdit(input: C.PdfEditOpen): Promise<C.PdfEditSession>; commitPdfEdit(input: C.PdfEditCommit): Promise<C.PdfEditResult>; cancelPdfEdit(editSessionId: string, contextId: string): Promise<void>; }
export interface ObjectsPort { resolveRegionTargets(input: C.RegionRequest): Promise<C.LocateResult>; attachSelectedRegionImage(selectionId: string): Promise<{ attached: boolean; reason?: string }>; }
export interface ExportPort { exportReport(input: C.ExportRequest): Promise<C.ExportResult>; }
export interface CleanupPort { cleanupWorkspace(input: { now: string; dryRun: boolean }): Promise<C.CleanupResult>; migrateWorkspace(fromVersion: number): Promise<C.Diagnostic[]>; }
export interface WatcherPort { start(): Promise<void>; stop(): Promise<void>; }
export interface HostAdapter { detectCapabilities(): Promise<C.HostCapabilities>; updateSelectionContext(context: C.SelectionContext | null): Promise<void>; sendUserRequestedMessage(prompt: string): Promise<void>; }
export interface TerminalPort {
  create(binding: C.TerminalBinding): Promise<C.TerminalSession>;
  get(sessionId: string): C.TerminalSession;
  bind(sessionId: string, binding: C.TerminalBinding): Promise<void>;
  suspend(sessionId: string): void;
  request(sessionId: string, prompt: string, expectedBinding?: C.TerminalBinding, submit?: boolean): Promise<void>;
  input(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  subscribe(sessionId: string, receive: (event: C.TerminalEvent) => void): () => void;
  stop(sessionId: string): Promise<void>;
  hasActiveWork(): boolean;
  close(): Promise<void>;
}
export interface WorkbenchServices { workspace: WorkspacePort; files: FilesPort; outline: OutlinePort; html: HtmlPort; contexts: ContextsPort; history: HistoryPort; compiler: CompilerPort; buildQueue: BuildQueuePort; synctex: SyncTexPort; assets: AssetsPort; projection: TextProjectionPort; pdfEdit: PdfEditPort; objects: ObjectsPort; exporter: ExportPort; cleanup: CleanupPort; watcher: WatcherPort; }

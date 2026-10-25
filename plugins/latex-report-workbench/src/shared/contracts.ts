import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const idSchema = z.uuid();
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const relativePathSchema = z.string().min(1).max(512).refine(value => {
  const parts = value.replaceAll('\\', '/').split('/');
  return !/[<>:"|?*\x00-\x1f]/.test(value) && !value.startsWith('/') && !value.startsWith('\\') && parts.every(part =>
    part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}, '必须是范围内的普通相对路径');
export const textRangeSchema = z.object({ start: z.int().min(0), end: z.int().min(0) }).strict().refine(r => r.end >= r.start, '范围必须左闭右开且 end >= start');
export const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
export const rectSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]);
export const diagnosticSchema = z.object({ severity: z.enum(['error', 'warning', 'info']), code: z.string(), message: z.string(), relativePath: relativePathSchema.optional(), line: z.int().positive().optional() }).strict();
export type Diagnostic = z.infer<typeof diagnosticSchema>;
export type TextRange = z.infer<typeof textRangeSchema>;
export type Point = z.infer<typeof pointSchema>;
export type Rect = z.infer<typeof rectSchema>;

export const reportManifestSchema = z.object({ schemaVersion: z.literal(1), reportId: idSchema, title: z.string().trim().min(1).max(200), mainFile: relativePathSchema, generatedFrom: relativePathSchema.optional(), engine: z.enum(['xelatex', 'pdflatex', 'lualatex']), bibliography: z.enum(['auto', 'bibtex', 'biber', 'none']) }).strict().refine(value => !value.generatedFrom || (/\.html$/i.test(value.mainFile) && value.generatedFrom.replaceAll('\\', '/').toLowerCase() !== value.mainFile.replaceAll('\\', '/').toLowerCase()), '生成源必须与 HTML 入口不同');
export type ReportManifest = z.infer<typeof reportManifestSchema>;
export type ReportRecord = Omit<ReportManifest, 'schemaVersion'> & { workspaceId: string; rootRelativePath: string; reportRevision: string };
export type FileSnapshot = { relativePath: string; text: string; fileVersion: string; encoding: 'utf8'; eol: 'lf' | 'crlf' | 'mixed'; bom: boolean };
export type FileReadResult = FileSnapshot & { returnedRange?: TextRange };
export type HtmlTextRun = { runId: string; text: string };
export type HtmlBlock = { blockId: string; tag: string; text: string; range: TextRange; contentRange: TextRange; editable: boolean; level?: number; runs?: HtmlTextRun[]; formula?: string };
export type HtmlPreview = { reportId: string; relativePath: string; generatedFrom?: string; fileVersion: string; text: string; html: string; blocks: HtmlBlock[]; assets: Record<string, string>; renderMs: number };
export type FileTreeNode = { relativePath: string; name: string; kind: 'file' | 'directory'; children?: FileTreeNode[] };
export type SourceTarget = { relativePath: string; range: TextRange; fileVersion: string; exactText: string; prefix: string; suffix: string };
export type OutlineNode = { nodeId: string; title: string; level: number; relativePath: string; headingRange: TextRange; bodySpans: SourceTarget[]; label?: string; children: OutlineNode[]; warnings: Diagnostic[] };
export type OutlineResult = { nodes: OutlineNode[]; diagnostics: Diagnostic[] };

export const selectionKindSchema = z.enum(['chapter', 'source', 'pdf-text', 'pdf-region']);
export const pdfRegionSchema = z.object({ page: z.int().positive(), rect: rectSchema }).strict();
export const selectionInputSchema = z.object({ reportId: idSchema, contextId: idSchema, viewId: idSchema, kind: selectionKindSchema,
  candidateTargets: z.array(z.object({ relativePath: relativePathSchema, range: textRangeSchema, expectedVersion: hashSchema }).strict()).max(64),
  selectedText: z.string().max(100_000).optional(), buildId: idSchema.optional(), pdfRegion: pdfRegionSchema.optional()
}).strict().superRefine((value, ctx) => {
  if (value.kind.startsWith('pdf-') && !value.buildId) ctx.addIssue({ code: 'custom', path: ['buildId'], message: 'PDF 选择必须关联构建版本' });
  if (value.kind === 'pdf-region' && !value.pdfRegion) ctx.addIssue({ code: 'custom', path: ['pdfRegion'], message: '区域选择必须指定页面与矩形' });
  if (!value.kind.startsWith('pdf-') && value.candidateTargets.length === 0) ctx.addIssue({ code: 'custom', path: ['candidateTargets'], message: '源码选择必须有目标' });
});
export type SelectionInput = z.infer<typeof selectionInputSchema>;
export type SelectionRecord = {
  workspaceId: string; reportId: string; contextId: string; viewId: string; selectionId: string;
  kind: z.infer<typeof selectionKindSchema>; targets: SourceTarget[]; buildId?: string;
  pdfRegion?: z.infer<typeof pdfRegionSchema>; selectedText: string;
  validity: 'valid' | 'stale' | 'ambiguous' | 'unmapped'; createdAt: string;
};
export type SelectionContext = { workspaceId: string; reportId: string; contextId: string; selectionId: string; title: string; kind: SelectionRecord['kind']; summary: string; status: SelectionRecord['validity'] };

export const terminalBindingSchema = z.object({ reportId: idSchema, contextId: idSchema, viewId: idSchema, selectionId: idSchema.optional() }).strict();
export type TerminalBinding = z.infer<typeof terminalBindingSchema>;
export type TerminalSession = { sessionId: string; reportId: string; viewId: string; state: 'running' | 'exited'; exitCode?: number };
export type TerminalEvent = { type: 'output'; data: string; replay?: boolean } | { type: 'exit'; exitCode: number };
export const terminalFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(131072) }).strict(),
  z.object({ type: z.literal('resize'), cols: z.int().min(20).max(500), rows: z.int().min(4).max(200) }).strict(),
]);

const editSchema = z.object({ range: textRangeSchema, replacement: z.string().max(2_097_152) }).strict();
export const patchRequestSchema = z.object({ reportId: idSchema, contextId: idSchema, selectionId: idSchema.optional(), scope: z.enum(['selection', 'report']), scopeReason: z.string().trim().min(1).max(2000).optional(), operationId: idSchema,
  files: z.array(z.object({ relativePath: relativePathSchema, expectedVersion: hashSchema.nullable(), edits: z.array(editSchema).min(1).max(256) }).strict()).min(1).max(64)
}).strict().superRefine((value, ctx) => {
  if (value.scope === 'selection' && !value.selectionId) ctx.addIssue({ code: 'custom', path: ['selectionId'], message: '选区写入必须绑定 selectionId' });
  if (value.scope === 'report' && !value.scopeReason) ctx.addIssue({ code: 'custom', path: ['scopeReason'], message: '报告范围写入必须说明用户意图' });
  const names = new Set<string>();
  value.files.forEach((file, i) => {
    const name = file.relativePath.replaceAll('\\', '/').toLowerCase();
    if (names.has(name)) ctx.addIssue({ code: 'custom', path: ['files', i], message: '同文件必须合并为一个条件修改' });
    names.add(name);
    const edits = [...file.edits].sort((a, b) => a.range.start - b.range.start);
    edits.forEach((edit, j) => {
      const prev = edits[j - 1];
      if (prev && (prev.range.end > edit.range.start || (prev.range.start === edit.range.start && prev.range.end === prev.range.start))) ctx.addIssue({ code: 'custom', path: ['files', i, 'edits'], message: '修改范围不得重叠' });
    });
    if (file.expectedVersion === null && (value.scope === 'selection' || edits.length !== 1 || edits[0]!.range.start !== 0 || edits[0]!.range.end !== 0)) ctx.addIssue({ code: 'custom', path: ['files', i], message: '新文件只接受报告范围下单个空范围插入' });
  });
});
export type PatchRequest = z.infer<typeof patchRequestSchema>;
export type OperationRecord = { operationId: string; reportId: string; origin: 'source-editor' | 'codex' | 'pdf-editor' | 'external' | 'undo'; state: 'prepared' | 'committed' | 'conflict' | 'recovered'; createdAt: string; beforeVersions: Record<string, string | null>; afterVersions: Record<string, string>; diffSummary: string };
export type HistoryPage = { operations: OperationRecord[]; nextCursor?: string };
export type UndoRequest = { reportId: string; operationId: string; expectedCurrentVersions: Record<string, string>; undoOperationId: string };
export type DraftSave = { reportId: string; contextId: string; relativePath: string; baseVersion: string; text: string; operationId: string };
export type BuildRecord = { reportId: string; buildId: string; reportRevision: string; status: 'queued' | 'snapshotting' | 'running' | 'succeeded' | 'failed' | 'cancelled'; startedAt?: string; finishedAt?: string; inputVersions: Record<string, string>; pdfAssetId?: string; synctexAssetId?: string; diagnostics: Diagnostic[] };
export type BuildAsset = { assetId: string; kind: 'pdf' | 'synctex'; fileName: string; bytes: number; sha256: string };
export type BuildManifest = BuildRecord & { protocolVersion: number; inputPaths: Record<string, string>; assets: Record<string, BuildAsset>; detail?: string; currentSuccessfulBuildId?: string };
export type PdfLocateRequest = { reportId: string; buildId: string; page: number; point: Point; selectedText?: string };
export type SourceLocateRequest = { reportId: string; buildId: string; relativePath: string; line: number; column?: number };
export type LocateResult = { confidence: 'exact' | 'nearby' | 'ambiguous' | 'unmapped'; candidates: SourceTarget[]; diagnostics: Diagnostic[] };
export type PdfLocation = { page: number; rect: Rect };
export type AssetRequest = { reportId: string; buildId: string; assetId: string; offset: number; maxBytes: number };
export type AssetChunk = { bytesBase64: string; nextOffset: number | null; totalBytes: number };

export type TextProjectionRun = { runId: string; kind: 'editable' | 'protected'; text: string; sourceRange: TextRange; protectedTokenId?: string };
export type TextProjection = { sourceRange: TextRange; fileVersion: string; projectionVersion: string; runs: TextProjectionRun[]; reversible: boolean; diagnostics: Diagnostic[] };
export type PdfEditSession = { editSessionId: string; selectionId: string; reportId: string; contextId: string; viewId: string; buildId: string; relativePath: string; baseFileVersion: string; projectionVersion: string; sourceRange: TextRange; runs: TextProjectionRun[]; placement: { page: number; rects: Rect[] }; status: 'editing' | 'saving' | 'saved-awaiting-build' | 'conflict' | 'cancelled' };
export const pdfEditCommitSchema = z.object({ editSessionId: idSchema, contextId: idSchema, operationId: idSchema, expectedFileVersion: hashSchema, projectionVersion: hashSchema,
  changes: z.array(z.object({ runId: idSchema, text: z.string().max(2_097_152) }).strict()).max(256)
}).strict().refine(v => new Set(v.changes.map(c => c.runId)).size === v.changes.length, '每个文字 run 只能提交一次');
export type PdfEditCommit = z.infer<typeof pdfEditCommitSchema>;
export type PdfEditOpen = PdfLocateRequest & { contextId: string; viewId: string };
export type PdfEditResult = { operation: OperationRecord | null; buildId: string | null; unchanged: boolean };
export type RegionRequest = { reportId: string; buildId: string; regions: PdfLocation[] };
export type ExportRequest = { reportId: string; buildId?: string; format: 'pdf' | 'web-pdf' | 'source-zip' | 'latex-zip'; operationId: string };
export type ExportResult = { relativePath: string; reportRevision: string; buildId?: string };
export type CleanupResult = { removed: string[]; retained: string[]; diagnostics: Diagnostic[] };
export type WorkspaceEvent = { workspaceId: string; reportId: string; sequence: number; kind: 'files-changed' | 'outline-changed' | 'build-changed' | 'selection-changed' | 'operation-committed'; operationId?: string; buildId?: string };
export type HostCapabilities = { threadPanel: boolean; updateModelContext: boolean; sendMessage: boolean; assetTransport: 'bridge' | 'loopback' | 'copy-only' };
export type FeatureStatus = { id: string; title: string; milestone: 'M0' | 'M1' | 'M2' | 'M3' | 'M4'; status: 'implemented' | 'defined' | 'unverified'; detail: string };

const reportIdInput = z.object({ reportId: idSchema }).strict();
const htmlTargetInput = reportIdInput.extend({ contextId: idSchema, viewId: idSchema, expectedVersion: hashSchema, blockId: z.string().min(1).max(80) }).strict();
export const toolInputs = {
  probe_echo: z.object({ nonce: z.string().min(1).max(200) }).strict(),
  workspace_status: z.object({}).strict(),
  workbench_open: z.object({ reportId: idSchema.optional() }).strict(),
  report_list: z.object({}).strict(),
  report_create: z.object({ title: z.string().trim().min(1).max(200), templateId: z.string().min(1), operationId: idSchema }).strict(),
  report_import: z.object({ rootRelativePath: relativePathSchema, mainFile: relativePathSchema, generatedFrom: relativePathSchema.optional(), operationId: idSchema }).strict(),
  report_open: reportIdInput,
  report_tree: reportIdInput.extend({ kind: z.enum(['files', 'outline']) }).strict(),
  report_read: reportIdInput.extend({ relativePath: relativePathSchema, range: textRangeSchema.optional() }).strict(),
  report_preview: reportIdInput,
  html_select: htmlTargetInput,
  html_edit: htmlTargetInput.extend({ text: z.string().max(100_000).optional(), changes: z.array(z.object({ runId: z.string().min(1).max(80), text: z.string().max(100_000) }).strict()).min(1).max(256).optional(), formula: z.string().max(12_000).optional(), operationId: idSchema }).strict().refine(value => [value.text, value.changes, value.formula].filter(value => value !== undefined).length === 1, '提交文字、文本节点或公式其中一种修改'),
  report_context_get: z.object({ contextId: idSchema, selectionId: idSchema.optional() }).strict(),
  report_apply_patch: patchRequestSchema,
  report_compile: reportIdInput.extend({ force: z.boolean().optional() }).strict(),
  report_build_status: reportIdInput.extend({ buildId: idSchema.optional() }).strict(),
  report_locate_pdf: reportIdInput.extend({ buildId: idSchema, page: z.int().positive(), point: pointSchema, selectedText: z.string().max(100_000).optional() }).strict(),
  report_locate_source: reportIdInput.extend({ buildId: idSchema, relativePath: relativePathSchema, line: z.int().positive(), column: z.int().min(0).optional() }).strict(),
  report_history: reportIdInput.extend({ cursor: z.string().optional(), limit: z.int().min(1).max(100).default(20) }).strict(),
  report_undo: reportIdInput.extend({ operationId: idSchema, expectedCurrentVersions: z.record(relativePathSchema, hashSchema), undoOperationId: idSchema }).strict(),
  report_export: reportIdInput.extend({ buildId: idSchema.optional(), format: z.enum(['pdf', 'web-pdf', 'source-zip', 'latex-zip']), operationId: idSchema }).strict(),
  context_bind: z.object({ workspaceId: idSchema, reportId: idSchema, viewId: idSchema }).strict(),
  selection_set: selectionInputSchema,
  selection_clear: z.object({ contextId: idSchema }).strict(),
  draft_save: reportIdInput.extend({ contextId: idSchema, relativePath: relativePathSchema, baseVersion: hashSchema, text: z.string().max(2_097_152), operationId: idSchema }).strict(),
  workspace_asset_read: reportIdInput.extend({ buildId: idSchema, assetId: idSchema, offset: z.int().min(0), maxBytes: z.int().min(1).max(262_144) }).strict(),
  session_keepalive: z.object({ contextId: idSchema, viewId: idSchema }).strict(),
  pdf_edit_open: reportIdInput.extend({ contextId: idSchema, viewId: idSchema, buildId: idSchema, page: z.int().positive(), point: pointSchema }).strict(),
  pdf_edit_commit: pdfEditCommitSchema,
  pdf_edit_cancel: z.object({ editSessionId: idSchema, contextId: idSchema }).strict(),
  objects_resolve_region: reportIdInput.extend({ buildId: idSchema, regions: z.array(pdfRegionSchema).min(1).max(16) }).strict(),
  objects_attach_image: reportIdInput.extend({ selectionId: idSchema }).strict(),
} as const;
export type ToolName = keyof typeof toolInputs;
export type ToolArguments<N extends ToolName> = z.input<(typeof toolInputs)[N]>;

export interface ToolResults {
  probe_echo: { nonce: string; workspaceId: string; protocolVersion: number };
  workspace_status: { workspaceId: string; root: string; protocolVersion: number; features: FeatureStatus[] };
  workbench_open: { workspaceId: string; report: ReportRecord | null; features: FeatureStatus[] };
  report_list: { reports: ReportRecord[] };
  report_create: { report: ReportRecord }; report_import: { report: ReportRecord }; report_open: { report: ReportRecord };
  report_tree: { kind: 'files'; nodes: FileTreeNode[] } | { kind: 'outline'; nodes: OutlineNode[]; diagnostics: Diagnostic[] };
  report_read: FileReadResult; report_context_get: { selection: SelectionRecord | null };
  report_preview: HtmlPreview;
  html_select: { selection: SelectionRecord };
  html_edit: { operation: OperationRecord; buildId: null };
  report_apply_patch: { operation: OperationRecord; buildId: string | null };
  report_compile: { buildId: string }; report_build_status: { build: BuildManifest };
  report_locate_pdf: LocateResult; report_locate_source: { locations: PdfLocation[] };
  report_history: HistoryPage; report_undo: { operation: OperationRecord }; report_export: ExportResult;
  context_bind: { contextId: string }; selection_set: { selection: SelectionRecord };
  selection_clear: { cleared: true }; draft_save: { operation: OperationRecord; buildId: string | null };
  workspace_asset_read: AssetChunk; session_keepalive: { expiresAt: string };
  pdf_edit_open: { session: PdfEditSession }; pdf_edit_commit: PdfEditResult; pdf_edit_cancel: { cancelled: true };
  objects_resolve_region: LocateResult; objects_attach_image: { attached: boolean; reason?: string };
}

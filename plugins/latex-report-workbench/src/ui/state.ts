import type { BuildAsset, BuildManifest, PdfEditCommit, PdfEditSession, SelectionRecord, TextProjectionRun } from '../shared/contracts.js';

/** Draft text of every editable run, keyed by runId. Protected runs are never drafted. */
export type EditDraft = Record<string, string>;

export function canUsePdfLocation(displayedIdentity: string, requestedIdentity: string, loading: boolean, error: string): boolean {
  return Boolean(displayedIdentity) && displayedIdentity === requestedIdentity && !loading && !error;
}
type RefreshIdentity = { reportId: string; path: string; version: string; text: string };
export function canApplyFileRefresh(captured: RefreshIdentity, current: RefreshIdentity & { saveState: string }): boolean {
  return current.saveState === 'clean' && captured.reportId === current.reportId && captured.path === current.path && captured.version === current.version && captured.text === current.text;
}

export function editableRuns(session: PdfEditSession | null): TextProjectionRun[] {
  return session ? session.runs.filter(run => run.kind === 'editable') : [];
}

export function protectedRuns(session: PdfEditSession | null): TextProjectionRun[] {
  return session ? session.runs.filter(run => run.kind === 'protected') : [];
}

/** Seeds the editor with the current source text of every editable run. */
export function initialEditDraft(session: PdfEditSession): EditDraft {
  const draft: EditDraft = {};
  for (const run of session.runs) if (run.kind === 'editable') draft[run.runId] = run.text;
  return draft;
}

/**
 * Builds the commit payload. Only editable runs whose text actually changed are sent, and the
 * server re-validates every run id, so a stale overlay can never invent source offsets.
 */
export function changedRuns(session: PdfEditSession, draft: EditDraft): PdfEditCommit['changes'] {
  const changes: PdfEditCommit['changes'] = [];
  for (const run of session.runs) {
    if (run.kind !== 'editable') continue;
    const text = draft[run.runId] ?? run.text;
    if (text !== run.text) changes.push({ runId: run.runId, text });
  }
  return changes;
}

export function isEditDraftDirty(session: PdfEditSession | null, draft: EditDraft): boolean {
  return Boolean(session && changedRuns(session, draft).length > 0);
}

export function newOperationId(): string {
  return crypto.randomUUID();
}

export function pdfAssetOf(build: BuildManifest | null): BuildAsset | null {
  if (!build?.pdfAssetId) return null;
  return build.assets[build.pdfAssetId] ?? null;
}

export function synctexAssetOf(build: BuildManifest | null): BuildAsset | null {
  if (!build?.synctexAssetId) return null;
  return build.assets[build.synctexAssetId] ?? null;
}

const BUILD_LABEL: Record<BuildManifest['status'], string> = {
  queued: '排队中',
  snapshotting: '冻结输入',
  running: '正在编译',
  succeeded: '预览已更新',
  failed: '编译失败',
  cancelled: '已取消',
};

export function buildLabel(build: BuildManifest | null): string {
  if (!build) return '尚无构建';
  return `${BUILD_LABEL[build.status]} · ${build.buildId.slice(0, 8)}`;
}

/** A build that still occupies the queue; the panel keeps polling while this is true. */
export function buildActive(build: BuildManifest | null): boolean {
  return build !== null && (build.status === 'queued' || build.status === 'snapshotting' || build.status === 'running');
}

/**
 * After a PDF text commit the session waits for a rebuild. The overlay may close only once a
 * *different* successful build exists, never when the old PDF is still the newest success.
 */
export function awaitingRebuild(session: PdfEditSession | null, build: BuildManifest | null): boolean {
  if (!session || session.status !== 'saved-awaiting-build') return false;
  return !(build?.status === 'succeeded' && build.buildId !== session.buildId);
}

export function selectionHeadline(selection: SelectionRecord | null): string {
  if (!selection) return '没有修改对象';
  const target = selection.targets[0];
  const where = target ? `${target.relativePath}` : selection.pdfRegion ? `第 ${selection.pdfRegion.page} 页区域` : '报告';
  const text = selection.selectedText.replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${where}：${text || '（空选区）'}`;
}

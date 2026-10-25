import { useCallback, useEffect, useRef, useState } from 'react';
import { claimViewIdentity, type ViewIdentity } from './view-identity.js';
import type {
  BuildManifest, Diagnostic, FeatureStatus, FileSnapshot, FileTreeNode, OperationRecord,
  OutlineNode, Point, ReportRecord, SelectionContext, SelectionRecord, TextRange, PdfLocation, SourceTarget,
} from '../shared/contracts.js';
import { WorkbenchError, toErrorEnvelope } from '../shared/errors.js';
import { ToolCallError, type ToolClient } from './api.js';
import { ReportPicker } from './ReportPicker.js';
import { NavigationTree, OutlineTree } from './NavigationTree.js';
import { SourceEditor, type SaveState } from './SourceEditor.js';
import { PdfPreview } from './PdfPreview.js';
import { HtmlPreview } from './HtmlPreview.js';
import { isHtmlReport } from '../shared/html-report.js';
import { SelectionBar } from './SelectionBar.js';
import { HistoryPanel } from './HistoryPanel.js';
import { CodexRequestPanel } from './CodexRequestPanel.js';
import { CodexTerminal } from './CodexTerminal.js';
import { PanelDivider } from './PanelDivider.js';
import { sameSelectionRequest, type SelectionRequestIdentity } from './chat-request.js';
import type { PdfEditOverlayStatus, PdfTextEditorOverlayProps } from './PdfTextEditorOverlay.js';
import {
  awaitingRebuild, buildActive, buildLabel, changedRuns, initialEditDraft, isEditDraftDirty, canApplyFileRefresh,
  newOperationId, selectionHeadline, type EditDraft,
} from './state.js';

const AUTOSAVE_DELAY_MS = 800;
const SELECTION_DELAY_MS = 150;
const ACTIVE_POLL_MS = 1_000;
const IDLE_POLL_MS = 5_000;

type PdfEditUi = { session: PdfTextEditorOverlayProps['session']; draft: EditDraft; status: PdfEditOverlayStatus; message: string; savedVersion?: string };

function errorMessage(error: unknown): string {
  if (error instanceof ToolCallError) return error.message;
  if (error instanceof WorkbenchError) return error.message;
  return toErrorEnvelope(error).message;
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof ToolCallError) return error.envelope?.code;
  return toErrorEnvelope(error).code;
}

export function Workbench({ client, mode }: { client: ToolClient; mode: 'local' | 'desktop' }) {
  const [viewId, setViewId] = useState('');
  useEffect(() => {
    let active = true; let identity: ViewIdentity | undefined;
    void claimViewIdentity(sessionStorage, navigator.locks ? (name, work) => navigator.locks.request(name, { ifAvailable: true }, lock => work(Boolean(lock))) : undefined)
      .then(claim => { identity = claim; if (active) setViewId(claim.viewId); else void claim.release(); });
    return () => { active = false; void identity?.release(); };
  }, []);
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [features, setFeatures] = useState<FeatureStatus[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [reportId, setReportId] = useState('');
  const [contextId, setContextId] = useState('');
  const [nodes, setNodes] = useState<FileTreeNode[]>([]);
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [outlineDiagnostics, setOutlineDiagnostics] = useState<Diagnostic[]>([]);
  const [treeTab, setTreeTab] = useState<'outline' | 'files'>('outline');
  const [activeOutlineId, setActiveOutlineId] = useState('');
  const [file, setFile] = useState<FileSnapshot | null>(null);
  const [draft, setDraft] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('clean');
  const [revealRange, setRevealRange] = useState<TextRange | null>(null);
  const [selection, setSelection] = useState<SelectionRecord | null>(null);
  const [selectionPending, setSelectionPending] = useState(false);
  const [selectionFailed, setSelectionFailed] = useState(false);
  const [build, setBuild] = useState<BuildManifest | null>(null);
  const [previewBuild, setPreviewBuild] = useState<BuildManifest | null>(null);
  const [operations, setOperations] = useState<OperationRecord[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | undefined>(undefined);
  const [editMode, setEditMode] = useState(false);
  const [panel, setPanel] = useState<'none' | 'navigation' | 'source' | 'codex'>('none');
  const readingBody = useRef<HTMLDivElement>(null);
  const [pdfEdit, setPdfEdit] = useState<PdfEditUi | null>(null);
  const [regionCandidates, setRegionCandidates] = useState<{ region: PdfLocation; targets: SourceTarget[]; buildId: string; request: SelectionRequestIdentity } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(true);
  const [buildBusy, setBuildBusy] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [htmlRefreshKey, setHtmlRefreshKey] = useState(0);
  const [htmlEditing, setHtmlEditing] = useState(false);
  const report = reports.find(item => item.reportId === reportId) ?? null;
  const htmlMode = isHtmlReport(report?.mainFile ?? '');
  const htmlChanged = useCallback(() => setHtmlRefreshKey(value => value + 1), []);
  const htmlEditingChanged = useCallback((value: boolean) => setHtmlEditing(value), []);

  const generation = useRef(0);
  const sequence = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSelection = useRef<{ range: TextRange; request: SelectionRequestIdentity } | null>(null);
  const selectionSequence = useRef(0);
  const draftRef = useRef<{ text: string; version: string; path: string } | null>(null);
  const saving = useRef<Promise<boolean> | null>(null);
  const historyCursorRef = useRef(historyCursor);
  historyCursorRef.current = historyCursor;
  const stateRef = useRef({ reportId: '', contextId: '', viewId, saveState: 'clean' as SaveState });
  stateRef.current = { reportId, contextId, viewId, saveState };

  const beginSelection = useCallback((): SelectionRequestIdentity => {
    setSelectionPending(true); setSelectionFailed(false); setRegionCandidates(null);
    return { sequence: ++selectionSequence.current, reportId: stateRef.current.reportId, contextId: stateRef.current.contextId };
  }, []);
  const isCurrentSelection = useCallback((request: SelectionRequestIdentity) => sameSelectionRequest(request, { sequence: selectionSequence.current, reportId: stateRef.current.reportId, contextId: stateRef.current.contextId }), []);
  const finishSelection = useCallback((request: SelectionRequestIdentity, failed: boolean) => {
    if (!isCurrentSelection(request)) return;
    setSelectionPending(false); setSelectionFailed(failed);
  }, [isCurrentSelection]);

  const refreshHistory = useCallback(async (id: string, append = false) => {
    try {
      const cursor = historyCursorRef.current;
      const page = await client.call('report_history', { reportId: id, ...(append && cursor ? { cursor } : {}) });
      if (stateRef.current.reportId !== id) return;
      setOperations(previous => append ? [...previous, ...page.operations] : page.operations);
      setHistoryCursor(page.nextCursor);
    } catch { /* history is a convenience view; a failed page must not break editing */ }
  }, [client]);

  const refreshBuild = useCallback(async (id: string, throwOnError = false) => {
    try {
      const { build: manifest } = await client.call('report_build_status', { reportId: id });
      if (stateRef.current.reportId !== id) return null;
      setBuild(manifest);
      if (manifest.status === 'succeeded') setPreviewBuild(manifest);
      else if (manifest.currentSuccessfulBuildId) {
        const { build: successful } = await client.call('report_build_status', { reportId: id, buildId: manifest.currentSuccessfulBuildId });
        if (stateRef.current.reportId === id) setPreviewBuild(successful);
      }
      return manifest;
    } catch (failure) {
      if (stateRef.current.reportId === id && errorCode(failure) === 'INVALID_INPUT') setBuild(null);
      if (throwOnError) throw failure;
      return null;
    }
  }, [client]);

  const refreshTrees = useCallback(async (id: string) => {
    const [tree, outlineResult] = await Promise.all([
      client.call('report_tree', { reportId: id, kind: 'files' }),
      client.call('report_tree', { reportId: id, kind: 'outline' }),
    ]);
    if (stateRef.current.reportId !== id) return;
    if (tree.kind === 'files') setNodes(tree.nodes);
    if (outlineResult.kind === 'outline') { setOutline(outlineResult.nodes); setOutlineDiagnostics(outlineResult.diagnostics); }
  }, [client]);

  // Initial load: resolve the workspace identity and the report list.
  useEffect(() => {
    let active = true;
    void Promise.all([client.call('report_list', {}), client.call('workspace_status', {})])
      .then(([list, status]) => {
        if (!active) return;
        setReports(list.reports);
        setFeatures(status.features);
        setWorkspaceId(status.workspaceId);
        const previous = localStorage.getItem(`latex-last-report:${status.workspaceId}`);
        setReportId(current => current || list.reports.find(report => report.reportId === previous)?.reportId || list.reports[0]?.reportId || '');
      })
      .catch(failure => { if (active) setError(errorMessage(failure)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [client]);

  useEffect(() => { if (reportId && workspaceId) localStorage.setItem(`latex-last-report:${workspaceId}`, reportId); }, [reportId, workspaceId]);

  // Binding a report creates one server-side context for this panel instance. Switching reports
  // clears the selection and the editor instead of reusing the previous object.
  useEffect(() => {
    if (!reportId || !workspaceId || !viewId) return;
    const current = ++generation.current;
    setBusy(true); setError(''); setNotice('');
    setFile(null); setDraft(''); setSaveState('clean'); setRevealRange(null);
    setHtmlEditing(false);
    draftRef.current = null;
    setContextId(''); setBuild(null); setPreviewBuild(null);
    setSelection(null); setPdfEdit(null); setEditMode(false); setOperations([]); setHistoryCursor(undefined);
    selectionSequence.current += 1;
    setSelectionPending(false); setSelectionFailed(false); setRegionCandidates(null); pendingSelection.current = null;
    if (selectionTimer.current) { clearTimeout(selectionTimer.current); selectionTimer.current = null; }
    void (async () => {
      try {
        const bound = await client.call('context_bind', { workspaceId, reportId, viewId });
        if (current !== generation.current) return;
        setContextId(bound.contextId);
        try {
          const stored = JSON.parse(sessionStorage.getItem(`latex-pdf-draft:${reportId}`) ?? 'null') as PdfEditUi | null;
          if (stored?.session.reportId === reportId) { setPdfEdit(stored); setEditMode(true); setNotice('已恢复此标签页的原位改字草稿；保存时会重新校验源码版本。'); }
        } catch { /* storage unavailable or corrupt */ }
        await refreshTrees(reportId);
        if (current !== generation.current) return;
        await refreshHistory(reportId);
        await refreshBuild(reportId);
      } catch (failure) {
        if (current === generation.current) setError(errorMessage(failure));
      } finally {
        if (current === generation.current) setBusy(false);
      }
    })();
  }, [client, reportId, workspaceId, viewId, refreshTrees, refreshHistory, refreshBuild]);

  // Publish automatically only when the MCP host supports it. The local browser's request
  // panel prepares a native annotation explicitly on the user's click instead.
  useEffect(() => {
    if (!client.updateSelectionContext || !contextId) return;
    const report = reports.find(item => item.reportId === reportId);
    const context: SelectionContext | null = selection
      ? {
          workspaceId, reportId, contextId, selectionId: selection.selectionId,
          title: report?.title ?? '', kind: selection.kind,
          summary: selectionHeadline(selection), status: selection.validity,
        }
      : null;
    void client.updateSelectionContext(context).catch(failure => setError(errorMessage(failure)));
  }, [client, contextId, reports, reportId, selection, workspaceId]);

  const publishSelection = useCallback(async (range: TextRange, expectedVersion: string, path: string, request: SelectionRequestIdentity) => {
    const { contextId: boundContext, reportId: boundReport, viewId: boundView } = stateRef.current;
    if (!boundContext || !boundReport || !isCurrentSelection(request)) return;
    try {
      const { selection: record } = await client.call('selection_set', {
        reportId: boundReport, contextId: boundContext, viewId: boundView, kind: 'source',
        candidateTargets: [{ relativePath: path, range, expectedVersion }],
      });
      if (!isCurrentSelection(request)) return;
      setSelection(record); finishSelection(request, false);
      setError('');
    } catch (failure) {
      if (isCurrentSelection(request)) { setError(errorMessage(failure)); finishSelection(request, true); }
    }
  }, [client, finishSelection, isCurrentSelection]);

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (saving.current) return saving.current;
    const work = (async () => {
    const pending = draftRef.current;
    const { reportId: boundReport, contextId: boundContext } = stateRef.current;
    if (!pending || !boundReport || !boundContext || stateRef.current.saveState === 'clean') return true;
    setSaveState('saving');
    try {
      const result = await client.call('draft_save', {
        reportId: boundReport, contextId: boundContext, relativePath: pending.path,
        baseVersion: pending.version, text: pending.text, operationId: newOperationId(),
      });
      const nextVersion = result.operation.afterVersions[pending.path] ?? pending.version;
      const latest = draftRef.current;
      if (stateRef.current.reportId !== boundReport || latest?.path !== pending.path) return true;
      draftRef.current = { ...latest, version: nextVersion };
      setFile(current => current && current.relativePath === pending.path ? { ...current, text: pending.text, fileVersion: nextVersion } : current);
      setSaveState(latest.text === pending.text ? 'clean' : 'dirty');
      if (latest.text === pending.text) { try { sessionStorage.removeItem(`latex-draft:${boundReport}:${pending.path}`); } catch { /* storage unavailable */ } }
      if (latest.text !== pending.text) saveTimer.current = setTimeout(() => { void saveNow(); }, AUTOSAVE_DELAY_MS);
      void refreshHistory(boundReport);
      if (result.buildId) void refreshBuild(boundReport);
      const queued = pendingSelection.current;
      pendingSelection.current = null;
      if (queued) await publishSelection(queued.range, nextVersion, pending.path, queued.request);
      return true;
    } catch (failure) {
      setSaveState(errorCode(failure) === 'FILE_VERSION_CONFLICT' ? 'conflict' : 'error');
      setError(errorMessage(failure));
      return false;
    }
    })();
    saving.current = work;
    try { return await work; } finally { saving.current = null; }
  }, [client, publishSelection, refreshBuild, refreshHistory]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { saveTimer.current = null; void saveNow(); }, AUTOSAVE_DELAY_MS);
  }, [saveNow]);

  const openFile = useCallback(async (relativePath: string, reveal: TextRange | null = null, reload = false) => {
    const { reportId: boundReport } = stateRef.current;
    if (!boundReport) return;
    if (!reload && draftRef.current && !await saveNow()) return;
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    setBusy(true); setError('');
    try {
      const snapshot = await client.call('report_read', { reportId: boundReport, relativePath });
      if (stateRef.current.reportId !== boundReport) return;
      setFile(snapshot); setDraft(snapshot.text); setSaveState('clean'); setRevealRange(reveal);
      draftRef.current = { text: snapshot.text, version: snapshot.fileVersion, path: snapshot.relativePath };
      if (!reload) {
        try {
          const stored = JSON.parse(sessionStorage.getItem(`latex-draft:${boundReport}:${relativePath}`) ?? 'null') as { text: string; version: string } | null;
          if (stored && stored.text !== snapshot.text) {
            draftRef.current = { ...draftRef.current, text: stored.text, version: stored.version };
            setDraft(stored.text); setSaveState(stored.version === snapshot.fileVersion ? 'dirty' : 'conflict');
            setNotice('已恢复此浏览器标签页的源码草稿；可保存，或重新载入磁盘版本。');
          }
        } catch { /* storage unavailable or invalid */ }
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }, [client, saveNow]);

  const onDraftChange = useCallback((text: string) => {
    const current = draftRef.current;
    if (!current) return;
    draftRef.current = { ...current, text };
    try { sessionStorage.setItem(`latex-draft:${stateRef.current.reportId}:${current.path}`, JSON.stringify(draftRef.current)); } catch { /* storage unavailable */ }
    setDraft(text); setSaveState('dirty');
    scheduleSave();
  }, [scheduleSave]);

  const onSourceSelectionChange = useCallback((range: TextRange) => {
    if (!file || range.end <= range.start) return;
    const request = beginSelection();
    if (selectionTimer.current) clearTimeout(selectionTimer.current);
    selectionTimer.current = setTimeout(() => {
      selectionTimer.current = null;
      const current = draftRef.current;
      if (!current || !isCurrentSelection(request)) { finishSelection(request, true); return; }
      if (stateRef.current.saveState !== 'clean') { pendingSelection.current = { range, request }; void saveNow(); return; }
      void publishSelection(range, current.version, current.path, request);
    }, SELECTION_DELAY_MS);
  }, [beginSelection, file, finishSelection, isCurrentSelection, publishSelection, saveNow]);

  const selectChapter = useCallback(async (node: OutlineNode) => {
    const { reportId: boundReport, contextId: boundContext, viewId: boundView } = stateRef.current;
    if (!boundReport || !boundContext) return;
    const request = beginSelection();
    setActiveOutlineId(node.nodeId);
    try {
      const snapshot = node.relativePath === file?.relativePath && saveState === 'clean'
        ? file
        : await client.call('report_read', { reportId: boundReport, relativePath: node.relativePath });
      if (!isCurrentSelection(request)) return;
      const spans = node.bodySpans.length
        ? node.bodySpans.map(span => ({
            relativePath: span.relativePath,
            range: span.range,
            expectedVersion: span.relativePath === node.relativePath ? snapshot.fileVersion : span.fileVersion,
          }))
        : [{ relativePath: node.relativePath, range: node.headingRange, expectedVersion: snapshot.fileVersion }];
      const { selection: record } = await client.call('selection_set', {
        reportId: boundReport, contextId: boundContext, viewId: boundView, kind: 'chapter',
        candidateTargets: spans, selectedText: node.bodySpans.map(span => span.exactText).join('\n') || node.title,
      });
      if (!isCurrentSelection(request)) return;
      setSelection(record); setError(''); finishSelection(request, false);
      await openFile(node.relativePath, node.headingRange);
    } catch (failure) {
      if (isCurrentSelection(request)) { setError(errorMessage(failure)); finishSelection(request, true); }
    }
  }, [beginSelection, client, file, finishSelection, isCurrentSelection, openFile, saveState]);

  const locateText = useCallback(async (input: { page: number; point: Point; selectedText: string }) => {
    const { reportId: boundReport, contextId: boundContext, viewId: boundView } = stateRef.current;
    if (!boundReport || !boundContext || !previewBuild) return;
    const request = beginSelection();
    try {
      const located = await client.call('report_locate_pdf', { reportId: boundReport, buildId: previewBuild.buildId, ...input });
      if (!isCurrentSelection(request)) return;
      if (located.candidates.length === 0) { setError('这段文字没有映射到源码；可以改用章节或源码选择。'); finishSelection(request, true); return; }
      if (located.confidence !== 'exact' || located.candidates.length !== 1) {
        setPanel('source');
        const first = located.candidates[0]!;
        setNotice('定位存在邻近或多个候选，请在源码中核对并重新选择。');
        finishSelection(request, true);
        await openFile(first.relativePath, first.range); return;
      }
      const { selection: record } = await client.call('selection_set', {
        reportId: boundReport, contextId: boundContext, viewId: boundView, kind: 'pdf-text',
        buildId: previewBuild.buildId,
        candidateTargets: located.candidates.map(candidate => ({ relativePath: candidate.relativePath, range: candidate.range, expectedVersion: candidate.fileVersion })),
        selectedText: input.selectedText,
      });
      if (!isCurrentSelection(request)) return;
      setSelection(record); setError(''); finishSelection(request, false);
      const first = located.candidates[0]!;
      setNotice(located.confidence === 'exact' ? '' : `选区来自${located.confidence === 'nearby' ? '邻近候选' : located.confidence}，请核对源码范围。`);
      await openFile(first.relativePath, first.range);
    } catch (failure) {
      if (isCurrentSelection(request)) { setError(errorMessage(failure)); finishSelection(request, true); }
    }
  }, [beginSelection, finishSelection, isCurrentSelection, previewBuild, client, openFile]);

  const openPdfEdit = useCallback(async (input: { page: number; point: Point }) => {
    const { reportId: boundReport, contextId: boundContext, viewId: boundView } = stateRef.current;
    if (!boundReport || !boundContext || !previewBuild) return;
    if (pdfEdit && isEditDraftDirty(pdfEdit.session, pdfEdit.draft) && pdfEdit.status !== 'saved') { setNotice('先保存或取消当前原位改字草稿，再编辑另一段。'); return; }
    try {
      const { session } = await client.call('pdf_edit_open', {
        reportId: boundReport, contextId: boundContext, viewId: boundView, buildId: previewBuild.buildId, ...input,
      });
      setPdfEdit({ session, draft: initialEditDraft(session), status: 'editing', message: '' });
      setError('');
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [previewBuild, client, pdfEdit]);

  const commitPdfEdit = useCallback(async () => {
    if (!pdfEdit) return;
    const changes = changedRuns(pdfEdit.session, pdfEdit.draft);
    if (changes.length === 0) { setPdfEdit({ ...pdfEdit, status: 'editing', message: '没有实际改动。' }); return; }
    setPdfEdit({ ...pdfEdit, status: 'saving', message: '' });
    try {
      const result = await client.call('pdf_edit_commit', {
        editSessionId: pdfEdit.session.editSessionId, contextId: pdfEdit.session.contextId,
        operationId: newOperationId(), expectedFileVersion: pdfEdit.session.baseFileVersion,
        projectionVersion: pdfEdit.session.projectionVersion, changes,
      });
      setPdfEdit({
        ...pdfEdit,
        session: { ...pdfEdit.session, status: 'saved-awaiting-build' },
        status: 'saved',
        message: result.unchanged ? '内容没有变化，未生成新构建。' : '已写回源码，正在重新编译…',
        ...(result.operation ? { savedVersion: result.operation.afterVersions[pdfEdit.session.relativePath] } : {}),
      });
      if (result.buildId) void refreshBuild(pdfEdit.session.reportId);
      void refreshHistory(pdfEdit.session.reportId);
    } catch (failure) {
      const code = errorCode(failure);
      setPdfEdit({ ...pdfEdit, status: code === 'FILE_VERSION_CONFLICT' || code === 'PDF_EDIT_SESSION_STALE' ? 'conflict' : 'error', message: errorMessage(failure) });
    }
  }, [client, pdfEdit, refreshBuild, refreshHistory]);

  const cancelPdfEdit = useCallback(async () => {
    if (!pdfEdit) return;
    const session = pdfEdit.session;
    try { sessionStorage.removeItem(`latex-pdf-draft:${session.reportId}`); } catch { /* storage unavailable */ }
    setPdfEdit(null);
    await client.call('pdf_edit_cancel', { editSessionId: session.editSessionId, contextId: session.contextId }).catch(() => undefined);
  }, [client, pdfEdit]);

  const resolveRegion = useCallback(async (region: PdfLocation) => {
    if (!previewBuild || !reportId) return;
    const request = beginSelection();
    const result = await client.call('objects_resolve_region', { reportId, buildId: previewBuild.buildId, regions: [region] }).catch(failure => { if (isCurrentSelection(request)) { setError(errorMessage(failure)); finishSelection(request, true); } return null; });
    if (!result || !isCurrentSelection(request)) return;
    setRegionCandidates({ region, targets: result.candidates, buildId: previewBuild.buildId, request });
    if (!result.candidates.length) { setNotice('框选没有唯一源码对象，请打开附近章节或在源码中选择。'); finishSelection(request, true); }
  }, [beginSelection, client, finishSelection, isCurrentSelection, previewBuild, reportId]);

  const confirmRegion = useCallback(async (target: SourceTarget) => {
    if (!regionCandidates || !contextId || !isCurrentSelection(regionCandidates.request)) return;
    const request = regionCandidates.request;
    try {
      const result = await client.call('selection_set', { reportId, contextId, viewId, kind: 'pdf-region', buildId: regionCandidates.buildId, pdfRegion: regionCandidates.region, candidateTargets: [{ relativePath: target.relativePath, range: target.range, expectedVersion: target.fileVersion }] });
      if (!isCurrentSelection(request)) return;
      setSelection(result.selection); setRegionCandidates(null); finishSelection(request, false);
      await openFile(target.relativePath, target.range);
    } catch (failure) { if (isCurrentSelection(request)) { setError(errorMessage(failure)); finishSelection(request, true); } }
  }, [client, contextId, finishSelection, isCurrentSelection, openFile, regionCandidates, reportId, viewId]);

  const clearSelection = useCallback(async () => {
    const { contextId: boundContext } = stateRef.current;
    if (!boundContext) return;
    const request = beginSelection();
    try { await client.call('selection_clear', { contextId: boundContext }); } catch { /* clearing stays local even if the record is gone */ }
    if (isCurrentSelection(request)) { setSelection(null); setRegionCandidates(null); finishSelection(request, false); }
  }, [beginSelection, client, finishSelection, isCurrentSelection]);

  const pickHtmlBlock = useCallback(async (blockId: string, expectedVersion: string) => {
    const bound = stateRef.current;
    if (!bound.contextId || bound.saveState !== 'clean') return;
    const request = beginSelection();
    try {
      const result = await client.call('html_select', { reportId: bound.reportId, contextId: bound.contextId, viewId: bound.viewId, expectedVersion, blockId });
      if (isCurrentSelection(request)) { setSelection(result.selection); setError(''); finishSelection(request, false); }
    } catch (failure) { if (isCurrentSelection(request)) { setError(errorMessage(failure)); finishSelection(request, true); } }
  }, [client, beginSelection, finishSelection, isCurrentSelection]);

  const showSourceFile = useCallback(async (relativePath: string) => {
    setPanel('source');
    if (report?.generatedFrom === relativePath) await clearSelection();
    await openFile(relativePath);
  }, [report?.generatedFrom, clearSelection, openFile]);

  useEffect(() => {
    if (!contextId) return;
    const timer = setInterval(() => { void client.call('session_keepalive', { contextId, viewId }).catch(() => undefined); }, 30_000);
    return () => clearInterval(timer);
  }, [client, contextId, viewId]);

  const compile = useCallback(async () => {
    const { reportId: boundReport } = stateRef.current;
    if (!boundReport) return;
    setBuildBusy(true); setError('');
    try {
      if (!await saveNow()) return;
      await client.call('report_compile', { reportId: boundReport });
      await refreshBuild(boundReport);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBuildBusy(false);
    }
  }, [client, refreshBuild, saveNow]);

  const undo = useCallback(async (operation: OperationRecord) => {
    const { reportId: boundReport } = stateRef.current;
    if (!boundReport) return;
    setHistoryBusy(true); setError('');
    try {
      const expectedCurrentVersions: Record<string, string> = {};
      for (const [path, version] of Object.entries(operation.afterVersions)) if (version) expectedCurrentVersions[path] = version;
      await client.call('report_undo', { reportId: boundReport, operationId: operation.operationId, expectedCurrentVersions, undoOperationId: newOperationId() });
      await refreshHistory(boundReport);
      if (file) {
        const snapshot = await client.call('report_read', { reportId: boundReport, relativePath: file.relativePath });
        setFile(snapshot); setDraft(snapshot.text); draftRef.current = { text: snapshot.text, version: snapshot.fileVersion, path: snapshot.relativePath };
        setSaveState('clean');
      }
      await refreshBuild(boundReport);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setHistoryBusy(false);
    }
  }, [client, file, refreshBuild, refreshHistory]);

  const exportReport = useCallback(async (format: 'pdf' | 'web-pdf' | 'source-zip' | 'latex-zip') => {
    const { reportId: boundReport } = stateRef.current;
    if (!boundReport) return;
    setBuildBusy(true); setError('');
    try {
      if (!await saveNow()) return;
      const result = await client.call('report_export', {
        reportId: boundReport, format, operationId: newOperationId(),
        ...(format === 'pdf' && previewBuild && !htmlMode ? { buildId: previewBuild.buildId } : {}),
      });
      if (htmlMode) void refreshBuild(boundReport);
      setNotice(`已导出到 ${result.relativePath} · 源码版本 ${result.reportRevision.slice(0, 8)}${pdfEdit && isEditDraftDirty(pdfEdit.session, pdfEdit.draft) && pdfEdit.status !== 'saved' ? '（原位改字草稿尚未保存，没有包含在导出中）' : ''}`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBuildBusy(false);
    }
  }, [previewBuild, client, saveNow, pdfEdit, htmlMode, refreshBuild]);

  const createReport = useCallback(async (title: string, templateId: string) => {
    if (!await saveNow()) return;
    if (htmlEditing) { setNotice('先保存或取消正在修改的网页文字。'); return; }
    if (pdfEdit && pdfEdit.status !== 'saved' && isEditDraftDirty(pdfEdit.session, pdfEdit.draft)) { setNotice('先保存或取消原位改字草稿。'); return; }
    setBusy(true); setError('');
    try {
      const { report } = await client.call('report_create', { title, templateId, operationId: newOperationId() });
      setReports(previous => [...previous, report]);
      setReportId(report.reportId);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }, [client, saveNow, pdfEdit, htmlEditing]);

  const importReport = useCallback(async (rootRelativePath: string, mainFile: string, generatedFrom?: string) => {
    if (!await saveNow()) return;
    if (htmlEditing) { setNotice('先保存或取消正在修改的网页文字。'); return; }
    if (pdfEdit && pdfEdit.status !== 'saved' && isEditDraftDirty(pdfEdit.session, pdfEdit.draft)) { setNotice('先保存或取消原位改字草稿。'); return; }
    setBusy(true); setError('');
    try {
      const { report } = await client.call('report_import', { rootRelativePath, mainFile, ...(generatedFrom ? { generatedFrom } : {}), operationId: newOperationId() });
      setReports(previous => previous.some(item => item.reportId === report.reportId) ? previous : [...previous, report]);
      setReportId(report.reportId);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }, [client, saveNow, pdfEdit, htmlEditing]);

  useEffect(() => {
    if (!pdfEdit) return;
    try { sessionStorage.setItem(`latex-pdf-draft:${pdfEdit.session.reportId}`, JSON.stringify(pdfEdit)); } catch { /* storage unavailable */ }
    if (pdfEdit.status === 'saved' && previewBuild?.status === 'succeeded' && previewBuild.reportId === pdfEdit.session.reportId && previewBuild.inputVersions[pdfEdit.session.relativePath] === pdfEdit.savedVersion) {
      setPdfEdit(null); setNotice('原位改字已写回源码，新 PDF 已更新。');
      try { sessionStorage.removeItem(`latex-pdf-draft:${pdfEdit.session.reportId}`); } catch { /* storage unavailable */ }
    } else if (pdfEdit.status === 'saved' && build?.status === 'failed') {
      setPdfEdit(current => current ? { ...current, status: 'error', message: '文字已保存，重新编译失败；草稿与源码均保留，请先修复编译错误。' } : current);
    }
  }, [pdfEdit, previewBuild, build]);

  // Workspace events keep both trees, the build banner and the history in step. The HTTP entry
  // exposes them; the desktop bridge may not, so the loop is optional and never fakes progress.
  useEffect(() => {
    const poll = client.pollEvents?.bind(client);
    if (!poll || !reportId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const events = await poll(sequence.current);
        let filesChanged = false; let buildChanged = false;
        for (const event of events) {
          sequence.current = Math.max(sequence.current, event.sequence);
          if (event.reportId !== stateRef.current.reportId) continue;
          if (event.kind === 'files-changed' || event.kind === 'operation-committed') filesChanged = true;
          if (event.kind === 'build-changed') buildChanged = true;
        }
        const eventReport = stateRef.current.reportId;
        if (filesChanged) {
            if (stateRef.current.saveState === 'clean' && file) {
              const captured = { reportId: eventReport, path: file.relativePath, version: draftRef.current?.version ?? '', text: draftRef.current?.text ?? '' };
              const snapshot = await client.call('report_read', { reportId: eventReport, relativePath: file.relativePath }).catch(() => null);
              const current = draftRef.current;
              if (!stopped && snapshot && current && canApplyFileRefresh(captured, { ...current, reportId: stateRef.current.reportId, saveState: stateRef.current.saveState })) { setFile(snapshot); setDraft(snapshot.text); draftRef.current = { text: snapshot.text, version: snapshot.fileVersion, path: snapshot.relativePath }; }
            }
            if (!stopped) htmlChanged();
            const currentContext = stateRef.current.contextId;
            const currentSequence = selectionSequence.current;
            if (currentContext) void client.call('report_context_get', { contextId: currentContext }).then(result => {
              if (!stopped && stateRef.current.contextId === currentContext && selectionSequence.current === currentSequence) setSelection(result.selection);
            }).catch(() => undefined);
            void refreshHistory(eventReport);
            void refreshTrees(eventReport).catch(() => undefined);
        }
        if (buildChanged) void refreshBuild(eventReport);
      } catch { /* the loop retries; a dropped poll is not a user-visible failure */ }
      if (!stopped) timer = setTimeout(() => { void tick(); }, htmlMode ? 300 : buildActive(build) ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    timer = setTimeout(() => { void tick(); }, ACTIVE_POLL_MS);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [build, client, file, refreshBuild, refreshHistory, refreshTrees, reportId, htmlMode, htmlChanged]);

  // While a build or a saved PDF edit waits for a new PDF, keep the banner honest.
  useEffect(() => {
    if (!reportId) return;
    const waiting = buildActive(build) || awaitingRebuild(pdfEdit?.session ?? null, build);
    if (!waiting) return;
    const timer = setTimeout(() => { void refreshBuild(reportId); }, ACTIVE_POLL_MS);
    return () => clearTimeout(timer);
  }, [build, pdfEdit, refreshBuild, reportId]);

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (selectionTimer.current) clearTimeout(selectionTimer.current);
  }, []);

  const overlay: PdfTextEditorOverlayProps | null = pdfEdit ? {
    session: pdfEdit.session,
    draft: pdfEdit.draft,
    status: pdfEdit.status,
    message: pdfEdit.message,
    onChange: (runId, text) => setPdfEdit(current => current ? { ...current, draft: { ...current.draft, [runId]: text }, status: 'editing', message: '' } : current),
    onCommit: () => { void commitPdfEdit(); },
    onCancel: () => { void cancelPdfEdit(); },
    onDismiss: () => setPdfEdit(null),
  } : null;

  const statusLabel: Record<FeatureStatus['status'], string> = { implemented: '已实现', defined: '接口已定义', unverified: '未验证' };
  const dirty = saveState !== 'clean';
  const overlayDirty = htmlEditing || (pdfEdit ? pdfEdit.status !== 'saved' && isEditDraftDirty(pdfEdit.session, pdfEdit.draft) : false);

  return <main className="reading-workspace">
    <header className="reading-header">
      <button type="button" aria-expanded={panel === 'navigation'} aria-controls="navigation-drawer" onClick={() => setPanel(value => value === 'navigation' ? 'none' : 'navigation')}>目录</button>
      <div className="reading-title" title={report?.rootRelativePath}><h1>{report?.title ?? '报告工作台'}</h1>{report && <span className="report-mode" title={report.generatedFrom ? `生成源：${report.generatedFrom}` : report.mainFile}>{htmlMode ? report.generatedFrom ? '生成网页' : '网页编辑' : 'LaTeX · PDF'} · {report.mainFile}</span>}</div>
      <div className="header-actions">
        <button type="button" disabled={!reportId} aria-expanded={panel === 'source'} aria-controls="source-drawer" onClick={() => { if (panel === 'source') setPanel('none'); else if (report) void showSourceFile(report.generatedFrom ?? file?.relativePath ?? report.mainFile); }}>源码</button>
        <button type="button" aria-expanded={panel === 'codex'} aria-controls="codex-drawer" disabled={!reportId} onClick={() => setPanel(value => value === 'codex' ? 'none' : 'codex')}>Codex</button>
        {!htmlMode && <button type="button" disabled={!reportId || buildBusy || dirty} onClick={() => { void compile(); }} title={dirty ? '先保存当前草稿' : '手动编译当前报告'}>{buildBusy ? '排队中…' : '编译'}</button>}
        <details className="export-menu"><summary>{buildBusy ? '导出中…' : '导出'}</summary><div>
        {htmlMode && <button type="button" className="primary" title="通过浏览器生成与网页相同排版的 PDF" disabled={buildBusy || overlayDirty} onClick={() => { void exportReport('web-pdf'); }}>导出 PDF</button>}
        <button type="button" disabled={!reportId || buildBusy || overlayDirty || (!htmlMode && !previewBuild)} onClick={() => { void exportReport('pdf'); }}>{htmlMode ? '可选：LaTeX 排版 PDF' : '导出 PDF'}</button>
        {htmlMode && <button type="button" disabled={buildBusy || overlayDirty} onClick={() => { void exportReport('latex-zip'); }}>导出 LaTeX 包</button>}
        <button type="button" disabled={!reportId || buildBusy || overlayDirty} onClick={() => { void exportReport('source-zip'); }}>导出源码包</button>
        </div></details>
      </div>
    </header>
    {selection && <SelectionBar selection={selection} contextBound={Boolean(contextId)} onClear={() => { void clearSelection(); }} onRequest={() => setPanel('codex')}/>}
    {error && <div className="error" role="alert">{error}<button type="button" className="link-button" onClick={() => setError('')}>关闭</button></div>}
    {notice && <div className="notice" role="status">{notice}<button type="button" className="link-button" onClick={() => setNotice('')}>关闭</button></div>}
    {regionCandidates && <div className="notice" role="dialog" aria-label="确认框选对象">
      <strong>核对源码对象后绑定</strong>
      {regionCandidates.targets.map((target, index) => <button type="button" key={index} onClick={() => { void confirmRegion(target); }}>{target.relativePath}：{target.exactText.slice(0, 80)}</button>)}
      <span>{client.terminal ? '发送给网页 Codex 时附带框选图像。' : '当前宿主使用文字与源码上下文。'}</span>
      <button type="button" onClick={() => { finishSelection(regionCandidates.request, false); selectionSequence.current += 1; setRegionCandidates(null); }}>取消</button>
    </div>}
    <div className="reading-body" data-panel={panel} ref={readingBody}>
      <PanelDivider container={readingBody} panel={panel} storageKey={`latex-workbench:panels:${workspaceId}:${viewId}`}/>
      <aside id="navigation-drawer" className="workbench-drawer navigation-drawer" hidden={panel !== 'navigation'} aria-label="报告目录">
        <div className="drawer-heading"><strong>报告与文件</strong><button type="button" onClick={() => setPanel('none')}>关闭目录</button></div>
        <ReportPicker reports={reports} selectedId={reportId} busy={busy} onSelect={id => {
          if (overlayDirty) { setNotice('先保存或取消正在修改的文字，再切换报告。'); return; }
          void saveNow().then(saved => { if (saved) setReportId(id); });
        }} onCreate={createReport} onImport={importReport}/>
        <div className="panel-title">
          <div className="tree-tabs">
            <button type="button" className={treeTab === 'outline' ? 'active' : ''} onClick={() => setTreeTab('outline')}>章节</button>
            <button type="button" className={treeTab === 'files' ? 'active' : ''} onClick={() => setTreeTab('files')}>文件</button>
          </div>
          <span>{busy ? '读取中' : treeTab === 'outline' ? `${outline.length} 项` : '只读'}</span>
        </div>
        {reports.length === 0 && !busy
          ? <p className="hint">还没有注册的报告。用“新建报告”复制内置中文模板，或注册 reports 下已有目录。</p>
          : treeTab === 'outline'
            ? <OutlineTree nodes={outline} activeNodeId={activeOutlineId} onSelect={node => { setPanel('source'); void selectChapter(node); }}/>
            : <NavigationTree nodes={nodes} selectedPath={file?.relativePath ?? ''} onSelect={relativePath => { setPanel('source'); void openFile(relativePath); }}/>}
        {treeTab === 'outline' && outlineDiagnostics.length > 0 && <details className="tree-diagnostics"><summary>索引诊断 · {outlineDiagnostics.length}</summary><ul>{outlineDiagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}-${index}`} className={`severity-${diagnostic.severity}`}>{diagnostic.message}</li>)}</ul></details>}
        <HistoryPanel operations={operations} hasMore={Boolean(historyCursor)} busy={historyBusy} onLoadMore={() => { if (reportId) void refreshHistory(reportId, true); }} onUndo={operation => { void undo(operation); }}/>
        <details className="capabilities"><summary>能力状态 · {features.filter(feature => feature.status === 'implemented').length} 项已实现</summary><ul>{features.map(feature => <li key={feature.id}><strong>{feature.title}</strong><span className={`status ${feature.status}`}>{statusLabel[feature.status]}</span><p>{feature.detail}</p></li>)}</ul></details>
      </aside>
      <div id="source-drawer" className="workbench-drawer source-drawer" hidden={panel !== 'source'} aria-label="源码编辑器">
        <div className="drawer-heading"><strong>{report?.generatedFrom ? '生成源与源码' : '源码编辑'}</strong><button type="button" onClick={() => setPanel('none')}>关闭源码</button></div>
        <SourceEditor
          value={draft}
          file={file}
          saveState={saveState}
          revealRange={revealRange}
          onDraftChange={onDraftChange}
          onSave={() => { void saveNow(); }}
          onSelectionChange={onSourceSelectionChange}
          onReload={() => { if (file) void openFile(file.relativePath, revealRange, true); }}
          readOnly={Boolean(report?.generatedFrom && file?.relativePath === report.mainFile)}
        />
      </div>
      <div className="reading-document">
        {htmlMode ? <HtmlPreview client={client} reportId={reportId} contextId={contextId} viewId={viewId} refreshKey={htmlRefreshKey} draft={file ? { relativePath: file.relativePath, text: draft, dirty } : null} onPick={pickHtmlBlock} onChanged={htmlChanged} onEditing={htmlEditingChanged} onOpenSource={relativePath => { void showSourceFile(relativePath); }}/> : <PdfPreview
          client={client}
          reportId={reportId}
          build={previewBuild}
          editMode={editMode}
          overlay={overlay}
          onToggleEditMode={value => setEditMode(value)}
          onOpenPdfEdit={input => { void openPdfEdit(input); }}
          onLocateText={input => { void locateText(input); }}
          onRegion={region => { void resolveRegion(region); }}
          onRefresh={async () => { await refreshBuild(reportId, true); }}
        />}
      </div>
      <div id="codex-drawer" className="workbench-drawer codex-drawer" hidden={panel !== 'codex'} aria-label="Codex 协作">
        <div className="drawer-heading"><strong>Codex 协作</strong><button type="button" onClick={() => setPanel('none')}>关闭 Codex</button></div>
        {mode === 'local' && client.terminal ? <CodexTerminal client={client} mode={mode} report={report} workspaceId={workspaceId} contextId={contextId} viewId={viewId} selection={selection} draftPending={busy || dirty || overlayDirty} selectionPending={selectionPending} selectionFailed={selectionFailed}/> : <CodexRequestPanel client={client} mode={mode} report={report} workspaceId={workspaceId} contextId={contextId} viewId={viewId} selection={selection} draftPending={busy || dirty || overlayDirty} selectionPending={selectionPending} selectionFailed={selectionFailed}/>}
      </div>
    </div>
    {overlayDirty && <p className="edit-warning">{htmlEditing ? '正在修改网页文字，Enter 保存、Esc 取消。' : `原位改字草稿尚未保存：${pdfEdit?.session.relativePath} · 第 ${pdfEdit?.session.placement.page} 页。`}</p>}
  </main>;
}

import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FileSnapshot, PdfEditCommit, PdfEditOpen, PdfEditResult, PdfEditSession, PatchRequest, Rect, TextProjection, TextRange } from '../shared/contracts.js';
import { WorkbenchError } from '../shared/errors.js';
import type { BuildQueuePort, ContextsPort, PdfEditPort, SyncTexPort, TextProjectionPort } from '../shared/ports.js';
import type { Compiler } from './compiler.js';
import type { FileService, TextEdit } from './files.js';
import type { HistoryStore } from './history.js';
import { normalizeRelativePath } from './path-policy.js';
import { KeyedMutex, newId, nowIso, readJson, writeJsonAtomic } from './store.js';
import { decodeText } from './files.js';
import { escapeLatexText, projectionVersionOf, unescapeLatexText } from './text-projection.js';
import type { Workspace } from './workspace.js';

export type PdfEditDependencies = {
  workspace: Workspace;
  compiler: Compiler;
  files: FileService;
  contexts: ContextsPort;
  synctex: SyncTexPort;
  projection: TextProjectionPort;
  buildQueue: BuildQueuePort;
  history: HistoryStore;
};

type StoredSession = PdfEditSession & { schemaVersion: 1; frozenRelativePath: string; committed?: { operationId: string; result: PdfEditResult } };

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < Math.min(offset, text.length); index += 1) if (text[index] === '\n') line += 1;
  return line;
}

function uniqueIndexOf(text: string, needle: string): { index: number; count: number } {
  if (!needle) return { index: -1, count: 0 };
  let index = text.indexOf(needle);
  if (index < 0) return { index: -1, count: 0 };
  const first = index;
  let count = 0;
  while (index >= 0) {
    count += 1;
    index = text.indexOf(needle, index + 1);
  }
  return { index: first, count };
}

function placementFor(rects: Rect[], fallback: { page: number; x: number; y: number }): PdfEditSession['placement'] {
  if (rects.length) return { page: fallback.page, rects };
  return { page: fallback.page, rects: [[fallback.x - 4, fallback.y - 14, fallback.x + 120, fallback.y + 6]] };
}

/**
 * PDF direct text editing: sessions are bound to an immutable build, a live file version and a
 * projection version. Only editable runs are replaced; protected tokens are verified untouched.
 */
export function createPdfEdit(dependencies: PdfEditDependencies): PdfEditPort {
  const sessions = new Map<string, StoredSession>();
  const lock = new KeyedMutex();

  const sessionPath = (editSessionId: string) => path.join(dependencies.workspace.layout.edits, `${editSessionId}.json`);

  async function load(editSessionId: string): Promise<StoredSession> {
    const cached = sessions.get(editSessionId);
    if (cached) return cached;
    const stored = await readJson<StoredSession>(sessionPath(editSessionId));
    if (!stored || stored.schemaVersion !== 1) throw new WorkbenchError('PDF_EDIT_SESSION_STALE', '该 PDF 编辑会话已不存在，请重新打开。', false, { editSessionId });
    sessions.set(editSessionId, stored);
    return stored;
  }

  async function save(session: StoredSession): Promise<void> {
    sessions.set(session.editSessionId, session);
    await writeJsonAtomic(sessionPath(session.editSessionId), session);
  }

  async function discard(editSessionId: string): Promise<void> {
    sessions.delete(editSessionId);
    await rm(sessionPath(editSessionId), { force: true });
  }

  async function requireContext(contextId: string, reportId: string): Promise<void> {
    const selection = await dependencies.contexts.getContext(contextId).catch(() => null);
    if (!selection) {
      const contexts = dependencies.contexts as ContextsPort & { reportIdFor?: (contextId: string) => Promise<string | null> };
      const bound = await contexts.reportIdFor?.(contextId).catch(() => null);
      if (bound !== reportId) throw new WorkbenchError('CONTEXT_NOT_BOUND', 'PDF 编辑需要已绑定该报告的工作台会话。', false, { contextId });
      return;
    }
    if (selection.reportId !== reportId) throw new WorkbenchError('CONTEXT_NOT_BOUND', '面板会话与报告不匹配。', false, { contextId });
  }

  return {
    async openPdfEdit(input: PdfEditOpen): Promise<PdfEditSession> {
      await requireContext(input.contextId, input.reportId);
      await dependencies.contexts.keepAlive(input.contextId, input.viewId);
      const manifest = await dependencies.compiler.readManifest(input.reportId, input.buildId);
      if (!manifest) throw new WorkbenchError('FILE_NOT_FOUND', '找不到该构建，无法打开 PDF 编辑。', false, { buildId: input.buildId });
      if (manifest.status !== 'succeeded') throw new WorkbenchError('BUILD_FAILED', '只允许在成功构建的 PDF 上编辑文字。', false, { status: manifest.status });
      const located = await dependencies.synctex.locatePdfTarget({ reportId: input.reportId, buildId: input.buildId, page: input.page, point: input.point });
      if (located.candidates.length === 0) {
        throw new WorkbenchError('PDF_EDIT_NOT_SUPPORTED', '这个位置没有可映射的正文；图片、页码或浮动体内的文字请改用源码编辑。', false, { diagnostics: located.diagnostics });
      }
      if (located.candidates.length > 1 || located.confidence === 'ambiguous') {
        throw new WorkbenchError('PDF_EDIT_NOT_SUPPORTED', '该位置对应多个源码候选，请先用划词搜索定位到唯一段落。', false, { candidates: located.candidates.length });
      }
      const candidate = located.candidates[0]!;
      const live = await dependencies.files.readTextFile(input.reportId, candidate.relativePath);
      const resolved = resolveLiveRange(live, candidate);
      if (!resolved) {
        throw new WorkbenchError('PDF_EDIT_SESSION_STALE', '源码已经更新，无法把这段文字安全地映射回当前文件，请重新选择。', true, { relativePath: candidate.relativePath });
      }
      const projection = dependencies.projection.buildTextProjection(live, resolved);
      if (!projection.reversible) {
        throw new WorkbenchError('PDF_EDIT_NOT_SUPPORTED', '该段包含无法安全反向转换的命令或环境，请改用源码编辑。', false, { diagnostics: projection.diagnostics });
      }
      const paths = dependencies.compiler.pathsFor(input.reportId, input.buildId);
      const frozenBytes = await readFile(path.join(paths.source, candidate.relativePath)).catch(() => null);
      const frozenText = frozenBytes ? decodeText(candidate.relativePath, frozenBytes).text : '';
      const frozenLine = lineOf(frozenText, candidate.range.start);
      const locations = await dependencies.synctex
        .locateSourceTarget({ reportId: input.reportId, buildId: input.buildId, relativePath: candidate.relativePath, line: frozenLine })
        .catch(() => []);
      const rects = locations.filter(location => location.page === input.page).map(location => location.rect);
      const session: StoredSession = {
        schemaVersion: 1,
        editSessionId: newId(),
        selectionId: newId(),
        reportId: input.reportId,
        contextId: input.contextId,
        viewId: input.viewId,
        buildId: input.buildId,
        relativePath: candidate.relativePath,
        frozenRelativePath: candidate.relativePath,
        baseFileVersion: live.fileVersion,
        projectionVersion: projection.projectionVersion,
        sourceRange: projection.sourceRange,
        runs: projection.runs,
        placement: placementFor(rects, { page: input.page, x: input.point.x, y: input.point.y }),
        status: 'editing',
      };
      await save(session);
      return session;
    },

    async commitPdfEdit(input: PdfEditCommit): Promise<PdfEditResult> {
      return lock.run(input.editSessionId, async () => {
      const session = await load(input.editSessionId);
      if (session.contextId !== input.contextId) throw new WorkbenchError('CONTEXT_NOT_BOUND', '编辑会话不属于当前面板。', false, { editSessionId: input.editSessionId });
      if (session.committed?.operationId === input.operationId) return session.committed.result;
      await requireContext(input.contextId, session.reportId);
      if (session.status !== 'editing') throw new WorkbenchError('PDF_EDIT_SESSION_STALE', '该编辑会话已经提交或取消。', false, { status: session.status });
      if (session.baseFileVersion !== input.expectedFileVersion) {
        throw new WorkbenchError('FILE_VERSION_CONFLICT', '打开编辑后源码已被修改，请重新打开这段文字。', true, { expected: session.baseFileVersion, actual: input.expectedFileVersion });
      }
      const fresh = await dependencies.files.readTextFile(session.reportId, session.relativePath);
      if (fresh.fileVersion !== session.baseFileVersion) throw new WorkbenchError('FILE_VERSION_CONFLICT', '源码已被修改，草稿保留，请重新定位。', true);
      const projection = dependencies.projection.buildTextProjection(fresh, session.sourceRange);
      if (projection.projectionVersion !== input.projectionVersion || projection.projectionVersion !== session.projectionVersion) {
        throw new WorkbenchError('PDF_EDIT_SESSION_STALE', '源码结构已经变化，本次编辑没有写回，请重新打开。', true, { projectionVersion: session.projectionVersion });
      }
      if (!projection.reversible) throw new WorkbenchError('PDF_EDIT_NOT_SUPPORTED', '该范围当前不可反向转换。', false, { diagnostics: projection.diagnostics });
      const currentProtected = projection.runs.filter(run => run.kind === 'protected').map(run => `${run.sourceRange.start}:${run.text}`).join('|');
      const originalProtected = session.runs.filter(run => run.kind === 'protected').map(run => `${run.sourceRange.start}:${run.text}`).join('|');
      if (currentProtected !== originalProtected) throw new WorkbenchError('PROTECTED_TOKEN_CHANGED', '公式、引用或标签在编辑期间发生变化，已拒绝写回。', true);

      const edits: TextEdit[] = [];
      for (const change of input.changes) {
        const run = projection.runs.find(candidate => candidate.runId === change.runId);
        if (!run) throw new WorkbenchError('PDF_EDIT_SESSION_STALE', '提交中包含未知的文字片段。', false, { runId: change.runId });
        if (run.kind !== 'editable') throw new WorkbenchError('PDF_EDIT_NOT_SUPPORTED', '受保护内容不能通过文字编辑修改。', false, { runId: change.runId });
        const normalized = change.text.replaceAll('\r\n', '\n').replaceAll('\n', ' ');
        if (normalized === run.text) continue;
        edits.push({ range: run.sourceRange, replacement: escapeLatexText(normalized) });
      }
      if (edits.length === 0) {
        const result = { operation: null, buildId: null, unchanged: true };
        session.committed = { operationId: input.operationId, result };
        session.status = 'saved-awaiting-build';
        await save(session);
        return result;
      }
      const patch: PatchRequest = {
        reportId: session.reportId,
        contextId: session.contextId,
        scope: 'report',
        scopeReason: '用户在 PDF 预览中原位修改文字（不经过模型）',
        operationId: input.operationId,
        files: [{ relativePath: session.relativePath, expectedVersion: session.baseFileVersion, edits }],
      };
      const record = await dependencies.files.applyPatchInternal(patch, 'pdf-editor');
      const { buildId } = await dependencies.buildQueue.enqueueBuild(session.reportId);
      session.status = 'saved-awaiting-build';
      const result = { operation: record, buildId, unchanged: false };
      session.committed = { operationId: input.operationId, result };
      await save(session);
      return result;
      });
    },

    async cancelPdfEdit(editSessionId: string, contextId: string): Promise<void> {
      const session = await load(editSessionId).catch(() => null);
      if (!session) return;
      if (session.contextId !== contextId) throw new WorkbenchError('CONTEXT_NOT_BOUND', '编辑会话不属于当前面板。', false, { editSessionId });
      await discard(editSessionId);
    },
  };
}

/**
 * Maps a build-time candidate onto the live file. When the file changed, the exact text is
 * re-anchored only if it is unique; otherwise the caller must ask the user to select again.
 */
export function resolveLiveRange(live: FileSnapshot, candidate: { range: TextRange; exactText: string; fileVersion: string }): TextRange | null {
  if (live.fileVersion === candidate.fileVersion) return candidate.range;
  if (!candidate.exactText) return null;
  const { index, count } = uniqueIndexOf(live.text, candidate.exactText);
  if (count !== 1 || index < 0) return null;
  return { start: index, end: index + candidate.exactText.length };
}

export function projectionSummary(projection: TextProjection): string {
  const editable = projection.runs.filter(run => run.kind === 'editable');
  return `${editable.length} 段可编辑文字，${projection.runs.length - editable.length} 个受保护片段`;
}

export function sessionTimestamp(): string {
  return nowIso();
}

export { normalizeRelativePath };

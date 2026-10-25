import { createHash } from 'node:crypto';
import { lstat, readFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, DraftSave, FileSnapshot, FileTreeNode, OperationRecord, PatchRequest, SelectionRecord, TextRange } from '../shared/contracts.js';
import type { FilesPort } from '../shared/ports.js';
import { DEFAULTS } from '../shared/config.js';
import { WorkbenchError } from '../shared/errors.js';
import { normalizeRelativePath, resolveSafePath } from './path-policy.js';
import { KeyedMutex, nowIso, replaceFileWithRetry, sha256 } from './store.js';
import type { HistoryStore } from './history.js';
import type { Workspace } from './workspace.js';

export type EolStyle = 'lf' | 'crlf';
export type DecodedText = {
  snapshot: FileSnapshot;
  /** Style of every newline in the normalized text, in order. */
  eols: EolStyle[];
  raw: Uint8Array;
};

export type TextEdit = { range: TextRange; replacement: string };
export type EditPlan = { text: string; eols: EolStyle[] };

const WRITABLE_EXTENSIONS = new Set(['.tex', '.bib', '.cls', '.sty', '.txt', '.md', '.json', '.html', '.css', '.svg', '.py']);
const READABLE_EXTENSIONS = WRITABLE_EXTENSIONS;

export function decodeDetailed(relativePath: string, raw: Uint8Array): DecodedText {
  const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? raw.subarray(3) : raw);
  } catch {
    throw new WorkbenchError('UNSUPPORTED_ENCODING', '文件不是有效 UTF-8，框架不会自动转换原稿。');
  }
  if (decoded.includes('\0') || /\r(?!\n)/.test(decoded)) throw new WorkbenchError('UNSUPPORTED_ENCODING', '文件包含二进制内容或尚未支持的换行形式。');
  const eols: EolStyle[] = [];
  let text = '';
  for (let index = 0; index < decoded.length; index += 1) {
    const character = decoded[index]!;
    if (character === '\r' && decoded[index + 1] === '\n') {
      eols.push('crlf');
      text += '\n';
      index += 1;
    } else if (character === '\n') {
      eols.push('lf');
      text += '\n';
    } else {
      text += character;
    }
  }
  const crlf = eols.filter(style => style === 'crlf').length;
  const lf = eols.length - crlf;
  const snapshot: FileSnapshot = {
    relativePath,
    text,
    fileVersion: createHash('sha256').update(raw).digest('hex'),
    encoding: 'utf8',
    eol: crlf && lf ? 'mixed' : crlf ? 'crlf' : 'lf',
    bom,
  };
  return { snapshot, eols, raw };
}

export function decodeText(relativePath: string, raw: Uint8Array): FileSnapshot {
  return decodeDetailed(relativePath, raw).snapshot;
}

function dominantEol(eols: EolStyle[]): EolStyle {
  const crlf = eols.filter(style => style === 'crlf').length;
  return crlf * 2 > eols.length ? 'crlf' : 'lf';
}

function unicodeBoundary(text: string, offset: number): boolean {
  const previous = text.charCodeAt(offset - 1), current = text.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff);
}
function assertUnicodeText(text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new WorkbenchError('INVALID_INPUT', '输入包含不完整的 Unicode 字符。');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new WorkbenchError('INVALID_INPUT', '输入包含不完整的 Unicode 字符。');
  }
}

/**
 * Applies non-overlapping edits to the normalized text while keeping a per-newline style
 * plan, so a mixed-EOL file is never silently normalized by a local edit.
 */
export function applyEdits(source: DecodedText, edits: TextEdit[]): EditPlan {
  const sorted = [...edits].sort((a, b) => a.range.start - b.range.start);
  const dominant = dominantEol(source.eols);
  let text = '';
  const eols: EolStyle[] = [];
  let cursor = 0;
  let newlineCursor = 0;
  const pushNewlines = (chunk: string, style: EolStyle | 'source') => {
    for (const character of chunk) {
      text += character;
      if (character !== '\n') continue;
      if (style === 'source') eols.push(source.eols[newlineCursor] ?? dominant);
      else eols.push(style);
      if (style === 'source') newlineCursor += 1;
    }
  };
  for (const edit of sorted) {
    if (!Number.isInteger(edit.range.start) || !Number.isInteger(edit.range.end) || edit.range.start < 0 || edit.range.end < edit.range.start || edit.range.end > source.snapshot.text.length) throw new WorkbenchError('INVALID_INPUT', '修改范围超出源码内容。');
    if (!unicodeBoundary(source.snapshot.text, edit.range.start) || !unicodeBoundary(source.snapshot.text, edit.range.end)) throw new WorkbenchError('INVALID_INPUT', '修改范围切开了 Unicode 字符，请重新选择完整字符。');
    assertUnicodeText(edit.replacement);
    if (edit.range.start < cursor) throw new WorkbenchError('INVALID_INPUT', '修改范围重叠，已拒绝整批写入。');
    const unchanged = source.snapshot.text.slice(cursor, edit.range.start);
    pushNewlines(unchanged, 'source');
    newlineCursor += (source.snapshot.text.slice(edit.range.start, edit.range.end).match(/\n/g) ?? []).length;
    pushNewlines(edit.replacement, dominant);
    cursor = edit.range.end;
  }
  pushNewlines(source.snapshot.text.slice(cursor), 'source');
  return { text, eols };
}

export function encodeText(plan: EditPlan, options: { bom: boolean; eol: FileSnapshot['eol'] }): Uint8Array {
  const dominant: EolStyle = options.eol === 'crlf' ? 'crlf' : 'lf';
  let serialized = '';
  let newlineIndex = 0;
  for (const character of plan.text) {
    if (character !== '\n') {
      serialized += character;
      continue;
    }
    const style = plan.eols[newlineIndex] ?? dominant;
    serialized += style === 'crlf' ? '\r\n' : '\n';
    newlineIndex += 1;
  }
  const body = options.bom ? `\uFEFF${serialized}` : serialized;
  return new TextEncoder().encode(body);
}

/** Minimal common-prefix/suffix diff used to turn an editor save into real ranged edits. */
export function diffToEdits(base: string, next: string): TextEdit[] {
  assertUnicodeText(next);
  if (base === next) return [];
  let prefix = 0;
  const maximum = Math.min(base.length, next.length);
  while (prefix < maximum && base[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < maximum - prefix && base[base.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  if (!unicodeBoundary(base, prefix) || !unicodeBoundary(next, prefix)) prefix -= 1;
  if (!unicodeBoundary(base, base.length - suffix) || !unicodeBoundary(next, next.length - suffix)) suffix -= 1;
  return [{ range: { start: prefix, end: base.length - suffix }, replacement: next.slice(prefix, next.length - suffix) }];
}

export function describeEdits(files: { relativePath: string; edits: TextEdit[] }[]): string {
  const parts = files.map(file => {
    let removed = 0;
    let added = 0;
    for (const edit of file.edits) {
      removed += edit.range.end - edit.range.start;
      added += edit.replacement.length;
    }
    const preview = file.edits[0]?.replacement.replaceAll('\n', '⏎').slice(0, 40) ?? '';
    return `${file.relativePath}：${file.edits.length} 处（-${removed} +${added} 字符）${preview ? `，如「${preview}」` : ''}`;
  });
  const summary = parts.join('；');
  return summary.length > 500 ? `${summary.slice(0, 497)}…` : summary;
}

type PreparedFile = {
  relativePath: string;
  expectedVersion: string | null;
  isNew: boolean;
  before: Uint8Array;
  after: Uint8Array;
  beforeVersion: string | null;
  afterVersion: string;
  beforeSnapshot: DecodedText | null;
};

export type PatchOrigin = OperationRecord['origin'];

export type PatchHooks = {
  /** Lets the context store remap a selection to the committed ranges instead of guessing later. */
  afterCommit?: (info: { reportId: string; request: PatchRequest; record: OperationRecord; files: { relativePath: string; edits: TextEdit[] }[] }) => Promise<void>;
};

export class FileService implements FilesPort {
  private resolveSelection: (contextId: string, selectionId?: string) => Promise<SelectionRecord | null> = async () => null;
  private boundReport: (contextId: string) => Promise<string | null> = async () => null;
  constructor(
    private readonly workspace: Workspace,
    private readonly history: HistoryStore,
    private readonly lock: KeyedMutex,
    private readonly hooks: PatchHooks = {},
  ) {}

  setSelectionResolver(resolver: (contextId: string, selectionId?: string) => Promise<SelectionRecord | null>): void {
    this.resolveSelection = resolver;
  }
  setContextResolver(resolver: (contextId: string) => Promise<string | null>): void { this.boundReport = resolver; }

  async readTextFile(reportId: string, relativePath: string): Promise<FileSnapshot> {
    const root = await this.workspace.getReportRoot(reportId);
    return this.readTextAtRoot(root, relativePath);
  }

  /** Internal reuse after the caller has resolved a current report root. */
  async readTextAtRoot(root: string, relativePath: string): Promise<FileSnapshot> {
    const file = await resolveSafePath(root, relativePath);
    if (!READABLE_EXTENSIONS.has(path.extname(file).toLowerCase())) throw new WorkbenchError('UNSUPPORTED_ENCODING', '该文件类型不属于源码文本读取范围。');
    const info = await lstat(file);
    if (!info.isFile()) throw new WorkbenchError('INVALID_INPUT', '目标必须是普通文件。');
    if (info.size > DEFAULTS.maxTextBytes) throw new WorkbenchError('FILE_TOO_LARGE', '源码超过 2 MiB 读取上限。');
    const raw = await readFile(file);
    if (raw.length > DEFAULTS.maxTextBytes) throw new WorkbenchError('FILE_TOO_LARGE', '源码在读取时超过上限。');
    return decodeDetailed(relativePath, raw).snapshot;
  }

  async readDecoded(reportId: string, relativePath: string): Promise<DecodedText> {
    const root = await this.workspace.getReportRoot(reportId);
    const file = await resolveSafePath(root, relativePath);
    const raw = await readFile(file);
    if (raw.length > DEFAULTS.maxTextBytes) throw new WorkbenchError('FILE_TOO_LARGE', '源码超过 2 MiB 读取上限。');
    return decodeDetailed(relativePath, raw);
  }

  async listFileTree(reportId: string): Promise<FileTreeNode[]> {
    return this.workspace.tree(await this.workspace.getReportRoot(reportId));
  }

  async applyPatch(request: PatchRequest, validateWrite?: () => void): Promise<OperationRecord> {
    return this.applyPatchInternal(request, 'codex', validateWrite);
  }

  async saveDraft(request: DraftSave): Promise<OperationRecord> {
    if (await this.boundReport(request.contextId) !== request.reportId) throw new WorkbenchError('CONTEXT_NOT_BOUND', '保存会话没有绑定该报告。');
    const existing = await this.history.getOperation(request.reportId, request.operationId);
    if (existing) return existing;
    const current = await this.readTextFile(request.reportId, request.relativePath);
    if (current.fileVersion !== request.baseVersion) {
      throw new WorkbenchError('FILE_VERSION_CONFLICT', '文件已变化，草稿未覆盖较新内容。', true, { relativePath: request.relativePath, expected: request.baseVersion, actual: current.fileVersion });
    }
    const edits = diffToEdits(current.text, request.text);
    const patch: PatchRequest = {
      reportId: request.reportId,
      contextId: request.contextId,
      scope: 'report',
      scopeReason: '工作台源码编辑器的条件保存',
      operationId: request.operationId,
      files: [{ relativePath: request.relativePath, expectedVersion: request.baseVersion, edits: edits.length ? edits : [] }],
    };
    if (edits.length === 0) {
      const record: OperationRecord = {
        operationId: request.operationId, reportId: request.reportId, origin: 'source-editor', state: 'committed', createdAt: nowIso(),
        beforeVersions: { [request.relativePath]: request.baseVersion }, afterVersions: { [request.relativePath]: request.baseVersion }, diffSummary: '无变化，未生成修改。',
      };
      return record;
    }
    return this.applyPatchInternal(patch, 'source-editor');
  }

  async applyPatchInternal(request: PatchRequest, origin: PatchOrigin, validateWrite?: () => void): Promise<OperationRecord> {
    if (await this.boundReport(request.contextId) !== request.reportId) throw new WorkbenchError('CONTEXT_NOT_BOUND', '修改会话没有绑定该报告。');
    const report = await this.workspace.getReport(request.reportId);
    return this.lock.run(`report:${report.reportId}`, async () => {
      validateWrite?.();
      const existing = await this.history.getOperation(report.reportId, request.operationId);
      if (existing) return existing;
      await this.assertWritable(report.reportId, request.files.map(file => file.relativePath));
      const root = await this.workspace.getReportRoot(report.reportId);
      let selection: SelectionRecord | null = null;
      if (request.scope === 'selection') {
        selection = await this.resolveSelection(request.contextId, request.selectionId);
        if (!selection || selection.validity !== 'valid') throw new WorkbenchError('SELECTION_STALE', '修改对象已失效，请重新选择后再改。');
        if (selection.reportId !== request.reportId) throw new WorkbenchError('CONTEXT_NOT_BOUND', '修改对象不属于当前报告。');
      }
      // A new entry must exist before the manifest starts referring to it. This also
      // leaves the old report discoverable if a content write fails and needs recovery.
      const targets = [...request.files].sort((a, b) => {
        const left = normalizeRelativePath(a.relativePath), right = normalizeRelativePath(b.relativePath);
        return Number(left.toLowerCase() === '.latex-report.json') - Number(right.toLowerCase() === '.latex-report.json') || left.localeCompare(right);
      });
      const prepared: PreparedFile[] = [];
      const editSets: { relativePath: string; edits: TextEdit[] }[] = [];
      for (const file of targets) {
        for (const edit of file.edits) assertUnicodeText(edit.replacement);
        const relativePath = normalizeRelativePath(file.relativePath);
        const extension = path.extname(relativePath).toLowerCase();
        if (!WRITABLE_EXTENSIONS.has(extension)) throw new WorkbenchError('INVALID_INPUT', `不支持写入 ${extension || '无扩展名'} 文件。`);
        const isNew = file.expectedVersion === null;
        const absolute = await resolveSafePath(root, relativePath, { allowMissingLeaf: isNew });
        const info = await stat(absolute).catch(() => null);
        if (isNew) {
          if (info) throw new WorkbenchError('FILE_VERSION_CONFLICT', '新文件目标已存在。', false, { relativePath });
        } else if (!info?.isFile()) {
          throw new WorkbenchError('FILE_NOT_FOUND', '目标文件不存在。', false, { relativePath });
        }
        if (selection) this.assertEditsInsideSelection(selection, relativePath, file.edits);
        if (isNew) {
          const plan: EditPlan = { text: file.edits[0]?.replacement ?? '', eols: Array.from({ length: (file.edits[0]?.replacement ?? '').split('\n').length - 1 }, () => 'lf' as EolStyle) };
          const after = encodeText(plan, { bom: false, eol: 'lf' });
          if (after.byteLength > DEFAULTS.maxTextBytes) throw new WorkbenchError('FILE_TOO_LARGE', '新建文件超过文本大小上限。');
          prepared.push({ relativePath, expectedVersion: null, isNew, before: new Uint8Array(), after, beforeVersion: null, afterVersion: createHash('sha256').update(after).digest('hex'), beforeSnapshot: null });
          editSets.push({ relativePath, edits: file.edits });
          continue;
        }
        const raw = await readFile(absolute);
        if (raw.length > DEFAULTS.maxTextBytes) throw new WorkbenchError('FILE_TOO_LARGE', '源码超过 2 MiB 写入上限。', false, { relativePath });
        const decoded = decodeDetailed(relativePath, raw);
        if (decoded.snapshot.fileVersion !== file.expectedVersion) {
          throw new WorkbenchError('FILE_VERSION_CONFLICT', '文件版本已变化，修改未应用。', true, { relativePath, expected: file.expectedVersion, actual: decoded.snapshot.fileVersion });
        }
        const plan = applyEdits(decoded, file.edits);
        const after = encodeText(plan, { bom: decoded.snapshot.bom, eol: decoded.snapshot.eol });
        if (after.byteLength > DEFAULTS.maxTextBytes) throw new WorkbenchError('FILE_TOO_LARGE', '修改后文件超过文本大小上限。');
        prepared.push({ relativePath, expectedVersion: file.expectedVersion, isNew, before: raw, after, beforeVersion: decoded.snapshot.fileVersion, afterVersion: createHash('sha256').update(after).digest('hex'), beforeSnapshot: decoded });
        editSets.push({ relativePath, edits: file.edits });
      }
      if (prepared.every(file => file.beforeVersion === file.afterVersion)) {
        return {
          operationId: request.operationId, reportId: report.reportId, origin, state: 'committed', createdAt: nowIso(),
          beforeVersions: Object.fromEntries(prepared.map(file => [file.relativePath, file.beforeVersion])),
          afterVersions: Object.fromEntries(prepared.map(file => [file.relativePath, file.afterVersion])),
          diffSummary: '无实际变化，未写入文件。',
        };
      }
      validateWrite?.();
      // Journal prepared state with both sides so a crash can be recovered.
      const journal = await this.history.beginJournal(report.reportId, request.operationId, prepared.map(file => ({
        relativePath: file.relativePath, beforeVersion: file.beforeVersion, afterVersion: file.afterVersion, before: file.before, after: file.after,
      })));
      const applied: string[] = [];
      try {
        for (const file of prepared) {
          const absolute = await resolveSafePath(root, file.relativePath, { allowMissingLeaf: file.isNew });
          const current = await readFile(absolute).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
          if ((current ? sha256(current) : null) !== file.beforeVersion) throw new WorkbenchError('FILE_VERSION_CONFLICT', '准备事务后文件又被修改，已停止写入。', true);
          validateWrite?.();
          await replaceFileWithRetry(absolute, file.after);
          applied.push(file.relativePath);
          await journal.markProgress(file.relativePath);
        }
        validateWrite?.();
      } catch (error) {
        await this.recoverJournalEntry(journal.entry, report.reportId);
        throw error;
      }
      const record: OperationRecord = {
        operationId: request.operationId,
        reportId: report.reportId,
        origin,
        state: 'committed',
        createdAt: nowIso(),
        beforeVersions: Object.fromEntries(prepared.map(file => [file.relativePath, file.beforeVersion])),
        afterVersions: Object.fromEntries(prepared.map(file => [file.relativePath, file.afterVersion])),
        diffSummary: describeEdits(editSets),
      };
      await this.history.commitJournal(journal.entry, record, prepared.map(file => ({ relativePath: file.relativePath, before: file.before, after: file.after })));
      if (this.hooks.afterCommit) await this.hooks.afterCommit({ reportId: report.reportId, request, record, files: editSets });
      return record;
    });
  }

  private assertEditsInsideSelection(selection: SelectionRecord, relativePath: string, edits: TextEdit[]): void {
    const targets = selection.targets.filter(target => normalizeRelativePath(target.relativePath) === relativePath);
    if (targets.length === 0) throw new WorkbenchError('SELECTION_STALE', '修改范围超出了当前选择对象。', false, { relativePath });
    for (const edit of edits) {
      const contained = targets.some(target => target.range.start <= edit.range.start && target.range.end >= edit.range.end);
      if (!contained) throw new WorkbenchError('SELECTION_STALE', '修改范围超出了当前选择对象。', false, { relativePath, range: edit.range });
    }
  }

  /** Writes raw bytes during undo, keeping the same lock and retry behaviour as a patch. */
  async assertWritable(reportId: string, relativePaths: string[]): Promise<void> {
    const report = await this.workspace.getReport(reportId);
    if (report.generatedFrom && relativePaths.some(file => normalizeRelativePath(file).toLowerCase() === normalizeRelativePath(report.mainFile).toLowerCase())) throw new WorkbenchError('GENERATED_OUTPUT_READ_ONLY', `此网页由 ${report.generatedFrom} 生成，请修改生成源。`);
  }

  async restoreFile(reportId: string, relativePath: string, bytes: Uint8Array, expectedVersion: string): Promise<void> {
    await this.assertWritable(reportId, [relativePath]);
    const root = await this.workspace.getReportRoot(reportId);
    const absolute = await resolveSafePath(root, relativePath);
    const raw = await readFile(absolute);
    const actual = createHash('sha256').update(raw).digest('hex');
    if (actual !== expectedVersion) throw new WorkbenchError('FILE_VERSION_CONFLICT', '文件已变化，撤销未覆盖较新内容。', true, { relativePath, expected: expectedVersion, actual });
    await replaceFileWithRetry(absolute, bytes);
  }

  async withReportLock<T>(reportId: string, work: () => Promise<T>): Promise<T> { return this.lock.run(`report:${reportId}`, work); }

  async removeFile(reportId: string, relativePath: string, expectedVersion: string): Promise<void> {
    await this.assertWritable(reportId, [relativePath]);
    const absolute = await resolveSafePath(await this.workspace.getReportRoot(reportId), relativePath);
    if (sha256(await readFile(absolute)) !== expectedVersion) throw new WorkbenchError('FILE_VERSION_CONFLICT', '文件已有后续修改，未删除。', true);
    await rm(absolute);
  }

  async recoverTransactions(reportId: string): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    for (const entry of await this.history.listJournal(reportId)) {
      diagnostics.push(...await this.recoverJournalEntry(entry, reportId));
    }
    return diagnostics;
  }

  private async recoverJournalEntry(entry: Awaited<ReturnType<HistoryStore['beginJournal']>>['entry'], reportId: string): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    const root = await this.workspace.getReportRoot(reportId);
    // The journal stores both sides as snapshot files; the pre-edit bytes must come from disk,
    // not from the journal metadata, so a crash can always be rolled back.
    const snapshots = await this.history.readSnapshot(reportId, entry.operationId).catch(() => []);
    const beforeBytes = new Map(snapshots.map(snapshot => [snapshot.relativePath, snapshot.before]));
    // Reverse dependency order during rollback as well. At every intermediate
    // step the manifest must still point to a source that exists on disk.
    for (const file of [...entry.files].reverse()) {
      let absolute: string;
      try {
        absolute = await resolveSafePath(root, file.relativePath, { allowMissingLeaf: file.beforeVersion === null || file.afterVersion === '' });
      } catch {
        diagnostics.push({ severity: 'warning', code: 'RECOVERY_PATH_UNAVAILABLE', message: `恢复时找不到 ${file.relativePath}。`, relativePath: file.relativePath });
        continue;
      }
      const current = await readFile(absolute).catch(() => null);
      const version = current ? createHash('sha256').update(current).digest('hex') : null;
      if (file.beforeVersion === null) {
        if (version === file.afterVersion) { await rm(absolute); continue; }
        if (version !== null) {
          const conflict = `${absolute}.conflict-${Date.now()}`;
          await replaceFileWithRetry(conflict, current ?? new Uint8Array());
          diagnostics.push({ severity: 'warning', code: 'RECOVERY_CONFLICT_COPY', message: `未提交事务的新建文件被外部写入，已保留冲突副本。`, relativePath: file.relativePath });
        }
        continue;
      }
      if (version === file.beforeVersion) continue;
      if (version === file.afterVersion || (version === null && file.afterVersion === '')) {
        const before = beforeBytes.get(file.relativePath);
        if (!before) {
          diagnostics.push({ severity: 'error', code: 'RECOVERY_SNAPSHOT_MISSING', message: `找不到 ${file.relativePath} 的事务前快照，未自动回滚。`, relativePath: file.relativePath });
          continue;
        }
        await replaceFileWithRetry(absolute, before);
        diagnostics.push({ severity: 'info', code: 'RECOVERY_ROLLED_BACK', message: '检测到未提交事务，已回滚到修改前内容。', relativePath: file.relativePath });
        continue;
      }
      const conflict = `${absolute}.conflict-${Date.now()}`;
      if (current) await replaceFileWithRetry(conflict, current);
      diagnostics.push({ severity: 'warning', code: 'RECOVERY_CONFLICT_COPY', message: '文件在恢复前被外部修改，已保留冲突副本，未覆盖较新内容。', relativePath: file.relativePath });
    }
    await this.history.markRecovered(reportId, entry);
    return diagnostics;
  }
}

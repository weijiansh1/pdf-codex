import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { FileSnapshot, OperationRecord, PatchRequest, SelectionInput, SelectionRecord, SourceTarget } from '../shared/contracts.js';
import type { ContextsPort } from '../shared/ports.js';
import { DEFAULTS } from '../shared/config.js';
import { WorkbenchError } from '../shared/errors.js';
import { newId, nowIso, readJson, workspaceLayout, writeJsonAtomic } from './store.js';
import type { TextEdit } from './files.js';
import type { Workspace } from './workspace.js';

const ANCHOR_LENGTH = 120;

type ContextFile = {
  schemaVersion: 1;
  contextId: string;
  workspaceId: string;
  reportId: string;
  viewId: string;
  createdAt: string;
  lastSeenAt: string;
  clearedAt?: string;
  selection: SelectionRecord | null;
};

export type ContextsDependencies = {
  workspace: Workspace;
  readTextFile(reportId: string, relativePath: string): Promise<FileSnapshot>;
};

export type PatchCommitInfo = {
  reportId: string;
  request: PatchRequest;
  record: OperationRecord;
  files: { relativePath: string; edits: TextEdit[] }[];
};

function anchorFrom(text: string, range: { start: number; end: number }): { exactText: string; prefix: string; suffix: string } {
  return {
    exactText: text.slice(range.start, range.end),
    prefix: text.slice(Math.max(0, range.start - ANCHOR_LENGTH), range.start),
    suffix: text.slice(range.end, Math.min(text.length, range.end + ANCHOR_LENGTH)),
  };
}

function uniqueMatchIndex(haystack: string, needle: string): { index: number; count: number } {
  let index = haystack.indexOf(needle);
  if (index < 0) return { index: -1, count: 0 };
  const first = index;
  let count = 0;
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + 1);
  }
  return { index: first, count };
}

export class ContextsService implements ContextsPort {
  private readonly cache = new Map<string, ContextFile>();
  constructor(private readonly dependencies: ContextsDependencies) {}

  private contextPath(contextId: string): string {
    return path.join(workspaceLayout(this.dependencies.workspace.root).contexts, `${contextId}.json`);
  }

  private async load(contextId: string): Promise<ContextFile | null> {
    const cached = this.cache.get(contextId);
    if (cached) return cached;
    const stored = await readJson<ContextFile>(this.contextPath(contextId));
    if (!stored || stored.schemaVersion !== 1) return null;
    this.cache.set(contextId, stored);
    return stored;
  }

  private async save(context: ContextFile): Promise<void> {
    this.cache.set(context.contextId, context);
    await mkdir(path.dirname(this.contextPath(context.contextId)), { recursive: true });
    await writeJsonAtomic(this.contextPath(context.contextId), context);
  }

  private async require(contextId: string): Promise<ContextFile> {
    const context = await this.load(contextId);
    if (!context) throw new WorkbenchError('CONTEXT_NOT_BOUND', '当前面板还没有绑定报告会话。', false, { contextId });
    return context;
  }

  async bindContext(input: { workspaceId: string; reportId: string; viewId: string }): Promise<{ contextId: string }> {
    if (input.workspaceId !== this.dependencies.workspace.workspaceId) throw new WorkbenchError('ROOT_MISMATCH', '面板绑定的工作区与本地服务不一致。');
    await this.dependencies.workspace.getReport(input.reportId);
    const contextId = newId();
    const timestamp = nowIso();
    await this.save({ schemaVersion: 1, contextId, workspaceId: input.workspaceId, reportId: input.reportId, viewId: input.viewId, createdAt: timestamp, lastSeenAt: timestamp, selection: null });
    return { contextId };
  }

  async validateBinding(input: { contextId: string; reportId: string; viewId: string }): Promise<void> {
    const context = await this.require(input.contextId);
    if (context.reportId !== input.reportId || context.viewId !== input.viewId) throw new WorkbenchError('CONTEXT_NOT_BOUND', '终端与报告视图不匹配。');
  }

  async setSelection(input: SelectionInput): Promise<SelectionRecord> {
    const context = await this.require(input.contextId);
    if (context.reportId !== input.reportId) throw new WorkbenchError('CONTEXT_NOT_BOUND', '会话与报告不匹配，已拒绝选区。');
    if (context.viewId !== input.viewId) throw new WorkbenchError('CONTEXT_NOT_BOUND', '面板实例与绑定的视图不一致。');
    const targets: SourceTarget[] = [];
    for (const candidate of input.candidateTargets) {
      const snapshot = await this.dependencies.readTextFile(input.reportId, candidate.relativePath);
      if (snapshot.fileVersion !== candidate.expectedVersion) {
        throw new WorkbenchError('SELECTION_STALE', '候选范围的版本已变化，请重新选择。', true, { relativePath: candidate.relativePath, expected: candidate.expectedVersion, actual: snapshot.fileVersion });
      }
      if (candidate.range.end > snapshot.text.length) throw new WorkbenchError('SELECTION_STALE', '候选范围超出当前源码。');
      const anchor = anchorFrom(snapshot.text, candidate.range);
      targets.push({ relativePath: candidate.relativePath, range: candidate.range, fileVersion: snapshot.fileVersion, ...anchor });
    }
    const derivedText = input.selectedText ?? targets.map(target => target.exactText).join('\n');
    if (derivedText.length > 100_000) throw new WorkbenchError('INVALID_INPUT', '选区文本超过上限。');
    const selection: SelectionRecord = {
      workspaceId: this.dependencies.workspace.workspaceId,
      reportId: input.reportId,
      contextId: input.contextId,
      viewId: input.viewId,
      selectionId: newId(),
      kind: input.kind,
      targets,
      selectedText: derivedText,
      validity: targets.length || input.kind === 'pdf-region' ? 'valid' : 'unmapped',
      createdAt: nowIso(),
      ...(input.buildId === undefined ? {} : { buildId: input.buildId }),
      ...(input.pdfRegion === undefined ? {} : { pdfRegion: input.pdfRegion }),
    };
    context.lastSeenAt = nowIso();
    context.selection = selection;
    await this.save(context);
    return selection;
  }

  /** Re-verifies every target against real file bytes and re-anchors when the text moved. */
  async getContext(contextId: string, selectionId?: string): Promise<SelectionRecord | null> {
    const context = await this.load(contextId);
    if (!context) return null;
    if (selectionId && context.selection && context.selection.selectionId !== selectionId) return null;
    if (!context.selection) return null;
    context.lastSeenAt = nowIso();
    const { selection, changed } = await this.revalidate(context);
    if (changed) await this.save(context);
    return selection;
  }

  /** Reports the bound report without requiring an active selection (used by PDF direct edit). */
  async reportIdFor(contextId: string): Promise<string | null> {
    const context = await this.load(contextId);
    if (!context) return null;
    if (Date.parse(context.lastSeenAt) + DEFAULTS.idleShutdownMs * 4 < Date.now()) return null;
    return context.reportId;
  }

  private async revalidate(context: ContextFile): Promise<{ selection: SelectionRecord; changed: boolean }> {
    const selection = context.selection;
    if (!selection) throw new WorkbenchError('CONTEXT_NOT_BOUND', '会话没有活动选区。');
    let changed = false;
    const targets: SourceTarget[] = [];
    let validity: SelectionRecord['validity'] = 'valid';
    for (const target of selection.targets) {
      let snapshot: FileSnapshot;
      try {
        snapshot = await this.dependencies.readTextFile(selection.reportId, target.relativePath);
      } catch {
        validity = 'unmapped';
        targets.push(target);
        continue;
      }
      if (snapshot.fileVersion === target.fileVersion) {
        if (target.range.end > snapshot.text.length) {
          validity = validity === 'valid' ? 'stale' : validity;
          targets.push(target);
          continue;
        }
        targets.push({ ...target, ...anchorFrom(snapshot.text, target.range), fileVersion: snapshot.fileVersion });
        continue;
      }
      if (!target.exactText) {
        validity = validity === 'valid' ? 'stale' : validity;
        targets.push(target);
        continue;
      }
      const { index, count } = uniqueMatchIndex(snapshot.text, target.exactText);
      if (count === 1 && index >= 0) {
        const range = { start: index, end: index + target.exactText.length };
        const anchor = anchorFrom(snapshot.text, range);
        const anchorsMatch = (!target.prefix || snapshot.text.slice(Math.max(0, range.start - target.prefix.length), range.start) === target.prefix)
          && (!target.suffix || snapshot.text.slice(range.end, range.end + target.suffix.length) === target.suffix);
        if (anchorsMatch) {
          changed = true;
          targets.push({ relativePath: target.relativePath, range, fileVersion: snapshot.fileVersion, ...anchor });
          continue;
        }
      }
      validity = count > 1 ? 'ambiguous' : 'stale';
      targets.push(target);
    }
    const next: SelectionRecord = { ...selection, targets, validity };
    context.selection = next;
    return { selection: next, changed: changed || validity !== selection.validity };
  }

  async clearSelection(contextId: string): Promise<void> {
    const context = await this.require(contextId);
    context.selection = null;
    context.clearedAt = nowIso();
    context.lastSeenAt = context.clearedAt;
    await this.save(context);
  }

  async keepAlive(contextId: string, viewId: string): Promise<{ expiresAt: string }> {
    const context = await this.require(contextId);
    if (context.viewId !== viewId) throw new WorkbenchError('CONTEXT_NOT_BOUND', '面板实例与绑定视图不一致。');
    context.lastSeenAt = nowIso();
    await this.save(context);
    return { expiresAt: new Date(Date.now() + DEFAULTS.idleShutdownMs).toISOString() };
  }

  /** After a committed patch the selection follows the known edits instead of a fuzzy search. */
  async remapAfterPatch(info: PatchCommitInfo): Promise<void> {
    const context = await this.load(info.request.contextId);
    const selection = context?.selection;
    if (!context || !selection || selection.reportId !== info.reportId) return;
    if (info.request.selectionId && selection.selectionId !== info.request.selectionId) return;
    for (const file of info.files) {
      const snapshot = await this.dependencies.readTextFile(info.reportId, file.relativePath).catch(() => null);
      for (const target of selection.targets) {
        if (target.relativePath !== file.relativePath || !snapshot) continue;
        const inside = file.edits.filter(edit => edit.range.start >= target.range.start && edit.range.end <= target.range.end);
        const crossing = file.edits.some(edit => edit.range.start < target.range.end && edit.range.end > target.range.start && !(edit.range.start >= target.range.start && edit.range.end <= target.range.end));
        if (crossing) { selection.validity = 'stale'; continue; }
        if (inside.length === 0) {
          const delta = file.edits.filter(edit => edit.range.end <= target.range.start).reduce((sum, edit) => sum + edit.replacement.length - (edit.range.end - edit.range.start), 0);
          const range = { start: target.range.start + delta, end: target.range.end + delta };
          if (snapshot.text.slice(range.start, range.end) !== target.exactText) { selection.validity = 'stale'; continue; }
          Object.assign(target, { range, ...anchorFrom(snapshot.text, range), fileVersion: snapshot.fileVersion });
          continue;
        }
        // Rebuild the new selection text from the known edits, then anchor it uniquely.
        let rebuilt = '';
        let cursor = target.range.start;
        for (const edit of [...inside].sort((a, b) => a.range.start - b.range.start)) {
          rebuilt += target.exactText.slice(cursor - target.range.start, edit.range.start - target.range.start);
          rebuilt += edit.replacement;
          cursor = edit.range.end;
        }
        rebuilt += target.exactText.slice(cursor - target.range.start);
        const { index, count } = uniqueMatchIndex(snapshot.text, rebuilt);
        if (count === 1 && index >= 0) {
          const range = { start: index, end: index + rebuilt.length };
          Object.assign(target, { range, ...anchorFrom(snapshot.text, range), fileVersion: snapshot.fileVersion });
          selection.validity = 'valid';
        } else {
          selection.validity = count > 1 ? 'ambiguous' : 'stale';
        }
      }
    }
    context.lastSeenAt = nowIso();
    await this.save(context);
  }

  /** Leases are used to decide when an idle daemon may exit. */
  activeLeaseCount(): number {
    const threshold = Date.now() - DEFAULTS.idleShutdownMs;
    return [...this.cache.values()].filter(context => Date.parse(context.lastSeenAt) > threshold).length;
  }
}

export function createContexts(dependencies: ContextsDependencies): ContextsService {
  return new ContextsService(dependencies);
}

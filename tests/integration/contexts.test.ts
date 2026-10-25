import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../helpers/workspace.js';

it('moves an active target when source editing inserts text before it', async () => {
  const f = await fixture('前缀\n目标文字\n后缀\n');
  try {
    const file = await f.app.call('report_read', { reportId: f.reportId, relativePath: 'chapters/正文.tex' });
    await f.app.call('selection_set', { reportId: f.reportId, contextId: f.contextId, viewId: f.viewId, kind: 'source', candidateTargets: [{ relativePath: file.relativePath, range: { start: 3, end: 7 }, expectedVersion: file.fileVersion }] });
    await f.app.call('report_apply_patch', { reportId: f.reportId, contextId: f.contextId, scope: 'report', scopeReason: '在选区前插入', operationId: randomUUID(), files: [{ relativePath: file.relativePath, expectedVersion: file.fileVersion, edits: [{ range: { start: 0, end: 0 }, replacement: '新增😀' }] }] });
    const selection = (await f.app.call('report_context_get', { contextId: f.contextId })).selection!;
    expect(selection.targets[0]?.range).toEqual({ start: 7, end: 11 });
    expect(selection.targets[0]?.exactText).toBe('目标文字');
  } finally { await f.close(); }
});

it('keeps independent chat selections isolated, rejects scope escapes and cleared credentials', async () => {
  const f = await fixture('前段正文\n后段内容\n');
  try {
    const file = await f.app.call('report_read', { reportId: f.reportId, relativePath: 'chapters/正文.tex' });
    const view2 = randomUUID(), context2 = (await f.app.call('context_bind', { workspaceId: f.app.workspace.workspaceId, reportId: f.reportId, viewId: view2 })).contextId;
    const select = (contextId: string, viewId: string, start: number, end: number) => f.app.call('selection_set', { reportId: f.reportId, contextId, viewId, kind: 'source', candidateTargets: [{ relativePath: file.relativePath, range: { start, end }, expectedVersion: file.fileVersion }] });
    const a = (await select(f.contextId, f.viewId, 0, 4)).selection;
    const b = (await select(context2, view2, 5, 9)).selection;
    expect((await f.app.call('report_context_get', { contextId: f.contextId })).selection?.selectionId).toBe(a.selectionId);
    expect((await f.app.call('report_context_get', { contextId: context2 })).selection?.selectionId).toBe(b.selectionId);
    const patch = { reportId: f.reportId, contextId: f.contextId, selectionId: a.selectionId, scope: 'selection', operationId: randomUUID(), files: [{ relativePath: file.relativePath, expectedVersion: file.fileVersion, edits: [{ range: { start: 5, end: 9 }, replacement: '越界' }] }] };
    await expect(f.app.call('report_apply_patch', patch)).rejects.toMatchObject({ code: 'SELECTION_STALE' });
    await f.app.call('selection_clear', { contextId: f.contextId });
    expect((await f.app.call('report_context_get', { contextId: f.contextId, selectionId: a.selectionId })).selection).toBeNull();
    expect((await f.app.call('report_context_get', { contextId: context2 })).selection?.validity).toBe('valid');
  } finally { await f.close(); }
});

it('marks repeated old text ambiguous after external writes instead of applying old offsets', async () => {
  const f = await fixture('前缀\n目标文字\n后缀\n');
  try {
    const file = await f.app.call('report_read', { reportId: f.reportId, relativePath: 'chapters/正文.tex' });
    await f.app.call('selection_set', { reportId: f.reportId, contextId: f.contextId, viewId: f.viewId, kind: 'source', candidateTargets: [{ relativePath: file.relativePath, range: { start: 3, end: 7 }, expectedVersion: file.fileVersion }] });
    await writeFile(path.join(f.reportRoot, file.relativePath), '目标文字\n重复\n目标文字\n');
    expect((await f.app.call('report_context_get', { contextId: f.contextId })).selection?.validity).toBe('ambiguous');
  } finally { await f.close(); }
});

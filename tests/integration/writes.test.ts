import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../helpers/workspace.js';
import type { FileService } from '../../plugins/latex-report-workbench/src/server/files.js';

it('rolls back the first undo write immediately when the second file write fails', async () => {
  const f = await fixture('原正文\n');
  try {
    const files = await Promise.all(['main.tex', 'chapters/正文.tex'].map(relativePath => f.app.call('report_read', { reportId: f.reportId, relativePath })));
    const { operation } = await f.app.call('report_apply_patch', { reportId: f.reportId, contextId: f.contextId, scope: 'report', scopeReason: 'test', operationId: randomUUID(), files: files.map(file => ({ relativePath: file.relativePath, expectedVersion: file.fileVersion, edits: [{ range: { start: file.text.length, end: file.text.length }, replacement: '%已修改\n' }] })) });
    const fileService = f.app.services.files as FileService;
    const original = fileService.restoreFile.bind(fileService);
    let calls = 0;
    const stub = vi.spyOn(fileService, 'restoreFile').mockImplementation(async (...args) => { if (++calls === 2) throw Object.assign(new Error('simulated lock'), { code: 'EPERM' }); return original(...args); });
    await expect(f.app.call('report_undo', { reportId: f.reportId, operationId: operation.operationId, expectedCurrentVersions: operation.afterVersions, undoOperationId: randomUUID() })).rejects.toThrow('simulated lock');
    stub.mockRestore();
    for (const file of files) expect((await f.app.call('report_read', { reportId: f.reportId, relativePath: file.relativePath })).text).toBe(file.text + '%已修改\n');
  } finally { await f.close(); }
});

it('undo of a newly created source file removes it rather than leaving an empty file', async () => {
  const f = await fixture();
  try {
    const { operation } = await f.app.call('report_apply_patch', { reportId: f.reportId, contextId: f.contextId, scope: 'report', scopeReason: 'test', operationId: randomUUID(), files: [{ relativePath: 'chapters/new.tex', expectedVersion: null, edits: [{ range: { start: 0, end: 0 }, replacement: '新正文' }] }] });
    await f.app.call('report_undo', { reportId: f.reportId, operationId: operation.operationId, expectedCurrentVersions: operation.afterVersions, undoOperationId: randomUUID() });
    await expect(stat(path.join(f.reportRoot, 'chapters/new.tex'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await f.close(); }
});

it('never creates over an existing file or accepts an unbound report context', async () => {
  const f = await fixture();
  try {
    const patch = { reportId: f.reportId, contextId: f.contextId, scope: 'report', scopeReason: 'test', operationId: randomUUID(), files: [{ relativePath: 'chapters/正文.tex', expectedVersion: null, edits: [{ range: { start: 0, end: 0 }, replacement: '覆盖' }] }] };
    await expect(f.app.call('report_apply_patch', patch)).rejects.toMatchObject({ code: 'FILE_VERSION_CONFLICT' });
    const invalid = { ...patch, operationId: randomUUID(), files: [{ relativePath: 'chapters/invalid.tex', expectedVersion: null, edits: [{ range: { start: 0, end: 0 }, replacement: '\uD800' }] }] };
    await expect(f.app.call('report_apply_patch', invalid)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(f.app.call('report_apply_patch', { ...invalid, operationId: randomUUID(), files: [{ ...invalid.files[0]!, edits: [{ range: { start: 0, end: 0 }, replacement: '中'.repeat(700_000) }] }] })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    const before = await f.app.call('report_read', { reportId: f.reportId, relativePath: 'chapters/正文.tex' });
    await expect(f.app.call('draft_save', { reportId: f.reportId, contextId: randomUUID(), relativePath: before.relativePath, baseVersion: before.fileVersion, text: '越权', operationId: randomUUID() })).rejects.toMatchObject({ code: 'CONTEXT_NOT_BOUND' });
    expect((await f.app.call('report_read', { reportId: f.reportId, relativePath: before.relativePath })).text).toBe(before.text);
  } finally { await f.close(); }
});

it('retries a draft save exactly once, preserves BOM/EOL and rejects stale concurrent writes', async () => {
  const f = await fixture('\uFEFF正文😀\r\n第二行\r\n');
  try {
    const before = await f.app.call('report_read', { reportId: f.reportId, relativePath: 'chapters/正文.tex' });
    const save = { reportId: f.reportId, contextId: f.contextId, relativePath: before.relativePath, baseVersion: before.fileVersion, text: before.text.replace('正文', '修改'), operationId: randomUUID() };
    const first = await f.app.call('draft_save', save);
    expect((await f.app.call('draft_save', save)).operation).toEqual(first.operation);
    expect((await readFile(path.join(f.reportRoot, before.relativePath))).toString()).toBe('\uFEFF修改😀\r\n第二行\r\n');
    await expect(f.app.call('draft_save', { ...save, operationId: randomUUID(), text: '并发覆盖' })).rejects.toMatchObject({ code: 'FILE_VERSION_CONFLICT' });
    expect((await f.app.call('report_history', { reportId: f.reportId })).operations).toHaveLength(1);
  } finally { await f.close(); }
});

it('validates every file before undo so a conflict cannot leave a partial undo', async () => {
  const f = await fixture('旧章节\n');
  try {
    const a = await f.app.call('report_read', { reportId: f.reportId, relativePath: 'main.tex' });
    const b = await f.app.call('report_read', { reportId: f.reportId, relativePath: 'chapters/正文.tex' });
    const { operation } = await f.app.call('report_apply_patch', { reportId: f.reportId, contextId: f.contextId, scope: 'report', scopeReason: 'test', operationId: randomUUID(), files: [a, b].map(file => ({ relativePath: file.relativePath, expectedVersion: file.fileVersion, edits: [{ range: { start: 0, end: file.text.length }, replacement: file.text + '%追加\n' }] })) });
    await writeFile(path.join(f.reportRoot, 'main.tex'), a.text + '%外部修改\n');
    await expect(f.app.call('report_undo', { reportId: f.reportId, operationId: operation.operationId, expectedCurrentVersions: operation.afterVersions, undoOperationId: randomUUID() })).rejects.toMatchObject({ code: 'FILE_VERSION_CONFLICT' });
    expect((await f.app.call('report_read', { reportId: f.reportId, relativePath: b.relativePath })).text).toContain('%追加');
    expect((await f.app.call('report_history', { reportId: f.reportId })).operations).toHaveLength(1);
  } finally { await f.close(); }
});

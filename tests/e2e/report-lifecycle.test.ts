import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fixture } from '../helpers/workspace.js';
import { startWorkspaceDaemon } from '../../plugins/latex-report-workbench/src/server/daemon.js';
import { connectWorkspaceService } from '../../plugins/latex-report-workbench/src/server/service-client.js';

it('local HTTP lifecycle: create → chapter/file tree → bind/select → write → history → undo → export', async () => {
  const f = await fixture();
  await f.app.close();
  const service = await startWorkspaceDaemon(f.root, { port: 0 });
  try {
    const client = await connectWorkspaceService(f.root);
    const { report } = await client.call('report_create', { title: '完整生命周期演示', templateId: 'chinese-report', operationId: randomUUID() });
    const viewId = randomUUID();
    const { contextId } = await client.call('context_bind', { workspaceId: service.app.workspace.workspaceId, reportId: report.reportId, viewId });
    const outline = await client.call('report_tree', { reportId: report.reportId, kind: 'outline' });
    expect(outline.nodes.length).toBeGreaterThan(0);
    const relativePath = 'chapters/02-method.tex';
    const file = await client.call('report_read', { reportId: report.reportId, relativePath });
    const start = file.text.indexOf('这里'), end = file.text.indexOf('\n', start);
    const { selection } = await client.call('selection_set', { reportId: report.reportId, contextId, viewId, kind: 'source', candidateTargets: [{ relativePath, range: { start, end }, expectedVersion: file.fileVersion }] });
    const { operation } = await client.call('report_apply_patch', { reportId: report.reportId, contextId, selectionId: selection.selectionId, scope: 'selection', operationId: randomUUID(), files: [{ relativePath, expectedVersion: file.fileVersion, edits: [{ range: { start, end }, replacement: '通过同一本地服务修改中文正文😀。' }] }] });
    expect((await client.call('report_read', { reportId: report.reportId, relativePath })).text).toContain('修改中文正文😀');
    expect((await client.call('report_history', { reportId: report.reportId })).operations).toHaveLength(1);
    await client.call('selection_clear', { contextId });
    expect((await client.call('report_context_get', { contextId })).selection).toBeNull();
    await client.call('report_undo', { reportId: report.reportId, operationId: operation.operationId, expectedCurrentVersions: operation.afterVersions, undoOperationId: randomUUID() });
    expect((await client.call('report_read', { reportId: report.reportId, relativePath })).text).toBe(file.text);
    const exported = await client.call('report_export', { reportId: report.reportId, format: 'source-zip', operationId: randomUUID() });
    const bytes = await readFile(path.join(f.root, report.rootRelativePath, exported.relativePath));
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
  } finally { await service.close(); await f.close(); }
});

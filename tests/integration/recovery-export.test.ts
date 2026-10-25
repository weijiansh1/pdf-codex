import { expect, it } from 'vitest';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from '../helpers/workspace.js';
import { createApplication } from '../../plugins/latex-report-workbench/src/server/application.js';
import { HistoryStore } from '../../plugins/latex-report-workbench/src/server/history.js';
import { sha256 } from '../../plugins/latex-report-workbench/src/server/store.js';
import { startWorkspaceDaemon } from '../../plugins/latex-report-workbench/src/server/daemon.js';
import { connectWorkspaceService } from '../../plugins/latex-report-workbench/src/server/service-client.js';

function unzip(bytes: Buffer) {
  const entries: Record<string, Buffer> = {};
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8), size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const body = bytes.subarray(start, start + size);
    entries[name] = method === 8 ? inflateRawSync(body) : body;
    offset = start + size;
  }
  return entries;
}

it('exports valid UTF-8 source ZIP with no histories, credentials, intermediate files or exports', async () => {
  const f = await fixture();
  try {
    for (const name of ['.git', '.latex-workspace', 'exports']) {
      await mkdir(path.join(f.reportRoot, name)); await writeFile(path.join(f.reportRoot, name, 'secret.txt'), 'secret');
    }
    await writeFile(path.join(f.reportRoot, 'main.aux'), 'intermediate');
    const request = { reportId: f.reportId, format: 'source-zip', operationId: randomUUID() };
    const exported = await f.app.call('report_export', request);
    expect(await f.app.call('report_export', request)).toEqual(exported);
    const entries = unzip(await readFile(path.join(f.reportRoot, exported.relativePath)));
    expect(Object.keys(entries)).toContain('chapters/正文.tex');
    expect(entries['chapters/正文.tex']?.toString()).toBe('正文😀\n');
    expect(Object.keys(entries).some(name => /secret|\.aux|exports/.test(name))).toBe(false);
  } finally { await f.close(); }
});

it('recovers a prepared transaction on service restart and retains newer external bytes', async () => {
  const f = await fixture('修改前\n');
  let reopened;
  try {
    const file = 'chapters/正文.tex', before = await readFile(path.join(f.reportRoot, file)), after = Buffer.from('未提交\n');
    const history = new HistoryStore(f.app.workspace);
    const journal = await history.beginJournal(f.reportId, randomUUID(), [{ relativePath: file, beforeVersion: sha256(before), afterVersion: sha256(after), before, after }]);
    await writeFile(path.join(f.reportRoot, file), after); await journal.markProgress(file);
    await f.app.close(); reopened = await createApplication(f.root);
    await reopened.recover();
    expect(await readFile(path.join(f.reportRoot, file))).toEqual(before);
    const external = Buffer.from('外部新稿\n');
    await history.beginJournal(f.reportId, randomUUID(), [{ relativePath: file, beforeVersion: sha256(before), afterVersion: sha256(after), before, after }]);
    await writeFile(path.join(f.reportRoot, file), external);
    await reopened.recover();
    expect(await readFile(path.join(f.reportRoot, file))).toEqual(external);
  } finally { await reopened?.close(); await f.close(); }
});
it('recovers a new-file transaction without erasing newer external content', async () => {
  const f = await fixture();
  try {
    const history = new HistoryStore(f.app.workspace);
    const after = Buffer.from('未提交');
    for (const [file, contents] of [['chapters/new.tex', after], ['chapters/external.tex', Buffer.from('外部稿件')]] as const) {
      await history.beginJournal(f.reportId, randomUUID(), [{ relativePath: file, beforeVersion: null, afterVersion: sha256(after), before: Buffer.alloc(0), after }]);
      await writeFile(path.join(f.reportRoot, file), contents);
    }
    await f.app.recover();
    await expect(readFile(path.join(f.reportRoot, 'chapters/new.tex'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readFile(path.join(f.reportRoot, 'chapters/external.tex'))).toString()).toBe('外部稿件');
  } finally { await f.close(); }
});

it('routes independent stdio clients to one daemon with the same context and write lock', async () => {
  const f = await fixture();
  await f.app.close();
  const daemon = await startWorkspaceDaemon(f.root, { port: 0 });
  try {
    const a = await connectWorkspaceService(f.root), b = await connectWorkspaceService(f.root);
    const { contextId } = await a.call('context_bind', { workspaceId: daemon.app.workspace.workspaceId, reportId: f.reportId, viewId: f.viewId });
    const file = await a.call('report_read', { reportId: f.reportId, relativePath: 'chapters/正文.tex' });
    const { selection } = await a.call('selection_set', { reportId: f.reportId, contextId, viewId: f.viewId, kind: 'source', candidateTargets: [{ relativePath: file.relativePath, range: { start: 0, end: 2 }, expectedVersion: file.fileVersion }] });
    expect((await b.call('report_context_get', { contextId, selectionId: selection.selectionId })).selection?.selectedText).toBe('正文');
    await expect(startWorkspaceDaemon(f.root, { port: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await daemon.close();
    const replacement = await startWorkspaceDaemon(f.root, { port: 0 });
    try { expect((await a.call('workspace_status', {})).workspaceId).toBe(replacement.app.workspace.workspaceId); }
    finally { await replacement.close(); }
  } finally { await daemon.close().catch(() => undefined); await f.close(); }
});

it('imports an existing report outside reports and rediscovers it after restart', async () => {
  const f = await fixture(); let reopened;
  try {
    const directory = path.join(f.root, '已有 文档'); await mkdir(directory);
    await writeFile(path.join(directory, 'report.tex'), '\\documentclass{article}\n\\begin{document}Text\\end{document}');
    const imported = await f.app.call('report_import', { rootRelativePath: '已有 文档', mainFile: 'report.tex', operationId: randomUUID() });
    expect(imported.report.rootRelativePath).toBe('已有 文档');
    await f.app.close(); reopened = await createApplication(f.root);
    expect((await reopened.call('report_open', { reportId: imported.report.reportId })).report.mainFile).toBe('report.tex');
  } finally { await reopened?.close(); await f.close(); }
});

import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalService } from '../../plugins/latex-report-workbench/src/server/terminal.js';
import { fixture } from '../helpers/workspace.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const waitFor = async (predicate: () => boolean) => { const end = Date.now() + 8000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 30)); expect(predicate()).toBe(true); };
async function setup() {
  const f = await fixture(); cleanups.push(f.close);
  // A real PTY process, with no network/model cost. Raw mode also exposes Unicode/Ctrl+C bugs.
  const terminal = new TerminalService(f.app, { launch: async () => ({ file: process.execPath, args: ['-e', "process.stdin.setRawMode(true);process.stdout.write('READY\\r\\nECHO:');process.stdin.on('data',d=>{process.stdout.write(d);if(d.includes(13))process.stdout.write('[SUBMITTED]');if(d.includes(3))process.exit(7)})"] }) });
  cleanups.push(() => terminal.close());
  return { ...f, terminal, binding: { reportId: f.reportId, contextId: f.contextId, viewId: f.viewId } };
}

it('reconnects the same view/report to one real PTY, replays Unicode, resizes and propagates exit', async () => {
  const f = await setup();
  const s = await f.terminal.create(f.binding);
  expect((await f.terminal.create(f.binding)).sessionId).toBe(s.sessionId);
  let output = ''; let code: number | undefined;
  const unsubscribe = f.terminal.subscribe(s.sessionId, event => { if (event.type === 'output') output += event.data; if (event.type === 'exit') code = event.exitCode; });
  await waitFor(() => output.includes('READY'));
  f.terminal.resize(s.sessionId, 122, 31);
  f.terminal.input(s.sessionId, '中文😀');
  await waitFor(() => output.includes('ECHO:中文😀'));
  unsubscribe();
  let replay = ''; const detach = f.terminal.subscribe(s.sessionId, event => { if (event.type === 'output') replay += event.data; });
  expect(replay).toContain('中文😀'); detach();
  const again = f.terminal.subscribe(s.sessionId, event => { if (event.type === 'exit') code = event.exitCode; });
  f.terminal.input(s.sessionId, '\x03');
  await waitFor(() => code === 7); again();
  expect(f.terminal.get(s.sessionId).state).toBe('exited');
  expect(() => f.terminal.input(s.sessionId, 'late')).toThrow();
});

it('submits a UI request with one explicit action while preserving literal paste', async () => {
  const f = await setup(); const s = await f.terminal.create(f.binding);
  let output = ''; const detach = f.terminal.subscribe(s.sessionId, e => { if (e.type === 'output') output += e.data; });
  await waitFor(() => output.includes('READY'));
  await f.terminal.request(s.sessionId, '直接修改这份报告', f.binding, true);
  await waitFor(() => output.includes('[SUBMITTED]'));
  expect(output).toContain('直接修改这份报告'); detach();
});

it('delivers a real selected chart as MCP image content and revokes delayed images on binding changes', async () => {
  const f = await setup();
  const config = JSON.parse(await readFile(path.join(f.reportRoot, '.latex-report.json'), 'utf8'));
  await writeFile(path.join(f.reportRoot, '.latex-report.json'), JSON.stringify({ ...config, mainFile: 'main.html' }));
  await writeFile(path.join(f.reportRoot, 'main.html'), '<figure><svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="blue"/></svg><figcaption>标定曲线</figcaption></figure>');
  const preview = await f.app.call('report_preview', { reportId: f.reportId });
  const { selection } = await f.app.call('html_select', { ...f.binding, expectedVersion: preview.fileVersion, blockId: preview.blocks.find(block => block.tag === 'figure')!.blockId });
  const binding = { ...f.binding, selectionId: selection.selectionId };
  const session = await f.terminal.create(binding);
  const target = await f.terminal.call(session.sessionId, 'terminal_target', {}) as { visualImages: { mimeType: string; data: string }[] };
  expect(target.visualImages[0]?.mimeType).toBe('image/png');
  expect(Buffer.from(target.visualImages[0]!.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
  const { terminalToolContent } = await import('../../plugins/latex-report-workbench/src/shared/terminal-content.js');
  const result = terminalToolContent(target);
  expect(result.content.some(content => content.type === 'image')).toBe(true);
  expect(result.content.filter(content => content.type === 'text').map(content => content.text).join('')).not.toContain(target.visualImages[0]!.data);
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const called = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(f.app.services.html, 'preview').mockImplementationOnce(async () => { entered(); await gate; return preview; });
  const pending = f.terminal.call(session.sessionId, 'terminal_target', {}).then(() => 'leaked', () => 'rejected');
  await called; f.terminal.suspend(session.sessionId); release(); expect(await pending).toBe('rejected');
});

it('rejects unbounded input and invalid terminal dimensions', async () => {
  const f = await setup(); const s = await f.terminal.create(f.binding);
  expect(() => f.terminal.resize(s.sessionId, -1, 24)).toThrow();
  expect(() => f.terminal.resize(s.sessionId, 80, 10001)).toThrow();
  expect(() => f.terminal.input(s.sessionId, 'x'.repeat(131073))).toThrow();
});

it('pastes complete Chinese requests literally without terminal control injection or implicit Enter', async () => {
  const f = await setup(); const s = await f.terminal.create(f.binding);
  let output = ''; const detach = f.terminal.subscribe(s.sessionId, event => { if (event.type === 'output') output += event.data; });
  await waitFor(() => output.includes('READY'));
  const prompt = '保留公式' + '数据分析'.repeat(1500) + '\x1b[201~\r\x03END';
  await f.terminal.request(s.sessionId, prompt);
  await waitFor(() => output.includes('END'));
  expect(output).toContain('数据分析'.repeat(1500));
  expect(f.terminal.get(s.sessionId).state).toBe('running');
  detach();
});

it('rejects a context from another report even if it belongs to the same view', async () => {
  const f = await setup();
  const other = await f.app.call('report_create', { title: '另一报告', templateId: 'chinese-report', operationId: randomUUID() });
  await expect(f.terminal.create({ ...f.binding, reportId: other.report.reportId })).rejects.toThrow();
});

it('limits MCP writes to the real selected report/context and preserves transaction history', async () => {
  const f = await setup();
  const file = await f.app.call('report_read', { reportId: f.reportId, relativePath: 'chapters/正文.tex' });
  const { selection } = await f.app.call('selection_set', { ...f.binding, kind: 'source', candidateTargets: [{ relativePath: file.relativePath, range: { start: 0, end: 2 }, expectedVersion: file.fileVersion }] });
  const s = await f.terminal.create({ ...f.binding, selectionId: selection.selectionId });
  const request = { ...f.binding, selectionId: selection.selectionId, scope: 'selection', operationId: randomUUID(), files: [{ relativePath: file.relativePath, expectedVersion: file.fileVersion, edits: [{ range: { start: 0, end: 2 }, replacement: '改字' }] }] };
  const { viewId: _, ...patch } = request;
  await expect(f.terminal.call(s.sessionId, 'draft_save', {})).rejects.toThrow();
  await expect(f.terminal.call(s.sessionId, 'report_read', { reportId: randomUUID(), relativePath: 'main.tex' })).rejects.toThrow();
  await expect(f.terminal.call(s.sessionId, 'report_apply_patch', { ...patch, scope: 'report', scopeReason: 'bypass' })).rejects.toThrow();
  await f.terminal.call(s.sessionId, 'report_apply_patch', patch);
  expect(await readFile(path.join(f.reportRoot, file.relativePath), 'utf8')).toBe('改字😀\n');
  const history = await f.app.call('report_history', { reportId: f.reportId });
  expect(history.operations.some(op => op.operationId === patch.operationId && op.origin === 'codex' && op.state === 'committed')).toBe(true);
});

it('does not widen a stale or pending target and stops the PTY on service close', async () => {
  const f = await setup(); const s = await f.terminal.create(f.binding);
  await expect(f.terminal.bind(s.sessionId, { ...f.binding, selectionId: randomUUID() })).rejects.toThrow();
  await expect(f.terminal.call(s.sessionId, 'report_apply_patch', {})).rejects.toThrow();
  await f.terminal.bind(s.sessionId, f.binding);
  f.terminal.suspend(s.sessionId);
  await expect(f.terminal.call(s.sessionId, 'report_apply_patch', {})).rejects.toThrow();
  await f.terminal.close();
  expect(f.terminal.hasActiveWork()).toBe(false);
  expect(() => f.terminal.get(s.sessionId)).toThrow();
});

it('a delayed bind cannot restore write access after a newer suspension', async () => {
  const f = await setup(); const s = await f.terminal.create(f.binding);
  const validate = f.app.services.contexts.validateBinding.bind(f.app.services.contexts);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.app.services.contexts, 'validateBinding').mockImplementationOnce(async input => { await gate; await validate(input); });
  const pending = f.terminal.bind(s.sessionId, f.binding);
  f.terminal.suspend(s.sessionId);
  release(); await pending.catch(() => undefined);
  await expect(f.terminal.call(s.sessionId, 'terminal_target', {})).rejects.toThrow();
});

it('revokes a patch already queued behind the report transaction lock', async () => {
  const f = await setup(); const s = await f.terminal.create(f.binding);
  const snapshot = await f.app.call('report_read', { reportId: f.reportId, relativePath: 'chapters/正文.tex' });
  let release!: () => void; let locked!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { locked = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const files = f.app.services.files as import('../../plugins/latex-report-workbench/src/server/files.js').FileService;
  const holder = files.withReportLock(f.reportId, async () => { locked(); await gate; }); await held;
  const call = f.app.call.bind(f.app);
  vi.spyOn(f.app, 'call').mockImplementation(async (name, input, ...rest) => { if (name === 'report_apply_patch') entered(); return call(name, input, ...rest); });
  const patch = f.terminal.call(s.sessionId, 'report_apply_patch', { reportId: f.reportId, contextId: f.contextId, scope: 'report', scopeReason: 'fixture', operationId: randomUUID(), files: [{ relativePath: snapshot.relativePath, expectedVersion: snapshot.fileVersion, edits: [{ range: { start: 0, end: 2 }, replacement: '改字' }] }] });
  const outcome = patch.then(() => 'committed', () => 'rejected');
  await reached; f.terminal.suspend(s.sessionId); release(); await holder;
  expect(await outcome).toBe('rejected');
  expect((await f.app.call('report_read', { reportId: f.reportId, relativePath: snapshot.relativePath })).text).toBe('正文😀\n');
});

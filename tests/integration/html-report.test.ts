import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../helpers/workspace.js';
import { HistoryStore } from '../../plugins/latex-report-workbench/src/server/history.js';
import * as store from '../../plugins/latex-report-workbench/src/server/store.js';

export const HTML = '<!doctype html><html><head><style>body{color:#123}</style></head><body><h1>快速报告😀</h1><section><h2>实验分析</h2><p>原始正文</p><p>公式 <span data-tex="p+\\frac12\\rho v^2=C"></span></p></section><script>parent.hacked=true</script><img src="https://invalid.example/x" onerror="alert(1)"></body></html>';
export async function htmlFixture() {
  const f = await fixture();
  const manifestPath = path.join(f.reportRoot, '.latex-report.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, mainFile: 'main.html', bibliography: 'none' }));
  await writeFile(path.join(f.reportRoot, 'main.html'), HTML);
  return f;
}

describe('HTML daily authoring', () => {
  it.each(['switch', 'undo'] as const)('keeps the report discoverable when the %s rollback is interrupted', async phase => {
    const f = await fixture();
    let journal: ReturnType<typeof vi.spyOn> | undefined;
    let replacement: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const manifest = await f.app.call('report_read', { reportId: f.reportId, relativePath: '.latex-report.json' });
      const patch = { reportId: f.reportId, contextId: f.contextId, scope: 'report', scopeReason: '用户切换网页工作稿', operationId: randomUUID(), files: [
        { relativePath: '.latex-report.json', expectedVersion: manifest.fileVersion, edits: [{ range: { start: 0, end: manifest.text.length }, replacement: JSON.stringify({ ...JSON.parse(manifest.text), mainFile: 'main.html' }) }] },
        { relativePath: 'main.html', expectedVersion: null, edits: [{ range: { start: 0, end: 0 }, replacement: HTML }] },
      ] };
      const switched = phase === 'undo' ? await f.app.call('report_apply_patch', patch) : null;
      const failedOperationId = phase === 'switch' ? patch.operationId : randomUUID();
      const originalJournal = HistoryStore.prototype.beginJournal;
      const originalReplace = store.replaceFileWithRetry;
      let recovering = false;
      journal = vi.spyOn(HistoryStore.prototype, 'beginJournal').mockImplementation(async function (this: HistoryStore, ...args) {
        const prepared = await originalJournal.apply(this, args);
        if (args[1] !== failedOperationId) return prepared;
        return { ...prepared, markProgress: async relativePath => {
          await prepared.markProgress(relativePath);
          if (relativePath === (phase === 'switch' ? '.latex-report.json' : 'main.html')) { recovering = true; throw new Error('interrupted last entry write'); }
        } };
      });
      replacement = vi.spyOn(store, 'replaceFileWithRetry').mockImplementation(async (...args) => {
        if (recovering && path.basename(args[0]) === (phase === 'switch' ? '.latex-report.json' : 'main.html')) throw new Error('interrupted rollback');
        return originalReplace(...args);
      });
      const action = phase === 'switch' ? f.app.call('report_apply_patch', patch) : f.app.call('report_undo', { reportId: f.reportId, operationId: switched!.operation.operationId, expectedCurrentVersions: switched!.operation.afterVersions, undoOperationId: failedOperationId });
      await expect(action).rejects.toThrow('interrupted rollback');
      replacement.mockRestore(); journal.mockRestore();
      expect((await f.app.call('report_open', { reportId: f.reportId })).report.mainFile).toBe(phase === 'switch' ? 'main.html' : 'main.tex');
      await f.app.recover();
      expect((await f.app.call('report_open', { reportId: f.reportId })).report.mainFile).toBe(phase === 'switch' ? 'main.tex' : 'main.html');
      expect((await f.app.call('report_read', { reportId: f.reportId, relativePath: 'main.tex' })).text).toContain('\\documentclass');
      expect(f.app.services.buildQueue.hasActiveWork()).toBe(false);
    } finally { replacement?.mockRestore(); journal?.mockRestore(); await f.close(); }
  });

  it('keeps the original report discoverable if an entry switch fails after its first write', async () => {
    const f = await fixture();
    const originalJournal = HistoryStore.prototype.beginJournal;
    const journal = vi.spyOn(HistoryStore.prototype, 'beginJournal').mockImplementation(async function (this: HistoryStore, ...args) {
      const prepared = await originalJournal.apply(this, args);
      return { ...prepared, markProgress: async relativePath => { await prepared.markProgress(relativePath); throw new Error('interrupted entry switch'); } };
    });
    try {
      const manifest = await f.app.call('report_read', { reportId: f.reportId, relativePath: '.latex-report.json' });
      const next = JSON.stringify({ ...JSON.parse(manifest.text), mainFile: 'main.html' });
      await f.app.call('report_apply_patch', { reportId: f.reportId, contextId: f.contextId, scope: 'report', scopeReason: '用户切换网页工作稿', operationId: randomUUID(), files: [
        { relativePath: '.latex-report.json', expectedVersion: manifest.fileVersion, edits: [{ range: { start: 0, end: manifest.text.length }, replacement: next }] },
        { relativePath: 'main.html', expectedVersion: null, edits: [{ range: { start: 0, end: 0 }, replacement: HTML }] },
      ] }).catch(() => undefined);
      expect(await readFile(path.join(f.reportRoot, '.latex-report.json'), 'utf8')).toBe(manifest.text);
      expect((await f.app.call('report_open', { reportId: f.reportId })).report.mainFile).toBe('main.tex');
      await expect(readFile(path.join(f.reportRoot, 'main.html'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.app.services.buildQueue.hasActiveWork()).toBe(false);
    } finally { journal.mockRestore(); await f.close(); }
  });

  it('switches to an editable HTML entry without compiling and can undo back to the original TeX', async () => {
    const f = await fixture();
    try {
      const manifest = await f.app.call('report_read', { reportId: f.reportId, relativePath: '.latex-report.json' });
      const originalTex = await readFile(path.join(f.reportRoot, 'main.tex'));
      const next = JSON.stringify({ ...JSON.parse(manifest.text), mainFile: 'main.html' });
      const { operation, buildId } = await f.app.call('report_apply_patch', { reportId: f.reportId, contextId: f.contextId, scope: 'report', scopeReason: '用户切换网页工作稿', operationId: randomUUID(), files: [
        { relativePath: '.latex-report.json', expectedVersion: manifest.fileVersion, edits: [{ range: { start: 0, end: manifest.text.length }, replacement: next }] },
        { relativePath: 'main.html', expectedVersion: null, edits: [{ range: { start: 0, end: 0 }, replacement: HTML }] },
      ] });
      expect(buildId).toBeNull();
      const preview = await f.app.call('report_preview', { reportId: f.reportId });
      expect(preview.relativePath).toBe('main.html');
      expect(preview.blocks.find(block => block.text === '原始正文')?.editable).toBe(true);
      expect(f.app.services.buildQueue.hasActiveWork()).toBe(false);
      await f.app.call('report_undo', { reportId: f.reportId, operationId: operation.operationId, expectedCurrentVersions: operation.afterVersions, undoOperationId: randomUUID() });
      expect((await f.app.call('report_open', { reportId: f.reportId })).report.mainFile).toBe('main.tex');
      expect(await readFile(path.join(f.reportRoot, 'main.tex'))).toEqual(originalTex);
      await expect(readFile(path.join(f.reportRoot, 'main.html'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await f.close(); }
  });

  it('creates an HTML report and saves through history without scheduling TeX', async () => {
    const f = await fixture();
    try {
      const { report } = await f.app.call('report_create', { title: '快速报告', templateId: 'html-report', operationId: randomUUID() });
      expect(report.mainFile).toBe('main.html');
      const { contextId } = await f.app.call('context_bind', { workspaceId: f.app.workspace.workspaceId, reportId: report.reportId, viewId: randomUUID() });
      const before = await f.app.call('report_read', { reportId: report.reportId, relativePath: 'main.html' });
      const result = await f.app.call('draft_save', { reportId: report.reportId, contextId, relativePath: 'main.html', baseVersion: before.fileVersion, text: before.text.replace('实验数据', '新实验数据'), operationId: randomUUID() });
      expect(result.buildId).toBeNull();
      expect((await f.app.call('report_read', { reportId: report.reportId, relativePath: 'main.html' })).text).toContain('新实验数据');
      expect(f.app.services.buildQueue.hasActiveWork()).toBe(false);
      expect((await f.app.call('report_history', { reportId: report.reportId })).operations).toHaveLength(1);
    } finally { await f.close(); }
  });

  it('renders formulas without TeX, binds server-derived blocks and safely edits ordinary text', async () => {
    const f = await htmlFixture();
    try {
      const preview = await f.app.call('report_preview', { reportId: f.reportId });
      expect(preview.html).toContain('<math');
      expect(preview.html).not.toContain('parent.hacked');
      expect(preview.html).not.toContain('onerror=');
      expect(preview.html).not.toContain('https://invalid.example');
      const block = preview.blocks.find(b => b.text === '原始正文')!;
      expect(block.editable).toBe(true);
      const bound = await f.app.call('html_select', { reportId: f.reportId, contextId: f.contextId, viewId: f.viewId, expectedVersion: preview.fileVersion, blockId: block.blockId });
      expect(bound.selection.targets[0]?.exactText).toBe('<p>原始正文</p>');
      const edit = { reportId: f.reportId, contextId: f.contextId, viewId: f.viewId, expectedVersion: preview.fileVersion, blockId: block.blockId, text: '更新 <正文> & 分析', operationId: randomUUID() };
      const result = await f.app.call('html_edit', edit);
      expect(result.buildId).toBeNull();
      expect(await f.app.call('html_edit', edit)).toEqual(result);
      const saved = await readFile(path.join(f.reportRoot, 'main.html'), 'utf8');
      expect(saved).toContain('更新 &lt;正文&gt; &amp; 分析');
      expect(saved).toContain('data-tex="p+\\frac12\\rho v^2=C"');
      await expect(f.app.call('html_edit', { reportId: f.reportId, contextId: f.contextId, viewId: f.viewId, expectedVersion: preview.fileVersion, blockId: block.blockId, text: '旧版本', operationId: randomUUID() })).rejects.toMatchObject({ code: 'FILE_VERSION_CONFLICT' });
      expect((await f.app.call('report_history', { reportId: f.reportId })).operations[0]?.origin).toBe('source-editor');
    } finally { await f.close(); }
  });

  it('protects formula blocks and refuses cross-view edits and forged block ids', async () => {
    const f = await htmlFixture();
    try {
      const preview = await f.app.call('report_preview', { reportId: f.reportId });
      const formula = preview.blocks.find(b => b.text.startsWith('公式'))!;
      expect(formula.editable).toBe(true);
      expect(formula.runs?.map(run => run.text)).toEqual(['公式 ']);
      const input = { reportId: f.reportId, contextId: f.contextId, viewId: f.viewId, expectedVersion: preview.fileVersion, blockId: formula.blockId, text: '不能替换', operationId: randomUUID() };
      await expect(f.app.call('html_edit', input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(f.app.call('html_edit', { ...input, viewId: randomUUID() })).rejects.toMatchObject({ code: 'CONTEXT_NOT_BOUND' });
      await expect(f.app.call('html_select', { reportId: f.reportId, contextId: f.contextId, viewId: f.viewId, expectedVersion: preview.fileVersion, blockId: 'forged' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(f.app.services.buildQueue.hasActiveWork()).toBe(false);
    } finally { await f.close(); }
  });

  it('refreshes external HTML changes and records Codex patch / undo without an automatic build', async () => {
    const f = await htmlFixture();
    try {
      await f.app.services.watcher.start();
      const file = await f.app.call('report_read', { reportId: f.reportId, relativePath: 'main.html' });
      const start = file.text.indexOf('原始正文');
      const patched = await f.app.call('report_apply_patch', { reportId: f.reportId, contextId: f.contextId, scope: 'report', scopeReason: '用户更新实验说明', operationId: randomUUID(), files: [{ relativePath: 'main.html', expectedVersion: file.fileVersion, edits: [{ range: { start, end: start + 4 }, replacement: '模型更新正文' }] }] });
      expect(patched.buildId).toBeNull();
      expect((await f.app.call('report_preview', { reportId: f.reportId })).html).toContain('模型更新正文');
      await f.app.call('report_undo', { reportId: f.reportId, operationId: patched.operation.operationId, expectedCurrentVersions: patched.operation.afterVersions, undoOperationId: randomUUID() });
      const event = new Promise<void>(resolve => { const off = f.app.subscribe(value => { if (value.reportId === f.reportId && value.kind === 'files-changed') { off(); resolve(); } }); });
      await writeFile(path.join(f.reportRoot, 'main.html'), HTML.replace('原始正文', '磁盘刷新正文'));
      await event;
      expect((await f.app.call('report_preview', { reportId: f.reportId })).html).toContain('磁盘刷新正文');
      await expect(f.app.call('report_build_status', { reportId: f.reportId })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(f.app.services.buildQueue.hasActiveWork()).toBe(false);
    } finally { await f.close(); }
  });
});

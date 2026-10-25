import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../helpers/workspace.js';
import { startHttpServer } from '../../plugins/latex-report-workbench/src/server/daemon.js';

async function paperFixture(generated = false) {
  const f = await fixture();
  const config = JSON.parse(await readFile(path.join(f.reportRoot, '.latex-report.json'), 'utf8'));
  await writeFile(path.join(f.reportRoot, '.latex-report.json'), JSON.stringify({ ...config, mainFile: 'main.html', ...(generated ? { generatedFrom: 'source.py' } : {}) }));
  await mkdir(path.join(f.reportRoot, 'paper'));
  await writeFile(path.join(f.reportRoot, 'paper/图 1.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><text x="0" y="20">图表</text></svg>');
  await writeFile(path.join(f.reportRoot, 'paper.css'), 'main{max-width:840px}.toc{width:210px}');
  await writeFile(path.join(f.reportRoot, 'main.html'), '<!doctype html><html><head><link rel="stylesheet" href="paper.css?v=2"></head><body><nav><a href="#results">结果</a></nav><main><h1>论文稿</h1><h2 id="results">结果</h2><figure><img src="paper/%E5%9B%BE%201.svg?v=115348#chart" alt="图 1"><figcaption>图 1 结果</figcaption></figure><div class="eq">E = mc²<span class="eqno">(1)</span></div><p>原稿正文</p></main></body></html>');
  if (generated) await writeFile(path.join(f.reportRoot, 'source.py'), 'TITLE = "原稿标题"\n');
  return f;
}

it('loads encoded SVG and CSS resources with queries while preserving paper anchors and formula blocks', async () => {
  const f = await paperFixture();
  try {
    const preview = await f.app.call('report_preview', { reportId: f.reportId });
    expect(preview.html).toContain('data:image/svg+xml;base64,');
    expect(preview.html).toContain('main{max-width:840px}');
    expect(preview.html).toContain('href="#results"');
    const equation = preview.blocks.find(block => block.tag === 'div' && block.text.includes('E = mc²'));
    expect(equation?.editable).toBe(false);
    const figure = preview.blocks.find(block => block.tag === 'figure')!;
    const selected = await f.app.call('html_select', { reportId: f.reportId, contextId: f.contextId, viewId: f.viewId, expectedVersion: preview.fileVersion, blockId: figure.blockId });
    expect(selected.selection.selectedText).toBe('图 1 结果');
    expect(selected.selection.targets[0]?.exactText).toContain('<figure>');
    await writeFile(path.join(f.reportRoot, 'main.html'), '<img src="%2e%2e/outside.svg?v=1">');
    await expect(f.app.call('report_preview', { reportId: f.reportId })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  } finally { await f.close(); }
});

it('keeps generated HTML read-only and edits its declared source through the normal transaction', async () => {
  const f = await paperFixture(true);
  try {
    const preview = await f.app.call('report_preview', { reportId: f.reportId });
    expect(preview.generatedFrom).toBe('source.py');
    const paragraph = preview.blocks.find(block => block.tag === 'p')!;
    await expect(f.app.call('html_edit', { reportId: f.reportId, contextId: f.contextId, viewId: f.viewId, expectedVersion: preview.fileVersion, blockId: paragraph.blockId, text: '不能覆盖输出', operationId: randomUUID() })).rejects.toMatchObject({ code: 'GENERATED_OUTPUT_READ_ONLY' });
    await expect(f.app.call('draft_save', { reportId: f.reportId, contextId: f.contextId, relativePath: 'main.html', baseVersion: preview.fileVersion, text: '<p>也不能从源码编辑器覆盖</p>', operationId: randomUUID() })).rejects.toMatchObject({ code: 'GENERATED_OUTPUT_READ_ONLY' });
    const source = await f.app.call('report_read', { reportId: f.reportId, relativePath: 'source.py' });
    const saved = await f.app.call('draft_save', { reportId: f.reportId, contextId: f.contextId, relativePath: 'source.py', baseVersion: source.fileVersion, text: 'TITLE = "更新标题"\n', operationId: randomUUID() });
    expect(saved.buildId).toBeNull();
    expect((await readFile(path.join(f.reportRoot, 'source.py'), 'utf8'))).toBe('TITLE = "更新标题"\n');
    expect(await readFile(path.join(f.reportRoot, 'main.html'), 'utf8')).toContain('原稿正文');
  } finally { await f.close(); }
});

it('creates a longform paper with separate styles and an internal table of contents', async () => {
  const f = await fixture();
  try {
    const { report } = await f.app.call('report_create', { title: '论文默认模板', templateId: 'html-paper', operationId: randomUUID() });
    expect(report.mainFile).toBe('main.html');
    const preview = await f.app.call('report_preview', { reportId: report.reportId });
    expect(preview.html).toContain('paper-shell');
    expect(preview.html).toContain('href="#results"');
    expect(preview.html).toContain('max-width:1120px');
    expect(preview.html).not.toContain('data-page-width');
  } finally { await f.close(); }
});

it('permits embedded preview images through the inherited HTTP content policy', async () => {
  const f = await fixture();
  const ui = path.join(f.root, 'preview-ui'); await mkdir(ui); await writeFile(path.join(ui, 'index.html'), '<div id="root"></div>');
  const server = await startHttpServer(f.app, { port: 0, uiDirectory: ui });
  try {
    const response = await fetch(server.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("img-src 'self' data:");
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  } finally { await server.close(); await f.close(); }
});

it('rejects silently changing a registered report into a generated report', async () => {
  const f = await paperFixture();
  try {
    await writeFile(path.join(f.reportRoot, 'source.py'), 'TITLE = "原稿"\n');
    const report = await f.app.workspace.getReport(f.reportId);
    await expect(f.app.call('report_import', { rootRelativePath: report.rootRelativePath, mainFile: 'main.html', generatedFrom: 'source.py', operationId: randomUUID() })).rejects.toMatchObject({ code: 'INVALID_REPORT_CONFIG' });
    expect((await f.app.workspace.getReport(f.reportId)).generatedFrom).toBeUndefined();
  } finally { await f.close(); }
});

it('does not let old undo history overwrite HTML after it is declared as generated', async () => {
  const f = await paperFixture();
  try {
    const before = await f.app.call('report_read', { reportId: f.reportId, relativePath: 'main.html' });
    const changed = before.text.replace('原稿正文', '更新正文');
    const saved = await f.app.call('draft_save', { reportId: f.reportId, contextId: f.contextId, relativePath: 'main.html', baseVersion: before.fileVersion, text: changed, operationId: randomUUID() });
    const configPath = path.join(f.reportRoot, '.latex-report.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    await writeFile(path.join(f.reportRoot, 'source.py'), 'TITLE = "原稿"\n');
    await writeFile(configPath, JSON.stringify({ ...config, generatedFrom: 'source.py' }));
    await expect(f.app.call('report_undo', { reportId: f.reportId, operationId: saved.operation.operationId, expectedCurrentVersions: saved.operation.afterVersions, undoOperationId: randomUUID() })).rejects.toMatchObject({ code: 'GENERATED_OUTPUT_READ_ONLY' });
    expect(await readFile(path.join(f.reportRoot, 'main.html'), 'utf8')).toBe(changed);
  } finally { await f.close(); }
});

import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../helpers/workspace.js';

it('edits rich text runs without flattening emphasis, formula, citation, comments or BOM/CRLF', async () => {
  const f = await fixture();
  try {
    const config = JSON.parse(await readFile(path.join(f.reportRoot, '.latex-report.json'), 'utf8'));
    await writeFile(path.join(f.reportRoot, '.latex-report.json'), JSON.stringify({ ...config, mainFile: 'main.html' }));
    const html = '\uFEFF<html>\r\n<body><p>结果 <strong>显著</strong><!-- 原注释 --><span data-tex="x^2"></span><a href="#ref1">[1]</a>，误差 &#60; 2%。</p></body>\r\n</html>';
    await writeFile(path.join(f.reportRoot, 'main.html'), html);
    const preview = await f.app.call('report_preview', { reportId: f.reportId });
    const block = preview.blocks.find(block => block.tag === 'p')!;
    expect(block.editable).toBe(true);
    expect(block.runs?.map(run => run.text)).toEqual(['结果 ', '显著', '，误差 < 2%。']);
    const base = { reportId: f.reportId, contextId: f.contextId, viewId: f.viewId, expectedVersion: preview.fileVersion, blockId: block.blockId };
    await expect(f.app.call('html_edit', { ...base, operationId: randomUUID(), changes: [{ runId: 'forged', text: '破坏公式' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(f.app.call('html_edit', { ...base, operationId: randomUUID(), text: '压平成纯文字' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await f.app.call('html_edit', { ...base, operationId: randomUUID(), changes: block.runs!.map((run, i) => ({ ...run, text: i === 1 ? '明显 & 稳定' : run.text })) });
    expect(await readFile(path.join(f.reportRoot, 'main.html'), 'utf8')).toBe(html.replace('<strong>显著</strong>', '<strong>明显 &amp; 稳定</strong>'));
    await expect(f.app.call('html_edit', { ...base, operationId: randomUUID(), changes: [{ runId: block.runs![0]!.runId, text: '过期' }] })).rejects.toMatchObject({ code: 'FILE_VERSION_CONFLICT' });
  } finally { await f.close(); }
});

it('edits an explicit TeX formula attribute through the same conditional transaction', async () => {
  const f = await fixture();
  try {
    const config = JSON.parse(await readFile(path.join(f.reportRoot, '.latex-report.json'), 'utf8'));
    await writeFile(path.join(f.reportRoot, '.latex-report.json'), JSON.stringify({ ...config, mainFile: 'main.html' }));
    await writeFile(path.join(f.reportRoot, 'main.html'), '<p>公式 <span data-tex="x^2" data-display="block"></span><!-- 保留 --></p>');
    const preview = await f.app.call('report_preview', { reportId: f.reportId });
    const block = preview.blocks.find(block => block.formula === 'x^2')!;
    expect(block).toBeTruthy();
    await f.app.call('html_edit', { reportId: f.reportId, contextId: f.contextId, viewId: f.viewId, expectedVersion: preview.fileVersion, blockId: block.blockId, formula: 'q=\\frac12\\rho V^2', operationId: randomUUID() });
    expect(await readFile(path.join(f.reportRoot, 'main.html'), 'utf8')).toContain('data-tex="q=\\frac12\\rho V^2" data-display="block"></span><!-- 保留 -->');
  } finally { await f.close(); }
});

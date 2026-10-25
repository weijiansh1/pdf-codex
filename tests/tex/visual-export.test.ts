import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fixture } from '../helpers/workspace.js';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="160"><rect width="360" height="160" fill="#164c96"/><text x="20" y="80" fill="white" font-size="30">SVG 图表</text></svg>';

it('exports a paper without its navigation sidebar or reserved sidebar column', async () => {
  const f = await fixture();
  try {
    const config = JSON.parse(await readFile(path.join(f.reportRoot, '.latex-report.json'), 'utf8'));
    await writeFile(path.join(f.reportRoot, '.latex-report.json'), JSON.stringify({ ...config, mainFile: 'main.html' }));
    const text = `<!doctype html><html><head><style>
      *{box-sizing:border-box}body{margin:0;font:16px Arial;background:#f7f8fb}
      .paper-shell{display:grid;grid-template-columns:210px minmax(0,840px);gap:28px;max-width:1120px;margin:auto;padding:28px 20px 60px}
      main{min-width:0;padding:48px 28px 80px;background:white;box-shadow:0 0 0 1px #ddd}
      .toc{position:sticky;top:24px;padding:16px;border:1px solid #ddd;background:white}
      .edges{display:flex;justify-content:space-between}
      </style></head><body><div class="paper-shell">
      <aside class="toc"><div>SIDEBAR_TITLE</div><nav><a href="#body">SIDEBAR_LINK</a></nav></aside>
      <main id="body"><div class="edges"><span>LEFT_EDGE</span><span>RIGHT_EDGE</span></div>
      <h1>报告正文</h1><aside>SCIENTIFIC_NOTE</aside><p>正文、图表及补充说明应保留。</p></main>
      </div></body></html>`;
    await writeFile(path.join(f.reportRoot, 'main.html'), text);
    const result = await f.app.call('report_export', { reportId: f.reportId, format: 'web-pdf', operationId: randomUUID() });
    const pdf = path.join(f.reportRoot, result.relativePath);
    const { stdout } = await promisify(execFile)('pdftotext', ['-enc', 'UTF-8', '-bbox', pdf, '-'], { shell: false, windowsHide: true });
    expect(stdout).not.toContain('SIDEBAR_TITLE');
    expect(stdout).not.toContain('SIDEBAR_LINK');
    expect(stdout).toContain('SCIENTIFIC_NOTE');
    expect(stdout).toContain('报告正文');
    const left = /<word xMin="([\d.]+)"[^>]*>LEFT_EDGE<\/word>/.exec(stdout);
    const right = /<word[^>]*xMax="([\d.]+)"[^>]*>RIGHT_EDGE<\/word>/.exec(stdout);
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    // A4 with 12 mm margins: the body must span the printable width, not a grid's second column.
    expect(Number(left![1])).toBeGreaterThan(30);
    expect(Number(left![1])).toBeLessThan(40);
    expect(Number(right![1])).toBeGreaterThan(550);
    expect(Number(right![1])).toBeLessThan(565);
    expect(await readFile(path.join(f.reportRoot, 'main.html'), 'utf8')).toBe(text);
    expect(result.buildId).toBeUndefined();
  } finally { await f.close(); }
}, 60_000);

it('prints the frozen HTML appearance as a one-page Chinese PDF without a TeX build', async () => {
  const f = await fixture();
  try {
    const config = JSON.parse(await readFile(path.join(f.reportRoot, '.latex-report.json'), 'utf8'));
    await writeFile(path.join(f.reportRoot, '.latex-report.json'), JSON.stringify({ ...config, mainFile: 'main.html' }));
    await writeFile(path.join(f.reportRoot, '图 1.svg'), svg);
    const text = '<html><head><style>body{margin:0}.slide{width:1280px;height:720px;background:#edf2ff;padding:40px;box-sizing:border-box}h1{font-size:48px}img{width:500px}</style></head><body><main class="slide" data-report-layout="slide"><h1>网页样式实验报告</h1><img src="%E5%9B%BE%201.svg?v=2#chart"><p data-tex="q=\\frac12\\rho V^2"></p><script>throw Error("never execute")</script></main></body></html>';
    await writeFile(path.join(f.reportRoot, 'main.html'), text);
    const result = await f.app.call('report_export', { reportId: f.reportId, format: 'web-pdf', operationId: randomUUID() });
    expect(result.buildId).toBeUndefined();
    const pdf = path.join(f.reportRoot, result.relativePath);
    expect((await readFile(pdf)).subarray(0, 5).toString()).toBe('%PDF-');
    const { stdout } = await promisify(execFile)('pdftotext', ['-enc', 'UTF-8', pdf, '-'], { shell: false, windowsHide: true });
    expect(stdout).toContain('网页样式实验报告');
    const info = await promisify(execFile)('pdfinfo', [pdf], { shell: false, windowsHide: true });
    expect(info.stdout).toMatch(/Pages:\s+1\b/);
    expect(info.stdout).toMatch(/Page size:\s+960 x 540 pts/);
    expect(await readFile(path.join(f.reportRoot, 'main.html'), 'utf8')).toBe(text);
    expect(await readdir(path.join(f.app.workspace.layout.builds, f.reportId)).catch(() => [])).toEqual([]);
  } finally { await f.close(); }
}, 60_000);

it('converts local and inline SVG to PNG in a frozen LaTeX export, including encoded query paths', async () => {
  const f = await fixture();
  try {
    const { generateHtmlLatex } = await import('../../plugins/latex-report-workbench/src/server/html-export.js');
    await writeFile(path.join(f.reportRoot, '图 1.svg'), svg);
    await writeFile(path.join(f.reportRoot, 'main.html'), `<h1>图表导出</h1><img src="%E5%9B%BE%201.svg?v=2#chart">${svg}`);
    await expect(generateHtmlLatex(f.reportRoot, 'main.html', new AbortController().signal)).resolves.toBe('generated-report.tex');
    const tex = await readFile(path.join(f.reportRoot, 'generated-report.tex'), 'utf8');
    expect(tex.match(/includegraphics/g)?.length).toBe(2);
    const names = await readdir(f.reportRoot);
    const images = names.filter(name => /^generated-image-.*\.png$/.test(name));
    expect(images).toHaveLength(2);
    for (const name of images) expect((await readFile(path.join(f.reportRoot, name))).subarray(1, 4).toString()).toBe('PNG');
  } finally { await f.close(); }
}, 60_000);

it('compiles an SVG chart through the real LaTeX PDF export', async () => {
  const f = await fixture();
  try {
    const config = JSON.parse(await readFile(path.join(f.reportRoot, '.latex-report.json'), 'utf8'));
    await writeFile(path.join(f.reportRoot, '.latex-report.json'), JSON.stringify({ ...config, mainFile: 'main.html' }));
    await writeFile(path.join(f.reportRoot, 'chart.svg'), svg);
    await writeFile(path.join(f.reportRoot, 'main.html'), '<h1>SVG 中文图表验收</h1><p>标定曲线导出</p><img src="chart.svg?v=3">');
    const result = await f.app.call('report_export', { reportId: f.reportId, format: 'pdf', operationId: randomUUID() });
    expect(result.buildId).toBeTruthy();
    const { stdout } = await promisify(execFile)('pdftotext', ['-enc', 'UTF-8', path.join(f.reportRoot, result.relativePath), '-'], { shell: false, windowsHide: true });
    expect(stdout).toContain('SVG 中文图表验收');
    const generated = await readFile(path.join(f.app.workspace.layout.builds, f.reportId, result.buildId!, 'source', 'generated-report.tex'), 'utf8');
    expect(generated).toContain('generated-image-1.png');
  } finally { await f.close(); }
}, 120_000);

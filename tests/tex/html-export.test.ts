import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fixture } from '../helpers/workspace.js';

it('exports the current HTML through real Pandoc and XeLaTeX without writing generated TeX to the report', async () => {
  const f = await fixture();
  try {
    const { report } = await f.app.call('report_create', { title: 'HTML 导出验收', templateId: 'html-report', operationId: randomUUID() });
    const { contextId } = await f.app.call('context_bind', { workspaceId: f.app.workspace.workspaceId, reportId: report.reportId, viewId: randomUUID() });
    const source = await f.app.call('report_read', { reportId: report.reportId, relativePath: report.mainFile });
    const saved = await f.app.call('draft_save', { reportId: report.reportId, contextId, relativePath: report.mainFile, baseVersion: source.fileVersion, text: source.text.replace('<h1>实验数据可视化与分析</h1>', '<h1>最终中文实验分析</h1>'), operationId: randomUUID() });
    expect(saved.buildId).toBeNull();
    const exported = await f.app.call('report_export', { reportId: report.reportId, format: 'pdf', operationId: randomUUID() });
    expect(exported.buildId).toBeTruthy();
    const { build } = await f.app.call('report_build_status', { reportId: report.reportId, buildId: exported.buildId! });
    expect(build.status, JSON.stringify(build.diagnostics)).toBe('succeeded');
    const sourceAfter = await f.app.call('report_read', { reportId: report.reportId, relativePath: report.mainFile });
    expect(build.inputVersions['main.html']).toBe(sourceAfter.fileVersion);
    const root = path.join(f.root, report.rootRelativePath);
    const tree = await f.app.call('report_tree', { reportId: report.reportId, kind: 'files' });
    expect(JSON.stringify(tree)).not.toContain('generated-report.tex');
    const generated = await readFile(path.join(f.app.workspace.layout.builds, report.reportId, build.buildId, 'source', 'generated-report.tex'), 'utf8');
    expect(generated).toContain('最终中文实验分析');
    expect(generated).toContain('\\frac{1}{2}');
    const { stdout: content } = await promisify(execFile)('pdftotext', ['-enc', 'UTF-8', path.join(root, exported.relativePath), '-'], { shell: false, windowsHide: true, encoding: 'utf8' });
    expect(content).toContain('最终中文实验分析');
    expect(content).toContain('结果分析');
    const { stdout: info } = await promisify(execFile)('pdfinfo', [path.join(root, exported.relativePath)], { shell: false, windowsHide: true, encoding: 'utf8' });
    expect(info).toMatch(/Pages:\s+1\b/);
    expect(info).toMatch(/Page size:\s+\d+[.\d]* x \d+[.\d]* pts/);
  } finally { await f.close(); }
}, 120_000);

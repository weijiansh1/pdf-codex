import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApplication, type Application } from '../../plugins/latex-report-workbench/src/server/application.js';
import type { BuildRecord } from '../../plugins/latex-report-workbench/src/shared/contracts.js';

const id = '11111111-1111-4111-8111-111111111111';
let root: string;
const opened: Application[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'latex-framework-'));
  await mkdir(path.join(root, 'reports', '中文 报告', 'chapters'), { recursive: true });
  await writeFile(path.join(root, 'reports', '中文 报告', '.latex-report.json'), JSON.stringify({ schemaVersion: 1, reportId: id, title: '实验报告', mainFile: 'main.tex', engine: 'xelatex', bibliography: 'auto' }));
  await writeFile(path.join(root, 'reports', '中文 报告', 'main.tex'), '\\input{chapters/绪论}');
  await writeFile(path.join(root, 'reports', '中文 报告', 'chapters', '绪论.tex'), '正文😀\r\n');
});

afterEach(async () => {
  for (const app of opened.splice(0)) await app.close();
  if (!root || path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('latex-framework-')) throw new Error('Unsafe test cleanup');
  await rm(root, { recursive: true, force: true });
});

async function open(): Promise<Application> {
  const app = await createApplication(root);
  opened.push(app);
  return app;
}

async function waitForBuild(app: Application, reportId: string, buildId: string): Promise<BuildRecord> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const { build } = await app.call('report_build_status', { reportId, buildId });
    if (build.status === 'succeeded' || build.status === 'failed' || build.status === 'cancelled') return build;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('构建在测试超时前没有进入终态。');
}

describe('本地报告框架', () => {
  it('列出报告、读取真实文件并显示目录树', async () => {
    const app = await open();
    const list = await app.call('report_list', {});
    expect(list.reports[0]?.reportId).toBe(id);
    const file = await app.call('report_read', { reportId: id, relativePath: 'chapters/绪论.tex' });
    expect(file.text).toBe('正文😀\n');
    const tree = await app.call('report_tree', { reportId: id, kind: 'files' });
    expect(JSON.stringify(tree)).toContain('绪论.tex');
  });

  it('缺 \\documentclass 的 fixture 编译必须如实失败，不能伪造成功', async () => {
    const app = await open();
    const { buildId } = await app.call('report_compile', { reportId: id });
    const build = await waitForBuild(app, id, buildId);
    expect(build.status).toBe('failed');
    expect(build.diagnostics.some(diagnostic => diagnostic.severity === 'error')).toBe(true);
    expect(build.pdfAssetId).toBeUndefined();
  }, 90_000);

  it('PDF 文字编辑要求已绑定上下文，而不是声称未实现', async () => {
    const app = await open();
    await expect(app.call('pdf_edit_open', { reportId: id, contextId: id, viewId: id, buildId: id, page: 1, point: { x: 10, y: 10 } }))
      .rejects.toMatchObject({ code: 'CONTEXT_NOT_BOUND' });
    expect(app.features().find(feature => feature.id === 'pdf-direct-edit')?.status).toBe('implemented');
  });

  it('注册配置变化会改变报告 revision', async () => {
    const app = await open();
    const before = (await app.call('report_list', {})).reports[0]!.reportRevision;
    await writeFile(path.join(root, 'reports', '中文 报告', '.latex-report.json'), JSON.stringify({ schemaVersion: 1, reportId: id, title: '改名后的报告', mainFile: 'main.tex', engine: 'lualatex', bibliography: 'none' }));
    expect((await app.call('report_list', {})).reports[0]!.reportRevision).not.toBe(before);
  });

  it('拒绝路径穿越、绝对路径和 junction 越界', async () => {
    const app = await open();
    await expect(app.call('report_read', { reportId: id, relativePath: '../main.tex' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(app.call('report_read', { reportId: id, relativePath: 'C:/secret.tex' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await symlink(root, path.join(root, 'reports', '中文 报告', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(app.call('report_read', { reportId: id, relativePath: 'escape/reports/中文 报告/main.tex' })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });
});

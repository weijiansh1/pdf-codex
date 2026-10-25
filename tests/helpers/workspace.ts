import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../../plugins/latex-report-workbench/src/server/application.js';
import type { Application } from '../../plugins/latex-report-workbench/src/server/application.js';

export async function fixture(text = '正文😀\n', main = '\\documentclass[UTF8]{ctexart}\n\\begin{document}\n\\input{chapters/正文}\n\\end{document}\n') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latex-workbench-test-'));
  const reportId = randomUUID();
  const reportRoot = path.join(root, 'reports', '中文 空格报告');
  await mkdir(path.join(reportRoot, 'chapters'), { recursive: true });
  await writeFile(path.join(reportRoot, '.latex-report.json'), JSON.stringify({ schemaVersion: 1, reportId, title: '验收报告', mainFile: 'main.tex', engine: 'xelatex', bibliography: 'auto' }));
  await writeFile(path.join(reportRoot, 'main.tex'), main);
  await writeFile(path.join(reportRoot, 'chapters/正文.tex'), text);
  const app = await createApplication(root);
  const viewId = randomUUID();
  const { contextId } = await app.call('context_bind', { workspaceId: app.workspace.workspaceId, reportId, viewId });
  return { root, reportRoot, reportId, viewId, contextId, app, async close() {
    await app.close();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('latex-workbench-test-')) throw new Error('unsafe cleanup');
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } };
}
export async function settled(app: Application, reportId: string, buildId: string) {
  const limit = Date.now() + 120_000;
  while (Date.now() < limit) {
    const { build } = await app.call('report_build_status', { reportId, buildId });
    if (['succeeded', 'failed', 'cancelled'].includes(build.status)) return build;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('build timeout');
}

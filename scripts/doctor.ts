import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApplication } from '../plugins/latex-report-workbench/src/server/application.js';
import { workspaceArgument } from '../plugins/latex-report-workbench/src/server/daemon.js';
import { findBrowser } from '../plugins/latex-report-workbench/src/server/static-renderer.js';
const run = promisify(execFile);
const checks = await Promise.all(['latexmk', 'xelatex', 'synctex', 'biber', 'pandoc', 'pdftoppm', 'pdfinfo'].map(async command => {
  try { const { stdout } = await run(command, [command === 'latexmk' ? '-v' : '--version'], { windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 65_536 }); const lines = stdout.trim().split(/\r?\n/); return { command, available: true, version: (lines.find(line => /version|latexmk|xetex|biber/i.test(line)) ?? lines[0]) }; }
  catch (error) { const failure = error as { code?: string; killed?: boolean }; return { command, available: null, probeStatus: failure.killed ? 'timeout' : 'failed', reason: failure.code ?? 'unknown' }; }
}));
try { checks.push({ command: 'web-pdf-browser', available: true, version: findBrowser() }); } catch (error) { checks.push({ command: 'web-pdf-browser', available: null, probeStatus: 'failed', reason: (error as Error).message }); }
const app = await createApplication(workspaceArgument());
const status = await app.call('workspace_status', {});
console.log(JSON.stringify({ node: process.version, workspace: status.root, workspaceId: status.workspaceId, mode: 'local-workbench', checks, desktopHost: 'unverified', compiler: 'implemented; real-TeX acceptance in tests/tex' }, null, 2));
await app.close();

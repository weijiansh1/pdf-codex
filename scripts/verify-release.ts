import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const directoryIndex = process.argv.indexOf('--directory');
const source = directoryIndex >= 0 ? path.resolve(process.argv[directoryIndex + 1]!)
  : (JSON.parse(await readFile(path.join(projectRoot, '.latex-workspace/packages/latest-release.json'), 'utf8')) as { directory: string }).directory;
assert(await stat(path.join(source, 'start.mjs')).then(s => s.isFile()).catch(() => false), '发布包缺少可移植启动器 start.mjs');
const metadata = JSON.parse(await readFile(path.join(source, 'release.json'), 'utf8')) as { version: string; platform: string; arch: string };
assert.equal(metadata.platform, process.platform); assert.equal(metadata.arch, process.arch);
const packageInfo = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')) as { name: string; bin?: Record<string, string> };
assert.equal(packageInfo.name, 'copdf', '发布包必须使用copdf名称');
assert.equal(packageInfo.bin?.copdf, 'bin/copdf.mjs', '发布包缺少copdf命令入口');
const inspect = async (folder: string, relative = ''): Promise<void> => {
  for (const item of await readdir(folder, { withFileTypes: true })) {
    const next = relative ? `${relative}/${item.name}` : item.name;
    assert(!item.isSymbolicLink(), `发布包包含符号链接：${next}`);
    assert(!['reports', '.latex-workspace', '.git', 'node_modules'].includes(item.name) || next.includes('/vendor/'), `发布包混入本地数据：${next}`);
    if (item.isDirectory()) await inspect(path.join(folder, item.name), next);
    else if (/\.(?:json|js|mjs|md|html)$/.test(item.name)) {
      const text = await readFile(path.join(folder, item.name), 'utf8');
      for (const forbidden of [projectRoot.replace(/[\\/]$/, ''), projectRoot.replaceAll('\\', '/').replace(/\/$/, ''), projectRoot.replaceAll('\\', '\\\\').replace(/[\\/]$/, '')]) {
        assert(!text.includes(forbidden), `发布包保留开发者绝对路径：${next}`);
      }
    }
  }
};
await inspect(source);
const isolated = await mkdtemp(path.join(os.tmpdir(), 'pdf-codex-release-'));
const unpacked = path.join(isolated, '中文 解压包');
let client: Client | undefined;
try {
  await cp(source, unpacked, { recursive: true });
  const root = await realpath(unpacked);
  const launch = () => run(process.execPath, [path.join(unpacked, 'start.mjs'), '--no-open'], { cwd: isolated, shell: false, windowsHide: true, timeout: 30_000 });
  await launch();
  const readService = async () => JSON.parse(await readFile(path.join(unpacked, '.latex-workspace/runtime/service.json'), 'utf8')) as { root: string; pid: number; url: string; token: string };
  const first = await readService();
  assert.equal(first.root, root);
  await launch();
  assert.equal((await readService()).pid, first.pid, '重复启动必须复用同一daemon');
  const page = await fetch(first.url); assert.equal(page.status, 200); assert((await page.text()).includes('id="root"'));
  const tool = async (name: string, input: unknown) => {
    const response = await fetch(`${first.url}/api/tools/${name}`, { method: 'POST', headers: { authorization: `Bearer ${first.token}`, 'content-type': 'application/json', 'x-latex-protocol': '1' }, body: JSON.stringify(input) });
    const value = await response.json() as { ok: boolean; result: any; error?: unknown };
    assert(response.ok && value.ok, JSON.stringify(value.error)); return value.result;
  };
  const initial = await tool('report_list', {}); assert.equal(initial.reports.length, 0, '下载包不应包含用户报告');
  const { report } = await tool('report_create', { title: '发布包启动验收', templateId: 'html-paper', operationId: randomUUID() });
  const preview = await tool('report_preview', { reportId: report.reportId });
  assert(preview.html.includes('paper-shell')); assert(preview.html.includes('<math'));
  const exported = await tool('report_export', { reportId: report.reportId, format: 'web-pdf', operationId: randomUUID() });
  const pdf = await readFile(path.join(root, report.rootRelativePath, exported.relativePath));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-'); assert(!exported.buildId);
  const mcp = JSON.parse(await readFile(path.join(unpacked, 'mcp.json'), 'utf8')).mcpServers['latex-report-workbench'] as { command: string; args: string[] };
  client = new Client({ name: 'portable-release-verifier', version: metadata.version });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: mcp.args, cwd: isolated, stderr: 'pipe', env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), PLUGIN_ROOT: root, LATEX_REPORT_WORKSPACE: root } }));
  const tools = await client.listTools(); assert.equal(tools.tools.length, 32);
  const status = await client.callTool({ name: 'workspace_status', arguments: {} });
  assert.equal((status.structuredContent as { root: string }).root, root);
  assert.equal((await readService()).pid, first.pid, 'stdio和HTTP必须复用同一daemon');
  const release = JSON.parse(await readFile(path.join(projectRoot, '.latex-workspace/packages/latest-release.json'), 'utf8')) as { npmPackage: string };
  assert(process.env.npm_execpath, '请用npm run verify:release执行npm安装验收');
  const prefix = path.join(isolated, 'npm 全局安装');
  await run(process.execPath, [process.env.npm_execpath, 'install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--offline', release.npmPackage], { cwd: isolated, shell: false, windowsHide: true, timeout: 40_000, maxBuffer: 2_097_152 });
  const installed = path.join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules/copdf');
  const installedCli = path.join(installed, 'bin/copdf.mjs');
  const help = await run(process.execPath, [installedCli, '--help'], { cwd: unpacked, shell: false, windowsHide: true });
  assert(help.stdout.includes('用法：copdf'));
  await run(process.execPath, [installedCli, '--no-open'], { cwd: unpacked, shell: false, windowsHide: true, timeout: 30_000 });
  assert.equal((await readService()).pid, first.pid, 'npm命令默认使用当前报告目录');
  assert(await stat(path.join(prefix, process.platform === 'win32' ? 'copdf.cmd' : 'bin/copdf')).then(s => s.isFile()));
  // Check the real installed native SVG payload as well as the CLI's JavaScript.
  const svgProbe = "const {Resvg}=require(process.argv[1]);const b=new Resvg('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"10\"></svg>').render().asPng();if(Buffer.from(b).subarray(1,4).toString()!=='PNG')process.exit(3);";
  await run(process.execPath, ['-e', svgProbe, path.join(installed, 'dist/server/vendor/node_modules/@resvg/resvg-js/index.js')], { cwd: isolated, shell: false, windowsHide: true, timeout: 15_000 });
  const nativeProbe = "const p=require(process.argv[1]).spawn(process.execPath,['-e',\"process.stdout.write('PORTABLE_PTY_OK');setTimeout(()=>process.exit(0),150)\"],{cwd:process.cwd(),env:process.env,cols:80,rows:24,useConpty:true,useConptyDll:true});p.onData(d=>process.stdout.write(d));p.onExit(e=>process.exit(e.exitCode));setTimeout(()=>process.exit(2),10000).unref();";
  const native = await run(process.execPath, ['-e', nativeProbe, path.join(root, 'dist/server/vendor/node-pty/lib/index.js')], { cwd: isolated, shell: false, windowsHide: true, timeout: 15_000 });
  assert(native.stdout.includes('PORTABLE_PTY_OK'));
  const result = { version: metadata.version, platform: metadata.platform, arch: metadata.arch, movedDirectory: true, differentCwd: true, noNodeModules: true, singleDaemon: true, http: true, stdioTools: tools.tools.length, htmlAndMath: true, realWebPdf: true, nativePty: true, npmGlobalInstall: true, npmBinCurrentDirectory: true, npmNativeSvg: true, pdfSha256: createHash('sha256').update(pdf).digest('hex') };
  await writeFile(path.join(projectRoot, '.latex-workspace/packages/release-verification.json'), JSON.stringify(result, null, 2));
  console.log(`可移植发布包验收通过：${JSON.stringify(result)}`);
} finally {
  await client?.close();
  const service = JSON.parse(await readFile(path.join(unpacked, '.latex-workspace/runtime/service.json'), 'utf8').catch(() => '{}')) as { root?: string; pid?: number };
  if (service.pid && service.root === await realpath(unpacked).catch(() => '') && service.pid !== process.pid) {
    try { process.kill(service.pid); } catch { /* exited */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (path.dirname(isolated) !== path.resolve(os.tmpdir()) || !path.basename(isolated).startsWith('pdf-codex-release-')) throw new Error('unsafe release fixture cleanup');
  await rm(isolated, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

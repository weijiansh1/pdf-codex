import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOL_NAMES } from '../plugins/latex-report-workbench/src/shared/tool-catalog.js';
import { UI_RESOURCE_URI } from '../plugins/latex-report-workbench/src/server/mcp.js';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = new URL('../plugins/latex-report-workbench/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('plugin.json', pluginRoot), 'utf8')) as { name: string; version: string };
const project = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as { version: string };
assert.equal(manifest.name, 'latex-report-workbench'); assert.equal(manifest.version, project.version);
const latest = JSON.parse(await readFile(path.join(projectRoot, '.latex-workspace/packages/latest.json'), 'utf8')) as { directory: string };
const isolated = await mkdtemp(path.join(os.tmpdir(), 'latex-package-'));
const cached = path.join(isolated, '插件 缓存');
await cp(latest.directory, cached, { recursive: true });
const workspace = path.join(isolated, '工作区'); await mkdir(workspace);
const config = JSON.parse(await readFile(path.join(cached, 'mcp.json'), 'utf8')).mcpServers['latex-report-workbench'] as { command: string; args: string[] };
const args = [...config.args]; args[args.length - 1] = workspace;
const transport = new StdioClientTransport({ command: config.command, args, env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), PLUGIN_ROOT: cached }, cwd: isolated, stderr: 'pipe' });
const client = new Client({ name: 'framework-package-verifier', version: '0.1.0' });
let stderr = ''; transport.stderr?.on('data', chunk => { stderr += String(chunk); });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [...TOOL_NAMES].sort());
  const open = tools.tools.find(tool => tool.name === 'workbench_open');
  assert.equal((open?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri, UI_RESOURCE_URI);
  const nonce = randomUUID(); const echo = await client.callTool({ name: 'probe_echo', arguments: { nonce } });
  assert.equal(echo.isError, undefined); assert.equal((echo.structuredContent as { nonce: string }).nonce, nonce);
  const deferred = await client.callTool({ name: 'report_compile', arguments: { reportId: randomUUID() } });
  assert.equal(deferred.isError, true); assert.equal((deferred.structuredContent as { error: { code: string } }).error.code, 'REPORT_NOT_FOUND');
  const resources = await client.listResources(); assert(resources.resources.some(resource => resource.uri === UI_RESOURCE_URI));
  const resource = await client.readResource({ uri: UI_RESOURCE_URI }); const content = resource.contents[0];
  assert(content && 'text' in content && typeof content.text === 'string' && content.text.includes('<div id="root">'));
  assert.equal(content.mimeType, 'text/html;profile=mcp-app');
  assert(!content.text.includes('src="/assets/')); assert(!content.text.includes('href="/assets/'));
  const status = await client.callTool({ name: 'workspace_status', arguments: {} });
  assert.equal((status.structuredContent as { root: string }).root, workspace);
  const created = await client.callTool({ name: 'report_create', arguments: { title: '缓存安装验收', templateId: 'chinese-report', operationId: randomUUID() } });
  assert.equal(created.isError, undefined, JSON.stringify(created));
  const htmlCreated = await client.callTool({ name: 'report_create', arguments: { title: 'HTML 缓存验收', templateId: 'html-report', operationId: randomUUID() } });
  assert.equal(htmlCreated.isError, undefined, JSON.stringify(htmlCreated));
  const htmlReport = (htmlCreated.structuredContent as { report: { reportId: string; mainFile: string } }).report;
  assert.equal(htmlReport.mainFile, 'main.html');
  const preview = await client.callTool({ name: 'report_preview', arguments: { reportId: htmlReport.reportId } });
  assert.equal(preview.isError, undefined, JSON.stringify(preview));
  assert((preview.structuredContent as { html: string }).html.includes('<math'));
  const paperCreated = await client.callTool({ name: 'report_create', arguments: { title: '论文缓存验收', templateId: 'html-paper', operationId: randomUUID() } });
  assert.equal(paperCreated.isError, undefined, JSON.stringify(paperCreated));
  const paperId = (paperCreated.structuredContent as { report: { reportId: string } }).report.reportId;
  const paperPreview = await client.callTool({ name: 'report_preview', arguments: { reportId: paperId } });
  assert.equal(paperPreview.isError, undefined, JSON.stringify(paperPreview));
  assert((paperPreview.structuredContent as { html: string }).html.includes('max-width:1120px'));
  assert((paperPreview.structuredContent as { html: string }).html.includes('href="#results"'));
  assert((await readFile(path.join(cached, 'dist/ui/html-preview.js'), 'utf8')).includes('postMessage'));
  assert(!content.text.includes('127.0.0.1:5173'));
  // Match the product's dedicated native host: its exit releases ConPTY worker handles.
  const nativeProbe = "const p=require(process.argv[1]).spawn(process.execPath,['-e',\"process.stdout.write('缓存PTY中文OK\\\\r\\\\n');setTimeout(()=>process.exit(0),150)\"],{cwd:process.cwd(),env:process.env,cols:80,rows:24,useConpty:true,useConptyDll:true});p.onData(d=>process.stdout.write(d));p.onExit(e=>process.exit(e.exitCode));setTimeout(()=>process.exit(2),10000).unref();";
  const terminalProbe = await promisify(execFile)(process.execPath, ['-e', nativeProbe, path.join(cached, 'dist/server/vendor/node-pty/lib/index.js')], { cwd: workspace, windowsHide: true, shell: false, timeout: 15000 });
  assert(terminalProbe.stdout.includes('缓存PTY中文OK'), 'cached native PTY must transport Unicode');
  assert((await readFile(path.join(cached, 'dist/server/terminal-stdio.js'), 'utf8')).length > 100);
  const svgProbe = "const {Resvg}=require(process.argv[1]);const b=new Resvg('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"10\"><rect width=\"20\" height=\"10\" fill=\"red\"/></svg>').render().asPng();if(Buffer.from(b).subarray(1,4).toString()!=='PNG')process.exit(3);process.stdout.write('PNG_OK')";
  const svgResult = await promisify(execFile)(process.execPath, ['-e', svgProbe, path.join(cached, 'dist/server/vendor/node_modules/@resvg/resvg-js/index.js')], { cwd: workspace, windowsHide: true, shell: false, timeout: 15000 });
  assert(svgResult.stdout.includes('PNG_OK'), 'cached SVG native dependency must render without project node_modules');
  console.log(`封装检查通过：${tools.tools.length} 个 MCP 工具、无 node_modules 缓存副本、独立工作区、真实 stdio、模板创建、自包含 UI、中文缓存目录真实原生 PTY；桌面加载仍未验证。`);
} catch (error) { if (stderr) console.error(stderr); throw error; }
finally {
  await client.close();
  const descriptor = JSON.parse(await readFile(path.join(workspace, '.latex-workspace/runtime/service.json'), 'utf8').catch(() => '{}')) as { pid?: number; root?: string };
  if (descriptor.pid && descriptor.root === workspace && descriptor.pid !== process.pid) {
    try { process.kill(descriptor.pid); } catch { /* already closed */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (path.dirname(isolated) !== path.resolve(os.tmpdir()) || !path.basename(isolated).startsWith('latex-package-')) throw new Error('unsafe cleanup');
  await rm(isolated, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

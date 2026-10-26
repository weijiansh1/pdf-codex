import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { buildZip } from '../plugins/latex-report-workbench/src/server/export.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string };
const source = path.join(root, 'plugins/latex-report-workbench');
const directory = path.join(root, '.latex-workspace/packages', `latex-report-workbench-${Date.now()}`);
await mkdir(directory, { recursive: true });
for (const name of ['plugin.json', 'skills', 'templates', 'dist/ui']) await cp(path.join(source, name), path.join(directory, name), { recursive: true });
const bundle = await rolldown({ input: { stdio: path.join(source, 'dist/server/stdio.js'), daemon: path.join(source, 'dist/server/daemon.js'), 'service-client': path.join(source, 'dist/server/service-client.js'), 'terminal-stdio': path.join(source, 'dist/server/terminal-stdio.js'), 'terminal-host': path.join(source, 'dist/server/terminal-host.js') }, platform: 'node' });
await bundle.write({ dir: path.join(directory, 'dist/server'), format: 'esm', entryFileNames: '[name].js', chunkFileNames: 'shared-[hash].js' });
await bundle.close();
// node-pty uses native addons and a worker resolved from __dirname. Keep its runtime layout.
const nativeSource = path.join(root, 'node_modules/node-pty');
const nativeTarget = path.join(directory, 'dist/server/vendor/node-pty');
await mkdir(nativeTarget, { recursive: true });
for (const entry of ['package.json', 'LICENSE', 'lib', `prebuilds/${process.platform}-${process.arch}`, ...(process.platform === 'win32' ? ['third_party/conpty'] : [])]) {
  await cp(path.join(nativeSource, entry), path.join(nativeTarget, entry), { recursive: true });
}
// The SVG rasterizer resolves its platform addon relative to the JS wrapper.
const resvgPackage = JSON.parse(await readFile(path.join(root, 'node_modules/@resvg/resvg-js/package.json'), 'utf8'));
for (const name of ['@resvg/resvg-js', ...Object.keys(resvgPackage.optionalDependencies as Record<string, string>).filter(name => {
  const folder = path.join(root, 'node_modules', name); return name.includes(`-${process.platform}-${process.arch}`) && existsSync(folder);
})]) await cp(path.join(root, 'node_modules', name), path.join(directory, 'dist/server/vendor/node_modules', name), { recursive: true });
await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'latex-report-workbench', version, private: true, type: 'module', engines: { node: '>=24' } }, null, 2));
const launch = "const p=require('node:path'); const u=require('node:url'); const root=process.env.PLUGIN_ROOT||process.env.CLAUDE_PLUGIN_ROOT; if(!root) throw Error('Plugin root missing'); import(u.pathToFileURL(p.join(root,'dist/server/stdio.js')).href);";
await writeFile(path.join(directory, 'mcp.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { 'latex-report-workbench': { type: 'stdio', command: process.execPath, args: ['-e', launch, '--', 'workbench', '--workspace', root] } } }, null, 2));
const notices: string[] = [`coPDF ${version}\nOriginal code in this workspace. No reference attachment code was copied.\n\nBundled dependency licenses:\n`];
const dependencies = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).dependencies as Record<string, string>;
for (const name of Object.keys(dependencies)) {
  const folder = path.join(root, 'node_modules', name);
  const license = (await readdir(folder)).find(candidate => /^licen[sc]e(?:\.|$)/i.test(candidate));
  if (license) notices.push(`\n--- ${name} ---\n${await readFile(path.join(folder, license), 'utf8')}`);
}
await writeFile(path.join(directory, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'));
const entries: { name: string; data: Uint8Array }[] = [];
async function collect(folder: string, relative = ''): Promise<void> {
  for (const item of await readdir(folder, { withFileTypes: true })) {
    const next = relative ? `${relative}/${item.name}` : item.name;
    if (item.isDirectory()) await collect(path.join(folder, item.name), next);
    else if (item.isFile()) entries.push({ name: next, data: await readFile(path.join(folder, item.name)) });
  }
}
await collect(directory);
const zip = `${directory}.zip`;
await writeFile(zip, buildZip(entries));
await writeFile(path.join(root, '.latex-workspace/packages/latest.json'), JSON.stringify({ directory, zip }, null, 2));
await mkdir(path.join(root, '.agents/plugins'), { recursive: true });
await writeFile(path.join(root, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'latex-report-workspace-local', interface: { displayName: 'coPDF 本地报告工作台' }, plugins: [{ name: 'latex-report-workbench', source: { source: 'local', path: directory }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }, null, 2));
console.log(`安装包已生成：${zip}\n缓存副本：${directory}\n工作区固定在 ${root}；没有自动安装或修改全局配置。`);

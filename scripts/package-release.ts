import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip } from '../plugins/latex-report-workbench/src/server/export.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string };
const local = JSON.parse(await readFile(path.join(root, '.latex-workspace/packages/latest.json'), 'utf8')) as { directory: string };
const platform = process.platform === 'win32' ? 'windows' : process.platform;
const name = `copdf-v${version}-${platform}-${process.arch}`;
const output = path.join(root, '.latex-workspace/releases', `${version}-${Date.now()}`);
const directory = path.join(output, name);
await mkdir(output, { recursive: true });
await cp(local.directory, directory, { recursive: true });
await cp(path.join(root, 'scripts/release/start.mjs'), path.join(directory, 'start.mjs'));
await cp(path.join(root, 'scripts/release/README.md'), path.join(directory, 'README.md'));
await cp(path.join(root, 'docs/usage.md'), path.join(directory, 'USAGE.md'));
await cp(path.join(root, 'docs/collaboration.md'), path.join(directory, 'COLLABORATION.md'));
await cp(path.join(root, 'LICENSE'), path.join(directory, 'LICENSE'));
await mkdir(path.join(directory, 'bin'));
await cp(path.join(root, 'scripts/release/copdf.mjs'), path.join(directory, 'bin/copdf.mjs'));
await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'copdf', version, description: 'coPDF：和 Codex 一起写报告，即时预览并导出 PDF', type: 'module', license: 'MIT', engines: { node: '>=24' }, os: [process.platform], cpu: [process.arch], bin: { copdf: 'bin/copdf.mjs' }, scripts: { start: 'node start.mjs' }, repository: { type: 'git', url: 'git+https://github.com/weijiansh1/pdf-codex.git' }, homepage: 'https://github.com/weijiansh1/pdf-codex#readme', bugs: { url: 'https://github.com/weijiansh1/pdf-codex/issues' }, publishConfig: { access: 'public' }, files: ['dist/', 'templates/', 'skills/', 'bin/', 'plugin.json', 'mcp.json', 'release.json', 'start.mjs', 'USAGE.md', 'COLLABORATION.md', 'THIRD-PARTY-NOTICES.txt', '启动工作台.cmd'] }, null, 2));
await writeFile(path.join(directory, 'release.json'), JSON.stringify({ name: 'copdf', version, platform: process.platform, arch: process.arch, nodeMinimumMajor: 24, repository: 'https://github.com/weijiansh1/pdf-codex' }, null, 2));
// The plugin host supplies PLUGIN_ROOT; an explicitly chosen workspace can live elsewhere.
const launch = "const p=require('node:path'),u=require('node:url');const root=process.env.PLUGIN_ROOT||process.env.CLAUDE_PLUGIN_ROOT;if(!root)throw Error('PLUGIN_ROOT is required');process.argv=[process.execPath,p.join(root,'dist/server/stdio.js'),'--workspace',process.env.LATEX_REPORT_WORKSPACE||root];import(u.pathToFileURL(process.argv[1]).href);";
await writeFile(path.join(directory, 'mcp.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { 'latex-report-workbench': { type: 'stdio', command: 'node', args: ['-e', launch] } } }, null, 2));
await writeFile(path.join(directory, '启动工作台.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nnode start.mjs %*\r\nif errorlevel 1 pause\r\n');
const entries: { name: string; data: Uint8Array }[] = [];
async function collect(folder: string, relative = name): Promise<void> {
  for (const item of await readdir(folder, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error(`发布包不支持符号链接：${item.name}`);
    const next = `${relative}/${item.name}`;
    if (item.isDirectory()) await collect(path.join(folder, item.name), next);
    else if (item.isFile()) entries.push({ name: next, data: await readFile(path.join(folder, item.name)) });
  }
}
await collect(directory);
const zip = path.join(output, `${name}.zip`);
const bytes = buildZip(entries);
await writeFile(zip, bytes);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const checksums = path.join(output, 'SHA256SUMS.txt');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('请通过 npm run package:release 执行，以找到 npm 打包入口。');
const packed = await promisify(execFile)(process.execPath, [npmCli, 'pack', directory, '--pack-destination', output, '--ignore-scripts', '--json'], { shell: false, windowsHide: true, maxBuffer: 4_194_304 });
const npmInfo = (JSON.parse(packed.stdout) as { filename: string }[])[0]!;
const npmPackage = path.join(output, npmInfo.filename);
const npmSha256 = createHash('sha256').update(await readFile(npmPackage)).digest('hex');
await writeFile(checksums, `${sha256}  ${path.basename(zip)}\n${npmSha256}  ${path.basename(npmPackage)}\n`, 'utf8');
await writeFile(path.join(root, '.latex-workspace/packages/latest-release.json'), JSON.stringify({ directory, zip, npmPackage, checksums, sha256, npmSha256, version, tag: `v${version}`, platform: process.platform, arch: process.arch }, null, 2));
console.log(`可移植发布包：${zip}\nnpm 安装包：${npmPackage}\nSHA256：${sha256}\n仅打包软件；不包含本地报告、登录或运行记录。`);

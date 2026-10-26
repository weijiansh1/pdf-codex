import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

try {
  const version = Number(process.versions.node.split('.')[0]);
  if (version < 24) throw new Error('请安装 Node.js 24 或更高版本，再重新启动。');
  const metadata = JSON.parse(await readFile(new URL('./release.json', import.meta.url), 'utf8'));
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('coPDF\n用法：copdf [--workspace <目录>] [--no-open]\nnpm 命令默认使用当前目录；ZIP 启动器默认使用解压目录。\n--version 显示版本；需要 Node.js 24+。');
  } else if (process.argv.includes('--version')) {
    console.log(metadata.version);
  } else {
    if (process.platform !== metadata.platform || process.arch !== metadata.arch) {
      throw new Error(`此运行包适用于 ${metadata.platform}/${metadata.arch}，当前为 ${process.platform}/${process.arch}。请下载对应平台包或从源码构建。`);
    }
    const args = process.argv.slice(2);
    const index = args.indexOf('--workspace');
    if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith('--'))) throw new Error('--workspace 后需要填写已存在的报告工作目录。');
    const root = await realpath(index >= 0 ? args[index + 1] : fileURLToPath(new URL('.', import.meta.url)));
    const { connectWorkspaceService, discoverService } = await import('./dist/server/service-client.js');
    await connectWorkspaceService(root);
    const service = await discoverService(root);
    if (!service) throw new Error('工作台服务未能启动，请检查目录写入权限。');
    console.log(`coPDF ${metadata.version}\n工作台：${service.url}\n报告保存在：${root}\n打开“目录”新建报告，再展开“Codex”开始对话。`);
    if (!args.includes('--no-open')) {
      const [command, argv] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', service.url]]
        : process.platform === 'darwin' ? ['open', [service.url]] : ['xdg-open', [service.url]];
      execFile(command, argv, { shell: false, windowsHide: true }, error => { if (error) console.error(`请在浏览器中打开 ${service.url}`); });
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '启动失败。');
  process.exitCode = 1;
}

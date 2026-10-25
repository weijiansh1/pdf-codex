import { access, stat, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { WorkbenchError } from '../shared/errors.js';

export type TerminalLaunch = { file: string; args: string[] };
const exists = async (file: string) => { try { await access(file); return (await stat(file)).isFile(); } catch { return false; } };

export async function standaloneTuiArguments(launch: TerminalLaunch, environment: NodeJS.ProcessEnv): Promise<string[]> {
  try { await promisify(execFile)(launch.file, [...launch.args, '--no-daemon', '--version'], { env: environment, shell: false, windowsHide: true, timeout: 3000 }); return ['--no-daemon']; }
  catch { return []; } // Older CLIs already run the TUI in-process and lack this option.
}

/** Disable inherited MCPs for this invocation only; unrelated desktop bridges delay CLI startup. */
export async function reportOnlyMcpArguments(launch: TerminalLaunch, environment: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  try {
    const { stdout } = await promisify(execFile)(launch.file, [...launch.args, 'mcp', 'list', '--json'], { env: environment, shell: false, windowsHide: true, timeout: 10000, maxBuffer: 1048576 });
    const servers = JSON.parse(stdout) as { name: string }[];
    if (!Array.isArray(servers)) throw new Error();
    // CLI auto-injected servers may be listed without a config-level transport. A complete
    // disabled declaration satisfies its config parser; the command is never started.
    return servers.filter(server => typeof server.name === 'string' && /^[a-zA-Z0-9_-]+$/.test(server.name) && server.name !== 'latex_terminal').flatMap(server => ['-c', `mcp_servers.${server.name}={command=${JSON.stringify(process.execPath)},args=["--version"],enabled=false}`]);
  } catch { throw new WorkbenchError('HOST_FEATURE_UNAVAILABLE', '读取 Codex 配置失败。请在终端运行 codex mcp list 检查本机配置，再重新启动。'); }
}

/** Resolve executable/JS directly; Windows .cmd/.ps1 wrappers need a shell and are never run. */
export async function resolveCodex(): Promise<TerminalLaunch> {
  const explicit = process.env.LATEX_CODEX_EXECUTABLE;
  if (explicit) {
    if (!path.isAbsolute(explicit) || !await exists(explicit) || /\.(cmd|bat|ps1)$/i.test(explicit)) throw new Error('LATEX_CODEX_EXECUTABLE 需要可执行文件或 codex.js 的绝对路径。');
    return explicit.endsWith('.js') ? { file: process.execPath, args: [explicit] } : { file: explicit, args: [] };
  }
  const bundled = process.env.CODEX_CLI_PATH;
  if (bundled && path.isAbsolute(bundled) && !/\.(cmd|bat|ps1)$/i.test(bundled) && await exists(bundled)) return bundled.endsWith('.js') ? { file: process.execPath, args: [bundled] } : { file: bundled, args: [] };
  // Explorer does not inherit CODEX_CLI_PATH. Use the installed desktop cache before PATH's
  // older npm wrapper; app updates create a new version directory under this same user folder.
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const directory = path.join(process.env.LOCALAPPDATA, 'OpenAI/Codex/bin');
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const candidates = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
      const file = path.join(directory, entry.name, 'codex.exe');
      try { const info = await stat(file); return info.isFile() ? { file, modified: info.mtimeMs } : null; } catch { return null; }
    }));
    const newest = candidates.filter((entry): entry is { file: string; modified: number } => entry !== null).sort((a, b) => b.modified - a.modified)[0];
    if (newest) return { file: newest.file, args: [] };
  }
  for (const directory of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    const native = path.join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (await exists(native)) return { file: native, args: [] };
    const script = path.join(directory, 'node_modules', '@openai/codex/bin/codex.js');
    if (await exists(script)) {
      if (process.platform === 'win32') {
        const require = createRequire(script);
        try {
          const pkg = require.resolve(`@openai/codex-win32-${process.arch}/package.json`);
          const triple = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
          const binary = path.join(path.dirname(pkg), `vendor/${triple}-pc-windows-msvc/bin/codex.exe`);
          if (await exists(binary)) return { file: binary, args: [] };
        } catch { /* Node wrapper remains usable with an argument array. */ }
      }
      return { file: process.execPath, args: [script] };
    }
  }
  throw new WorkbenchError('HOST_FEATURE_UNAVAILABLE', '未找到 Codex CLI。请先安装 @openai/codex 并运行 codex login，然后重启工作台。');
}

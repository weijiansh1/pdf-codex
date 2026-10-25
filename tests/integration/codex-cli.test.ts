import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { resolveCodex, reportOnlyMcpArguments } from '../../plugins/latex-report-workbench/src/server/codex-launch.js';
import { fixture } from '../helpers/workspace.js';

it('uses the installed desktop CLI before an older global npm CLI', async context => {
  const bundled = process.env.CODEX_CLI_PATH;
  if (!bundled || process.env.LATEX_CODEX_EXECUTABLE) { context.skip(); return; }
  expect((await resolveCodex()).file).toBe(bundled);
});

it('finds the installed desktop CLI when launched from Explorer without desktop environment variables', async context => {
  if (process.platform !== 'win32') { context.skip(); return; }
  const f = await fixture(); const previous = { local: process.env.LOCALAPPDATA, bundled: process.env.CODEX_CLI_PATH, explicit: process.env.LATEX_CODEX_EXECUTABLE };
  try {
    const executable = path.join(f.root, 'OpenAI/Codex/bin/current-desktop/codex.exe'); await mkdir(path.dirname(executable), { recursive: true }); await writeFile(executable, 'resolver fixture');
    process.env.LOCALAPPDATA = f.root; delete process.env.CODEX_CLI_PATH; delete process.env.LATEX_CODEX_EXECUTABLE;
    expect((await resolveCodex()).file).toBe(executable);
  } finally {
    for (const [name, value] of Object.entries({ LOCALAPPDATA: previous.local, CODEX_CLI_PATH: previous.bundled, LATEX_CODEX_EXECUTABLE: previous.explicit })) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await f.close();
  }
});

it('real Codex accepts session-only MCP overrides without changing the user configuration', async context => {
  let cli; try { cli = await resolveCodex(); } catch { context.skip(); return; }
  const f = await fixture(); const previous = process.env.CODEX_HOME;
  try {
    await writeFile(path.join(f.root, 'config.toml'), '[mcp_servers.desktop-helper]\ncommand="node"\nargs=["--version"]\nenabled=true\n');
    process.env.CODEX_HOME = f.root;
    const args = await reportOnlyMcpArguments(cli);
    const result = await promisify(execFile)(cli.file, [...cli.args, ...args, 'mcp', 'list', '--json'], { shell: false, windowsHide: true, timeout: 10000 });
    const servers = JSON.parse(result.stdout) as { name: string; enabled: boolean }[];
    expect(servers.find(s => s.name === 'desktop-helper')?.enabled).toBe(false);
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; await f.close(); }
});

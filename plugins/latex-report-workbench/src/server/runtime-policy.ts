import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod } from 'node:fs/promises';
const run = promisify(execFile);

/** The local bearer token inherits only the current user's runtime-directory permissions. */
export async function restrictRuntimeDirectory(directory: string): Promise<void> {
  if (process.platform !== 'win32') { await chmod(directory, 0o700); return; }
  const { stdout } = await run('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, shell: false });
  const sid = stdout.match(/S-\d-(?:\d+-)+\d+/)?.[0];
  if (!sid) throw new Error('无法识别当前 Windows 用户，未创建服务凭证。');
  await run('icacls.exe', [directory, '/reset'], { windowsHide: true, shell: false });
  await run('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true, shell: false });
}

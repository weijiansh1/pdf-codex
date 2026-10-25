import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import type { IPty, IBasePtyForkOptions } from 'node-pty';

const require = createRequire(import.meta.url);
const vendor = fileURLToPath(new URL('./vendor/node-pty/lib/index.js', import.meta.url));
const native = require(existsSync(vendor) ? vendor : 'node-pty') as typeof import('node-pty');
let pty: IPty | undefined; let stopping = false;
const send = (event: object, done?: () => void) => { if (process.connected) process.send?.(event, undefined, undefined, () => done?.()); else done?.(); };
const finish = (exitCode: number) => send({ type: 'exit', exitCode }, () => process.exit(0));
function stop() {
  if (stopping) return; stopping = true;
  if (!pty) { process.exit(0); return; }
  pty.kill();
  setTimeout(() => {
    if (process.platform === 'win32' && pty) execFile('taskkill.exe', ['/PID', String(pty.pid), '/T', '/F'], { shell: false, windowsHide: true }, () => finish(-1));
    else finish(-1);
  }, 1000).unref();
}
process.on('message', (raw: unknown) => {
  const event = raw as { type: string; file: string; args: string[]; options: IBasePtyForkOptions; data: string; cols: number; rows: number };
  try {
    if (event.type === 'start' && !pty) {
      pty = native.spawn(event.file, event.args, { ...event.options, useConpty: true, useConptyDll: true });
      pty.onData(data => send({ type: 'output', data }));
      pty.onExit(({ exitCode }) => finish(exitCode));
      send({ type: 'ready' });
    } else if (event.type === 'input') pty?.write(event.data);
    else if (event.type === 'resize') pty?.resize(event.cols, event.rows);
    else if (event.type === 'stop') stop();
  } catch (error) { send({ type: 'error', message: error instanceof Error ? error.message : '原生终端失败。' }, () => process.exit(1)); }
});
process.once('disconnect', stop);

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { IPty, IBasePtyForkOptions } from 'node-pty';

export type TerminalProcess = Pick<IPty, 'pid' | 'write' | 'resize' | 'kill' | 'onData' | 'onExit'>;
/** Isolate native handles/ConPTY worker threads so natural exit also releases every handle. */
export async function spawnTerminal(file: string, args: string[], options: IBasePtyForkOptions): Promise<TerminalProcess> {
  const host = fileURLToPath(new URL(`./terminal-host${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url));
  const loader = host.endsWith('.ts') ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : [];
  const child = spawn(process.execPath, [...loader, host], { cwd: path.dirname(host), windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number }) => void>();
  let exitCode: number | undefined; let buffered = '';
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('原生终端启动超时。')); }, 15000);
    child.on('message', (raw: unknown) => {
      const event = raw as { type: string; data: string; exitCode: number; message: string };
      if (event.type === 'ready') { clearTimeout(timeout); resolve(); }
      if (event.type === 'error') { clearTimeout(timeout); reject(new Error(event.message)); }
      if (event.type === 'output') { if (dataListeners.size) for (const receive of dataListeners) receive(event.data); else buffered = (buffered + event.data).slice(-524288); }
      if (event.type === 'exit') exitCode = event.exitCode;
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); exitCode ??= code ?? -1; for (const receive of exitListeners) receive({ exitCode }); reject(new Error('原生终端进程已退出。')); });
  });
  child.send({ type: 'start', file, args, options });
  await ready;
  const send = (event: unknown) => { if (!child.connected) throw new Error('原生终端已退出。'); child.send(event as object, error => { if (error) child.kill(); }); };
  return {
    pid: child.pid!,
    write: data => send({ type: 'input', data: typeof data === 'string' ? data : data.toString('utf8') }),
    resize: (cols, rows) => send({ type: 'resize', cols, rows }),
    kill: () => { if (child.connected) send({ type: 'stop' }); },
    onData: receive => { dataListeners.add(receive); if (buffered) { receive(buffered); buffered = ''; } return { dispose: () => dataListeners.delete(receive) }; },
    onExit: receive => { exitListeners.add(receive); if (exitCode !== undefined && child.exitCode !== null) receive({ exitCode }); return { dispose: () => exitListeners.delete(receive) }; },
  };
}

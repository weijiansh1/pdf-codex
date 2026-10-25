import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startHttpServer } from '../../plugins/latex-report-workbench/src/server/daemon.js';
import { fixture } from '../helpers/workspace.js';

it('authenticates real terminal HTTP/WebSocket, rejects external origins and reconnects without spawning again', async () => {
  const f = await fixture();
  const http = await startHttpServer(f.app, { port: 0, terminalLaunch: async () => ({ file: process.execPath, args: ['-e', "process.stdin.setRawMode(true);process.stdout.write('READY');process.stdin.on('data',d=>process.stdout.write('GOT:'+d))"] }) });
  const binding = { reportId: f.reportId, viewId: f.viewId, contextId: f.contextId };
  const post = (url: string, input: unknown, token = http.token) => fetch(http.url + url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const sockets: WebSocket[] = [];
  try {
    expect((await post('/api/terminal/sessions', binding, 'wrong')).status).toBe(401);
    const created = await post('/api/terminal/sessions', binding); expect(created.status).toBe(200);
    const { session } = await created.json() as { session: { sessionId: string } };
    expect((await (await post('/api/terminal/sessions', binding)).json() as { session: { sessionId: string } }).session.sessionId).toBe(session.sessionId);
    const foreign = new WebSocket(http.url.replace('http:', 'ws:') + '/api/terminal/socket', { origin: 'https://evil.example' });
    await new Promise<void>(resolve => { foreign.on('unexpected-response', (_req, res) => { expect(res.statusCode).toBe(403); res.resume(); foreign.terminate(); resolve(); }); foreign.on('error', () => undefined); });
    const denied = new WebSocket(http.url.replace('http:', 'ws:') + '/api/terminal/socket', { origin: http.url }); sockets.push(denied);
    denied.on('open', () => denied.send(JSON.stringify({ type: 'attach', token: 'bad', sessionId: session.sessionId, cols: 80, rows: 24 })));
    expect(await new Promise<number>(resolve => denied.on('close', resolve))).toBe(1008);
    for (let attempt = 0; attempt < 2; attempt++) {
      const ws = new WebSocket(http.url.replace('http:', 'ws:') + '/api/terminal/socket', { origin: http.url }); sockets.push(ws);
      let output = '';
      const done = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`terminal output timeout: ${output}`)), 8000);
        ws.on('message', raw => { const e = JSON.parse(String(raw)); if (e.type === 'output') output += e.data; if (output.includes('GOT:你好')) { clearTimeout(timeout); resolve(); } });
      });
      ws.on('open', () => { ws.send(JSON.stringify({ type: 'attach', token: http.token, sessionId: session.sessionId, cols: 80, rows: 24 })); if (attempt === 0) setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: '你好' })), 250); });
      await done; ws.close();
    }
    expect((await post(`/api/terminal/sessions/${session.sessionId}/bind`, { ...binding, viewId: 'bad' })).status).toBe(400);
    expect((await post(`/api/terminal/sessions/${session.sessionId}/request`, { prompt: 'x'.repeat(12001) })).status).toBe(400);
    expect((await post(`/api/terminal/sessions/${session.sessionId}/stop`, {})).status).toBe(200);
  } finally { for (const ws of sockets) ws.terminate(); await http.close(); await f.close(); }
}, 25000);

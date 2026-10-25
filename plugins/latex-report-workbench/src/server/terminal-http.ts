import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { idSchema, terminalBindingSchema, terminalFrameSchema, type ToolName } from '../shared/contracts.js';
import { WorkbenchError, toErrorEnvelope } from '../shared/errors.js';
import type { TerminalService } from './terminal.js';

type HttpContext = { token: string; url: () => string; allowedOrigins: string[]; activity: () => void; body: (req: IncomingMessage) => Promise<unknown>; respond: (res: ServerResponse, status: number, body: unknown) => void };
export function terminalRoutes(terminal: TerminalService, context: HttpContext) {
  return async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> => {
    if (!pathname.startsWith('/api/terminal/')) return false;
    if (req.method !== 'POST') { context.respond(res, 405, { ok: false, error: { message: '终端管理需要 POST。' } }); return true; }
    if (pathname === '/api/terminal/mcp') {
      const { sessionId, name, input } = z.object({ sessionId: idSchema, name: z.string().max(100), input: z.unknown() }).strict().parse(await context.body(req));
      if (!terminal.authenticate(sessionId, req.headers.authorization?.replace(/^Bearer /, '') ?? '')) throw new WorkbenchError('UNAUTHORIZED', '终端工具会话凭证无效。');
      context.activity();
      context.respond(res, 200, { ok: true, result: await terminal.call(sessionId, name as ToolName, input) }); return true;
    }
    if (req.headers.authorization !== `Bearer ${context.token}`) throw new WorkbenchError('UNAUTHORIZED', '缺少本地会话令牌。');
    context.activity();
    if (pathname === '/api/terminal/sessions') { const session = await terminal.create(terminalBindingSchema.parse(await context.body(req))); context.respond(res, 200, { ok: true, session }); return true; }
    const match = /^\/api\/terminal\/sessions\/([^/]+)\/(bind|request|stop)$/.exec(pathname);
    if (!match) throw new WorkbenchError('INVALID_INPUT', '未知终端操作。');
    const sessionId = idSchema.parse(match[1]); const action = match[2];
    const input = await context.body(req);
    if (action === 'bind') { if (input === null) terminal.suspend(sessionId); else await terminal.bind(sessionId, terminalBindingSchema.parse(input)); }
    if (action === 'request') { const request = z.object({ prompt: z.string().trim().min(1).max(12000), binding: terminalBindingSchema, submit: z.boolean().optional() }).strict().parse(input); await terminal.request(sessionId, request.prompt, request.binding, request.submit); }
    if (action === 'stop') await terminal.stop(sessionId);
    context.respond(res, 200, { ok: true }); return true;
  };
}

/** Authenticate in first frame, never URL/query logs. Every browser upgrade checks Host/Origin. */
export function terminalSockets(server: Server, terminal: TerminalService, context: HttpContext) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 524288, perMessageDeflate: false });
  const controllers = new Map<string, WebSocket>();
  const attachSchema = z.object({ type: z.literal('attach'), token: z.string().max(128), sessionId: idSchema, cols: z.int().min(20).max(500), rows: z.int().min(4).max(200) }).strict();
  server.on('upgrade', (req, socket, head) => {
    const url = context.url();
    if (req.headers.host !== new URL(url).host || !req.headers.origin || (req.headers.origin !== url && !context.allowedOrigins.includes(req.headers.origin)) || req.url !== '/api/terminal/socket' || wss.clients.size >= 16) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    let sessionId = ''; let detach: (() => void) | undefined; let alive = true;
    const timeout = setTimeout(() => ws.close(1008, 'authentication timeout'), 5000);
    const send = (event: unknown) => { if (ws.readyState !== WebSocket.OPEN) return; if (ws.bufferedAmount > 1048576) { ws.close(1013, 'terminal client too slow'); return; } ws.send(JSON.stringify(event)); };
    const heartbeat = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; ws.ping(); }, 30000);
    ws.on('pong', () => { alive = true; context.activity(); });
    ws.on('error', () => undefined);
    ws.on('message', (bytes, binary) => {
      try {
        if (binary) throw new Error('text frames only');
        const input: unknown = JSON.parse(bytes.toString());
        if (!sessionId) {
          const attach = attachSchema.parse(input);
          if (attach.token !== context.token) throw new Error('authentication failed');
          terminal.get(attach.sessionId);
          sessionId = attach.sessionId; clearTimeout(timeout);
          const previous = controllers.get(sessionId); controllers.set(sessionId, ws); previous?.close(1000, 'terminal reattached');
          if (terminal.get(sessionId).state === 'running') terminal.resize(sessionId, attach.cols, attach.rows);
          send({ type: 'attached', session: terminal.get(sessionId) });
          detach = terminal.subscribe(sessionId, send);
        } else {
          const frame = terminalFrameSchema.parse(input);
          if (frame.type === 'input') terminal.input(sessionId, frame.data); else terminal.resize(sessionId, frame.cols, frame.rows);
        }
        context.activity();
      } catch (error) { send({ type: 'error', message: error instanceof WorkbenchError ? error.message : '终端请求无效或会话认证失败。' }); ws.close(1008, 'invalid terminal request'); }
    });
    ws.once('close', () => {
      clearTimeout(timeout); clearInterval(heartbeat); detach?.();
      if (sessionId && controllers.get(sessionId) === ws) { controllers.delete(sessionId); try { terminal.suspend(sessionId); } catch { /* service already closed */ } }
    });
  });
  return () => { for (const ws of wss.clients) ws.terminate(); wss.close(); };
}

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, stat, open, rm, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSharedApplication, getSharedApplication, type Application } from './application.js';
import { toolInputs, type ToolName, type WorkspaceEvent } from '../shared/contracts.js';
import { WorkbenchError, toErrorEnvelope } from '../shared/errors.js';
import { DEFAULTS } from '../shared/config.js';
import { resolveSafePath } from './path-policy.js';
import { ensureLayout, readJson, workspaceLayout, writeJsonAtomic } from './store.js';
import { discoverService, type ServiceDescriptor } from './service-client.js';
import { restrictRuntimeDirectory } from './runtime-policy.js';
import { ZodError } from 'zod';
import { TerminalService } from './terminal.js';
import { terminalRoutes, terminalSockets } from './terminal-http.js';
import type { TerminalLaunch } from './codex-launch.js';

export function workspaceArgument(argv = process.argv.slice(2)): string {
  const index = argv.indexOf('--workspace');
  if (index >= 0 && !argv[index + 1]) throw new Error('--workspace requires a directory');
  return path.resolve(index >= 0 ? argv[index + 1]! : process.cwd());
}

/** Boots the single local service: recovery, watcher and shared application state. */
export async function startHttpServer(app: Application, options: { port?: number; uiDirectory?: string; allowedOrigins?: string[]; terminalLaunch?: () => Promise<TerminalLaunch> } = {}) {
  const token = randomBytes(32).toString('hex');
  let url = '';
  let lastActivity = Date.now();
  const events: WorkspaceEvent[] = [];
  const unsubscribe = app.subscribe(event => {
    events.push(event);
    if (events.length > 200) events.splice(0, events.length - 200);
  });
  const recovery = await app.recover();
  await app.services.watcher.start().catch(() => undefined);
  const respond = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); };
  const bodyOf = async (req: IncomingMessage): Promise<unknown> => {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new WorkbenchError('INVALID_INPUT', '需要 JSON 请求。');
    const maxBytes = DEFAULTS.maxTextBytes + 65_536;
    const parts: Buffer[] = []; let size = 0;
    for await (const part of req) {
      const bytes = Buffer.from(part);
      size += bytes.length;
      if (size > maxBytes) throw new WorkbenchError('FILE_TOO_LARGE', `请求超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 上限。`);
      parts.push(bytes);
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new WorkbenchError('INVALID_INPUT', 'JSON 格式错误。'); }
  };
  const terminal = new TerminalService(app, { ...(options.terminalLaunch ? { launch: options.terminalLaunch } : {}), endpoint: () => url });
  const terminalContext = { token, url: () => url, allowedOrigins: options.allowedOrigins ?? [], activity: () => { lastActivity = Date.now(); }, body: bodyOf, respond };
  const routeTerminal = terminalRoutes(terminal, terminalContext);
  const server = createServer((req, res) => { void (async () => {
    try {
      if (req.headers.host !== new URL(url).host) { respond(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Host 不允许。' } }); return; }
      const origin = req.headers.origin;
      if (origin && origin !== url && !(options.allowedOrigins ?? []).includes(origin)) { respond(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Origin 不允许。' } }); return; }
      const requestUrl = new URL(req.url ?? '/', url);
      const pathname = requestUrl.pathname;
      if (await routeTerminal(req, res, pathname)) return;
      if (req.method === 'GET' && pathname === '/health') { respond(res, 200, { ok: true, pid: process.pid, mode: 'local-service', workspaceId: app.workspace.workspaceId, protocolVersion: DEFAULTS.protocolVersion, recovery: recovery.length }); return; }
      if (req.method === 'GET' && pathname === '/api/bootstrap') { respond(res, 200, { token, workspaceId: app.workspace.workspaceId, protocolVersion: DEFAULTS.protocolVersion, features: app.features() }); return; }
      if (req.method === 'GET' && pathname === '/api/events') {
        if (req.headers.authorization !== `Bearer ${token}`) throw new WorkbenchError('UNAUTHORIZED', '缺少本地会话令牌。');
        lastActivity = Date.now();
        const since = Number(requestUrl.searchParams.get('since') ?? '0');
        respond(res, 200, { events: events.filter(event => event.sequence > (Number.isFinite(since) ? since : 0)) });
        return;
      }
      if (req.method === 'POST' && pathname.startsWith('/api/tools/')) {
        if (req.headers.authorization !== `Bearer ${token}`) throw new WorkbenchError('UNAUTHORIZED', '缺少本地会话令牌。');
        if (req.headers['x-latex-protocol'] && req.headers['x-latex-protocol'] !== '1') throw new WorkbenchError('INVALID_INPUT', '工作台协议版本不兼容，请刷新界面。');
        lastActivity = Date.now();
        const name = pathname.slice('/api/tools/'.length);
        if (!Object.hasOwn(toolInputs, name)) throw new WorkbenchError('INVALID_INPUT', '未知工具。');
        respond(res, 200, { ok: true, result: await app.call(name as ToolName, await bodyOf(req)) }); return;
      }
      if (req.method === 'GET' && options.uiDirectory && !pathname.startsWith('/api/')) {
        const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
        const file = await resolveSafePath(options.uiDirectory, relative);
        if (!(await stat(file)).isFile()) throw new WorkbenchError('FILE_NOT_FOUND', '页面不存在。');
        const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
        res.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; worker-src 'self' blob:; frame-ancestors 'none'" });
        res.end(await readFile(file)); return;
      }
      respond(res, 404, { ok: false, error: { code: 'FILE_NOT_FOUND', message: '端点不存在。' } });
    } catch (error) { const envelope = toErrorEnvelope(error instanceof ZodError ? new WorkbenchError('INVALID_INPUT', '请求参数无效。') : error); respond(res, envelope.code === 'UNAUTHORIZED' ? 401 : envelope.code === 'INVALID_INPUT' ? 400 : envelope.code === 'FEATURE_NOT_IMPLEMENTED' ? 501 : envelope.code === 'FILE_NOT_FOUND' ? 404 : 500, { ok: false, error: envelope }); }
  })(); });
  const closeSockets = terminalSockets(server, terminal, terminalContext);
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? DEFAULTS.port, '127.0.0.1', () => resolve()); }); }
  catch (error) { unsubscribe(); closeSockets(); await terminal.close(); throw error; }
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('HTTP address unavailable');
  url = `http://127.0.0.1:${address.port}`;
  return { url, token, recovery, terminal, lastActivity: () => terminal.hasActiveWork() ? Date.now() : lastActivity, close: async () => { unsubscribe(); closeSockets(); await terminal.close(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }); } };
}

export async function startWorkspaceDaemon(directory: string, options: { port?: number; uiDirectory?: string; allowedOrigins?: string[] } = {}) {
  const root = await realpath(directory);
  const layout = workspaceLayout(root);
  await ensureLayout(layout);
  await restrictRuntimeDirectory(layout.runtime);
  const lockPath = path.join(layout.runtime, 'owner.lock');
  let owner;
  try { owner = await open(lockPath, 'wx'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await discoverService(root);
    if (existing) throw new WorkbenchError('INVALID_INPUT', '该工作区的报告服务已经运行。', false, { url: existing.url });
    const previous = await readJson<{ pid: number }>(lockPath);
    let alive = false;
    if (previous?.pid) { try { process.kill(previous.pid, 0); alive = true; } catch { /* dead owner */ } }
    const age = Date.now() - (await stat(lockPath)).mtimeMs;
    if (alive || age < 30_000) throw new WorkbenchError('INVALID_INPUT', '该工作区服务正在启动，请稍后重试。');
    await rm(lockPath, { force: true });
    owner = await open(lockPath, 'wx');
  }
  await owner.writeFile(JSON.stringify({ pid: process.pid, root }));
  await owner.close();
  try {
    const app = await getSharedApplication(root);
    let http;
    try { http = await startHttpServer(app, options); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || options.port === 0) throw error;
      http = await startHttpServer(app, { ...options, port: 0 });
    }
    const descriptor: ServiceDescriptor = { pid: process.pid, root, url: http.url, token: http.token, workspaceId: app.workspace.workspaceId, protocolVersion: 1 };
    await writeJsonAtomic(layout.service, descriptor);
    return { app, http, descriptor, async close() {
      await http.close(); await closeSharedApplication(root);
      if ((await readJson<ServiceDescriptor>(layout.service))?.pid === process.pid) await rm(layout.service, { force: true });
      await rm(lockPath, { force: true });
    } };
  } catch (error) { await closeSharedApplication(root); await rm(lockPath, { force: true }); throw error; }
}

if (process.argv.includes('--serve') || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  const root = workspaceArgument();
  const service = await startWorkspaceDaemon(root, { uiDirectory: fileURLToPath(new URL('../../dist/ui/', import.meta.url)) });
  console.error(`LaTeX 工作台：${service.http.url}（工作区 ${service.app.workspace.root}）`);
  const stop = () => { void service.close().then(() => process.exit(0)); };
  if (process.argv.includes('--managed')) setInterval(() => { if (!service.app.services.buildQueue.hasActiveWork() && Date.now() - service.http.lastActivity() > DEFAULTS.idleShutdownMs) stop(); }, 30_000).unref();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

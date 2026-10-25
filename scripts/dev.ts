import { createServer } from 'vite';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startWorkspaceDaemon, workspaceArgument } from '../plugins/latex-report-workbench/src/server/daemon.js';
import { discoverService } from '../plugins/latex-report-workbench/src/server/service-client.js';
const root = await realpath(workspaceArgument());
const existing = await discoverService(root);
const owned = existing ? null : await startWorkspaceDaemon(root, { allowedOrigins: ['http://127.0.0.1:5173'], uiDirectory: fileURLToPath(new URL('../plugins/latex-report-workbench/dist/ui/', import.meta.url)) });
const url = existing?.url ?? owned!.http.url;
try {
  const vite = await createServer({ server: { proxy: { '^/api/': { target: url, changeOrigin: true, ws: true, rewriteWsOrigin: true, configure(proxy) { proxy.on('proxyReq', request => request.removeHeader('origin')); } } } } }); await vite.listen();
  console.log(`报告工作台：http://127.0.0.1:5173（统一服务 ${url}）`);
  const stop = () => { void Promise.all([vite.close(), owned?.close()]).then(() => process.exit(0)); }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (error) { await owned?.close(); throw error; }

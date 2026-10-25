import { expect, it } from 'vitest';
import { createServer } from 'vite';
import { createApplication } from '../../plugins/latex-report-workbench/src/server/application.js';
import { startHttpServer } from '../../plugins/latex-report-workbench/src/server/daemon.js';
it('serves api.ts as a module while proxying only /api/ routes', async () => {
  const http = await startHttpServer(await createApplication(process.cwd()), { port: 0 });
  const vite = await createServer({ server: { port: 0, watch: null, proxy: { '^/api/': { target: http.url, changeOrigin: true } } }, logLevel: 'silent' });
  try {
    await vite.listen(); const address = vite.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite test address unavailable');
    const url = `http://127.0.0.1:${address.port}`;
    const module = await fetch(`${url}/api.ts`);
    expect(module.status).toBe(200); expect(await module.text()).toContain('LocalToolClient');
    const bootstrap = await fetch(`${url}/api/bootstrap`);
    expect(bootstrap.status).toBe(200); expect((await bootstrap.json() as { token: string }).token).toMatch(/^[a-f0-9]{64}$/);
  } finally { await vite.close(); await http.close(); }
});

import { expect, it } from 'vitest';
import { request } from 'node:http';
import { startHttpServer } from '../../plugins/latex-report-workbench/src/server/daemon.js';
import { createApplication } from '../../plugins/latex-report-workbench/src/server/application.js';
it('requires a local token and rejects foreign origins/hosts', async () => {
  const app = await createApplication(process.cwd());
  const server = await startHttpServer(app, { port: 0 });
  try {
    const bootstrap = await fetch(`${server.url}/api/bootstrap`);
    const { token } = await bootstrap.json() as { token: string };
    const payload = JSON.stringify({ nonce: 'HTTP-中文' });
    const denied = await fetch(`${server.url}/api/tools/probe_echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
    expect(denied.status).toBe(401);
    const foreign = await fetch(`${server.url}/api/bootstrap`, { headers: { Origin: 'https://untrusted.example' } });
    expect(foreign.status).toBe(403);
    // Node fetch normalizes Host; use the HTTP client to exercise the actual Host boundary.
    const wrongHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const probe = request(`${server.url}/api/bootstrap`, { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); });
      probe.once('error', reject); probe.end();
    });
    expect(wrongHostStatus).toBe(403);
    const call = await fetch(`${server.url}/api/tools/probe_echo`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: payload });
    expect(call.status).toBe(200);
    expect((await call.json() as { result: { nonce: string } }).result.nonce).toBe('HTTP-中文');
    const invalid = await fetch(`${server.url}/api/tools/probe_echo`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{bad' });
    expect(invalid.status).toBe(400);
    const obsolete = await fetch(`${server.url}/api/tools/probe_echo`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-latex-protocol': '0' }, body: payload });
    expect(obsolete.status).toBe(400);
  } finally { await server.close(); await app.close(); }
});

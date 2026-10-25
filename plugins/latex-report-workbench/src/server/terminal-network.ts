import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type SystemProxy = { enabled: boolean; server: string };
function proxyUrl(server: string | undefined): string | undefined {
  if (!server) return undefined;
  try { const url = new URL(server.includes('://') ? server : `http://${server}`); return ['http:', 'https:', 'socks5:'].includes(url.protocol) && url.hostname && !/\s/.test(server) ? url.href.replace(/\/$/, '') : undefined; } catch { return undefined; }
}
/** Read-only bridge from existing user network settings to a child CLI's environment. */
export function terminalProxyEnvironment(environment: NodeJS.ProcessEnv, proxy: SystemProxy): NodeJS.ProcessEnv {
  const env = { ...environment };
  // A nested CLI is its own session. Parent desktop pipe/task IDs otherwise attach it to the
  // running agent's tools/runtime instead of a standalone local CLI. Keep explicit user homes/auth.
  for (const name of Object.keys(env)) if (name.startsWith('CODEX_') && !['CODEX_HOME', 'CODEX_API_KEY'].includes(name)) delete env[name];
  if (proxy.enabled && !env.ALL_PROXY && !env.all_proxy) {
    const entries = Object.fromEntries(proxy.server.split(';').map(part => part.split('=', 2)).filter(parts => parts.length === 2));
    if (!env.HTTPS_PROXY && !env.https_proxy) { const url = proxyUrl(entries.https ?? entries.http ?? proxy.server); if (url) env.HTTPS_PROXY = url; }
    if (!env.HTTP_PROXY && !env.http_proxy) { const url = proxyUrl(entries.http ?? entries.https ?? proxy.server); if (url) env.HTTP_PROXY = url; }
  }
  env.NO_PROXY = [...new Set([...(env.NO_PROXY ?? env.no_proxy ?? '').split(',').filter(Boolean), '127.0.0.1', 'localhost', '::1'])].join(',');
  return env;
}
export async function codexEnvironment(): Promise<NodeJS.ProcessEnv> {
  if (process.platform !== 'win32') return terminalProxyEnvironment(process.env, { enabled: false, server: '' });
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const [enabled, server] = await Promise.all(['ProxyEnable', 'ProxyServer'].map(value => promisify(execFile)('reg.exe', ['query', key, '/v', value], { shell: false, windowsHide: true, timeout: 3000 })));
    return terminalProxyEnvironment(process.env, { enabled: /ProxyEnable\s+REG_DWORD\s+0x1\s*$/mi.test(enabled!.stdout), server: /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(server!.stdout)?.[1]?.trim() ?? '' });
  } catch { return terminalProxyEnvironment(process.env, { enabled: false, server: '' }); }
}

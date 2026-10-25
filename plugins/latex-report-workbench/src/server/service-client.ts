import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Application } from './application.js';
import { readJson, workspaceLayout } from './store.js';
import { WorkbenchError, type ErrorEnvelope } from '../shared/errors.js';

export type ServiceDescriptor = { pid: number; url: string; token: string; workspaceId: string; root: string; protocolVersion: number };

export async function discoverService(root: string): Promise<ServiceDescriptor | null> {
  const descriptor = await readJson<ServiceDescriptor>(workspaceLayout(root).service);
  if (!descriptor || descriptor.root !== root || descriptor.protocolVersion !== 1) return null;
  const url = new URL(descriptor.url);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') return null;
  try {
    const response = await fetch(`${descriptor.url}/health`, { signal: AbortSignal.timeout(1000) });
    const health = await response.json() as { workspaceId: string; pid: number };
    return health.workspaceId === descriptor.workspaceId && health.pid === descriptor.pid ? descriptor : null;
  } catch { return null; }
}

/** stdio is a transport proxy. All chats and the browser use one workspace daemon. */
export async function connectWorkspaceService(directory: string): Promise<Pick<Application, 'call'>> {
  const root = await realpath(directory);
  let service = await discoverService(root);
  if (!service) {
    const module = fileURLToPath(new URL(`./daemon${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url));
    const loader = module.endsWith('.ts') ? ['--import', 'tsx'] : [];
    const child = spawn(process.execPath, [...loader, module, '--serve', '--workspace', root, '--managed'], { cwd: root, windowsHide: true, shell: false, detached: true, stdio: 'ignore' });
    child.unref();
    const deadline = Date.now() + 15_000;
    while (!service && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      service = await discoverService(root);
    }
    if (!service) throw new WorkbenchError('BUILD_FAILED', '本地报告服务未能启动，请运行工作区诊断。');
  }
  return {
    async call(name, input) {
      const endpoint = await discoverService(root);
      if (!endpoint) return (await connectWorkspaceService(root)).call(name, input);
      const response = await fetch(`${endpoint.url}/api/tools/${name}`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json', 'x-latex-protocol': '1' }, body: JSON.stringify(input) });
      const envelope = await response.json() as { ok: boolean; result: never; error: ErrorEnvelope };
      if (!response.ok || !envelope.ok) throw new WorkbenchError(envelope.error.code, envelope.error.message, envelope.error.retryable, envelope.error.details);
      return envelope.result;
    },
  };
}

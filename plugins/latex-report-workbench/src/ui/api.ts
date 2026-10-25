import type { HostCapabilities, SelectionContext, ToolArguments, ToolName, ToolResults, TerminalBinding, TerminalSession } from '../shared/contracts.js';
import type { ErrorEnvelope } from '../shared/errors.js';

export type WorkspaceEventLite = { sequence: number; kind: 'files-changed' | 'outline-changed' | 'build-changed' | 'selection-changed' | 'operation-committed'; reportId: string; buildId?: string; operationId?: string };

export interface ToolClient {
  terminal?: TerminalTransport;
  call<N extends ToolName>(name: N, input: ToolArguments<N>): Promise<ToolResults[N]>;
  /** Present when the transport can expose the shared workspace event stream (local HTTP mode). */
  pollEvents?(since: number): Promise<WorkspaceEventLite[]>;
  /**
   * Present when the host can share the current edit target with the running chat. A missing
   * implementation means the panel stays in explicit-context mode; it never fakes a handshake.
   */
  updateSelectionContext?(context: SelectionContext | null): Promise<void>;
  detectCapabilities?(): Promise<HostCapabilities>;
  sendUserRequestedMessage?(prompt: string): Promise<void>;
  close(): Promise<void>;
}

export interface TerminalTransport {
  create(binding: TerminalBinding): Promise<TerminalSession>;
  bind(sessionId: string, binding: TerminalBinding | null): Promise<void>;
  request(sessionId: string, prompt: string, binding: TerminalBinding, submit?: boolean): Promise<void>;
  stop(sessionId: string): Promise<void>;
  socket(sessionId: string, cols: number, rows: number): Promise<WebSocket>;
}

export class ToolCallError extends Error {
  constructor(message: string, readonly envelope?: ErrorEnvelope) {
    super(message);
    this.name = 'ToolCallError';
  }
}

export class LocalToolClient implements ToolClient {
  private token: Promise<string> | undefined;
  private async requireToken(): Promise<string> {
    this.token ??= fetch('/api/bootstrap').then(async response => {
      if (!response.ok) throw new Error('本地服务不可用。');
      const bootstrap = await response.json() as { token: string; protocolVersion: number };
      if (bootstrap.protocolVersion !== 1) throw new Error('工作台版本不兼容，请刷新界面或重新打开插件。');
      return bootstrap.token;
    });
    return this.token;
  }
  private async terminalPost(endpoint: string, input: unknown) {
    const response = await fetch(`/api/terminal/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.requireToken()}` }, body: JSON.stringify(input) });
    const result = await response.json() as { ok: boolean; session?: TerminalSession; error?: ErrorEnvelope };
    if (!response.ok || !result.ok) throw new Error(result.error?.message ?? '终端操作失败。');
    return result;
  }
  readonly terminal: TerminalTransport = {
    create: async binding => { const result = await this.terminalPost('sessions', binding); if (!result.session) throw new Error('终端未返回会话。'); return result.session; },
    bind: async (id, binding) => { await this.terminalPost(`sessions/${id}/bind`, binding); },
    request: async (id, prompt, binding, submit) => { await this.terminalPost(`sessions/${id}/request`, { prompt, binding, ...(submit === undefined ? {} : { submit }) }); },
    stop: async id => { await this.terminalPost(`sessions/${id}/stop`, {}); },
    socket: async (sessionId, cols, rows) => {
      const token = await this.requireToken();
      const address = new URL('/api/terminal/socket', window.location.href); address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(address);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'attach', token, sessionId, cols, rows })), { once: true });
      return socket;
    },
  };
  async call<N extends ToolName>(name: N, input: ToolArguments<N>): Promise<ToolResults[N]> {
    const response = await fetch(`/api/tools/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-latex-protocol': '1', authorization: `Bearer ${await this.requireToken()}` }, body: JSON.stringify(input) });
    const body = await response.json() as { ok: boolean; result?: ToolResults[N]; error?: ErrorEnvelope };
    if (!response.ok || !body.ok || !body.result) throw new ToolCallError(body.error?.message ?? '本地工具调用失败。', body.error);
    return body.result;
  }
  async pollEvents(since: number): Promise<WorkspaceEventLite[]> {
    const response = await fetch(`/api/events?since=${since}`, { headers: { authorization: `Bearer ${await this.requireToken()}` } });
    if (!response.ok) throw new Error('读取工作区事件失败。');
    return (await response.json() as { events: WorkspaceEventLite[] }).events;
  }
  async close() { this.token = undefined; }
}

const ASSET_CHUNK_BYTES = 262_144;

/** Re-assembles a build asset through the chunked UI tool; bytes never become model content. */
export async function loadAssetBytes(client: ToolClient, reportId: string, buildId: string, assetId: string, totalBytes: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let guard = 0;
  while (guard < 1024) {
    guard += 1;
    const chunk = await client.call('workspace_asset_read', { reportId, buildId, assetId, offset, maxBytes: ASSET_CHUNK_BYTES });
    const binary = atob(chunk.bytesBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    parts.push(bytes);
    if (chunk.nextOffset === null || chunk.nextOffset <= offset) break;
    offset = chunk.nextOffset;
  }
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  if (length !== totalBytes) throw new Error(`资产分块不完整：已读取 ${length} / ${totalBytes} 字节。`);
  const merged = new Uint8Array(length);
  let cursor = 0;
  for (const part of parts) {
    merged.set(part, cursor);
    cursor += part.length;
  }
  return merged;
}

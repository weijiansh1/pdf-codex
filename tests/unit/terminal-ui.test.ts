import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CodexTerminal } from '../../plugins/latex-report-workbench/src/ui/CodexTerminal.js';
import { TerminalService } from '../../plugins/latex-report-workbench/src/server/terminal.js';
import type { ToolClient } from '../../plugins/latex-report-workbench/src/ui/api.js';
import { fixture } from '../helpers/workspace.js';

// Canvas rendering belongs to the real browser test. Keep React lifecycle and actual daemon
// permissions here, so a missing HTTP suspension is observed through the real write gate.
vi.mock('@xterm/xterm', () => ({ Terminal: class { cols = 80; rows = 24; receive = (_data: string) => {}; loadAddon() {} open() {} reset() {} write(data: string, done?: () => void) { if (data === 'DEVICE_QUERY') this.receive('DEVICE_REPLY'); done?.(); } focus() {} dispose() {} onData(receive: (data: string) => void) { this.receive = receive; return { dispose() {} }; } onResize() { return { dispose() {} }; } } }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
class ByteSocket extends EventTarget { readyState = 1; messages: string[] = []; send(data: string) { this.messages.push(data); } close() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code: 1006 })); } }
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); }); };

it('revokes HTTP write access when WS disconnects and the PDF draft becomes dirty', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const window = new Window();
  for (const [name, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Element: window.Element, ResizeObserver: window.ResizeObserver, sessionStorage: window.sessionStorage })) vi.stubGlobal(name, value);
  const f = await fixture();
  const terminal = new TerminalService(f.app, { launch: async () => ({ file: process.execPath, args: ['-e', "process.stdout.write('READY');setInterval(()=>{},1000)"] }) });
  const { report } = await f.app.call('report_open', { reportId: f.reportId });
  let sessionId = ''; let byteSocket: ByteSocket | undefined;
  const client: ToolClient = { call: f.app.call.bind(f.app), close: async () => undefined, terminal: {
    create: async binding => { const session = await terminal.create(binding); sessionId = session.sessionId; return session; },
    bind: async (id, binding) => { if (binding) await terminal.bind(id, binding); else terminal.suspend(id); },
    request: (id, prompt, binding) => terminal.request(id, prompt, binding), stop: id => terminal.stop(id),
    socket: async () => { byteSocket = new ByteSocket(); return byteSocket as unknown as WebSocket; },
  } };
  sessionStorage.setItem(`latex-terminal:${f.viewId}:${f.reportId}`, 'restore');
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const props = { client, mode: 'local' as const, report, workspaceId: f.app.workspace.workspaceId, contextId: f.contextId, viewId: f.viewId, selection: null, draftPending: false, selectionPending: false, selectionFailed: false };
  try {
    await act(async () => { root.render(createElement(CodexTerminal, props)); });
    const deadline = Date.now() + 6000; while (!byteSocket && Date.now() < deadline) await flush();
    expect(byteSocket).toBeDefined();
    await act(async () => { byteSocket!.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'attached', session: terminal.get(sessionId) }) })); });
    await flush();
    // Replayed startup queries must not send stale terminal replies into the user's composer.
    await act(async () => { byteSocket!.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'output', data: 'DEVICE_QUERY', replay: true }) })); });
    expect(byteSocket!.messages.filter(raw => JSON.parse(raw).type === 'input')).toHaveLength(0);
    await act(async () => { byteSocket!.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'output', data: 'DEVICE_QUERY' }) })); });
    expect(byteSocket!.messages.filter(raw => JSON.parse(raw).type === 'input').map(raw => JSON.parse(raw).data)).toEqual(['DEVICE_REPLY']);
    // Attachment starts an asynchronous binding check against the workspace; wait for its result.
    await vi.waitFor(async () => {
      expect((await terminal.call(sessionId, 'terminal_target', {}) as { reportId: string }).reportId).toBe(f.reportId);
    }, { timeout: 6000, interval: 40 });
    await act(async () => { byteSocket!.close(); root.render(createElement(CodexTerminal, { ...props, draftPending: true })); });
    await flush();
    await expect(terminal.call(sessionId, 'terminal_target', {})).rejects.toThrow();
  } finally { await act(async () => root.unmount()); container.remove(); await terminal.close(); await f.close(); await window.happyDOM.close(); vi.unstubAllGlobals(); }
}, 15000);

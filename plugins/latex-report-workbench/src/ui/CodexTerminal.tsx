import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalBinding, TerminalSession } from '../shared/contracts.js';
import { CodexRequestPanel, type CodexRequestPanelProps } from './CodexRequestPanel.js';

type Props = Omit<CodexRequestPanelProps, 'onTerminalRequest' | 'terminalConnected'> & { viewId: string };
export function CodexTerminal(props: Props) {
  const { client, report, contextId, viewId, selection, draftPending, selectionPending, selectionFailed } = props;
  const transport = client.terminal;
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const replaying = useRef(0);
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [status, setStatus] = useState('尚未启动');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const identity = `${report?.reportId ?? ''}:${contextId}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const binding: TerminalBinding | null = report && contextId ? { reportId: report.reportId, contextId, viewId, ...(selection ? { selectionId: selection.selectionId } : {}) } : null;
  const bindingRef = useRef(binding); bindingRef.current = binding;
  const blocked = !binding || draftPending || selectionPending || selectionFailed;
  const blockedRef = useRef(blocked); blockedRef.current = blocked;

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({ cursorBlink: true, fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 13, scrollback: 5000, allowProposedApi: false, theme: { background: '#101826', foreground: '#d9e4f3', cursor: '#8fb4ff', selectionBackground: '#355380' } });
    const addon = new FitAddon(); term.loadAddon(addon); term.open(host.current); addon.fit(); terminal.current = term; fit.current = addon;
    const data = term.onData(data => { if (!replaying.current && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'input', data })); });
    const resize = term.onResize(({ cols, rows }) => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'resize', cols: Math.max(20, Math.min(500, cols)), rows: Math.max(4, Math.min(200, rows)) })); });
    const observer = new ResizeObserver(() => { if (host.current?.clientWidth) addon.fit(); }); observer.observe(host.current);
    return () => { observer.disconnect(); data.dispose(); resize.dispose(); term.dispose(); terminal.current = null; fit.current = null; };
  }, []);

  // Restore only a previously started report session. Opening a page never starts a model turn.
  useEffect(() => {
    setSession(null); setConnected(false); setError(''); setStatus('尚未启动'); terminal.current?.reset();
    if (!transport || !binding || !sessionStorage.getItem(`latex-terminal:${viewId}:${binding.reportId}`)) return;
    const captured = identity;
    void transport.create(binding).then(s => { if (identityRef.current === captured) setSession(s); }).catch(e => { if (identityRef.current === captured) setError(String(e.message)); });
  }, [identity, transport, viewId]);

  useEffect(() => {
    if (!transport || !session) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined; let opened: WebSocket | undefined;
    setStatus('连接中…'); setConnected(false);
    void transport.socket(session.sessionId, Math.max(20, Math.min(500, terminal.current?.cols ?? 100)), Math.max(4, Math.min(200, terminal.current?.rows ?? 28))).then(ws => {
      opened = ws;
      if (stopped) { ws.close(); return; }
      socket.current = ws;
      ws.addEventListener('message', message => {
        if (stopped) return;
        const e = JSON.parse(String(message.data));
        if (e.type === 'attached') { terminal.current?.reset(); setConnected(e.session.state === 'running'); setStatus(e.session.state === 'running' ? '已连接 · Codex CLI' : `已退出 · ${e.session.exitCode}`); fit.current?.fit(); }
        if (e.type === 'output') {
          if (e.replay && terminal.current) { replaying.current++; terminal.current.write(e.data, () => { replaying.current = Math.max(0, replaying.current - 1); }); }
          else terminal.current?.write(e.data);
        }
        if (e.type === 'exit') { setConnected(false); setStatus(`已退出 · ${e.exitCode}`); sessionStorage.removeItem(`latex-terminal:${viewId}:${session.reportId}`); }
        if (e.type === 'error') { setError(e.message); setConnected(false); }
      });
      ws.addEventListener('close', event => { if (stopped) return; setConnected(false); socket.current = null; if (event.code !== 1008) { setStatus('连接中断，正在重连…'); timer = setTimeout(() => setRetry(n => n + 1), 2500); } else setStatus('连接已拒绝，请重新启动终端'); });
      ws.addEventListener('error', () => { if (!stopped) setStatus('连接中断，正在重连…'); });
    }).catch(e => { if (!stopped) setError(String(e.message)); });
    return () => { stopped = true; if (timer) clearTimeout(timer); opened?.close(); if (socket.current === opened) socket.current = null; };
  }, [session, retry, transport, viewId]);

  useEffect(() => {
    if (!transport || !session) return;
    let active = true;
    void transport.bind(session.sessionId, blocked || !connected ? null : binding).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [transport, session, connected, blocked, identity, selection?.selectionId]);

  const start = async () => {
    if (!transport || !bindingRef.current || blockedRef.current) return;
    setBusy(true); setError(''); const captured = identity;
    try { const s = await transport.create(bindingRef.current); if (identityRef.current !== captured) return; setSession(s); sessionStorage.setItem(`latex-terminal:${viewId}:${s.reportId}`, s.sessionId); }
    catch (e) { if (identityRef.current === captured) setError(e instanceof Error ? e.message : '启动 Codex 失败。'); }
    finally { setBusy(false); }
  };
  const request = async (prompt: string) => {
    if (!transport || !session || !connected || !bindingRef.current || blockedRef.current) throw new Error('先保存草稿、完成目标选择并启动终端。');
    const captured = bindingRef.current;
    await transport.bind(session.sessionId, captured);
    if (blockedRef.current || captured.reportId !== bindingRef.current?.reportId || captured.contextId !== bindingRef.current?.contextId || captured.selectionId !== bindingRef.current?.selectionId) throw new Error('目标正在变化，请重新填入。');
    await transport.request(session.sessionId, prompt, captured, true); terminal.current?.focus();
  };
  return <section className="codex-dock" aria-label="网页 Codex 终端">
    <div className="terminal-heading"><div><strong>Codex</strong><span>{status}</span></div><div className="terminal-actions">
      {!connected && <button type="button" disabled={!binding || blocked || busy} onClick={() => { void start(); }}>{busy ? '启动中…' : session ? '重启终端' : '启动 Codex'}</button>}
      <button type="button" disabled={!connected} onClick={() => { socket.current?.send(JSON.stringify({ type: 'input', data: '\x03' })); terminal.current?.focus(); }} title="发送 Ctrl+C">中断</button>
      <button type="button" disabled={!session || busy} onClick={() => { if (!session || !transport) return; setBusy(true); void transport.stop(session.sessionId).then(() => { sessionStorage.removeItem(`latex-terminal:${viewId}:${session.reportId}`); setSession(null); setStatus('已结束'); setConnected(false); }).catch(e => setError(e.message)).finally(() => setBusy(false)); }}>结束</button>
    </div></div>
    <div className="terminal-description">本页独立 Codex 会话 · 复用本机登录 · {report?.mainFile.endsWith('.html') ? 'HTML 保存即时刷新' : 'LaTeX 保存自动编译'}</div>
    {error && <div className="error" role="alert">{error}<button type="button" onClick={() => setError('')}>关闭</button></div>}
    <div className="terminal-surface" ref={host} aria-label="Codex 命令行"/>
    {!session && <p className="terminal-empty">点击“启动 Codex”，随后直接在终端输入。首次启动时，在终端完成目录信任或登录提示。</p>}
    <CodexRequestPanel {...props} onTerminalRequest={request} terminalConnected={connected}/>
  </section>;
}

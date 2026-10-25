import { useEffect, useRef, useState } from 'react';
import type { ReportRecord, SelectionRecord } from '../shared/contracts.js';
import type { ToolClient } from './api.js';
import { browserAnnotation, buildChatRequest, deliverHostMessage, requestBrowserAnnotation } from './chat-request.js';

export type CodexRequestPanelProps = {
  client: ToolClient;
  mode: 'local' | 'desktop';
  report: ReportRecord | null;
  workspaceId: string;
  contextId: string;
  viewId?: string;
  selection: SelectionRecord | null;
  draftPending: boolean;
  selectionPending: boolean;
  selectionFailed: boolean;
  onTerminalRequest?: (prompt: string) => Promise<void>;
  terminalConnected?: boolean;
};

export function CodexRequestPanel({ client, mode, report, workspaceId, contextId, viewId, selection, draftPending, selectionPending, selectionFailed, onTerminalRequest, terminalConnected }: CodexRequestPanelProps) {
  const [prompt, setPrompt] = useState('');
  const [annotationAvailable, setAnnotationAvailable] = useState(false);
  const [hostAvailable, setHostAvailable] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const target = useRef<HTMLDivElement>(null);
  const identity = `${report?.reportId ?? ''}:${contextId}:${selection?.selectionId ?? ''}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const promptStorage = `latex-workbench:request:${workspaceId}:${report?.reportId ?? ''}:${viewId ?? contextId}`;
  useEffect(() => { try { setPrompt(window.localStorage.getItem(promptStorage) ?? ''); } catch { setPrompt(''); } }, [promptStorage]);

  useEffect(() => {
    setFeedback('');
  }, [identity, report?.reportId]);

  useEffect(() => {
    let active = true;
    const update = () => setAnnotationAvailable(Boolean(browserAnnotation()));
    update();
    // The browser can grant/revoke the site feature after the document has loaded.
    window.addEventListener('focus', update);
    const timer = setInterval(update, 2_000);
    if (mode === 'desktop' && client.detectCapabilities && client.sendUserRequestedMessage) {
      void client.detectCapabilities().then(capabilities => { if (active) setHostAvailable(capabilities.sendMessage); }).catch(() => { if (active) setHostAvailable(false); });
    }
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', update); };
  }, [client, mode]);

  let request = null;
  let validation = '';
  if (report) {
    try { request = buildChatRequest({ workspaceId, report, contextId, selection, prompt, draftPending, selectionPending, selectionFailed }); }
    catch (error) { validation = error instanceof Error ? error.message : '当前修改对象尚未准备好。'; }
  }
  const canConnect = onTerminalRequest ? Boolean(terminalConnected) : mode === 'desktop' ? hostAvailable : annotationAvailable;
  const connection = onTerminalRequest ? terminalConnected ? '网页终端已连接' : '先启动终端' : mode === 'desktop' && hostAvailable ? '当前聊天已连接' : mode === 'local' && annotationAvailable ? '可交给当前聊天' : '聊天连接不可用';

  const submit = () => {
    if (!request || !target.current || pending) return;
    setFeedback('');
    if (onTerminalRequest) {
      const captured = identity; setPending(true);
      void onTerminalRequest(prompt).then(() => { if (identityRef.current === captured) { setFeedback('已发送给 Codex。选中的图表会通过 terminal_target 同时提供图像。'); setPrompt(''); try { window.localStorage.removeItem(promptStorage); } catch { /* Optional storage. */ } } })
        .catch(error => { if (identityRef.current === captured) setFeedback(error instanceof Error ? error.message : '发送失败。'); })
        .finally(() => setPending(false));
      return;
    }
    if (mode === 'local') {
      try {
        requestBrowserAnnotation(browserAnnotation(), target.current, request);
        setFeedback('批注请求已准备。请在弹出的 Codex 批注编辑器中核对并发送；发送后，Codex 才会开始处理。');
      } catch (error) { setFeedback(error instanceof Error ? error.message : '无法打开批注编辑器。'); }
      return;
    }
    if (!hostAvailable) { setFeedback('当前宿主没有声明聊天消息能力，可复制修改请求。'); return; }
    const captured = identity;
    setPending(true);
    void deliverHostMessage(client.sendUserRequestedMessage?.bind(client), request)
      .then(() => { if (identityRef.current === captured) setFeedback('修改请求已提交到当前聊天；执行结果和编译状态将在聊天与工作台中更新。'); })
      .catch(error => { if (identityRef.current === captured) setFeedback(error instanceof Error ? error.message : '提交修改请求失败。'); })
      .finally(() => setPending(false));
  };

  return <section className="codex-request-panel" aria-label="让 Codex 修改">
    <div className="codex-request-heading"><strong>让 Codex 修改</strong><span>{connection}</span></div>
    <div ref={target} className="codex-request-target" oai-annotatable="LaTeX 报告修改对象" oai-annotation-metadata={request ? JSON.stringify(request.metadata) : undefined}>
      <span className="codex-request-scope">{selectionPending ? '正在绑定选择对象…' : selectionFailed ? '请重新选择对象' : selection ? '当前选区' : '当前整份报告'}</span>
      <p>{report?.title ?? '先选择一份报告'}</p>
      {selection && <p className="codex-request-quote">{selection.kind === 'chapter' ? `已选择章节正文 · ${selection.targets.length} 个文件` : /\\[a-zA-Z]+/.test(selection.selectedText) ? `已选择源码内容 · ${selection.targets.length} 个目标` : selection.selectedText.slice(0, 180) || selection.targets[0]?.relativePath}</p>}
      {prompt.trim() && <p className="codex-request-intent">修改要求：{prompt.trim()}</p>}
      {report && <span className="codex-request-path">{report.rootRelativePath}{selection?.targets[0] ? ` / ${selection.targets[0].relativePath}` : ''}</span>}
    </div>
    <label htmlFor="codex-modification-request">修改要求</label>
    <textarea id="codex-modification-request" value={prompt} disabled={!report || pending} maxLength={12_000} rows={3}
      placeholder="例如：把结论压缩成三点，保留实验数据。"
      onChange={event => { setPrompt(event.target.value); setFeedback(''); try { window.localStorage.setItem(promptStorage, event.target.value); } catch { /* The visible prompt remains usable. */ } }}
      onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}/>
    <div className="codex-request-actions">
      <button type="button" className="primary" disabled={!request || !canConnect || pending} onClick={submit}>{pending ? '提交中…' : onTerminalRequest ? '发送给 Codex' : mode === 'desktop' ? '交给当前 Codex' : '在当前聊天中修改'}</button>
      <button type="button" disabled={!request || pending} onClick={() => {
        if (!request) return;
        void navigator.clipboard.writeText(request.message).then(() => setFeedback('已复制修改请求，可粘贴到当前 Codex 聊天。')).catch(() => setFeedback('复制失败，请检查浏览器剪贴板权限。'));
      }}>复制请求</button>
    </div>
    <p className="codex-request-help">{onTerminalRequest ? 'Ctrl+Enter 直接发送。首次启动后先在终端完成登录或目录信任；执行批准仍在终端确认。' : !canConnect ? '请在支持批注的 Codex 内嵌浏览器打开工作台。当前也可复制完整请求。' : mode === 'local' ? '打开原生批注编辑器，核对后发送到当前聊天。Ctrl+Enter 可打开。' : '请求连同当前报告和选区一起交给当前聊天。'}</p>
    {validation && prompt.trim() && <p className="codex-request-validation" role="status">{validation}</p>}
    {feedback && <p className="codex-request-feedback" role="status">{feedback}</p>}
  </section>;
}

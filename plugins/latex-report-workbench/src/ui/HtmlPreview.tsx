import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HtmlPreview as Preview, HtmlTextRun } from '../shared/contracts.js';
import { renderHtmlDocument } from '../shared/html-report.js';
import type { ToolClient } from './api.js';

type Props = { client: ToolClient; reportId: string; contextId: string; viewId: string; refreshKey: number;
  draft: { relativePath: string; text: string; dirty: boolean } | null;
  onPick: (blockId: string, fileVersion: string) => void; onChanged: () => void; onEditing: (value: boolean) => void;
  onOpenSource?: (relativePath: string) => void;
};

type ReadingPosition = { x: number; y: number; anchor: string; offset: number; block?: string; blockOffset?: number };
function readingPosition(value: unknown): ReadingPosition | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as ReadingPosition;
  const valid = [p.x, p.y, p.offset].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100_000_000) && p.x >= 0 && p.y >= 0 && typeof p.anchor === 'string' && p.anchor.length <= 512;
  if (!valid) return null;
  const block = typeof p.block === 'string' && /^[a-z0-9-]{1,80}$/i.test(p.block) && typeof p.blockOffset === 'number' && Number.isFinite(p.blockOffset) && Math.abs(p.blockOffset) <= 100_000_000 ? { block: p.block, blockOffset: p.blockOffset } : {};
  return { x: p.x, y: p.y, anchor: p.anchor, offset: p.offset, ...block };
}

function frameDocument(html: string, key: string): string {
  const origin = window.location.origin;
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${origin}; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">`;
  const style = '<style data-wb-owned>html[data-wb-selecting="true"] [data-wb-block]:hover{outline:1px dashed #148395;outline-offset:3px;cursor:crosshair}[data-wb-selected]{outline:2px solid #148395;outline-offset:3px}[contenteditable]{outline:2px solid #148395!important;background:#eaf8fc!important;cursor:text}</style>';
  // A separate static script works under the parent's strict CSP. User scripts remain
  // stripped; the sandbox has no same-origin access, network, forms or navigation grants.
  const script = `<script data-wb-owned src="${origin}/html-preview.js#${key}"></script>`;
  return html.replace(/<head(?:\s[^>]*)?>/i, match => match + policy.replace('<meta ', '<meta data-wb-owned ') + style).replace(/<\/body>/i, script + '</body>');
}

type InlineDraft = { blockId: string; version: string; operationId: string; relativePath: string; changes?: HtmlTextRun[]; text?: string; formula?: string };
function storedDraft(key: string): InlineDraft | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? 'null') as InlineDraft | null;
    if (!value || typeof value.blockId !== 'string' || !/^[a-f0-9]{64}$/.test(value.version) || typeof value.operationId !== 'string' || typeof value.relativePath !== 'string') return null;
    if (value.changes && (!Array.isArray(value.changes) || value.changes.length > 256 || !value.changes.every(run => typeof run.runId === 'string' && typeof run.text === 'string' && run.text.length <= 100_000))) return null;
    return value;
  } catch { return null; }
}

export function HtmlPreview({ client, reportId, contextId, viewId, refreshKey, draft, onPick, onChanged, onEditing, onOpenSource }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('正在读取网页…');
  const [editing, setEditing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [view, setView] = useState('original');
  const [selecting, setSelecting] = useState(false);
  const [recovery, setRecovery] = useState<InlineDraft | null>(null);
  const [formula, setFormula] = useState<{ blockId: string; text: string } | null>(null);
  const position = useRef<ReadingPosition | null>(null);
  const positionStorage = `latex-workbench:reading:${reportId}:${viewId}`;
  useEffect(() => {
    try { position.current = readingPosition(JSON.parse(window.sessionStorage.getItem(positionStorage) ?? 'null')); } catch { position.current = null; }
    setSelecting(false);
  }, [positionStorage]);
  const frame = useRef<HTMLIFrameElement>(null);
  const editingRef = useRef(false);
  const draftRef = useRef(draft); draftRef.current = draft;
  const pending = useRef<InlineDraft | null>(null);
  const storage = `latex-workbench:inline:${reportId}:${viewId}`;
  const identity = `${reportId}:${contextId}:${viewId}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const markEditing = useCallback((value: boolean) => { editingRef.current = value; setEditing(value); onEditing(value); }, [onEditing]);
  useEffect(() => {
    setPreview(null); setError(''); pending.current = null; setFormula(null); markEditing(false);
    let saved = storedDraft(storage);
    if (!saved) {
      try { for (let i = 0; i < window.localStorage.length; i++) { const key = window.localStorage.key(i)!; if (key.startsWith(`latex-workbench:inline:${reportId}:`)) { saved = storedDraft(key); if (saved) break; } } } catch { /* No persistent storage. */ }
    }
    setRecovery(saved);
  }, [reportId, viewId, storage, markEditing]);
  useEffect(() => {
    if (!reportId || editingRef.current) return;
    let active = true;
    void client.call('report_preview', { reportId }).then(result => { if (active && result.reportId === reportId && !editingRef.current && !draftRef.current?.dirty) { setPreview(current => current?.reportId === result.reportId && current.fileVersion === result.fileVersion && JSON.stringify(current.assets) === JSON.stringify(result.assets) ? current : result); setError(''); setStatus(`网页已更新 · ${result.renderMs} ms`); } })
      .catch(failure => { if (active && !editingRef.current) setError(failure instanceof Error ? failure.message : '读取网页失败'); });
    return () => { active = false; };
  }, [client, reportId, refreshKey, reloadKey]);
  const localDraft = Boolean(preview?.reportId === reportId && draft?.dirty && draft.relativePath === preview?.relativePath);
  const projection = useMemo(() => preview?.reportId === reportId ? localDraft && draft ? renderHtmlDocument(draft.text, preview.assets).html : preview.html : '', [preview, reportId, localDraft, draft?.text]);
  const key = useMemo(() => crypto.randomUUID().replaceAll('-', ''), [reportId, viewId]);
  const initial = useRef({ key: '', doc: '', projection: '', version: '' });
  const ready = useRef(false);
  const updateSequence = useRef(0);
  const displayed = useRef<string | null>(null);
  if (initial.current.key !== key) { initial.current = { key, doc: '', projection: '', version: '' }; ready.current = false; displayed.current = null; }
  if (!initial.current.doc && projection && preview) initial.current = { key, doc: frameDocument(projection, key), projection, version: preview.fileVersion };
  const doc = initial.current.doc;
  const post = useCallback((value: object) => frame.current?.contentWindow?.postMessage({ key, ...value }, '*'), [key]);
  useEffect(() => {
    if (!ready.current || !preview || editingRef.current) return;
    displayed.current = null;
    post({ type: 'update', html: projection, version: ++updateSequence.current, readOnly: Boolean(preview.generatedFrom || localDraft) });
  }, [projection, preview, localDraft, editing, post]);
  const retain = useCallback((change: InlineDraft) => {
    pending.current = change;
    try { window.localStorage.setItem(storage, JSON.stringify(change)); }
    catch { setError('浏览器存储已满，请保存当前修改。'); }
  }, [storage]);
  const clearDraft = useCallback(() => {
    const change = pending.current ?? recovery;
    try {
      for (let i = window.localStorage.length - 1; i >= 0; i--) {
        const key = window.localStorage.key(i)!;
        if (key.startsWith(`latex-workbench:inline:${reportId}:`) && storedDraft(key)?.operationId === change?.operationId) window.localStorage.removeItem(key);
      }
    } catch { /* Saved report remains authoritative. */ }
    pending.current = null; setRecovery(null);
  }, [reportId, recovery]);
  const save = useCallback(async () => {
    const change = pending.current; if (!change) return;
    const captured = identityRef.current;
    setStatus('保存文字…');
    try {
      await client.call('html_edit', { reportId, contextId, viewId, expectedVersion: change.version, blockId: change.blockId, ...(change.changes ? { changes: change.changes } : change.formula !== undefined ? { formula: change.formula } : { text: change.text! }), operationId: change.operationId });
      if (captured !== identityRef.current) return;
      clearDraft(); setFormula(null); post({ type: 'saved' }); markEditing(false); setError(''); setStatus('修改已保存'); setReloadKey(value => value + 1); onChanged();
    } catch (failure) { if (captured === identityRef.current) setError(`${failure instanceof Error ? failure.message : '保存失败'} 文字保留在预览中，可重试或取消。`); }
  }, [client, reportId, contextId, viewId, markEditing, onChanged, clearDraft, post]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (pending.current && storedDraft(storage)?.operationId !== pending.current.operationId) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [storage]);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.key !== key || !preview || preview.reportId !== reportId) return;
      const message = event.data as { type?: string; blockId?: string; text?: string; changes?: HtmlTextRun[]; position?: unknown; version?: number };
      if (message.type === 'ready') {
        ready.current = true; displayed.current = initial.current.version;
        post({ type: 'configure', view, selecting, readOnly: Boolean(preview.generatedFrom || localDraft), position: position.current });
        if (initial.current.projection !== projection) { displayed.current = null; post({ type: 'update', html: projection, version: ++updateSequence.current, readOnly: Boolean(preview.generatedFrom || localDraft) }); }
      }
      if (message.type === 'updated' && message.version === updateSequence.current) displayed.current = preview.fileVersion;
      if (message.type === 'position') {
        const next = readingPosition(message.position);
        if (next) { position.current = next; try { window.sessionStorage.setItem(positionStorage, JSON.stringify(next)); } catch { /* Reading continues when storage is unavailable. */ } }
      }
      if (localDraft) return;
      if (message.type === 'select' && message.blockId && displayed.current === preview.fileVersion && !editingRef.current) onPick(message.blockId, preview.fileVersion);
      if (message.type === 'editing' && !preview.generatedFrom) markEditing(true);
      if (message.type === 'cancel') { clearDraft(); setFormula(null); markEditing(false); setError(''); setReloadKey(v => v + 1); }
      if (message.type === 'formula' && !preview.generatedFrom && !editingRef.current) {
        const block = preview.blocks.find(block => block.blockId === message.blockId);
        if (block?.formula !== undefined) { setFormula({ blockId: block.blockId, text: block.formula }); markEditing(true); }
      }
      if (['draft', 'edit'].includes(message.type ?? '') && !preview.generatedFrom && typeof message.blockId === 'string' && (typeof message.text === 'string' || Array.isArray(message.changes))) {
        const block = preview.blocks.find(block => block.blockId === message.blockId);
        if (!block?.editable) return;
        if (message.changes && (!message.changes.every(run => typeof run.text === 'string' && run.text.length <= 100_000 && block.runs?.some(allowed => allowed.runId === run.runId)) || message.changes.length > 256)) return;
        const previous = pending.current;
        retain({ blockId: message.blockId, ...(message.changes ? { changes: message.changes } : { text: message.text! }), relativePath: preview.relativePath, version: previous?.blockId === message.blockId ? previous.version : preview.fileVersion, operationId: previous?.blockId === message.blockId ? previous.operationId : crypto.randomUUID() });
        markEditing(true);
        if (message.type === 'edit') void save();
      }
    };
    window.addEventListener('message', listener); return () => window.removeEventListener('message', listener);
  }, [key, preview, reportId, localDraft, onPick, markEditing, save, view, selecting, positionStorage, clearDraft, retain, post, projection]);
  return <section className="html-panel" aria-label="HTML 即时预览">
    <div className="html-toolbar"><span role="status">{localDraft ? '草稿预览 · 自动保存中' : status}</span>
      <button type="button" aria-pressed={selecting} disabled={editing || localDraft} onClick={() => { const value = !selecting; setSelecting(value); frame.current?.contentWindow?.postMessage({ key, type: 'interaction', selecting: value }, '*'); }}>{selecting ? '结束选择' : '选择内容'}</button>
      <button type="button" title="重新读取当前网页，保留阅读位置和其他面板" disabled={editing || localDraft} onClick={() => setReloadKey(v => v + 1)}>刷新预览</button>
      <select aria-label="预览显示方式" value={view} onChange={event => { setView(event.target.value); frame.current?.contentWindow?.postMessage({ key, type: 'zoom', view: event.target.value }, '*'); }}><option value="original">自适应排版</option><option value="page">横版整页适配</option></select>
    </div>
    {selecting && <p className="html-help">点击段落、公式或图表，选给 Codex；目录链接仍可跳转。</p>}
    {preview?.generatedFrom && <div className="html-provenance">生成源：{preview.generatedFrom}<button type="button" onClick={() => onOpenSource?.(preview.generatedFrom!)}>编辑生成源</button><span>保存生成源后，按原项目流程重新生成网页。</span></div>}
    {recovery && !editing && <div className="html-recovery">恢复未保存的修改 · {recovery.relativePath}
      {preview?.fileVersion === recovery.version ? <button type="button" onClick={() => { retain(recovery); markEditing(true); if (recovery.formula !== undefined) setFormula({ blockId: recovery.blockId, text: recovery.formula }); else post({ type: 'recover', blockId: recovery.blockId, changes: recovery.changes }); }}>恢复草稿</button> : <><span>磁盘已有新版本，草稿保留供合并。</span><textarea readOnly aria-label="冲突草稿" value={recovery.formula ?? recovery.text ?? recovery.changes?.map(run => run.text).join('') ?? ''}/></>}
      <button type="button" onClick={clearDraft}>丢弃此草稿</button></div>}
    {error && <div className="error" role="alert">{error}{pending.current && <button onClick={() => { void save(); }}>重试保存</button>}</div>}
    {editing && <div className="html-edit-status">{formula ? '正在修改公式' : '正在修改文字 · Ctrl+S 保存'}<button type="button" onClick={() => { if (formula) { if (pending.current) void save(); else { setFormula(null); markEditing(false); } } else post({ type: 'save' }); }}>保存</button><button type="button" onClick={() => { if (formula) { clearDraft(); setFormula(null); markEditing(false); } else post({ type: 'cancel' }); }}>取消改字</button></div>}
    {formula && <div className="html-formula-editor"><label>LaTeX 公式<textarea autoFocus value={formula.text} onChange={event => { const value = { ...formula, text: event.target.value }; setFormula(value); retain({ blockId: value.blockId, formula: value.text, relativePath: preview!.relativePath, version: preview!.fileVersion, operationId: pending.current?.operationId ?? crypto.randomUUID() }); }} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); } }}/></label><div dangerouslySetInnerHTML={{ __html: renderHtmlDocument(`<span data-tex="${formula.text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}"></span>`).html }}/></div>}
    {doc ? <iframe key={key} ref={frame} title="报告网页" sandbox="allow-scripts" srcDoc={doc}/> : <div className="empty">正在准备网页预览…</div>}
  </section>;
}

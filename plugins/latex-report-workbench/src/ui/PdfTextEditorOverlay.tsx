import { useRef } from 'react';
import type { PdfEditSession } from '../shared/contracts.js';
import { changedRuns, type EditDraft } from './state.js';

export type PdfEditOverlayStatus = 'editing' | 'saving' | 'saved' | 'conflict' | 'error';

export interface PdfTextEditorOverlayProps {
  session: PdfEditSession;
  draft: EditDraft;
  status: PdfEditOverlayStatus;
  message: string;
  onChange: (runId: string, text: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}

/**
 * In-place text editor over one projected source paragraph. Editable runs become small text
 * fields; protected runs (formulas, \ref, \label, comments) are shown as read-only chips and
 * are never part of the commit payload. IME composition is respected: Enter used to pick a
 * candidate never saves; only the explicit button or Ctrl+Enter does.
 */
export function PdfTextEditorOverlay({ session, draft, status, message, onChange, onCommit, onCancel, onDismiss }: PdfTextEditorOverlayProps) {
  const composing = useRef(false);
  const dirty = changedRuns(session, draft).length > 0;
  const busy = status === 'saving';
  const closed = status === 'saved';

  return <div className={`pdf-edit-overlay status-${status}`} role="dialog" aria-label="PDF 原位文字编辑">
    <div className="pdf-edit-head">
      <strong>原位改字</strong>
      <span>{session.relativePath} · 第 {session.placement.page} 页</span>
    </div>
    <div className="pdf-edit-runs" onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); return; }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (!busy && !closed) onCommit();
      }
    }}>
      {session.runs.map(run => run.kind === 'editable'
        ? <textarea
            key={run.runId}
            className="pdf-edit-run"
            rows={1}
            value={draft[run.runId] ?? run.text}
            disabled={busy || closed}
            aria-label={`可编辑文字片段 ${run.runId.slice(0, 8)}`}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onChange={event => onChange(run.runId, event.target.value)}
            onKeyDown={event => { if (composing.current && event.key === 'Enter') event.stopPropagation(); }}
            ref={element => { if (element) autoGrow(element); }}
            onInput={event => autoGrow(event.currentTarget)}
          />
        : <span key={run.runId} className="pdf-edit-protected" title={`受保护内容，需在源码中修改：${run.text}`}>{run.text}</span>)}
    </div>
    <p className="pdf-edit-hint">输入按纯文本写回并自动转义（如 <code>%</code> → <code>\%</code>）；公式与引用保持原样，不会因改字而改动。</p>
    {message && <p className={`pdf-edit-message status-${status}`}>{message}</p>}
    <div className="pdf-edit-actions">
      {closed
        ? <button type="button" onClick={onDismiss}>关闭</button>
        : <>
            <button type="button" className="primary" disabled={busy || !dirty} onClick={onCommit}>{busy ? '保存中…' : '保存并重新编译'}</button>
            <button type="button" disabled={busy} onClick={onCancel}>取消</button>
            {status === 'conflict' && <button type="button" onClick={onDismiss}>保留草稿并关闭</button>}
          </>}
    </div>
  </div>;
}

function autoGrow(element: HTMLTextAreaElement): void {
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
}

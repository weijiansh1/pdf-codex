import type { FileSnapshot } from '../shared/contracts.js';
import type { TextRange } from '../shared/contracts.js';
import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { html, xml } from '@codemirror/legacy-modes/mode/xml';
import { css } from '@codemirror/legacy-modes/mode/css';
import { python } from '@codemirror/legacy-modes/mode/python';

export type SaveState = 'clean' | 'dirty' | 'saving' | 'conflict' | 'error';

const SAVE_LABEL: Record<SaveState, string> = {
  clean: '已保存',
  dirty: '未保存',
  saving: '保存中',
  conflict: '版本冲突，草稿保留',
  error: '保存失败，草稿保留',
};

export type SourceEditorProps = {
  value: string;
  file: FileSnapshot | null;
  saveState: SaveState;
  revealRange: TextRange | null;
  onDraftChange: (text: string) => void;
  onSave: () => void;
  onSelectionChange: (range: TextRange) => void;
  onReload: () => void;
  readOnly?: boolean;
};

/**
 * CodeMirror 6 LaTeX editor. Offsets stay in UTF-16 units of the normalized LF text, which is
 * exactly the range contract the local service validates against the raw-byte file version.
 */
export function SourceEditor({ file, value, saveState, revealRange, onDraftChange, onSave, onSelectionChange, onReload, readOnly = false }: SourceEditorProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const writable = useRef(new Compartment());
  const handlers = useRef({ onDraftChange, onSave, onSelectionChange });
  const suppressSelection = useRef(false);
  const syncing = useRef(false);
  handlers.current = { onDraftChange, onSave, onSelectionChange };

  useEffect(() => {
    if (!container.current || view.current) return;
    const state = EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        language.current.of(StreamLanguage.define(stex)),
        writable.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { handlers.current.onSave(); return true; } },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of(update => {
          if (syncing.current) return;
          if (update.docChanged) handlers.current.onDraftChange(update.state.doc.toString());
          if (update.selectionSet || update.docChanged) {
            if (suppressSelection.current) {
              suppressSelection.current = false;
              return;
            }
            const range = update.state.selection.main;
            handlers.current.onSelectionChange({ start: range.from, end: range.to });
          }
        }),
      ],
    });
    view.current = new EditorView({ state, parent: container.current });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const extension = file?.relativePath.split('.').at(-1)?.toLowerCase();
    view.current?.dispatch({ effects: language.current.reconfigure(StreamLanguage.define(extension === 'html' ? html : extension === 'css' ? css : extension === 'svg' ? xml : extension === 'py' ? python : stex)) });
  }, [file?.relativePath]);

  useEffect(() => { view.current?.dispatch({ effects: writable.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) }); }, [readOnly]);

  useEffect(() => {
    const current = view.current;
    if (!current) return;
    const next = value;
    if (current.state.doc.toString() === next) return;
    syncing.current = true;
    try { current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: next } }); }
    finally { syncing.current = false; }
  }, [file?.relativePath, value]);

  useEffect(() => {
    const current = view.current;
    if (!current || !revealRange || !file) return;
    const maximum = current.state.doc.length;
    const from = Math.min(Math.max(revealRange.start, 0), maximum);
    const to = Math.min(Math.max(revealRange.end, from), maximum);
    suppressSelection.current = true;
    current.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    current.focus();
  }, [revealRange, file?.relativePath]);

  return <section className="source-panel">
    <div className="panel-title">
      <strong>{file?.relativePath ?? '源码'}</strong>
      <span className={`save-state ${saveState}`}>{readOnly ? '生成页 · 只读' : file ? SAVE_LABEL[saveState] : '未打开文件'}</span>
    </div>
    <div className="editor-host" ref={container} style={{ display: file ? undefined : 'none' }} aria-label={`报告源码 ${file?.relativePath ?? ''}`}/>
    {!file && <div className="empty"><h2>选择左侧文件查看源码</h2><p>点击章节或选择源码范围后，在左侧“让 Codex 修改”填写要求。Ctrl+S 立即保存源码。</p></div>}
    {file && (saveState === 'conflict' || saveState === 'error') && <div className="panel-note">
      <span>{saveState === 'conflict' ? '服务端已有较新版本，草稿仍保留在编辑器中。' : '保存没有成功，草稿仍保留在编辑器中。'}</span>
      <button type="button" className="link-button" onClick={onReload}>重新载入服务端版本</button>
      <button type="button" className="link-button" onClick={onSave}>再试一次</button>
    </div>}
  </section>;
}

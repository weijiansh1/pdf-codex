import type { SelectionRecord } from '../shared/contracts.js';

const KIND_LABEL: Record<SelectionRecord['kind'], string> = { chapter: '章节', source: '源码', 'pdf-text': 'PDF 正文', 'pdf-region': 'PDF 区域' };
const STATUS_LABEL: Record<SelectionRecord['validity'], string> = { valid: '有效', stale: '已过期', ambiguous: '有歧义', unmapped: '无法映射' };

export type SelectionBarProps = {
  selection: SelectionRecord | null;
  contextBound: boolean;
  onClear: () => void;
  onRequest?: () => void;
};

export function SelectionBar({ selection, contextBound, onClear, onRequest }: SelectionBarProps) {
  if (!contextBound) return <div className="selection-bar" role="status">面板尚未绑定报告会话；选择文件不会向当前聊天发送指令。</div>;
  if (!selection) return <div className="selection-bar" role="status">点击报告内容或左侧章节，选择要交给 Codex 修改的部分。</div>;
  const preview = selection.selectedText.replace(/\s+/g, ' ').slice(0, 160);
  return <div className={`selection-bar status-${selection.validity}`} role="status">
    <span className="selection-kind">{selection.kind === 'source' && /\.html$/i.test(selection.targets[0]?.relativePath ?? '') ? '网页内容' : KIND_LABEL[selection.kind]}</span>
    <span className="selection-text">{preview || '（空选区）'}</span>
    <span className="selection-meta">
      {STATUS_LABEL[selection.validity]} · {selection.targets.length} 个目标
      {selection.targets[0] ? ` · ${selection.targets[0].relativePath}` : ''}
      {selection.buildId ? ' · 绑定构建' : ''}
    </span>
    <button type="button" className="link-button" onClick={onClear}>清除</button>
    {onRequest && <button type="button" className="link-button" onClick={onRequest}>交给 Codex</button>}
    <button type="button" className="link-button" onClick={() => { void navigator.clipboard.writeText(`请读取 report_context_get(contextId="${selection.contextId}", selectionId="${selection.selectionId}")，校验后修改当前选择对象；reportId="${selection.reportId}"。`); }}>复制修改对象</button>
  </div>;
}

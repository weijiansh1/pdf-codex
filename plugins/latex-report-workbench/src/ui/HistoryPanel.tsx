import type { OperationRecord } from '../shared/contracts.js';

const ORIGIN_LABEL: Record<OperationRecord['origin'], string> = { 'source-editor': '源码编辑', codex: 'Codex 修改', 'pdf-editor': 'PDF 原位改字', external: '外部/恢复', undo: '撤销' };
const STATE_LABEL: Record<OperationRecord['state'], string> = { prepared: '进行中', committed: '已提交', conflict: '冲突', recovered: '已恢复' };

export type HistoryPanelProps = {
  operations: OperationRecord[];
  hasMore: boolean;
  busy: boolean;
  onLoadMore: () => void;
  onUndo: (operation: OperationRecord) => void;
};

export function HistoryPanel({ operations, hasMore, busy, onLoadMore, onUndo }: HistoryPanelProps) {
  return <details className="history" open>
    <summary>修改历史 · {operations.length} 条</summary>
    {operations.length === 0 && <p>当前报告还没有修改记录。保存源码或让 Codex 修改后会出现在这里。</p>}
    <ul>{operations.map(operation => <li key={operation.operationId}>
      <div className="history-line">
        <strong>{ORIGIN_LABEL[operation.origin]}</strong>
        <span>{new Date(operation.createdAt).toLocaleString('zh-CN')}</span>
      </div>
      <p>{operation.diffSummary}</p>
      <div className="history-line">
        <span>{STATE_LABEL[operation.state]}</span>
        {operation.state === 'committed' && operation.origin !== 'undo' && <button type="button" className="link-button" disabled={busy} onClick={() => onUndo(operation)}>撤销</button>}
      </div>
    </li>)}</ul>
    {hasMore && <button type="button" className="link-button" disabled={busy} onClick={onLoadMore}>加载更多</button>}
  </details>;
}

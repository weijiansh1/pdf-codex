import type { FileTreeNode, OutlineNode } from '../shared/contracts.js';

export function NavigationTree({ nodes, selectedPath, onSelect }: { nodes: FileTreeNode[]; selectedPath: string; onSelect: (path: string) => void }) {
  return <ul className="file-tree">{nodes.map(node => <li key={node.relativePath}>{node.kind === 'directory' ? <details open><summary>{node.name}</summary><NavigationTree nodes={node.children ?? []} selectedPath={selectedPath} onSelect={onSelect}/></details> : <button aria-current={selectedPath === node.relativePath ? 'true' : undefined} onClick={() => onSelect(node.relativePath)}>{node.name}</button>}</li>)}</ul>;
}

export type OutlineTreeProps = {
  nodes: OutlineNode[];
  activeNodeId: string;
  onSelect: (node: OutlineNode) => void;
};

/**
 * Chapter tree built from the lexical outline index. Selecting a node only sets the edit
 * target; it never sends a chat instruction by itself.
 */
export function OutlineTree({ nodes, activeNodeId, onSelect }: OutlineTreeProps) {
  if (nodes.length === 0) return <p className="hint">还没有解析到章节。确认入口文件包含 \section、\chapter 等标题命令。</p>;
  return <ul className="outline-tree">{nodes.map(node => <OutlineNodeItem key={node.nodeId} node={node} activeNodeId={activeNodeId} onSelect={onSelect}/>)}</ul>;
}

function OutlineNodeItem({ node, activeNodeId, onSelect }: { node: OutlineNode; activeNodeId: string; onSelect: (node: OutlineNode) => void }) {
  const warning = node.warnings.find(item => item.severity === 'warning');
  return <li>
    <button
      type="button"
      className={`outline-node level-${Math.min(node.level, 4)}`}
      aria-current={activeNodeId === node.nodeId ? 'true' : undefined}
      title={`${node.relativePath}${node.label ? ` · ${node.label}` : ''}`}
      onClick={() => onSelect(node)}
    >
      {node.title}{node.label ? <em> (ref: {node.label})</em> : null}
    </button>
    {warning && <p className="outline-warning">{warning.message}</p>}
    {node.children.length > 0 && <OutlineTree nodes={node.children} activeNodeId={activeNodeId} onSelect={onSelect}/>}
  </li>;
}

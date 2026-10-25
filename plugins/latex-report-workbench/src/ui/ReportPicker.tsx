import { useState } from 'react';
import type { ReportRecord } from '../shared/contracts.js';

export type ReportPickerProps = {
  reports: ReportRecord[];
  selectedId: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: (title: string, templateId: string) => Promise<void>;
  onImport: (rootRelativePath: string, mainFile: string, generatedFrom?: string) => Promise<void>;
};

export function ReportPicker({ reports, selectedId, busy, onSelect, onCreate, onImport }: ReportPickerProps) {
  const [title, setTitle] = useState('');
  const [templateId, setTemplateId] = useState('html-paper');
  const [rootRelativePath, setRootRelativePath] = useState('reports/');
  const [mainFile, setMainFile] = useState('main.html');
  const [generatedFrom, setGeneratedFrom] = useState('');
  const [panel, setPanel] = useState<'none' | 'create' | 'import'>('none');

  return (
    <div className="report-picker">
      <label>当前报告
        <select value={selectedId} disabled={busy} onChange={event => onSelect(event.target.value)}>
          <option value="">请选择报告</option>
          {reports.map(report => <option key={report.reportId} value={report.reportId}>{report.title}</option>)}
        </select>
      </label>
      <div className="report-actions">
        <button type="button" onClick={() => setPanel(panel === 'create' ? 'none' : 'create')}>新建报告</button>
        <button type="button" onClick={() => setPanel(panel === 'import' ? 'none' : 'import')}>注册已有目录</button>
      </div>
      {panel === 'create' && <form className="report-form" onSubmit={event => { event.preventDefault(); if (!title.trim()) return; void onCreate(title.trim(), templateId).then(() => { setTitle(''); setPanel('none'); }); }}>
        <label>报告标题<input value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：实验报告"/></label>
        <label>编辑方式<select value={templateId} onChange={event => setTemplateId(event.target.value)}><option value="html-paper">论文网页 · 连续阅读</option><option value="html-report">横版一页 · 展示报告</option><option value="chinese-report">LaTeX · 编译预览</option></select></label>
        <p className="hint">在 reports 下创建独立目录。网页保存后直接更新，导出 PDF 时保留网页排版；也可选择 LaTeX 输出。</p>
        <button type="submit" disabled={busy || !title.trim()}>创建</button>
      </form>}
      {panel === 'import' && <form className="report-form" onSubmit={event => { event.preventDefault(); if (!rootRelativePath.trim() || !mainFile.trim()) return; void onImport(rootRelativePath.trim(), mainFile.trim(), /\.html$/i.test(mainFile) ? generatedFrom.trim() || undefined : undefined).then(() => setPanel('none')); }}>
        <label>已有目录（相对工作区）<input value={rootRelativePath} onChange={event => setRootRelativePath(event.target.value)} placeholder="reports/已有报告"/></label>
        <label>入口文件<input value={mainFile} onChange={event => setMainFile(event.target.value)} placeholder="main.html"/></label>
        {/\.html$/i.test(mainFile) && <label>生成源（可选，相对报告目录）<input value={generatedFrom} onChange={event => setGeneratedFrom(event.target.value)} placeholder="例如：paper.py"/></label>}
        <p className="hint">只登记已有目录，不搬动或改写其中的文件。</p>
        <button type="submit" disabled={busy || !rootRelativePath.trim() || !mainFile.trim()}>注册</button>
      </form>}
    </div>
  );
}

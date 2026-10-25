import { toolInputs, type ToolName } from './contracts.js';
export type ToolSpec = { title: string; feature: string; readOnly: boolean; visibility: ('model' | 'app')[]; implemented: boolean; rendersUi?: boolean };
const spec = (title: string, feature: string, readOnly: boolean, implemented = true, appOnly = false): ToolSpec => ({ title, feature, readOnly, implemented, visibility: appOnly ? ['app'] : ['model', 'app'] });
export const TOOL_CATALOG: Record<ToolName, ToolSpec> = {
  probe_echo: spec('连接探针', 'mcp-transport', true, true), workspace_status: spec('工作区状态', 'workspace-read', true, true),
  workbench_open: { ...spec('打开报告工作台', 'workspace-read', true, true), rendersUi: true },
  report_list: spec('列出报告', 'workspace-read', true), report_create: spec('创建报告', 'report-management', false), report_import: spec('注册报告目录', 'report-management', false),
  report_open: spec('读取报告摘要', 'workspace-read', true), report_tree: spec('报告目录树', 'workspace-read', true), report_read: spec('读取报告源码', 'workspace-read', true),
  report_preview: spec('HTML 即时预览', 'html-authoring', true, true, true), html_select: spec('选择网页内容块', 'html-authoring', false, true, true), html_edit: spec('修改网页文字', 'html-authoring', false, true, true),
  report_context_get: spec('读取修改对象', 'contexts', true), report_apply_patch: spec('条件修改报告', 'transactions', false), report_compile: spec('编译报告', 'compiler', false), report_build_status: spec('构建状态', 'compiler', true),
  report_locate_pdf: spec('PDF 反查源码', 'synctex', true), report_locate_source: spec('源码定位 PDF', 'synctex', true), report_history: spec('修改历史', 'transactions', true), report_undo: spec('条件撤销', 'transactions', false), report_export: spec('导出报告', 'export-recovery', false),
  context_bind: spec('绑定面板上下文', 'contexts', false, true, true), selection_set: spec('设置修改对象', 'contexts', false, true, true), selection_clear: spec('清除修改对象', 'contexts', false, true, true), draft_save: spec('保存源码草稿', 'transactions', false, true, true), workspace_asset_read: spec('读取构建资产', 'pdf-preview', true, true, true), session_keepalive: spec('刷新会话租约', 'contexts', false, true, true),
  pdf_edit_open: spec('打开 PDF 文字编辑', 'pdf-direct-edit', false, true, true), pdf_edit_commit: spec('保存 PDF 文字修改', 'pdf-direct-edit', false, true, true), pdf_edit_cancel: spec('取消 PDF 编辑', 'pdf-direct-edit', false, true, true),
  objects_resolve_region: spec('解析 PDF 框选对象', 'region-edit', true, true, true), objects_attach_image: spec('附加框选图像', 'region-edit', true, true, true),
};
export const TOOL_NAMES = Object.keys(toolInputs) as ToolName[];

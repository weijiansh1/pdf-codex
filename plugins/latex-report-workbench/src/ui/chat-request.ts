import type { ReportRecord, SelectionRecord } from '../shared/contracts.js';

export type ChatRequestInput = {
  workspaceId: string;
  report: ReportRecord;
  contextId: string;
  selection: SelectionRecord | null;
  prompt: string;
  draftPending: boolean;
  selectionPending?: boolean;
  selectionFailed?: boolean;
};

export type SelectionRequestIdentity = { sequence: number; reportId: string; contextId: string };
export function sameSelectionRequest(captured: SelectionRequestIdentity, current: SelectionRequestIdentity): boolean {
  return captured.sequence === current.sequence && captured.reportId === current.reportId && captured.contextId === current.contextId;
}

export type ChatRequest = {
  scope: 'selection' | 'report';
  message: string;
  initialComment: string;
  metadata: Record<string, string | null>;
};

export type BrowserAnnotation = {
  request(target: HTMLElement, options: { mode: 'default'; metadata: Record<string, string | null>; initialComment: string }): { accepted: boolean };
};

function shortText(text: string, limit: number): string {
  let result = text.slice(0, limit);
  const last = result.charCodeAt(result.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) result = result.slice(0, -1);
  return result;
}

/** Identifiers describe a target; only the service can resolve current source write ranges. */
export function buildChatRequest(input: ChatRequestInput): ChatRequest {
  const { workspaceId, report, contextId, selection, draftPending } = input;
  const prompt = input.prompt.trim();
  if (!contextId || !workspaceId || report.workspaceId !== workspaceId) throw new Error('先完成当前报告会话绑定。');
  if (input.selectionPending) throw new Error('正在绑定新选择的对象，请稍后再交给 Codex。');
  if (input.selectionFailed) throw new Error('上一次对象选择未完成，请重新选择，或明确清除选区后处理整份报告。');
  if (draftPending) throw new Error('先保存或取消当前草稿，再交给 Codex 修改。');
  if (!prompt) throw new Error('请填写修改要求。');
  if (prompt.length > 12_000) throw new Error('修改要求请控制在 12,000 字符以内。');
  if (selection && (selection.workspaceId !== workspaceId || selection.reportId !== report.reportId || selection.contextId !== contextId)) throw new Error('修改对象与当前报告会话不一致，请重新选择。');
  if (selection && (selection.validity !== 'valid' || !selection.targets.length)) throw new Error('当前修改对象已失效或无法唯一定位，请重新选择。');

  const scope = selection ? 'selection' : 'report';
  const binding = {
    workspaceId, reportId: report.reportId, contextId,
    selectionId: selection?.selectionId ?? null,
    buildId: selection?.buildId ?? null,
    scope, rootRelativePath: report.rootRelativePath,
    targets: selection?.targets.map(target => ({ relativePath: target.relativePath, fileVersion: target.fileVersion })) ?? [],
  };
  const instructions = selection
    ? '先用 report_context_get(contextId, selectionId) 重新读取并校验选区；以 scope="selection" 经 report_apply_patch 修改，范围由服务端选区确定。选区过期或有歧义时停止并要求重新选择。'
    : '用户当前未选择局部对象，请按下面的明确要求处理当前报告；写入使用 scope="report"，scopeReason 取本次用户要求，不猜测另一份报告。';
  return {
    scope,
    message: `请在当前工作区使用 LaTeX 报告工作台修改报告「${report.title}」。\n\n绑定信息：\n${JSON.stringify(binding, null, 2)}\n\n用户修改要求：\n${prompt}\n\n${instructions}\n修改前读取当前文件版本，保留公式、引用和宏结构，通过工作台版本事务保存并等待成功编译；在当前聊天说明结果。`,
    initialComment: prompt.length <= 240 ? prompt : `完整修改要求见所选工作台卡片。${shortText(prompt, 210)}`,
    // Browser annotations accept at most six flat properties, 256 UTF-16 units per string.
    metadata: { workspaceId, reportId: report.reportId, contextId, selectionId: selection?.selectionId ?? null, buildId: selection?.buildId ?? null, scope },
  };
}

export function browserAnnotation(): BrowserAnnotation | undefined {
  if (typeof document === 'undefined') return undefined;
  const annotation = (document as Document & { oai?: { annotation?: BrowserAnnotation } }).oai?.annotation;
  return typeof annotation?.request === 'function' ? annotation : undefined;
}

/** Must stay synchronous inside the user's click, otherwise the native gesture can expire. */
export function requestBrowserAnnotation(annotation: BrowserAnnotation | undefined, target: HTMLElement, request: ChatRequest): 'prepared' {
  if (!annotation) throw new Error('当前浏览器没有提供批注连接，请在 Codex 内嵌浏览器打开工作台，或复制修改请求。');
  const result = annotation.request(target, { mode: 'default', metadata: request.metadata, initialComment: request.initialComment });
  if (result?.accepted !== true) throw new Error('浏览器未接收这次批注。请结束已有批注或浏览器自动操作，再点击重试；也可在“Site tools / 站点工具”检查批注权限。');
  return 'prepared';
}

export async function deliverHostMessage(send: ((prompt: string) => Promise<void>) | undefined, request: ChatRequest): Promise<'sent'> {
  if (!send) throw new Error('当前面板没有连接聊天消息能力。');
  await send(request.message);
  return 'sent';
}

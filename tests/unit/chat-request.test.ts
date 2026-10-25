import { describe, expect, it, vi } from 'vitest';
import type { ReportRecord, SelectionRecord } from '../../plugins/latex-report-workbench/src/shared/contracts.js';
import { buildChatRequest, requestBrowserAnnotation, deliverHostMessage, sameSelectionRequest } from '../../plugins/latex-report-workbench/src/ui/chat-request.js';

const workspaceId = '238210bd-191a-47c7-9eca-ff3a928f7b5e';
const reportId = '734aa6fd-d974-4d7d-af52-01e2e50127f1';
const contextId = '53ba3152-4a44-4f02-b511-c4f27e529ef1';
const report: ReportRecord = { workspaceId, reportId, title: '风洞实验报告', rootRelativePath: 'reports/风洞实验', mainFile: 'main.tex', engine: 'xelatex', bibliography: 'auto', reportRevision: 'a'.repeat(64) };
const selection: SelectionRecord = {
  workspaceId, reportId, contextId, viewId: '897c9cc0-e23e-4c03-aad7-606b4d2c3a53', selectionId: '0a265320-56ac-436c-9bd5-3338bdf37db8',
  kind: 'pdf-text', buildId: '5a58097c-4585-43f0-a778-bdf9fe2fc7d1', selectedText: '当前结论', validity: 'valid', createdAt: new Date(0).toISOString(),
  targets: [{ relativePath: 'chapters/03-conclusion.tex', range: { start: 1, end: 5 }, fileVersion: 'b'.repeat(64), exactText: '当前结论', prefix: '', suffix: '' }],
};
const input = { workspaceId, report, contextId, selection, prompt: '把这段结论写得更简洁。', draftPending: false };

describe('current-chat request', () => {
  it('carries the exact selected report, context and immutable PDF identity', () => {
    const request = buildChatRequest(input);
    expect(request.scope).toBe('selection');
    expect(request.metadata).toMatchObject({ reportId, contextId, selectionId: selection.selectionId, buildId: selection.buildId, scope: 'selection' });
    expect(request.message).toContain(selection.selectionId);
    expect(request.message).toContain('report_context_get');
    expect(request.message).toContain('report_apply_patch');
    expect(request.message).toContain('把这段结论写得更简洁。');
    expect(request.message).toContain('chapters/03-conclusion.tex');
    expect(request.message).toContain('b'.repeat(64));
    expect(request.message).not.toContain('"start":');
  });

  it('uses explicit report scope with the user request when no object is selected', () => {
    const request = buildChatRequest({ ...input, selection: null });
    expect(request.scope).toBe('report');
    expect(request.metadata.selectionId).toBeNull();
    expect(request.message).toContain('scopeReason');
    expect(request.message).toContain(report.rootRelativePath);
  });

  it.each(['stale', 'ambiguous', 'unmapped'] as const)('refuses %s selections instead of broadening to the report', validity => {
    expect(() => buildChatRequest({ ...input, selection: { ...selection, validity } })).toThrow(/重新选择/);
  });

  it('refuses selections from another report, context or workspace', () => {
    for (const changed of [{ reportId: crypto.randomUUID() }, { contextId: crypto.randomUUID() }, { workspaceId: crypto.randomUUID() }]) {
      expect(() => buildChatRequest({ ...input, selection: { ...selection, ...changed } })).toThrow(/绑定|报告|会话/);
    }
  });

  it('requires a bound context, a saved draft and a nonempty user request', () => {
    expect(() => buildChatRequest({ ...input, contextId: '' })).toThrow(/绑定/);
    expect(() => buildChatRequest({ ...input, draftPending: true })).toThrow(/保存/);
    expect(() => buildChatRequest({ ...input, prompt: '  ' })).toThrow(/修改要求/);
  });

  it('does not broaden to report scope while a newly chosen target is resolving or has failed', () => {
    expect(() => buildChatRequest({ ...input, selection: null, selectionPending: true })).toThrow(/绑定|选择/);
    expect(() => buildChatRequest({ ...input, selection: null, selectionFailed: true })).toThrow(/重新选择/);
  });

  it('discards older selection responses and responses from another report or context', () => {
    const current = { sequence: 2, reportId, contextId };
    expect(sameSelectionRequest(current, { ...current })).toBe(true);
    for (const changed of [{ sequence: 1 }, { reportId: crypto.randomUUID() }, { contextId: crypto.randomUUID() }]) {
      expect(sameSelectionRequest({ ...current, ...changed }, current)).toBe(false);
    }
  });

  it('keeps annotation metadata within the published flat six-field limits', () => {
    const request = buildChatRequest({ ...input, report: { ...report, rootRelativePath: 'reports/' + '长'.repeat(490) }, prompt: '详细修改要求。'.repeat(100) });
    expect(Object.keys(request.metadata).length).toBeLessThanOrEqual(6);
    for (const value of Object.values(request.metadata)) expect(value === null || typeof value === 'string' && value.length <= 256).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(request.metadata))).toBeLessThanOrEqual(2048);
    expect(request.initialComment.length).toBeLessThanOrEqual(240);
    expect(request.message).toContain('详细修改要求。'.repeat(100));
    expect(request.initialComment).toContain('完整');
  });

  it('calls the browser API synchronously and treats accepted as prepared, never sent', () => {
    const request = buildChatRequest(input);
    const element = {} as HTMLElement;
    const requestApi = vi.fn(() => ({ accepted: true }));
    const outcome = requestBrowserAnnotation({ request: requestApi }, element, request);
    expect(requestApi).toHaveBeenCalledWith(element, { mode: 'default', metadata: request.metadata, initialComment: request.initialComment });
    expect(outcome).toBe('prepared');
    expect(outcome).not.toBe('sent');
  });

  it('does not treat rejected, malformed or absent browser bridges as success', () => {
    const request = buildChatRequest(input);
    const element = {} as HTMLElement;
    expect(() => requestBrowserAnnotation(undefined, element, request)).toThrow(/批注|连接/);
    expect(() => requestBrowserAnnotation({ request: () => ({ accepted: false }) }, element, request)).toThrow(/接收|批注/);
    expect(() => requestBrowserAnnotation({ request: (() => ({})) as never }, element, request)).toThrow(/接收|批注/);
  });

  it('submits host messages only with a real sender and surfaces host rejection', async () => {
    const request = buildChatRequest(input);
    const send = vi.fn(async () => {});
    await expect(deliverHostMessage(send, request)).resolves.toBe('sent');
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(request.message);
    await expect(deliverHostMessage(undefined, request)).rejects.toThrow(/聊天|连接/);
    await expect(deliverHostMessage(async () => { throw new Error('宿主拒绝'); }, request)).rejects.toThrow('宿主拒绝');
  });
});

import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CodexRequestPanel } from '../../plugins/latex-report-workbench/src/ui/CodexRequestPanel.js';
import type { ReportRecord } from '../../plugins/latex-report-workbench/src/shared/contracts.js';
import type { ToolClient } from '../../plugins/latex-report-workbench/src/ui/api.js';

it('restores the request belonging to each report when switching back and forth', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const window = new Window({ url: 'http://localhost/' });
  for (const [name, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Element: window.Element })) vi.stubGlobal(name, value);
  window.localStorage.setItem('latex-workbench:request:workspace:report-a:view', '报告 A 未发送的要求');
  window.localStorage.setItem('latex-workbench:request:workspace:report-b:view', '报告 B 未发送的要求');
  const report = (id: string) => ({ reportId: id, title: id, mainFile: 'main.html', workspaceId: 'workspace', rootRelativePath: `reports/${id}`, reportRevision: 'a'.repeat(64), engine: 'xelatex', bibliography: 'auto' }) as ReportRecord;
  const client: ToolClient = { call: vi.fn() as ToolClient['call'], close: async () => undefined };
  const props = { client, report: report('report-a'), workspaceId: 'workspace', contextId: 'context', viewId: 'view', mode: 'local' as const, selection: null, draftPending: false, selectionPending: false, selectionFailed: false };
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(CodexRequestPanel, props)));
    expect(container.querySelector('textarea')!.value).toBe('报告 A 未发送的要求');
    await act(async () => root.render(createElement(CodexRequestPanel, { ...props, report: report('report-b') })));
    expect(container.querySelector('textarea')!.value).toBe('报告 B 未发送的要求');
    await act(async () => root.render(createElement(CodexRequestPanel, props)));
    expect(container.querySelector('textarea')!.value).toBe('报告 A 未发送的要求');
  } finally { await act(async () => root.unmount()); container.remove(); await window.happyDOM.close(); vi.unstubAllGlobals(); }
});

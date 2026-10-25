import { Window, type BrowserWindow } from 'happy-dom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HtmlPreview } from '../../plugins/latex-report-workbench/src/ui/HtmlPreview.js';
import { renderHtmlDocument } from '../../plugins/latex-report-workbench/src/shared/html-report.js';
import type { HtmlPreview as Preview } from '../../plugins/latex-report-workbench/src/shared/contracts.js';
import type { ToolClient } from '../../plugins/latex-report-workbench/src/ui/api.js';

it('never seeds a new report frame with the previous report while its response is pending', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const window = new Window({ url: 'http://localhost/', settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true } });
  for (const [name, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Element: window.Element })) vi.stubGlobal(name, value);
  const make = (reportId: string): Preview => ({ reportId, relativePath: 'main.html', fileVersion: 'a'.repeat(64), text: `<p>${reportId}</p>`, ...renderHtmlDocument(`<p>${reportId}</p>`), assets: {}, renderMs: 1 });
  let finish!: (value: Preview) => void;
  const client: ToolClient = { call: (async (_name: string, input: { reportId: string }) => input.reportId === 'report-a' ? make('report-a') : new Promise<Preview>(resolve => { finish = resolve; })) as ToolClient['call'], close: async () => undefined };
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const props = { client, reportId: 'report-a', contextId: 'context', viewId: 'view', refreshKey: 0, draft: null, onPick: () => undefined, onChanged: () => undefined, onEditing: () => undefined };
  try {
    await act(async () => root.render(createElement(HtmlPreview, props)));
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toContain('report-a');
    await act(async () => root.render(createElement(HtmlPreview, { ...props, reportId: 'report-b' })));
    const wrongFrame = container.querySelector('iframe');
    if (wrongFrame) {
      const key = /html-preview\.js#([a-z0-9]+)/.exec(wrongFrame.getAttribute('srcdoc')!)![1];
      await act(async () => window.dispatchEvent(new window.MessageEvent('message', { source: wrongFrame.contentWindow as unknown as BrowserWindow, data: { key, type: 'ready' } })));
    }
    await act(async () => finish(make('report-b')));
    const correct = container.querySelector('iframe')!.getAttribute('srcdoc')!;
    expect(correct).toContain('report-b'); expect(correct).not.toContain('report-a');
  } finally { await act(async () => root.unmount()); container.remove(); await window.happyDOM.close(); vi.unstubAllGlobals(); }
});

it('keeps an inline draft in persistent storage and offers recovery after the component reloads', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const window = new Window({ url: 'http://localhost/', settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true } });
  for (const [name, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Element: window.Element })) vi.stubGlobal(name, value);
  const text = '<p>原始正文</p>';
  const base: Preview = { reportId: 'report-a', relativePath: 'main.html', fileVersion: 'a'.repeat(64), text, ...renderHtmlDocument(text), assets: {}, renderMs: 1 };
  const client: ToolClient = { call: (async () => base) as ToolClient['call'], close: async () => undefined };
  const container = document.createElement('div'); document.body.append(container); let root = createRoot(container);
  const props = { client, reportId: base.reportId, contextId: 'context', viewId: 'view', refreshKey: 0, draft: null, onPick: () => undefined, onChanged: () => undefined, onEditing: () => undefined };
  try {
    await act(async () => root.render(createElement(HtmlPreview, props)));
    const frame = container.querySelector('iframe')!;
    const key = /html-preview\.js#([a-z0-9]+)/.exec(frame.getAttribute('srcdoc')!)![1];
    await act(async () => root.render(createElement(HtmlPreview, { ...props, contextId: 'context-after-bind' })));
    const changes = [{ runId: base.blocks[0]!.runs![0]!.runId, text: '刷新前尚未保存的中文' }];
    await act(async () => window.dispatchEvent(new window.MessageEvent('message', { source: frame.contentWindow as unknown as BrowserWindow, data: { key, type: 'draft', blockId: base.blocks[0]!.blockId, changes } })));
    expect(window.localStorage.getItem('latex-workbench:inline:report-a:view')).toContain('刷新前尚未保存的中文');
    const unload = new window.Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => root.render(createElement(HtmlPreview, props)));
    expect(container.textContent).toContain('恢复未保存的修改');
    const current = container.querySelector('iframe')!;
    const post = vi.spyOn(current.contentWindow!, 'postMessage');
    await act(async () => (Array.from(container.querySelectorAll('button')).find(button => button.textContent === '恢复草稿') as HTMLButtonElement).click());
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'recover', blockId: base.blocks[0]!.blockId, changes }), '*');
    expect(container.textContent).toContain('正在修改文字');
  } finally { await act(async () => root.unmount()); container.remove(); await window.happyDOM.close(); vi.unstubAllGlobals(); }
});

it('keeps the active HTML text draft when an earlier preview response arrives late', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const window = new Window({ url: 'http://localhost/', settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true } });
  for (const [name, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Element: window.Element })) vi.stubGlobal(name, value);
  const text = '<h1>原稿标题</h1><p>原始正文</p>';
  const base: Preview = { reportId: 'report-a', relativePath: 'main.html', fileVersion: 'a'.repeat(64), text, ...renderHtmlDocument(text), assets: {}, renderMs: 1 };
  let finish: ((value: Preview) => void) | undefined;
  let calls = 0;
  const client: ToolClient = { call: (async () => ++calls === 1 ? base : new Promise<Preview>(resolve => { finish = resolve; })) as ToolClient['call'], close: async () => undefined };
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const props = { client, reportId: base.reportId, contextId: 'context', viewId: 'view', refreshKey: 0, draft: null, onPick: () => undefined, onChanged: () => undefined, onEditing: () => undefined };
  try {
    await act(async () => root.render(createElement(HtmlPreview, props)));
    const iframe = container.querySelector('iframe')!;
    const original = iframe.getAttribute('srcdoc');
    const key = /html-preview\.js#([a-z0-9]+)/.exec(original!)![1];
    await act(async () => root.render(createElement(HtmlPreview, { ...props, refreshKey: 1 })));
    expect(finish).toBeTypeOf('function');
    await act(async () => { window.dispatchEvent(new window.MessageEvent('message', { source: iframe.contentWindow as unknown as BrowserWindow, data: { key, type: 'editing' } })); });
    expect(container.textContent).toContain('正在修改文字');
    await act(async () => { const changed = '<h1>外部新稿</h1>'; finish!({ ...base, fileVersion: 'b'.repeat(64), text: changed, ...renderHtmlDocument(changed) }); });
    expect(iframe.getAttribute('srcdoc')).toBe(original);
    expect(container.textContent).toContain('正在修改文字');
  } finally { await act(async () => root.unmount()); container.remove(); await window.happyDOM.close(); vi.unstubAllGlobals(); }
});

it('uses the original layout and restores reading position only from its current frame', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const window = new Window({ url: 'http://localhost/', settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true } });
  for (const [name, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Element: window.Element })) vi.stubGlobal(name, value);
  const text = '<style>body{font-size:16.5px}main{max-width:840px}</style><main><h2 id="results">结果</h2><p>原稿正文</p></main>';
  let version = 'a'.repeat(64);
  const client: ToolClient = { call: (async () => ({ reportId: 'paper', relativePath: 'main.html', fileVersion: version, text, ...renderHtmlDocument(text), assets: {}, renderMs: 1 })) as ToolClient['call'], close: async () => undefined };
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const props = { client, reportId: 'paper', contextId: 'context', viewId: 'view', refreshKey: 0, draft: null, onPick: () => undefined, onChanged: () => undefined, onEditing: () => undefined };
  const position = { x: 0, y: 2200, anchor: 'results', offset: -42 };
  try {
    await act(async () => root.render(createElement(HtmlPreview, props)));
    const iframe = container.querySelector('iframe')!;
    const key = () => /html-preview\.js#([a-z0-9]+)/.exec(iframe.getAttribute('srcdoc')!)![1];
    const send = async (data: object) => act(async () => { window.dispatchEvent(new window.MessageEvent('message', { source: iframe.contentWindow as unknown as BrowserWindow, data })); });
    let post = vi.spyOn(iframe.contentWindow!, 'postMessage');
    await send({ key: key(), type: 'ready' });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'configure', view: 'original', selecting: false }), '*');
    await send({ key: 'wrong-frame', type: 'position', position: { ...position, y: 9999 } });
    await send({ key: key(), type: 'position', position });
    version = 'b'.repeat(64);
    await act(async () => root.render(createElement(HtmlPreview, { ...props, refreshKey: 1 })));
    post = vi.spyOn(iframe.contentWindow!, 'postMessage');
    await send({ key: key(), type: 'ready' });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'configure', position }), '*');
    expect(iframe.getAttribute('srcdoc')).toContain('main{max-width:840px}');
  } finally { await act(async () => root.unmount()); container.remove(); await window.happyDOM.close(); vi.unstubAllGlobals(); }
});

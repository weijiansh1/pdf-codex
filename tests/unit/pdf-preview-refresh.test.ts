import { Window } from 'happy-dom';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { BuildManifest } from '../../plugins/latex-report-workbench/src/shared/contracts.js';
import type { ToolClient } from '../../plugins/latex-report-workbench/src/ui/api.js';

const pdf = vi.hoisted(() => ({ open: vi.fn() }));
// Unit tests exercise refresh/lifecycle and the real asset chunk loader. Canvas/worker
// rendering is checked separately in the browser against the actual existing PDF.
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: pdf.open, TextLayer: class { async render() {} } }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?worker&inline', () => ({ default: class {} }));
import { PdfPreview } from '../../plugins/latex-report-workbench/src/ui/PdfPreview.js';

const build = (id: string): BuildManifest => ({ protocolVersion: 1, reportId: 'report', buildId: id, reportRevision: 'a'.repeat(64), status: 'succeeded', inputVersions: {}, inputPaths: {}, diagnostics: [], pdfAssetId: `asset-${id}`, assets: { [`asset-${id}`]: { assetId: `asset-${id}`, kind: 'pdf', fileName: 'main.pdf', bytes: 3, sha256: 'b'.repeat(64) } } });
const callbacks = { onToggleEditMode: () => undefined, onOpenPdfEdit: () => undefined, onLocateText: () => undefined, onRegion: () => undefined };
async function ui() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const window = new Window({ url: 'http://localhost/' });
  for (const [name, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Element: window.Element, ResizeObserver: window.ResizeObserver })) vi.stubGlobal(name, value);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  pdf.open.mockReset().mockImplementation(() => ({ promise: Promise.resolve({ numPages: 1, loadingTask: { destroy: async () => undefined }, getPage: async () => ({ view: [0, 0, 600, 800], getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale, rotation: 0 }), render: () => ({ promise: Promise.resolve(), cancel() {} }), streamTextContent: () => ({}) }) }) }));
  return { window, host, root, async close() { await act(async () => root.unmount()); host.remove(); await window.happyDOM.close(); vi.unstubAllGlobals(); } };
}

it('refreshes only PDF assets, including an unchanged build, while retaining zoom and neighboring input', async () => {
  const f = await ui(); const requests: string[] = [];
  const client: ToolClient = { call: (async (name: string) => { requests.push(name); return { bytesBase64: 'UERG', nextOffset: null, totalBytes: 3 }; }) as ToolClient['call'], close: async () => undefined };
  const refresh = vi.fn(async () => undefined);
  try {
    await act(async () => f.root.render(createElement('div', null, createElement('textarea', { defaultValue: 'Codex 未发送的要求' }), createElement(PdfPreview, { client, reportId: 'report', build: build('old'), editMode: false, overlay: null, onRefresh: refresh, ...callbacks }))));
    const panel = f.host.querySelector('.pdf-panel');
    const buttons = () => Array.from(f.host.querySelectorAll('button'));
    await act(async () => buttons().find(button => button.getAttribute('aria-label') === '放大')!.click());
    const zoom = f.host.querySelector('.pdf-zoom span')!.textContent;
    const reload = buttons().find(button => button.textContent === '刷新预览');
    expect(reload).toBeDefined();
    await act(async () => reload!.click());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(requests.filter(name => name === 'workspace_asset_read')).toHaveLength(2);
    expect(requests).not.toContain('report_compile');
    expect(f.host.querySelector('.pdf-panel')).toBe(panel);
    expect(f.host.querySelector('textarea')!.value).toBe('Codex 未发送的要求');
    expect(f.host.querySelector('.pdf-zoom span')!.textContent).toBe(zoom);
  } finally { await f.close(); }
});

it('loads the latest successful build on refresh and allows retry after a refresh error', async () => {
  const f = await ui(); const ids: string[] = []; let fail = true;
  const client: ToolClient = { call: (async (_name: string, input: { buildId: string }) => { ids.push(input.buildId); return { bytesBase64: 'UERG', nextOffset: null, totalBytes: 3 }; }) as ToolClient['call'], close: async () => undefined };
  function Harness() {
    const [current, setCurrent] = useState(build('old'));
    return createElement(PdfPreview, { client, reportId: 'report', build: current, editMode: false, overlay: null, onRefresh: async () => { if (fail) throw new Error('临时读取失败'); setCurrent(build('new')); }, ...callbacks });
  }
  try {
    await act(async () => f.root.render(createElement(Harness)));
    const reload = () => Array.from(f.host.querySelectorAll('button')).find(button => button.textContent === '刷新预览')!;
    expect(reload()).toBeDefined();
    await act(async () => reload().click()); expect(f.host.textContent).toContain('临时读取失败'); expect(reload().disabled).toBe(false);
    fail = false; await act(async () => reload().click());
    expect(ids.at(-1)).toBe('new'); expect(f.host.querySelector('.pdf-footer')!.textContent).toContain('new');
    expect(f.host.textContent).not.toContain('临时读取失败');
  } finally { await f.close(); }
});

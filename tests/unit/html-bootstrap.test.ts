import { Window } from 'happy-dom';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { renderHtmlDocument } from '../../plugins/latex-report-workbench/src/shared/html-report.js';

it('does not save a block that was opened and closed without changing its text', async () => {
  const window = new Window({ url: 'http://localhost/', settings: { disableJavaScriptFileLoading: true } });
  window.document.write(renderHtmlDocument('<p>原始 &nbsp; <strong>文字</strong></p>').html);
  const script = window.document.createElement('script'); script.src = 'http://localhost/html-preview.js#frame-key';
  const currentScript = vi.spyOn(window.document, 'currentScript', 'get').mockReturnValue(script);
  const post = vi.spyOn(window.parent, 'postMessage');
  try {
    window.eval(await readFile(new URL('../../plugins/latex-report-workbench/src/ui/public/html-preview.js', import.meta.url), 'utf8'));
    window.eval("dispatchEvent(new MessageEvent('message', {source:parent,data:{key:'frame-key',type:'configure',readOnly:false}}))");
    const run = window.document.querySelector('strong [data-wb-run]')!;
    run.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    run.dispatchEvent(new window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(post.mock.calls.some(([event]) => (event as { type: string }).type === 'edit')).toBe(false);
    expect(post.mock.calls.some(([event]) => (event as { type: string }).type === 'cancel')).toBe(true);
  } finally { currentScript.mockRestore(); await window.happyDOM.close(); }
});

it('persists rich text input immediately, saves with Ctrl+S, and preserves protected children', async () => {
  const window = new Window({ url: 'http://localhost/', settings: { disableJavaScriptFileLoading: true } });
  window.document.write(renderHtmlDocument('<p>结果 <strong>显著</strong><span data-tex="x^2"></span><a href="#ref">[1]</a></p>').html);
  const script = window.document.createElement('script'); script.src = 'http://localhost/html-preview.js#frame-key';
  const currentScript = vi.spyOn(window.document, 'currentScript', 'get').mockReturnValue(script);
  const post = vi.spyOn(window.parent, 'postMessage');
  try {
    window.eval(await readFile(new URL('../../plugins/latex-report-workbench/src/ui/public/html-preview.js', import.meta.url), 'utf8'));
    window.eval("dispatchEvent(new MessageEvent('message', {source:parent,data:{key:'frame-key',type:'configure',readOnly:false}}))");
    const run = window.document.querySelector('strong [data-wb-run]')!;
    run.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    expect(run.getAttribute('contenteditable')).toBe('plaintext-only');
    expect(window.document.querySelector('p')?.getAttribute('contenteditable')).toBeNull();
    run.textContent = '更明显'; run.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'draft', changes: expect.arrayContaining([expect.objectContaining({ text: '更明显' })]) }), '*');
    const save = new window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true, bubbles: true });
    run.dispatchEvent(save);
    expect(save.defaultPrevented).toBe(true);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'edit', changes: expect.arrayContaining([expect.objectContaining({ text: '更明显' })]) }), '*');
    expect(window.document.querySelector('math')).not.toBeNull();
    expect(window.document.querySelector('a')?.textContent).toBe('[1]');
  } finally { currentScript.mockRestore(); await window.happyDOM.close(); }
});

it('updates document nodes in place and never replaces an active draft', async () => {
  const window = new Window({ url: 'http://localhost/', settings: { disableJavaScriptFileLoading: true } });
  const original = '<main><p>原正文</p><figure id="chart"><img src="data:image/png;base64,aGVsbG8="><figcaption>图表</figcaption></figure></main>';
  window.document.write(renderHtmlDocument(original).html);
  const script = window.document.createElement('script'); script.src = 'http://localhost/html-preview.js#frame-key';
  const currentScript = vi.spyOn(window.document, 'currentScript', 'get').mockReturnValue(script);
  const image = window.document.querySelector('img');
  const message = (data: object) => window.eval(`dispatchEvent(new MessageEvent('message', {source:parent,data:${JSON.stringify({ key: 'frame-key', ...data })}}))`);
  try {
    window.eval(await readFile(new URL('../../plugins/latex-report-workbench/src/ui/public/html-preview.js', import.meta.url), 'utf8'));
    message({ type: 'configure', readOnly: false });
    message({ type: 'update', html: renderHtmlDocument(original.replace('原正文', '修改后的正文')).html, version: 'v2' });
    expect(window.document.querySelector('p')?.textContent).toBe('修改后的正文');
    expect(window.document.querySelector('img')).toBe(image);
    const run = window.document.querySelector('p [data-wb-run]')!;
    run.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })); run.textContent = '未保存的输入';
    message({ type: 'update', html: renderHtmlDocument(original.replace('原正文', '外部新稿')).html, version: 'v3' });
    expect(run.textContent).toBe('未保存的输入');
  } finally { currentScript.mockRestore(); await window.happyDOM.close(); }
});

it('handles paper table-of-contents links inside srcdoc without navigating to the parent URL', async () => {
  const window = new Window({ url: 'http://localhost/', settings: { disableJavaScriptFileLoading: true } });
  window.document.body.innerHTML = '<nav><a href="#results">结果</a></nav><main><h2 id="results">结果</h2></main>';
  const script = window.document.createElement('script'); script.src = 'http://localhost/html-preview.js#frame-key';
  const currentScript = vi.spyOn(window.document, 'currentScript', 'get').mockReturnValue(script);
  const heading = window.document.getElementById('results')!;
  const scroll = vi.spyOn(heading, 'scrollIntoView');
  try {
    window.eval(await readFile(new URL('../../plugins/latex-report-workbench/src/ui/public/html-preview.js', import.meta.url), 'utf8'));
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    window.document.querySelector('a')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(scroll).toHaveBeenCalled();
    expect(window.location.href).toBe('http://localhost/');
  } finally { currentScript.mockRestore(); await window.happyDOM.close(); }
});

it('keeps the same paragraph in view after content is inserted earlier in its chapter', async () => {
  const window = new Window({ url: 'http://localhost/', settings: { disableJavaScriptFileLoading: true } });
  window.document.write(renderHtmlDocument('<main><section id="results"><h2>结果</h2><p>正在阅读的段落</p></section></main>').html);
  const script = window.document.createElement('script'); script.src = 'http://localhost/html-preview.js#frame-key';
  const currentScript = vi.spyOn(window.document, 'currentScript', 'get').mockReturnValue(script);
  const paragraph = window.document.querySelector('p')!;
  const rect = new window.DOMRect(0, 3600, 700, 100);
  vi.spyOn(paragraph, 'getBoundingClientRect').mockReturnValue(rect);
  vi.spyOn(window.document.getElementById('results')!, 'getBoundingClientRect').mockReturnValue(new window.DOMRect(0, 500, 700, 5000));
  const scroll = vi.spyOn(window, 'scrollTo');
  try {
    window.eval(await readFile(new URL('../../plugins/latex-report-workbench/src/ui/public/html-preview.js', import.meta.url), 'utf8'));
    const message = { key: 'frame-key', type: 'configure', view: 'original', position: { x: 0, y: 3000, anchor: 'results', offset: -2500, block: paragraph.getAttribute('data-wb-reading'), blockOffset: 0 } };
    window.eval(`dispatchEvent(new MessageEvent('message', { source: parent, data: ${JSON.stringify(message)} }))`);
    await Promise.resolve();
    expect(window.document.documentElement.dataset.wbSelecting).toBe('false');
    await window.happyDOM.waitUntilComplete();
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ top: 3600 }));
  } finally { currentScript.mockRestore(); await window.happyDOM.close(); }
});

it('automatically fits a fixed-width page as its available viewport narrows and expands', async () => {
  const window = new Window({ url: 'http://localhost/', settings: { disableJavaScriptFileLoading: true } });
  window.document.body.innerHTML = '<main data-page-width="1280" style="width:1280px;background:white"><p>横版报告</p></main>';
  const page = window.document.querySelector('main')!;
  const originalStyle = page.getAttribute('style');
  const script = window.document.createElement('script'); script.src = 'http://localhost/html-preview.js#frame-key';
  const currentScript = vi.spyOn(window.document, 'currentScript', 'get').mockReturnValue(script);
  Object.defineProperty(window, 'innerWidth', { value: 800, writable: true });
  vi.spyOn(page, 'getBoundingClientRect').mockReturnValue(new window.DOMRect(16, 0, 1280, 720));
  try {
    window.eval(await readFile(new URL('../../plugins/latex-report-workbench/src/ui/public/html-preview.js', import.meta.url), 'utf8'));
    window.eval("dispatchEvent(new MessageEvent('message', {source:parent,data:{key:'frame-key',type:'configure',view:'original'}}))");
    expect(page.style.transform).toBe('scale(0.6)');
    window.innerWidth = 480;
    window.dispatchEvent(new window.Event('resize'));
    expect(page.style.transform).toBe('scale(0.35)');
    expect(page.style.width).toBe('1280px');
    window.innerWidth = 1440;
    window.dispatchEvent(new window.Event('resize'));
    expect(page.getAttribute('style')).toBe(originalStyle);
    await Promise.resolve(); await window.happyDOM.waitUntilComplete();
  } finally { currentScript.mockRestore(); await window.happyDOM.close(); }
});

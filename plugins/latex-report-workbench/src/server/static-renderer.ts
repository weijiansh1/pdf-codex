import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { WorkbenchError } from '../shared/errors.js';
import { renderHtmlDocument } from '../shared/html-report.js';

const require = createRequire(import.meta.url);
const vendor = fileURLToPath(new URL('./vendor/node_modules/@resvg/resvg-js/index.js', import.meta.url));
const { Resvg } = require(existsSync(vendor) ? vendor : '@resvg/resvg-js') as typeof import('@resvg/resvg-js');

/** Static vector renderer: scripts, event handlers and external URLs are removed first. */
export function svgPng(svg: string, width = 1600): Buffer {
  const safe = renderHtmlDocument(svg).html.match(/<svg\b[\s\S]*<\/svg>/i)?.[0];
  if (!safe) throw new WorkbenchError('INVALID_INPUT', 'SVG 缺少有效根元素。');
  try {
    const renderer = new Resvg(safe, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: true } });
    if (renderer.width * renderer.height > 8_000_000 || renderer.width < 1 || renderer.height < 1) throw new WorkbenchError('ASSET_TOO_LARGE', 'SVG 渲染尺寸超过 800 万像素，请缩小图表尺寸。');
    return Buffer.from(renderer.render().asPng());
  } catch (error) { if (error instanceof WorkbenchError) throw error; throw new WorkbenchError('BUILD_FAILED', `SVG 转换失败：${(error as Error).message.slice(0, 400)}`); }
}

export function findBrowser(): string {
  const candidates = [process.env.LATEX_BROWSER_EXECUTABLE,
    ...(process.platform === 'win32' ? [
      path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    ] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'])];
  const browser = candidates.find((value): value is string => Boolean(value && existsSync(value)));
  if (!browser) throw new WorkbenchError('BUILD_FAILED', '网页 PDF 和图像渲染需要 Edge 或 Chrome；可用 LATEX_BROWSER_EXECUTABLE 指定可执行文件。');
  return browser;
}

/** Renders only an already sanitized, self-contained document in a private, short-lived profile. */
export async function renderStatic(html: string, format: 'pdf' | 'png', options: { width?: number; height?: number; slide?: boolean; signal?: AbortSignal } = {}): Promise<Buffer> {
  const browser = findBrowser();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'latex-workbench-render-'));
  try {
    const width = Math.min(2400, Math.max(320, options.width ?? 1280));
    const height = Math.min(2400, Math.max(200, options.height ?? 720));
    const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:; base-uri \'none\'; form-action \'none\'">';
    const printStyle = format === 'pdf' ? `<style>@media print{
      ${options.slide
        ? `@page{size:${width}px ${height}px;margin:0}html,body{margin:0!important;padding:0!important}`
        : `@page{size:A4;margin:12mm}html,body{background:white!important}
          .paper-shell{display:block!important;min-width:0!important;width:auto!important;max-width:none!important;margin:0!important;padding:0!important}
          .paper-shell>main{min-width:0!important;width:auto!important;max-width:none!important;margin:0!important;padding:0!important;box-shadow:none!important}
          img,svg,table{max-width:100%}figure,tr{break-inside:avoid}`}
      body{print-color-adjust:exact;-webkit-print-color-adjust:exact}
      nav,.toc,[role="navigation"]{display:none!important}
    }</style>` : '';
    // Print overrides follow the author's styles; screen/PNG rendering keeps the original layout.
    const document = html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${policy}`).replace(/<\/head\s*>/i, match => `${printStyle}${match}`);
    const input = path.join(directory, 'document.html');
    const output = path.join(directory, `document.${format}`);
    await writeFile(input, document, 'utf8');
    const args = ['--headless', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--no-default-browser-check', '--hide-scrollbars',
      `--user-data-dir=${path.join(directory, 'profile')}`, '--allow-file-access-from-files', '--run-all-compositor-stages-before-draw', '--virtual-time-budget=1500', `--window-size=${width},${height}`,
      ...(format === 'pdf' ? ['--no-pdf-header-footer', `--print-to-pdf=${output}`] : [`--screenshot=${output}`]), pathToFileURL(input).href];
    try { await promisify(execFile)(browser, args, { shell: false, windowsHide: true, timeout: 35_000, maxBuffer: 1_048_576, ...(options.signal ? { signal: options.signal } : {}) }); }
    catch (error) { throw new WorkbenchError('BUILD_FAILED', `网页渲染失败：${(error as Error).message.slice(0, 500)}`); }
    const bytes = await readFile(output).catch(() => { throw new WorkbenchError('BUILD_FAILED', '浏览器没有生成渲染产物。'); });
    if (bytes.length > 32 * 1024 * 1024) throw new WorkbenchError('ASSET_TOO_LARGE', '渲染产物超过 32 MiB。');
    return bytes;
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('latex-workbench-render-')) throw new Error('unsafe render cleanup');
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

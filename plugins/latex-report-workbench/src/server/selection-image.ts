import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import type { SelectionRecord } from '../shared/contracts.js';
import type { Application } from './application.js';
import { htmlAttribute, htmlElements, isHtmlReport } from '../shared/html-report.js';
import { WorkbenchError } from '../shared/errors.js';
import { renderStatic, svgPng } from './static-renderer.js';
import { isInside } from './path-policy.js';

export async function selectionImage(app: Application, selection: SelectionRecord | null): Promise<{ mimeType: 'image/png'; data: string }[]> {
  if (!selection) return [];
  const report = await app.workspace.getReport(selection.reportId);
  if (isHtmlReport(report.mainFile)) {
    const target = selection.targets.find(target => target.relativePath === report.mainFile);
    if (!target || !/<(?:figure|table|svg|img)\b|\bdata-tex=|class=["'][^"']*\b(?:eq|equation|math)\b/i.test(target.exactText)) return [];
    const preview = await app.services.html.preview(selection.reportId);
    if (preview.fileVersion !== target.fileVersion) throw new WorkbenchError('SELECTION_STALE', '图像对应的网页版本已更新，请重新选择。');
    const block = preview.blocks.find(block => block.range.start === target.range.start && block.range.end === target.range.end);
    if (!block) throw new WorkbenchError('SELECTION_STALE', '图像内容块已变化，请重新选择。');
    const elements = htmlElements(preview.html);
    const node = elements.find(node => htmlAttribute(node, 'data-wb-block') === block.blockId);
    const loc = node?.sourceCodeLocation;
    if (!loc) throw new WorkbenchError('INVALID_INPUT', '无法渲染当前图表。');
    const snippet = preview.html.slice(loc.startOffset, loc.endOffset);
    const svg = snippet.match(/<svg\b[\s\S]*?<\/svg>/i)?.[0];
    const img = elements.find(node => node.tagName === 'img' && (node.sourceCodeLocation?.startOffset ?? -1) >= loc.startOffset && (node.sourceCodeLocation?.endOffset ?? Infinity) <= loc.endOffset);
    const src = img && htmlAttribute(img, 'src');
    let bytes: Buffer;
    if (svg && !/<table\b/i.test(snippet)) bytes = svgPng(svg, 1400);
    else if (src?.startsWith('data:image/svg+xml;base64,') && !/<table\b/i.test(snippet)) bytes = svgPng(Buffer.from(src.split(',')[1]!, 'base64').toString('utf8'), 1400);
    else {
      const head = preview.html.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? '';
      bytes = await renderStatic(`<!doctype html><html><head>${head}<style>html,body{margin:0!important;background:white!important}body{padding:24px!important}main{max-width:1200px!important;margin:0!important}img,svg,table{max-width:100%}figure{margin:0}nav{display:none}</style></head><body><main>${snippet}</main></body></html>`, 'png', { width: 1280, height: 1200 });
    }
    if (bytes.length > 8_388_608) throw new WorkbenchError('ASSET_TOO_LARGE', '选中图像超过 8 MiB。');
    return [{ mimeType: 'image/png', data: bytes.toString('base64') }];
  }
  if (!selection.buildId || !selection.pdfRegion) return [];
  const compiler = app.services.compiler as import('./compiler.js').Compiler;
  const manifest = await compiler.readManifest(selection.reportId, selection.buildId);
  const asset = manifest && Object.values(manifest.assets).find(asset => asset.kind === 'pdf');
  if (!manifest || manifest.status !== 'succeeded' || !asset) throw new WorkbenchError('BUILD_FAILED', '当前框选构建没有可渲染的 PDF。');
  const build = compiler.pathsFor(selection.reportId, selection.buildId);
  const pdf = path.resolve(build.directory, asset.fileName);
  if (!isInside(build.directory, pdf)) throw new WorkbenchError('PATH_OUTSIDE_WORKSPACE', 'PDF 资产超出构建。');
  const [x0, y0, x1, y1] = selection.pdfRegion.rect;
  const scale = 1.5;
  let info: string;
  try { info = (await promisify(execFile)(process.env.LATEX_PDFINFO_EXECUTABLE ?? 'pdfinfo', ['-box', '-f', String(selection.pdfRegion.page), '-l', String(selection.pdfRegion.page), pdf], { shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 1_048_576, encoding: 'utf8' })).stdout; }
  catch (error) { throw new WorkbenchError('BUILD_FAILED', `读取框选 PDF 页面需要 Poppler pdfinfo：${(error as Error).message.slice(0, 350)}`); }
  const box = (name: string) => {
    const match = new RegExp(`${name}:\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)`).exec(info);
    return match ? match.slice(1).map(Number) : null;
  };
  const media = box('MediaBox'), crop = box('CropBox') ?? media;
  const rotation = ((Number(/\brot:\s+(-?\d+)/i.exec(info)?.[1] ?? 0) % 360) + 360) % 360;
  if (!media || !crop || ![0, 90, 180, 270].includes(rotation)) throw new WorkbenchError('INVALID_INPUT', '无法读取 PDF 的实际页面几何。');
  const pageWidth = Math.min(media[2]!, crop[2]!) - Math.max(media[0]!, crop[0]!);
  const pageHeight = Math.min(media[3]!, crop[3]!) - Math.max(media[1]!, crop[1]!);
  if (![pageWidth, pageHeight, x0, y0, x1, y1].every(Number.isFinite) || pageWidth <= 0 || pageHeight <= 0 || x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0 || x1 > pageWidth + .02 || y1 > pageHeight + .02) throw new WorkbenchError('INVALID_INPUT', 'PDF 框选超出所显示页面的边界。');
  // UI regions use the unrotated, scale-1 CropBox viewport. Poppler crops after rotation.
  const forward = (x: number, y: number) => rotation === 90 ? [pageHeight - y, x] : rotation === 180 ? [pageWidth - x, pageHeight - y] : rotation === 270 ? [y, pageWidth - x] : [x, y];
  const a = forward(x0, y0), b = forward(Math.min(x1, pageWidth), Math.min(y1, pageHeight));
  const left = Math.floor(Math.min(a[0]!, b[0]!) * scale), top = Math.floor(Math.min(a[1]!, b[1]!) * scale);
  const width = Math.ceil(Math.max(a[0]!, b[0]!) * scale) - left, height = Math.ceil(Math.max(a[1]!, b[1]!) * scale) - top;
  if (width <= 0 || height <= 0 || width * height > 8_000_000) throw new WorkbenchError('INVALID_INPUT', 'PDF 框选尺寸无效或过大。');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'latex-workbench-image-'));
  try {
    const prefix = path.join(directory, 'region');
    try { await promisify(execFile)(process.env.LATEX_PDFTOPPM_EXECUTABLE ?? 'pdftoppm', ['-f', String(selection.pdfRegion.page), '-l', String(selection.pdfRegion.page), '-cropbox', '-singlefile', '-png', '-r', String(72 * scale), '-x', String(left), '-y', String(top), '-W', String(width), '-H', String(height), pdf, prefix], { shell: false, windowsHide: true, timeout: 20_000, maxBuffer: 1_048_576 }); }
    catch (error) { throw new WorkbenchError('BUILD_FAILED', `PDF 框选渲染需要 Poppler pdftoppm：${(error as Error).message.slice(0, 350)}`); }
    const bytes = await readFile(`${prefix}.png`);
    if (bytes.length > 8_388_608) throw new WorkbenchError('ASSET_TOO_LARGE', 'PDF 框选图像超过 8 MiB。');
    return [{ mimeType: 'image/png', data: bytes.toString('base64') }];
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('latex-workbench-image-')) throw new Error('unsafe image cleanup');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

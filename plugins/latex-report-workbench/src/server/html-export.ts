import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { htmlAttribute, htmlElements, htmlForLatex } from '../shared/html-report.js';
import { WorkbenchError } from '../shared/errors.js';
import { resolveSafePath } from './path-policy.js';
import { svgPng } from './static-renderer.js';

/** Runs only against a frozen build snapshot. It never creates a second editable original. */
export async function generateHtmlLatex(sourceRoot: string, mainFile: string, signal: AbortSignal): Promise<string> {
  const output = 'generated-report.tex';
  const input = 'generated-export-input.html';
  if (await stat(path.join(sourceRoot, output)).catch(() => null) || await stat(path.join(sourceRoot, input)).catch(() => null)) throw new WorkbenchError('INVALID_INPUT', '请为报告中的 generated-report.tex / generated-export-input.html 改名，这两个名称用于导出快照。');
  const text = await readFile(await resolveSafePath(sourceRoot, mainFile), 'utf8');
  const imagePaths: Record<string, string> = {};
  let imageIndex = 0;
  for (const node of htmlElements(text).filter(n => n.tagName === 'img' || n.tagName === 'svg')) {
    if (node.tagName === 'svg') {
      const loc = node.sourceCodeLocation;
      if (!loc) continue;
      const name = `generated-image-${++imageIndex}.png`;
      if (await stat(path.join(sourceRoot, name)).catch(() => null)) throw new WorkbenchError('INVALID_INPUT', `导出保留文件名已存在：${name}`);
      await writeFile(path.join(sourceRoot, name), svgPng(text.slice(loc.startOffset, loc.endOffset)));
      imagePaths[`inline:${loc.startOffset}`] = name;
      continue;
    }
    const src = htmlAttribute(node, 'src') ?? '';
    let pathname: string;
    try { pathname = decodeURIComponent(src.split(/[?#]/, 1)[0]!).replaceAll('\\', '/'); } catch { throw new WorkbenchError('INVALID_INPUT', '图表路径编码无效。'); }
    if (/^[a-z]+:|^\//i.test(pathname) || !/\.(png|jpe?g|pdf|svg)$/i.test(pathname)) throw new WorkbenchError('INVALID_INPUT', 'LaTeX 图表须使用报告目录内的 SVG、PNG、JPEG 或 PDF 图片。');
    const relative = path.posix.join(path.posix.dirname(mainFile.replaceAll('\\', '/')), pathname);
    const file = await resolveSafePath(sourceRoot, relative);
    if ((await stat(file)).size > 5_242_880) throw new WorkbenchError('ASSET_TOO_LARGE', '单张图表超过 5 MiB。');
    if (/\.svg$/i.test(relative)) {
      const name = `generated-image-${++imageIndex}.png`;
      if (await stat(path.join(sourceRoot, name)).catch(() => null)) throw new WorkbenchError('INVALID_INPUT', `导出保留文件名已存在：${name}`);
      await writeFile(path.join(sourceRoot, name), svgPng(await readFile(file, 'utf8')));
      imagePaths[src] = name;
    } else imagePaths[src] = relative;
  }
  let html: string;
  try { html = htmlForLatex(text, imagePaths); } catch (error) { throw new WorkbenchError('INVALID_INPUT', error instanceof Error ? error.message : 'HTML 导出包含不支持的结构。'); }
  await writeFile(path.join(sourceRoot, input), html, 'utf8');
  const slide = htmlElements(text).some(n => htmlAttribute(n, 'data-report-layout') === 'slide');
  const args = ['--from=html+tex_math_dollars+tex_math_single_backslash', `--to=${slide ? 'beamer' : 'latex'}`, '--standalone', '--wrap=none', '--pdf-engine=xelatex',
    '-V', `documentclass=${slide ? 'ctexbeamer' : 'ctexart'}`, '-V', `classoption=fontset=${process.platform === 'win32' ? 'windows' : 'fandol'}`,
    ...(slide ? ['-V', 'classoption=aspectratio=169', '--slide-level=1'] : ['-V', 'geometry=margin=24mm']),
    '--output', output, input];
  try {
    await promisify(execFile)(process.env.LATEX_PANDOC_EXECUTABLE ?? 'pandoc', args, { cwd: sourceRoot, shell: false, windowsHide: true, timeout: 20_000, maxBuffer: 4_194_304, signal });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkbenchError('BUILD_FAILED', 'HTML 导出需要 Pandoc；请安装 Pandoc 或设置 LATEX_PANDOC_EXECUTABLE。日常网页编辑可继续使用。');
    throw new WorkbenchError('BUILD_FAILED', `HTML 转 LaTeX 失败：${(error as Error).message.slice(0, 1200)}`);
  }
  return output;
}

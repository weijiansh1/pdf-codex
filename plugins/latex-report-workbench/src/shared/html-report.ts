import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import katex from 'katex';
import type { HtmlBlock } from './contracts.js';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
const BLOCKS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th', 'figcaption', 'section', 'figure', 'table']);
const OMIT = new Set(['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'form', 'input', 'button', 'textarea', 'select', 'template', 'foreignObject', 'foreignobject', 'animate', 'set']);
const VOID = new Set(['br', 'hr', 'img', 'wbr', 'col']);
const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'srcset', 'background']);
export const isHtmlReport = (mainFile: string): boolean => /\.html$/i.test(mainFile);
export const escapeHtml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function htmlAttribute(node: Element, name: string): string | undefined { return node.attrs.find(a => a.name === name)?.value; }
export function htmlText(node: Node): string {
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterTypes.TextNode).value;
  return 'childNodes' in node ? node.childNodes.map(htmlText).join('') : '';
}
export function htmlElements(text: string): Element[] {
  const elements: Element[] = [];
  const visit = (node: Node) => { if ('tagName' in node) elements.push(node); if ('childNodes' in node) node.childNodes.forEach(visit); };
  visit(parse(text, { sourceCodeLocationInfo: true }));
  return elements;
}
const TEXT_BLOCKS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th', 'figcaption']);
const INLINE_TEXT = new Set(['strong', 'b', 'em', 'i', 'u', 's', 'span', 'small', 'mark']);
const protectedElement = (node: Element) => htmlAttribute(node, 'data-tex') !== undefined || htmlAttribute(node, 'data-cite') !== undefined || htmlAttribute(node, 'class')?.split(/\s+/).some(name => /^(eq|equation|math|citation|cite|ref|reference|eqno)$/.test(name));

/** Source ranges are recomputed on the server for each conditional write. */
export function htmlEditableRuns(node: Element): { runId: string; text: string; range: { start: number; end: number } }[] {
  if (!TEXT_BLOCKS.has(node.tagName) || protectedElement(node)) return [];
  const runs: ReturnType<typeof htmlEditableRuns> = [];
  const visit = (child: Node) => {
    if (child.nodeName === '#text' && child.sourceCodeLocation) {
      const text = (child as DefaultTreeAdapterTypes.TextNode).value;
      if (text) runs.push({ runId: `r${child.sourceCodeLocation.startOffset.toString(36)}-${child.sourceCodeLocation.endOffset.toString(36)}`, text, range: { start: child.sourceCodeLocation.startOffset, end: child.sourceCodeLocation.endOffset } });
    } else if ('tagName' in child && INLINE_TEXT.has(child.tagName) && !protectedElement(child)) child.childNodes.forEach(visit);
  };
  node.childNodes.forEach(visit);
  return runs;
}
export function htmlBlocks(text: string): HtmlBlock[] {
  return htmlElements(text).flatMap(node => {
    const loc = node.sourceCodeLocation;
    const formula = Boolean(htmlAttribute(node, 'data-tex') !== undefined || htmlAttribute(node, 'class')?.split(/\s+/).some(name => ['eq', 'equation', 'math'].includes(name)));
    if ((!BLOCKS.has(node.tagName) && !formula) || !loc?.startTag || !loc.endTag) return [];
    const value = htmlText(node).trim() || htmlAttribute(node, 'data-tex') || '';
    if (!value) return [];
    const level = /^h[1-6]$/.test(node.tagName) ? Number(node.tagName[1]) : undefined;
    return [{ blockId: `b${loc.startOffset.toString(36)}-${loc.endOffset.toString(36)}`, tag: node.tagName, text: value.slice(0, 2000),
      range: { start: loc.startOffset, end: loc.endOffset }, contentRange: { start: loc.startTag.endOffset, end: loc.endTag.startOffset },
      editable: !formula && htmlEditableRuns(node).length > 0,
      runs: htmlEditableRuns(node).map(({ runId, text }) => ({ runId, text })),
      ...(htmlAttribute(node, 'data-tex') !== undefined ? { formula: htmlAttribute(node, 'data-tex')! } : {}),
      ...(level ? { level } : {}) }];
  });
}
function safeCss(value: string): string {
  return value.replace(/@import\s+[^;]+;?/gi, '').replace(/url\s*\([^)]*\)/gi, 'none').replace(/expression\s*\([^)]*\)/gi, '');
}
function imageUrl(value: string, assets: Record<string, string>): string {
  const data = assets[value] ?? value;
  return /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(data) ? data : '';
}

/** Shared, deterministic HTML projection. User scripts and remote resources never enter it. */
export function renderHtmlDocument(text: string, assets: Record<string, string> = {}): { html: string; blocks: HtmlBlock[] } {
  const blocks = htmlBlocks(text);
  const byStart = new Map(blocks.map(block => [block.range.start, block]));
  const runStarts = new Map(htmlElements(text).flatMap(node => htmlEditableRuns(node)).map(run => [run.range.start, run]));
  const counts = new Map<string, number>();
  const readingKeys = new Map(blocks.map(block => {
    let hash = 2166136261;
    for (const char of block.text.replace(/\s+/g, ' ').trim()) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
    const base = `${block.tag}-${(hash >>> 0).toString(36)}`;
    const count = (counts.get(base) ?? 0) + 1; counts.set(base, count);
    return [block.blockId, `${base}-${count}`];
  }));
  const render = (node: Node): string => {
    if (node.nodeName === '#text') {
      const value = escapeHtml((node as DefaultTreeAdapterTypes.TextNode).value);
      const run = runStarts.get(node.sourceCodeLocation?.startOffset ?? -1);
      return run ? `<span data-wb-run="${run.runId}">${value}</span>` : value;
    }
    if (!('tagName' in node)) return 'childNodes' in node ? node.childNodes.map(render).join('') : '';
    const tag = node.tagName;
    if (tag === 'link' && htmlAttribute(node, 'rel') === 'stylesheet') {
      const css = assets[htmlAttribute(node, 'href') ?? ''];
      return css ? `<style>${safeCss(css).replaceAll('<', '\\3c ')}</style>` : '';
    }
    if (OMIT.has(tag)) return '';
    if (tag === 'style') return `<style>${safeCss(htmlText(node)).replaceAll('<', '\\3c ')}</style>`;
    const formula = htmlAttribute(node, 'data-tex');
    const attributes: string[] = [];
    for (const attr of node.attrs) {
      const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
      if (/^on/i.test(name) || /^data-wb-/i.test(name) || ['contenteditable', 'autofocus', 'srcdoc', 'nonce', 'is', 'http-equiv'].includes(name)) continue;
      if (URL_ATTRIBUTES.has(name)) {
        if (tag === 'img' && name === 'src') { const source = imageUrl(attr.value, assets); if (source) attributes.push(`src="${escapeHtml(source)}"`); }
        else if ((name === 'href' || name === 'xlink:href') && /^#[a-z0-9_-]+$/i.test(attr.value)) attributes.push(`${name}="${escapeHtml(attr.value)}"`);
        continue;
      }
      attributes.push(`${name}="${escapeHtml(name === 'style' ? safeCss(attr.value) : attr.value)}"`);
    }
    const block = byStart.get(node.sourceCodeLocation?.startOffset ?? -1);
    if (block) attributes.push(`data-wb-block="${block.blockId}"`, `data-wb-editable="${block.editable}"`, `data-wb-reading="${readingKeys.get(block.blockId)}"`);
    const content = formula !== undefined ? katex.renderToString(formula, { output: 'mathml', displayMode: htmlAttribute(node, 'data-display') === 'block', throwOnError: false, trust: false, maxExpand: 1000 }) : node.childNodes.map(render).join('');
    return `<${tag}${attributes.length ? ' ' + attributes.join(' ') : ''}>${VOID.has(tag) ? '' : content + `</${tag}>`}`;
  };
  return { html: '<!doctype html>' + render(parse(text, { sourceCodeLocationInfo: true })), blocks };
}

/** Semantic export input; math is retained as TeX, CSS is left to the LaTeX template. */
export function htmlForLatex(text: string, imagePaths: Record<string, string> = {}): string {
  const render = (node: Node): string => {
    if (node.nodeName === '#text') return escapeHtml((node as DefaultTreeAdapterTypes.TextNode).value);
    if (!('tagName' in node)) return 'childNodes' in node ? node.childNodes.map(render).join('') : '';
    if (OMIT.has(node.tagName) || ['head', 'style'].includes(node.tagName)) return '';
    if (node.tagName === 'svg' && imagePaths[`inline:${node.sourceCodeLocation?.startOffset}`]) return `<img src="${escapeHtml(imagePaths[`inline:${node.sourceCodeLocation?.startOffset}`]!)}">`;
    if (['svg', 'canvas', 'video', 'audio'].includes(node.tagName)) throw new Error('LaTeX 导出不能转换 Canvas、视频或音频，请使用静态图表。');
    const formula = htmlAttribute(node, 'data-tex');
    if (formula !== undefined) return `<span class="math ${htmlAttribute(node, 'data-display') === 'block' ? 'display' : 'inline'}">${escapeHtml(htmlAttribute(node, 'data-display') === 'block' ? `\\[${formula}\\]` : `\\(${formula}\\)`)}</span>`;
    const attrs = node.attrs.filter(a => ['class', 'id', 'src', 'alt', 'width', 'height', 'style', 'colspan', 'rowspan'].includes(a.name));
    return `<${node.tagName}${attrs.map(a => ` ${a.name}="${escapeHtml(node.tagName === 'img' && a.name === 'src' ? imagePaths[a.value] ?? a.value : a.value)}"`).join('')}>${VOID.has(node.tagName) ? '' : node.childNodes.map(render).join('') + `</${node.tagName}>`}`;
  };
  return render(parse(text, { sourceCodeLocationInfo: true }));
}

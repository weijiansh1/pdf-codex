import { expect, it } from 'vitest';
import { decodeText, applyEdits, decodeDetailed, encodeText, diffToEdits } from '../../plugins/latex-report-workbench/src/server/files.js';
import { buildTextProjectionFrom, escapeLatexText, unescapeLatexText } from '../../plugins/latex-report-workbench/src/server/text-projection.js';

const project = (text: string) => buildTextProjectionFrom(decodeText('a.tex', Buffer.from(text)), { start: 0, end: text.length });
it('projects simple titles and preserves formatting, mathematics, labels, references and comments', () => {
  const p = project('\\section{中文标题}\n正文\\textbf{重点} $x^2$\\cite{key}\\label{sec:a}%注释\n末尾');
  expect(p.reversible).toBe(true);
  expect(p.runs.filter(r => r.kind === 'editable').map(r => r.text).join('')).toContain('中文标题');
  expect(p.runs.filter(r => r.kind === 'protected').map(r => r.text).join('')).toContain('$x^2$\\cite{key}\\label{sec:a}%注释');
});
it('escapes literal TeX input and round trips it, rejecting unknown macros', () => {
  const literal = '中文 % & _ # $ { } \\input{secret} ~ ^';
  expect(unescapeLatexText(escapeLatexText(literal))).toBe(literal);
  expect(project('正文\\custom{内容}').reversible).toBe(false);
});
it('preserves mixed EOLs when replacing a range containing a newline', () => {
  const s = decodeDetailed('a.tex', Buffer.from('\uFEFF甲\r\n乙\n丙\r\n丁'));
  const plan = applyEdits(s, [{ range: { start: 0, end: 4 }, replacement: '新\n' }]);
  expect(Buffer.from(encodeText(plan, s.snapshot)).toString('utf8')).toBe('\uFEFF新\r\n丙\r\n丁');
});
it('rejects out of bounds edits instead of appending silently', () => {
  const s = decodeDetailed('a.tex', Buffer.from('正文'));
  expect(() => applyEdits(s, [{ range: { start: 8, end: 9 }, replacement: '新' }])).toThrow();
});
it('rejects partial surrogate ranges and malformed replacement text', () => {
  const source = decodeDetailed('a.tex', Buffer.from('甲😀乙'));
  expect(() => applyEdits(source, [{ range: { start: 1, end: 2 }, replacement: '破坏' }])).toThrow();
  expect(() => applyEdits(source, [{ range: { start: 0, end: 1 }, replacement: '\uD800' }])).toThrow();
});
it('editor diffs replace a complete emoji even when its high surrogate matches', () => {
  const source = decodeDetailed('a.tex', Buffer.from('甲😀乙'));
  const edits = diffToEdits('甲😀乙', '甲😁乙');
  expect(edits).toEqual([{ range: { start: 1, end: 3 }, replacement: '😁' }]);
  expect(Buffer.from(encodeText(applyEdits(source, edits), source.snapshot)).toString()).toBe('甲😁乙');
});
it('rejects a line cut from a protected multiline environment, macro or comment', () => {
  for (const text of ['\\begin{equation}\nx^2+y^2\n\\end{equation}', '\\custom{\n隐藏参数\n}', '%注释文字']) {
    const start = text.includes('\n') ? text.indexOf('\n') + 1 : 1;
    const end = text.includes('\n') ? text.indexOf('\n', start) : text.length;
    const projection = buildTextProjectionFrom(decodeText('a.tex', Buffer.from(text)), { start, end });
    expect(projection.reversible).toBe(false);
  }
});

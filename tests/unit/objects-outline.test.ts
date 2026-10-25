import { expect, it } from 'vitest';
import { scanEnvironments, innermostEnvironment } from '../../plugins/latex-report-workbench/src/server/object-targets.js';
import { scanTex } from '../../plugins/latex-report-workbench/src/server/outline.js';
it('indexes starred headings, optional titles and nested braces while ignoring comments and verbatim', () => {
  const text = '%\\section{伪标题}\n\\section*[短]{含\\textbf{嵌套}标题}\n\\begin{verbatim}\n\\section{伪标题}\n\\end{verbatim}\n\\input{chapters/正文}';
  const scan = scanTex(text);
  expect(scan.events.filter(e => e.kind === 'heading')).toHaveLength(1);
  expect(scan.events.filter(e => e.kind === 'include')).toHaveLength(1);
});
it('pairs figure/table/equation environments and ignores commented commands', () => {
  const text = '%\\begin{figure}\n\\begin{figure}\n\\begin{tabular}{cc}甲&乙\\end{tabular}\n\\caption{图{嵌套}}\\end{figure}\n\\begin{equation}x^2\\end{equation}';
  const spans = scanEnvironments(text);
  expect(spans.map(s => s.name)).toEqual(['figure', 'tabular', 'equation']);
  expect(innermostEnvironment(spans, text.indexOf('甲'))?.name).toBe('tabular');
  expect(innermostEnvironment(spans, text.indexOf('caption'))?.name).toBe('figure');
});

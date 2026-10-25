import { describe, expect, it } from 'vitest';
import { renderHtmlDocument, htmlForLatex } from '../../plugins/latex-report-workbench/src/shared/html-report.js';
import { Window } from 'happy-dom';

describe('HTML projection', () => {
  it('keeps SVG charts and math while removing active content, network links and forged editor attributes', () => {
    const result = renderHtmlDocument('<style>@import "https://x/";p{background:url(https://x)}</style><h1 data-wb-block="forged" onclick="steal()">标题😀</h1><p>数学 <span data-tex="x^2"></span></p><svg viewBox="0 0 100 50"><script>steal()</script><foreignObject><iframe src="https://x"></iframe></foreignObject><path d="M0 0L10 10" onclick="steal()"/></svg><a href="javascript:steal()">链接</a><img src="https://x/" srcset="https://x/ 2x"><script>steal()</script>');
    const window = new Window();
    window.document.write(result.html);
    expect(window.document.querySelector('math')).not.toBeNull();
    expect(window.document.querySelector('svg path')?.getAttribute('d')).toBe('M0 0L10 10');
    expect(window.document.querySelectorAll('script,iframe,foreignObject,[onclick],[srcset],[href]')).toHaveLength(0);
    expect(window.document.querySelector('h1')?.getAttribute('data-wb-block')).not.toBe('forged');
    expect(window.document.querySelector('style')?.textContent).not.toContain('https://x');
    expect(window.document.querySelector('img')?.getAttribute('src')).toBeNull();
    window.close();
  });
  it('embeds only explicitly supplied image and CSS resources and exports semantic TeX formulas', () => {
    const png = 'data:image/png;base64,aGVsbG8=';
    const result = renderHtmlDocument('<link rel="stylesheet" href="style.css"><p>公式<span data-tex="\\rho v^2"></span></p><img src="chart.png">', { 'style.css': 'p{color:blue}', 'chart.png': png });
    expect(result.html).toContain('p{color:blue}');
    expect(result.html).toContain(png);
    expect(htmlForLatex('<p>A &amp; B <span data-tex="\\rho v^2"></span></p>')).toContain('\\(\\rho v^2\\)');
    expect(() => htmlForLatex('<svg><path d="M0 0"/></svg>')).toThrow('静态图表');
  });
});

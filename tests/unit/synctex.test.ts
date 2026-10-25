import { expect, it } from 'vitest';
import { boxToLocation, parseSyncTexEdit, parseSyncTexView } from '../../plugins/latex-report-workbench/src/server/synctex.js';

it('parses actual edit output without requiring page geometry, including Windows paths', () => {
  const hits = parseSyncTexEdit('SyncTeX result begin\nOutput:main.pdf\nInput:C:/中文 报告/章节.tex\nLine:12\nColumn:-1\nOffset:0\nContext:\nSyncTeX result end');
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ input: 'C:/中文 报告/章节.tex', line: 12, column: -1 });
});

it('preserves each view box and derives rectangles from h/v baseline rather than x/y', () => {
  const boxes = parseSyncTexView('SyncTeX result begin\nPage:1\nx:15\ny:27\nh:10\nv:30\nW:200\nH:12\nPage:2\nx:25\ny:47\nh:20\nv:50\nW:100\nH:14\nSyncTeX result end');
  expect(boxes).toHaveLength(2);
  expect(boxToLocation(boxes[0]!)).toEqual({ page: 1, rect: [10, 18, 210, 30] });
});

import { expect, it } from 'vitest';
import { canApplyFileRefresh, canUsePdfLocation } from '../../plugins/latex-report-workbench/src/ui/state.js';

it('allows PDF location only for the document identity actually displayed', () => {
  expect(canUsePdfLocation('report:old', 'report:new', false, '')).toBe(false);
  expect(canUsePdfLocation('report:new', 'report:new', true, '')).toBe(false);
  expect(canUsePdfLocation('report:new', 'report:new', false, 'load failed')).toBe(false);
  expect(canUsePdfLocation('report:new', 'report:new', false, '')).toBe(true);
});
it('discards a delayed clean-file refresh after user typing or report/file switching', () => {
  const captured = { reportId: 'a', path: 'a.tex', version: 'v1', text: '原文' };
  expect(canApplyFileRefresh(captured, { ...captured, saveState: 'clean' })).toBe(true);
  for (const current of [{ ...captured, text: '新草稿', saveState: 'dirty' }, { ...captured, reportId: 'b', saveState: 'clean' }, { ...captured, path: 'b.tex', saveState: 'clean' }, { ...captured, version: 'v2', saveState: 'clean' }]) expect(canApplyFileRefresh(captured, current)).toBe(false);
});

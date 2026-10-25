import { expect, it } from 'vitest';
import { svgPng } from '../../plugins/latex-report-workbench/src/server/static-renderer.js';

it('bounds raster pixel allocation before rendering unusually tall SVG figures', () => {
  expect(() => svgPng('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="5100"><rect width="10" height="10"/></svg>')).toThrow(/像素|尺寸/);
});

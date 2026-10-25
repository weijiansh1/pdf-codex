import { expect, it } from 'vitest';
import { toSyncTexPoint, toClientRect } from '../../plugins/latex-report-workbench/src/ui/pdf-coordinates.js';

it.each([0.75, 1, 2])('maps CSS coordinates at zoom %s independently of DPR', zoom => {
  for (const dpr of [1, 2]) {
    const viewport = { scale: dpr, rotation: 0, width: 600 * dpr, height: 800 * dpr };
    expect(toSyncTexPoint(viewport, { x: 10 + 100 * zoom, y: 20 + 200 * zoom }, { left: 10, top: 20, width: 600 * zoom, height: 800 * zoom })).toEqual({ x: 100, y: 200 });
  }
});
it.each([
  [0, 600, 800, 100, 200], [90, 800, 600, 200, 700], [180, 600, 800, 500, 600], [270, 800, 600, 400, 100],
])('handles rotation %s with known independent expected coordinates', (rotation, width, height, x, y) => {
  const viewport = { scale: 1, rotation: rotation!, width: width!, height: height! };
  expect(toSyncTexPoint(viewport, { x: 100, y: 200 }, { left: 0, top: 0, width: width!, height: height! })).toEqual({ x, y });
});
it('adds an explicit crop offset and transforms a PDF rectangle back into CSS pixels', () => {
  const viewport = { scale: 1, rotation: 90, width: 800, height: 600, cropOffset: { x: 20, y: 30 } };
  expect(toSyncTexPoint(viewport, { x: 100, y: 200 }, { left: 0, top: 0, width: 800, height: 600 })).toEqual({ x: 220, y: 730 });
  expect(toClientRect({ scale: 1, rotation: 90, width: 800, height: 600 }, [200, 680, 220, 700], { left: 0, top: 0, width: 1600, height: 1200 })).toEqual({ left: 200, top: 400, width: 40, height: 40 });
});

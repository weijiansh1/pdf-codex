import type { Point, Rect } from '../shared/contracts.js';

/** PDF.js display viewport; cropOffset is measured from MediaBox top-left in PDF big points. */
export type PageViewport = { scale: number; rotation: number; width: number; height: number; cropOffset?: Point };
type ElementRect = { left: number; top: number; width: number; height: number };

function dimensions(v: PageViewport) {
  const rotation = ((v.rotation % 360) + 360) % 360;
  const displayWidth = v.width / v.scale, displayHeight = v.height / v.scale;
  return { rotation, displayWidth, displayHeight, width: rotation % 180 ? displayHeight : displayWidth, height: rotation % 180 ? displayWidth : displayHeight };
}

/** Client CSS pixels → unrotated SyncTeX big points; backing-store DPR never leaks into coordinates. */
export function toSyncTexPoint(viewport: PageViewport, clientPoint: Point, box: ElementRect): Point {
  const d = dimensions(viewport);
  const x = Math.max(0, Math.min(d.displayWidth, (clientPoint.x - box.left) * d.displayWidth / (box.width || 1)));
  const y = Math.max(0, Math.min(d.displayHeight, (clientPoint.y - box.top) * d.displayHeight / (box.height || 1)));
  const point = d.rotation === 90 ? { x: y, y: d.height - x }
    : d.rotation === 180 ? { x: d.width - x, y: d.height - y }
    : d.rotation === 270 ? { x: d.width - y, y: x } : { x, y };
  return { x: point.x + (viewport.cropOffset?.x ?? 0), y: point.y + (viewport.cropOffset?.y ?? 0) };
}

export function toViewportRect(viewport: PageViewport, rect: { left: number; top: number; right: number; bottom: number }, box: ElementRect): Rect {
  const a = toSyncTexPoint(viewport, { x: rect.left, y: rect.top }, box);
  const b = toSyncTexPoint(viewport, { x: rect.right, y: rect.bottom }, box);
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
}

/** Unrotated SyncTeX rectangle → page-relative CSS rectangle, including rotation and crop origin. */
export function toClientRect(viewport: PageViewport, rect: Rect, box: ElementRect): { left: number; top: number; width: number; height: number } {
  const d = dimensions(viewport);
  const forward = (x0: number, y0: number) => {
    const x = x0 - (viewport.cropOffset?.x ?? 0), y = y0 - (viewport.cropOffset?.y ?? 0);
    return d.rotation === 90 ? { x: d.height - y, y: x }
      : d.rotation === 180 ? { x: d.width - x, y: d.height - y }
      : d.rotation === 270 ? { x: y, y: d.width - x } : { x, y };
  };
  const a = forward(rect[0], rect[1]), b = forward(rect[2], rect[3]);
  const sx = box.width / d.displayWidth, sy = box.height / d.displayHeight;
  return { left: Math.min(a.x, b.x) * sx, top: Math.min(a.y, b.y) * sy, width: Math.max(1, Math.abs(a.x - b.x) * sx), height: Math.max(1, Math.abs(a.y - b.y) * sy) };
}

export function isMeaningfulDrag(rect: { left: number; top: number; right: number; bottom: number }, minimum = 8): boolean {
  return Math.abs(rect.right - rect.left) >= minimum || Math.abs(rect.bottom - rect.top) >= minimum;
}

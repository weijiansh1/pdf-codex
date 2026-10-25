import { useState } from 'react';
import type { Point, Rect } from '../shared/contracts.js';

export function PdfRegionOverlay({ width, height, onComplete }: { width: number; height: number; onComplete: (rect: Rect) => void }) {
  const [drag, setDrag] = useState<{ start: Point; end: Point } | null>(null);
  return <div className="pdf-region-capture" aria-label="PDF 框选区域"
    onPointerDown={event => {
      const box = event.currentTarget.getBoundingClientRect();
      const start = { x: event.clientX - box.left, y: event.clientY - box.top };
      event.currentTarget.setPointerCapture(event.pointerId); setDrag({ start, end: start });
    }}
    onPointerMove={event => {
      if (!drag) return;
      const box = event.currentTarget.getBoundingClientRect();
      setDrag({ ...drag, end: { x: Math.max(0, Math.min(width, event.clientX - box.left)), y: Math.max(0, Math.min(height, event.clientY - box.top)) } });
    }}
    onPointerCancel={() => setDrag(null)}
    onPointerUp={event => {
      if (!drag) return;
      const { start, end } = drag; setDrag(null); event.currentTarget.releasePointerCapture(event.pointerId);
      if (Math.abs(start.x - end.x) < 8 && Math.abs(start.y - end.y) < 8) return;
      onComplete([Math.min(start.x, end.x), Math.min(start.y, end.y), Math.max(start.x, end.x), Math.max(start.y, end.y)]);
    }}>
    {drag && <div className="pdf-region-box" style={{ left: Math.min(drag.start.x, drag.end.x), top: Math.min(drag.start.y, drag.end.y), width: Math.abs(drag.start.x - drag.end.x), height: Math.abs(drag.start.y - drag.end.y) }}/>}</div>;
}

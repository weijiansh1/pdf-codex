import type { Point } from '../shared/contracts.js';

export type TextSelectionAnchor = {
  page: number;
  point: Point;
  selectedText: string;
  clientRect: { left: number; top: number; right: number; bottom: number };
};

function pageOf(node: Node | null, root: HTMLElement): number | null {
  let element = node instanceof Element ? node : node?.parentElement ?? null;
  while (element && element !== root) {
    const value = element.getAttribute('data-pdf-page');
    if (value) {
      const page = Number(value);
      if (Number.isInteger(page) && page > 0) return page;
    }
    element = element.parentElement;
  }
  return null;
}

/**
 * Reads the current DOM text selection inside a PDF text layer. A selection that spans two
 * pages is rejected (`page: null` case) because a SyncTeX lookup needs one unambiguous page.
 */
export function readTextSelection(selection: Selection | null, root: HTMLElement): TextSelectionAnchor | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const startPage = pageOf(range.startContainer, root);
  const endPage = pageOf(range.endContainer, root);
  if (!startPage || startPage !== endPage) return null;
  const clientRect = range.getBoundingClientRect();
  if (!clientRect || (clientRect.width === 0 && clientRect.height === 0)) return null;
  const point: Point = { x: clientRect.left + clientRect.width / 2, y: clientRect.top + clientRect.height / 2 };
  return {
    page: startPage,
    point,
    selectedText: text,
    clientRect: { left: clientRect.left, top: clientRect.top, right: clientRect.right, bottom: clientRect.bottom },
  };
}

/** Finds the rendered page element under a client point; used for click and drag targets. */
export function pageElementAt(root: HTMLElement, clientPoint: Point): HTMLElement | null {
  const element = document.elementFromPoint(clientPoint.x, clientPoint.y);
  if (!element || !root.contains(element)) return null;
  let cursor: Element | null = element;
  while (cursor && cursor !== root) {
    if (cursor instanceof HTMLElement && cursor.dataset.pdfPage) return cursor;
    cursor = cursor.parentElement;
  }
  return null;
}

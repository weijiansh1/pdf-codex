import { Window } from 'happy-dom';
import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PanelDivider } from '../../plugins/latex-report-workbench/src/ui/PanelDivider.js';

it('resizes an adjacent panel with the keyboard and restores its width without remounting document content', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const window = new Window({ width: 1280 });
  for (const [name, value] of Object.entries({ window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element })) vi.stubGlobal(name, value);
  const container = document.createElement('div'); document.body.append(container);
  const ref = createRef<HTMLDivElement>(); Object.assign(ref, { current: container });
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new window.DOMRect(0, 0, 1280, 800));
  let root = createRoot(container);
  const props = { container: ref, panel: 'codex' as const, storageKey: 'divider-test' };
  try {
    await act(async () => root.render(createElement(PanelDivider, props)));
    const divider = container.querySelector('[role="separator"]')!;
    const before = container.style.getPropertyValue('--panel-size');
    await act(async () => divider.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }) as unknown as Event));
    const after = container.style.getPropertyValue('--panel-size');
    expect(after).not.toBe(before);
    expect(Number.parseFloat(after)).toBeGreaterThan(Number.parseFloat(before));
    expect(window.localStorage.getItem('divider-test:codex')).toContain('wide');
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => root.render(createElement(PanelDivider, props)));
    expect(container.style.getPropertyValue('--panel-size')).toBe(after);
  } finally { await act(async () => root.unmount()); container.remove(); await window.happyDOM.close(); vi.unstubAllGlobals(); }
});

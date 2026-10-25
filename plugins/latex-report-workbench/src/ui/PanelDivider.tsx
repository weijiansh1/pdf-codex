import { useEffect, useState, type RefObject, type PointerEvent } from 'react';

type Panel = 'none' | 'navigation' | 'source' | 'codex';
export function PanelDivider({ container, panel, storageKey }: { container: RefObject<HTMLDivElement | null>; panel: Panel; storageKey: string }) {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 900);
  const [sizes, setSizes] = useState({ wide: .4, narrow: .48 });
  useEffect(() => {
    const media = window.matchMedia('(max-width:899px)');
    const update = () => setNarrow(media.matches); update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const defaults = { wide: panel === 'navigation' ? .22 : .4, narrow: panel === 'navigation' ? .38 : .48 };
    try {
      const value = JSON.parse(window.localStorage.getItem(`${storageKey}:${panel}`) ?? 'null') as typeof defaults | null;
      setSizes(value && [value.wide, value.narrow].every(n => Number.isFinite(n) && n >= .15 && n <= .75) ? value : defaults);
    } catch { setSizes(defaults); }
  }, [panel, storageKey]);
  useEffect(() => {
    container.current?.style.setProperty('--panel-size', `${sizes.wide * 100}%`);
    container.current?.style.setProperty('--panel-height', `${sizes.narrow * 100}%`);
  }, [sizes, container]);
  const set = (fraction: number) => {
    const rect = container.current?.getBoundingClientRect();
    const dimension = narrow ? rect?.height ?? 800 : rect?.width ?? 1280;
    const minPanel = narrow ? Math.min(120, dimension * .3) : 200;
    const minDocument = narrow ? Math.min(140, dimension * .35) : 320;
    const next = Math.min(.75, Math.max(.15, Math.min((dimension - minDocument - 6) / dimension, Math.max(minPanel / dimension, fraction))));
    const value = { ...sizes, [narrow ? 'narrow' : 'wide']: next };
    setSizes(value);
    try { window.localStorage.setItem(`${storageKey}:${panel}`, JSON.stringify(value)); } catch { /* Resizing remains available without storage. */ }
  };
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
  };
  return <div className="panel-divider" role="separator" tabIndex={panel === 'none' ? -1 : 0} hidden={panel === 'none'} aria-label="调整侧栏大小" aria-orientation={narrow ? 'horizontal' : 'vertical'} aria-valuemin={15} aria-valuemax={75} aria-valuenow={Math.round(sizes[narrow ? 'narrow' : 'wide'] * 100)}
    onPointerDown={drag} onPointerMove={event => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const rect = container.current?.getBoundingClientRect(); if (!rect) return;
      const offset = narrow ? panel === 'navigation' ? event.clientY - rect.top : rect.bottom - event.clientY : panel === 'navigation' ? event.clientX - rect.left : rect.right - event.clientX;
      set(offset / (narrow ? rect.height : rect.width));
    }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onKeyDown={event => {
      const negative = narrow ? 'ArrowUp' : 'ArrowLeft'; const positive = narrow ? 'ArrowDown' : 'ArrowRight';
      if (![negative, positive, 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const direction = (event.key === positive ? 1 : -1) * (panel === 'navigation' ? 1 : -1);
      set(event.key === 'Home' ? .2 : event.key === 'End' ? .65 : sizes[narrow ? 'narrow' : 'wide'] + direction * (event.shiftKey ? .1 : .02));
    }} title="拖动调整大小，方向键微调"/>;
}

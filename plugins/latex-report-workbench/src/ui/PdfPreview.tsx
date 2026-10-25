import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { GlobalWorkerOptions, TextLayer, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import PdfWorkerFactory from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';
import type { BuildManifest, Point, PdfLocation } from '../shared/contracts.js';
import { PdfRegionOverlay } from './PdfRegionOverlay.js';
import { loadAssetBytes, type ToolClient } from './api.js';
import { toClientRect, toSyncTexPoint, toViewportRect } from './pdf-coordinates.js';
import { pageElementAt, readTextSelection } from './pdf-selection.js';
import { PdfTextEditorOverlay, type PdfTextEditorOverlayProps } from './PdfTextEditorOverlay.js';
import { buildLabel, pdfAssetOf, canUsePdfLocation } from './state.js';

/**
 * Worker bootstrap. Vite inlines the PDF.js worker, so the MCP UI resource stays one
 * self-contained HTML file. A host that blocks blob workers throws here instead of silently
 * rendering nothing.
 */
let workerConfigured = false;
function ensurePdfWorker(): void {
  if (workerConfigured) return;
  GlobalWorkerOptions.workerPort = new PdfWorkerFactory();
  workerConfigured = true;
}

type PageSize = { width: number; height: number; rotation: number; mappingSupported: boolean };

export type PdfPreviewProps = {
  client: ToolClient;
  reportId: string;
  build: BuildManifest | null;
  editMode: boolean;
  overlay: PdfTextEditorOverlayProps | null;
  onToggleEditMode: (value: boolean) => void;
  onOpenPdfEdit: (input: { page: number; point: Point }) => void;
  onLocateText: (input: { page: number; point: Point; selectedText: string }) => void;
  onRegion: (region: PdfLocation) => void;
  onRefresh: () => Promise<void>;
};

/**
 * Renders the current *successful* build through PDF.js. Bytes come from the chunked UI tool and
 * never enter model-visible tool output. Coordinate conversion always goes through the scale-1
 * viewport, which is the SyncTeX unit (big points measured from the rendered page's top-left).
 */
export function PdfPreview({ client, reportId, build, editMode, overlay, onToggleEditMode, onOpenPdfEdit, onLocateText, onRegion, onRefresh }: PdfPreviewProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const document_ = useRef<PDFDocumentProxy | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [displayedIdentity, setDisplayedIdentity] = useState('');
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [zoom, setZoom] = useState(1.15);
  const [fitWidth, setFitWidth] = useState(true);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const refreshRequest = useRef<object | null>(null);
  const currentReport = useRef(reportId); currentReport.current = reportId;
  const [regionMode, setRegionMode] = useState(false);
  const [error, setError] = useState('');
  const [visible, setVisible] = useState<Set<number>>(() => new Set([1]));
  const anchor = useRef<{ page: number; offset: number } | null>(null);
  const restore = useRef<{ page: number; offset: number } | null>(null);
  const pressPoint = useRef<Point | null>(null);
  const asset = pdfAssetOf(build);
  const buildId = build?.buildId ?? '';
  const identity = `${reportId}:${buildId}`;
  const canLocate = Boolean(doc) && !refreshing && canUsePdfLocation(displayedIdentity, identity, loading, error);
  const pinnedPage = overlay?.session.placement.page ?? 0;
  const editPending = Boolean(overlay && overlay.status !== 'saved');

  useEffect(() => { refreshRequest.current = null; setRefreshing(false); }, [reportId]);
  async function refreshPreview() {
    if (!reportId || loading || refreshRequest.current || editPending) return;
    const request = {}; const captured = reportId;
    refreshRequest.current = request; setRefreshing(true); setError('');
    try {
      await onRefresh();
      if (currentReport.current === captured && refreshRequest.current === request) setReloadKey(value => value + 1);
    } catch (failure) {
      if (currentReport.current === captured && refreshRequest.current === request) setError(failure instanceof Error ? failure.message : '刷新 PDF 失败，请重试。');
    } finally {
      if (refreshRequest.current === request) { refreshRequest.current = null; setRefreshing(false); }
    }
  }

  useEffect(() => {
    const element = container.current;
    if (!element || !fitWidth || !sizes.length) return;
    const update = () => setZoom(Math.max(0.15, Math.min(3, (element.clientWidth - 40) / Math.max(...sizes.map(size => size.width)))));
    update(); const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, [fitWidth, sizes]);

  useEffect(() => {
    if (!asset || !build || build.status !== 'succeeded') { document_.current = null; setDoc(null); setSizes([]); return; }
    let cancelled = false;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        ensurePdfWorker();
        const bytes = await loadAssetBytes(client, reportId, build.buildId, asset.assetId, asset.bytes);
        if (cancelled) return;
        const task = getDocument({ data: bytes });
        const next = await task.promise;
        if (cancelled) { await next.loadingTask.destroy(); return; }
        const opened: PageSize[] = [];
        for (let page = 1; page <= next.numPages; page += 1) {
          const proxy = await next.getPage(page);
          const viewport = proxy.getViewport({ scale: 1 });
          opened.push({ width: viewport.width, height: viewport.height, rotation: viewport.rotation, mappingSupported: proxy.view[0] === 0 && proxy.view[1] === 0 });
        }
        if (cancelled) { await next.loadingTask.destroy(); return; }
        restore.current = anchor.current;
        const previous = document_.current;
        document_.current = next;
        setDoc(next);
        setDisplayedIdentity(`${reportId}:${build.buildId}`);
        setSizes(opened);
        setVisible(new Set([restore.current ? Math.min(restore.current.page, next.numPages) : 1]));
        if (previous && previous !== next) void previous.loadingTask.destroy();
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [client, reportId, buildId, asset?.assetId, build?.status, reloadKey]);

  useEffect(() => () => { void document_.current?.loadingTask.destroy(); document_.current = null; }, []);

  // Virtualization: keep pages near the viewport rendered, plus the active edit page.
  const onScroll = useCallback(() => {
    const root = container.current;
    const current = document_.current;
    if (!root || !current) return;
    const rootTop = root.getBoundingClientRect().top;
    const rootBottom = rootTop + root.clientHeight;
    const next = new Set<number>();
    let best: { page: number; offset: number } | null = null;
    for (const element of root.querySelectorAll<HTMLElement>('[data-pdf-page]')) {
      const page = Number(element.dataset.pdfPage);
      const rect = element.getBoundingClientRect();
      if (rect.bottom > rootTop - 700 && rect.top < rootBottom + 700) next.add(page);
      if (rect.top <= rootTop + 40 && (!best || rect.top > best.offset - Number.MAX_SAFE_INTEGER)) best = { page, offset: Math.max(0, rootTop - rect.top) };
    }
    if (pinnedPage) next.add(pinnedPage);
    if (best) anchor.current = best;
    setVisible(previous => sameSet(previous, next) ? previous : next);
  }, [pinnedPage]);

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [onScroll]);

  // Restore the reading position once the anchor page has been laid out.
  useEffect(() => {
    const root = container.current;
    const target = restore.current;
    if (!root || !target || !doc) return;
    const element = root.querySelector<HTMLElement>(`[data-pdf-page="${target.page}"]`);
    if (!element) return;
    restore.current = null;
    root.scrollTop = element.offsetTop + target.offset;
  }, [doc, sizes, zoom]);

  function geometryPoint(page: number, client: Point, element: HTMLElement): Point {
    const size = sizes[page - 1] ?? { width: 595, height: 842, rotation: 0, mappingSupported: false };
    const viewport = { scale: 1, rotation: size.rotation, width: size.width, height: size.height };
    const rect = element.getBoundingClientRect();
    return toSyncTexPoint(viewport, client, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  }

  function handleMouseUp(event: ReactMouseEvent<HTMLDivElement>) {
    if (regionMode || (event.target instanceof Element && event.target.closest('.pdf-edit-overlay'))) return;
    const root = container.current;
    if (!root || !canLocate) return;
    const start = pressPoint.current;
    pressPoint.current = null;
    if (editMode) {
      if (!start || Math.abs(event.clientX - start.x) > 4 || Math.abs(event.clientY - start.y) > 4) return;
      const element = pageElementAt(root, { x: event.clientX, y: event.clientY });
      const page = element ? Number(element.dataset.pdfPage) : Number.NaN;
      if (!element || !Number.isInteger(page)) return;
      if (!sizes[page - 1]?.mappingSupported) return;
      onOpenPdfEdit({ page, point: geometryPoint(page, { x: event.clientX, y: event.clientY }, element) });
      return;
    }
    const anchor_ = readTextSelection(window.getSelection(), root);
    if (!anchor_) return;
    if (!sizes[anchor_.page - 1]?.mappingSupported) return;
    const element = pageElementAt(root, anchor_.point);
    if (!element) return;
    onLocateText({ page: anchor_.page, point: geometryPoint(anchor_.page, anchor_.point, element), selectedText: anchor_.selectedText });
  }

  const pages = doc ? Array.from({ length: doc.numPages }, (_, index) => index + 1) : [];
  return <section className={`pdf-panel${editMode ? ' edit-mode' : ''}`} aria-busy={loading || refreshing}>
    <div className="panel-title">
      <strong>PDF 预览</strong>
      <span>{loading ? '读取资产…' : buildLabel(build)}</span>
    </div>
    <div className="pdf-toolbar">
      <button type="button" disabled={!reportId || loading || refreshing || editPending} onClick={() => { void refreshPreview(); }} title={editPending ? '先保存或取消原位改字' : '重新读取最新 PDF，保留当前页和缩放'}>{refreshing ? '刷新中…' : '刷新预览'}</button>
      <button type="button" className={editMode ? 'active' : ''} disabled={!canLocate || !overlayAllowed(build)} onClick={() => { setRegionMode(false); onToggleEditMode(!editMode); }} title={overlayAllowed(build) ? '点击正文直接改字' : '需要一次成功的构建'}>编辑文字</button>
      <button type="button" className={regionMode ? 'active' : ''} disabled={!canLocate} onClick={() => { onToggleEditMode(false); setRegionMode(!regionMode); }}>框选对象</button>
      <span className="pdf-mode-hint">{editMode ? '点击正文打开原位编辑器；Esc 取消' : '划选正文可定位源码；选择不会自动发送消息'}</span>
      <div className="pdf-zoom">
        <button type="button" className={fitWidth ? 'active' : ''} onClick={() => setFitWidth(true)}>适应宽度</button>
        <button type="button" onClick={() => { setFitWidth(false); setZoom(value => Math.max(0.15, Number((value - 0.15).toFixed(2)))); }} aria-label="缩小">－</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => { setFitWidth(false); setZoom(value => Math.min(3, Number((value + 0.15).toFixed(2)))); }} aria-label="放大">＋</button>
      </div>
    </div>
    <div className="pdf-scroll" ref={container} onMouseDown={event => { pressPoint.current = { x: event.clientX, y: event.clientY }; }} onMouseUp={handleMouseUp}>
      {!doc && !loading && <div className="empty"><div className="page-icon">PDF</div><h2>{build ? '当前构建没有可预览的 PDF' : '还没有成功构建'}</h2><p>{build?.status === 'failed' ? '编译失败，仍可阅读上一次成功构建的 PDF；请查看诊断或让 Codex 修复。' : '在顶部点击“编译”，成功后会在这里渲染 PDF。'}</p></div>}
      {loading && <div className="empty"><h2>正在读取 PDF 资产</h2><p>字节通过 UI 专用分块工具传输，不会进入模型上下文。</p></div>}
      {error && <div className="error" role="alert">PDF 预览失败：{error}</div>}
      {sizes.some(size => !size.mappingSupported) && <div className="notice">非零裁剪原点的页面可以阅读；当前禁止点击定位和原位编辑，请在源码中修改。</div>}
      <div className="pdf-pages">
        {pages.map(page => {
          const size = sizes[page - 1];
          if (!size || !doc) return null;
          const rendered = visible.has(page) || pinnedPage === page;
          return <div key={page} className="pdf-page" data-pdf-page={page} style={{ width: size.width * zoom, height: size.height * zoom }}>
            {rendered && <PdfPageSurface doc={doc} pageNumber={page} zoom={zoom}/>}
            {regionMode && canLocate && size.mappingSupported && <PdfRegionOverlay width={size.width * zoom} height={size.height * zoom} onComplete={rect => onRegion({ page, rect: toViewportRect({ scale: 1, rotation: size.rotation, width: size.width, height: size.height }, { left: rect[0], top: rect[1], right: rect[2], bottom: rect[3] }, { left: 0, top: 0, width: size.width * zoom, height: size.height * zoom }) })}/>}
            {overlay && overlay.session.placement.page === page && <div className="pdf-edit-anchor" style={anchorStyle(size, zoom, overlay.session.placement.rects)}>
              <PdfTextEditorOverlay {...overlay}/>
            </div>}
          </div>;
        })}
      </div>
      {doc && <p className="pdf-footer">共 {doc.numPages} 页 · 构建 {displayedIdentity.split(':').at(-1)?.slice(0, 8)}{!canLocate ? ' · 正在更新，暂不能定位' : ''}</p>}
    </div>
  </section>;
}

function overlayAllowed(build: BuildManifest | null): boolean {
  return build?.status === 'succeeded';
}

function anchorStyle(size: PageSize, zoom: number, rects: [number, number, number, number][]): CSSProperties {
  const first = rects[0];
  if (!first) return { left: 12 * zoom, top: 12 * zoom };
  const box = toClientRect({ scale: 1, rotation: size.rotation, width: size.width, height: size.height }, first, { left: 0, top: 0, width: size.width * zoom, height: size.height * zoom });
  return { left: box.left, top: box.top + box.height + 2, width: Math.max(260, Math.min(box.width + 40, size.width * zoom - box.left)) };
}

function sameSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function PdfPageSurface({ doc, pageNumber, zoom }: { doc: PDFDocumentProxy; pageNumber: number; zoom: number }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const text = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState('');

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    setFailed('');
    void (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const surface = canvas.current;
        const textHost = text.current;
        if (!surface || !textHost) return;
        const viewport = page.getViewport({ scale: zoom });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        surface.style.width = `${viewport.width}px`;
        surface.style.height = `${viewport.height}px`;
        surface.width = Math.floor(viewport.width * ratio);
        surface.height = Math.floor(viewport.height * ratio);
        textHost.replaceChildren();
        textHost.style.setProperty('--total-scale-factor', String(zoom));
        textHost.style.setProperty('--scale-round-x', '1px');
        textHost.style.setProperty('--scale-round-y', '1px');
        renderTask = page.render({ canvas: surface, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
        await renderTask.promise;
        if (cancelled) return;
        const layer = new TextLayer({ textContentSource: page.streamTextContent({ includeMarkedContent: true }), container: textHost, viewport });
        await layer.render();
      } catch (failure) {
        if (!cancelled) setFailed(failure instanceof Error ? failure.message : String(failure));
      }
    })();
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [doc, pageNumber, zoom]);

  return <>
    <canvas ref={canvas} className="pdf-canvas"/>
    <div ref={text} className="pdf-text-layer" data-pdf-text-layer/>
    {failed && <p className="pdf-page-error">第 {pageNumber} 页渲染失败：{failed}</p>}
  </>;
}

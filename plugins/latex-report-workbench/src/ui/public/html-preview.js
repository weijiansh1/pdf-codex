/* Workbench-owned iframe interaction only. This file never fetches or writes report files. */
(() => {
  const key = new URL(document.currentScript.src).hash.slice(1);
  let active = null, old = '', originals = new Map(), committed = false, view = 'original', selecting = false, readOnly = true;
  let restoring = true, scrollTimer, restoreSequence = 0, interacted = false;
  let bodyStyle = document.body.getAttribute('style');
  let page = document.querySelector('[data-page-width]');
  let pageStyle = page?.getAttribute('style');
  const send = (type, value = {}) => parent.postMessage({ key, type, ...value }, '*');
  const position = () => {
    let anchor = null;
    for (const node of document.querySelectorAll('main [id],article [id],h1[id],h2[id],h3[id]')) {
      if (node.getBoundingClientRect().top <= 100) anchor = node;
    }
    let block = null, nearest = -Infinity;
    for (const node of document.querySelectorAll('[data-wb-reading]')) {
      if (node.closest('nav,.toc,[role="navigation"]')) continue;
      const rect = node.getBoundingClientRect();
      if (rect.height > 0 && rect.top <= 100 && rect.top >= nearest) { block = node; nearest = rect.top; }
    }
    return { x: scrollX, y: scrollY, anchor: anchor?.id || '', offset: anchor?.getBoundingClientRect().top || 0,
      ...(block ? { block: block.dataset.wbReading, blockOffset: block.getBoundingClientRect().top } : {}) };
  };
  const remember = () => { if (!restoring) send('position', { position: position() }); };
  const cancel = () => {
    if (!active) return;
    active.innerHTML = old;
    active = null; committed = false;
    send('cancel');
  };
  const changes = () => Array.from(active?.querySelectorAll('[data-wb-run]') || [], node => ({ runId: node.dataset.wbRun, text: node.textContent }));
  const commit = () => {
    if (!active || committed) return;
    const value = changes();
    if (value.every(run => originals.get(run.runId) === run.text)) { cancel(); return; }
    committed = true;
    active.querySelectorAll('[contenteditable]').forEach(node => node.removeAttribute('contenteditable'));
    remember(); send('edit', { blockId: active.dataset.wbBlock, changes: value });
  };
  const begin = block => {
    active = block; old = block.innerHTML; committed = false;
    originals = new Map(changes().map(run => [run.runId, run.text]));
    block.querySelectorAll('[data-wb-run]').forEach(node => node.setAttribute('contenteditable', 'plaintext-only'));
    send('editing');
  };
  const resetStyle = (node, value) => { if (value === null) node.removeAttribute('style'); else node.setAttribute('style', value); };
  const resize = () => {
    if (!page) return;
    resetStyle(document.body, bodyStyle); resetStyle(page, pageStyle);
    const width = Number(page.dataset.pageWidth);
    if (!width || width > 10000) return;
    const natural = page.getBoundingClientRect();
    if (view === 'original' && natural.left >= 0 && natural.right <= innerWidth) return;
    const scale = Math.min(1, Math.max(.1, (innerWidth - 32) / width));
    page.style.transformOrigin = 'top left';
    page.style.transform = `scale(${scale})`;
    page.style.margin = '0';
    document.body.style.padding = '16px';
    document.body.style.height = `${page.offsetHeight * scale + 32}px`;
    document.body.style.overflowX = 'hidden';
  };
  const restore = async value => {
    const sequence = ++restoreSequence;
    await Promise.allSettled(Array.from(document.querySelectorAll('img'), img => img.complete ? Promise.resolve() : new Promise(resolve => { img.addEventListener('load', resolve, { once: true }); img.addEventListener('error', resolve, { once: true }); })));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (sequence !== restoreSequence) return;
    if (value && !interacted && Number.isFinite(value.y) && Number.isFinite(value.x) && Number.isFinite(value.offset) && typeof value.anchor === 'string') {
      const anchor = document.getElementById(value.anchor);
      const block = typeof value.block === 'string' && Number.isFinite(value.blockOffset) ? Array.from(document.querySelectorAll('[data-wb-reading]')).find(node => node.dataset.wbReading === value.block) : null;
      scrollTo({ left: value.x, top: block ? scrollY + block.getBoundingClientRect().top - value.blockOffset : anchor ? scrollY + anchor.getBoundingClientRect().top - value.offset : value.y, behavior: 'instant' });
    }
    restoring = false; remember();
  };
  addEventListener('wheel', () => { interacted = true; }, { passive: true });
  addEventListener('touchstart', () => { interacted = true; }, { passive: true });
  addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(remember, 80); }, { passive: true });
  addEventListener('resize', resize);
  addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    if (link) {
      const href = link.getAttribute('href');
      if (href?.startsWith('#')) {
        event.preventDefault(); interacted = true;
        let id; try { id = decodeURIComponent(href.slice(1)); } catch { return; }
        document.getElementById(id)?.scrollIntoView({ behavior: 'instant', block: 'start' }); remember();
      }
      return;
    }
    if (active || !selecting) return;
    const block = event.target.closest?.('[data-wb-block]');
    if (block) {
      document.querySelector('[data-wb-selected]')?.removeAttribute('data-wb-selected');
      block.setAttribute('data-wb-selected', ''); remember(); send('select', { blockId: block.dataset.wbBlock });
    }
  });
  addEventListener('dblclick', event => {
    if (readOnly || event.target.closest?.('a[href]')) return;
    const block = event.target.closest?.('[data-wb-block]');
    if (!block || active) return;
    if (block.hasAttribute('data-tex')) { send('formula', { blockId: block.dataset.wbBlock }); return; }
    if (block.dataset.wbEditable !== 'true') return;
    const run = event.target.closest?.('[data-wb-run]') || block.querySelector('[data-wb-run]');
    if (!run) return;
    remember(); begin(block); run.focus();
  });
  addEventListener('input', () => { if (active && !committed) send('draft', { blockId: active.dataset.wbBlock, changes: changes() }); });
  addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (active && !event.isComposing) commit(); return; }
    if (!active) { if (['PageDown', 'PageUp', 'Home', 'End', 'ArrowDown', 'ArrowUp', ' '].includes(event.key)) interacted = true; return; }
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); commit(); }
  });
  addEventListener('focusout', event => {
    if (!active || active.contains(event.relatedTarget)) return;
    commit();
  });
  const nodeKey = node => node.nodeType === 1 ? node.id || node.getAttribute('data-wb-reading') || '' : '';
  const patch = (current, next) => {
    if (current.isEqualNode(next)) return;
    if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) { current.replaceWith(next.cloneNode(true)); return; }
    if (current.nodeType !== 1) { current.textContent = next.textContent; return; }
    for (const attr of Array.from(current.attributes)) if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
    for (const attr of Array.from(next.attributes)) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
    const owned = node => node.nodeType === 1 && node.hasAttribute('data-wb-owned');
    const oldNodes = Array.from(current.childNodes).filter(node => !owned(node));
    const used = new Set();
    let cursor = current.firstChild;
    for (const incoming of Array.from(next.childNodes)) {
      if (incoming.nodeName === 'SCRIPT' || incoming.nodeName === 'META') continue;
      const id = nodeKey(incoming);
      let existing = id ? oldNodes.find(node => !used.has(node) && nodeKey(node) === id) : null;
      if (!existing) existing = oldNodes.find(node => !used.has(node) && node.nodeName === incoming.nodeName && !nodeKey(node));
      if (!existing) existing = oldNodes.find(node => !used.has(node) && node.nodeName === incoming.nodeName);
      if (existing) { used.add(existing); patch(existing, incoming); }
      else existing = incoming.cloneNode(true);
      while (cursor && owned(cursor)) cursor = cursor.nextSibling;
      if (existing !== cursor) current.insertBefore(existing, cursor);
      cursor = existing.nextSibling;
    }
    for (const node of oldNodes) if (!used.has(node)) node.remove();
  };
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.key !== key) return;
    if (event.data.type === 'cancel') cancel();
    if (event.data.type === 'saved') { active = null; committed = false; }
    if (event.data.type === 'retry') committed = false;
    if (event.data.type === 'save') commit();
    if (event.data.type === 'recover' && !readOnly && !active) {
      const block = Array.from(document.querySelectorAll('[data-wb-block]')).find(node => node.dataset.wbBlock === event.data.blockId);
      if (block?.dataset.wbEditable === 'true') {
        begin(block);
        for (const change of event.data.changes || []) {
          const run = Array.from(block.querySelectorAll('[data-wb-run]')).find(node => node.dataset.wbRun === change.runId);
          if (run && typeof change.text === 'string') run.textContent = change.text;
        }
        block.querySelector('[data-wb-run]')?.focus();
      }
    }
    if (event.data.type === 'update' && typeof event.data.html === 'string' && !active) {
      if (typeof event.data.readOnly === 'boolean') readOnly = event.data.readOnly;
      const at = position();
      const next = new DOMParser().parseFromString(event.data.html, 'text/html');
      next.querySelectorAll('script,meta,base,iframe,object,embed').forEach(node => node.remove());
      // Owned policy/style/script nodes survive every update. No user script is introduced.
      patch(document.head, next.head); patch(document.body, next.body);
      bodyStyle = document.body.getAttribute('style'); page = document.querySelector('[data-page-width]'); pageStyle = page?.getAttribute('style');
      interacted = false; resize(); void restore(at);
      send('updated', { version: event.data.version });
    }
    if (event.data.type === 'zoom') { view = event.data.view; resize(); }
    if (event.data.type === 'configure') {
      view = event.data.view; readOnly = event.data.readOnly !== false; selecting = event.data.selecting === true;
      document.documentElement.dataset.wbSelecting = String(selecting); resize(); void restore(event.data.position);
    }
    if (event.data.type === 'interaction') { selecting = event.data.selecting === true; document.documentElement.dataset.wbSelecting = String(selecting); if (!selecting) document.querySelector('[data-wb-selected]')?.removeAttribute('data-wb-selected'); }
  });
  send('ready');
})();

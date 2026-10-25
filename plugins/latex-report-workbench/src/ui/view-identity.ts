export type ViewLock = (name: string, work: (acquired: boolean) => Promise<void>) => Promise<void>;
type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type ViewIdentity = { viewId: string; release(): Promise<void> };

/** sessionStorage survives reload but is copied when a tab is cloned. Hold an exclusive document
 * lock to distinguish those cases before binding any report or attaching a running terminal. */
export async function claimViewIdentity(storage: ViewStorage, withLock?: ViewLock): Promise<ViewIdentity> {
  if (!withLock) { const viewId = crypto.randomUUID(); storage.setItem('latex-view-id', viewId); return { viewId, release: async () => undefined }; }
  const stored = storage.getItem('latex-view-id');
  const candidate = stored && /^[\da-f-]{36}$/i.test(stored) ? stored : crypto.randomUUID();
  let unlock!: () => void; let accept!: (viewId: string) => void;
  const held = new Promise<void>(resolve => { unlock = resolve; });
  const ready = new Promise<string>(resolve => { accept = resolve; });
  const acquire = async (id: string): Promise<void> => {
    let acquired = false;
    await withLock(`latex-workbench-view:${id}`, async available => {
      if (!available) return;
      acquired = true; storage.setItem('latex-view-id', id); accept(id); await held;
    });
    if (!acquired) await acquire(crypto.randomUUID());
  };
  const completed = acquire(candidate).catch(() => { const id = crypto.randomUUID(); storage.setItem('latex-view-id', id); accept(id); });
  return { viewId: await ready, release: async () => { unlock(); await completed; } };
}

import { locks } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { claimViewIdentity } from '../../plugins/latex-report-workbench/src/ui/view-identity.js';
const withLock = (name: string, work: (acquired: boolean) => Promise<void>) => locks.request(name, { ifAvailable: true }, lock => work(Boolean(lock)));

function storage(initial?: string) { const values = new Map(initial ? [['latex-view-id', initial]] : []); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; }

it('gives cloned active tabs different views while a refresh can restore the released view', async () => {
  const firstStorage = storage(); const first = await claimViewIdentity(firstStorage, withLock);
  const clonedStorage = storage(first.viewId); const clone = await claimViewIdentity(clonedStorage, withLock);
  try {
    expect(clone.viewId).not.toBe(first.viewId);
    expect(clonedStorage.getItem('latex-view-id')).toBe(clone.viewId);
    await first.release();
    const refresh = await claimViewIdentity(firstStorage, withLock);
    expect(refresh.viewId).toBe(first.viewId); await refresh.release();
  } finally { await first.release(); await clone.release(); }
});

it('uses a fresh identity when exclusive browser locks are unavailable', async () => {
  const saved = storage('old-copy'); const view = await claimViewIdentity(saved, undefined);
  expect(view.viewId).not.toBe('old-copy'); await view.release();
});

it('can still bind a new isolated view when a host refuses browser locks', async () => {
  const saved = storage('old-copy');
  const view = await claimViewIdentity(saved, async () => { throw new Error('SecurityError'); });
  expect(view.viewId).not.toBe('old-copy'); await view.release();
});

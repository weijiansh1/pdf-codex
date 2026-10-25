import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fixture } from '../helpers/workspace.js';
import { writeJsonAtomic } from '../../plugins/latex-report-workbench/src/server/store.js';
import { buildPaths } from '../../plugins/latex-report-workbench/src/server/compiler.js';

it('retains snapshotting builds and old builds referenced by selection contexts', async () => {
  const f = await fixture();
  try {
    const protectedId = randomUUID(), snapshottingId = randomUUID();
    const all = [protectedId, snapshottingId, ...Array.from({ length: 12 }, () => randomUUID())];
    for (const [index, buildId] of all.entries()) await writeJsonAtomic(buildPaths(f.app.workspace.layout.dir, f.reportId, buildId).manifest, {
      reportId: f.reportId, buildId, status: buildId === snapshottingId ? 'snapshotting' : index >= 10 ? 'failed' : 'succeeded', startedAt: new Date(1000 + index * 1000).toISOString(), finishedAt: new Date(2000 + index * 1000).toISOString(), inputVersions: {}, assets: {}, inputPaths: {}, protocolVersion: 1, diagnostics: [], reportRevision: 'test',
    });
    await writeJsonAtomic(path.join(f.app.workspace.layout.contexts, `${f.contextId}.json`), { selection: { reportId: f.reportId, buildId: protectedId }, lastSeenAt: new Date().toISOString() });
    const result = await f.app.services.cleanup.cleanupWorkspace({ now: new Date().toISOString(), dryRun: true });
    expect(result.retained).toContain(`build:${f.reportId}:${snapshottingId}`);
    expect(result.retained).toContain(`build:${f.reportId}:${protectedId}`);
    expect(result.removed).toHaveLength(4);
  } finally { await f.close(); }
});

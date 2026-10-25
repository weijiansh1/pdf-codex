import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { CleanupResult, Diagnostic } from '../shared/contracts.js';
import { DEFAULTS } from '../shared/config.js';
import { WorkbenchError } from '../shared/errors.js';
import type { CleanupPort } from '../shared/ports.js';
import type { Compiler } from './compiler.js';
import type { HistoryStore } from './history.js';
import { readJson, writeJsonAtomic } from './store.js';
import type { Workspace } from './workspace.js';

export type CleanupDependencies = { workspace: Workspace; compiler: Compiler; history: HistoryStore };
export type { CleanupPort } from '../shared/ports.js';

type StoredEditSession = { editSessionId: string; buildId: string; reportId: string };

/**
 * Retention runs only on rebuildable data: build directories, history snapshots and stale
 * PDF edit sessions. Report sources, exports and journals are never deleted here.
 */
export function createCleanup(dependencies: CleanupDependencies): CleanupPort {
  async function referencedBuilds(): Promise<Set<string>> {
    const referenced = new Set<string>();
    let names: string[];
    try {
      names = await readdir(dependencies.workspace.layout.edits);
    } catch {
      return referenced;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const session = await readJson<StoredEditSession>(path.join(dependencies.workspace.layout.edits, name));
      if (session?.buildId) referenced.add(session.buildId);
    }
    const contexts = await readdir(dependencies.workspace.layout.contexts).catch(() => []);
    for (const name of contexts) {
      if (!name.endsWith('.json')) continue;
      const context = await readJson<{ lastSeenAt: string; selection?: { buildId?: string } }>(path.join(dependencies.workspace.layout.contexts, name));
      if (context?.selection?.buildId && Date.parse(context.lastSeenAt) + DEFAULTS.idleShutdownMs * 4 > Date.now()) referenced.add(context.selection.buildId);
    }
    return referenced;
  }

  return {
    async cleanupWorkspace({ now, dryRun }): Promise<CleanupResult> {
      const removed: string[] = [];
      const retained: string[] = [];
      const diagnostics: Diagnostic[] = [];
      const current = Date.parse(now);
      if (Number.isNaN(current)) throw new WorkbenchError('INVALID_INPUT', 'now 必须是有效时间。');
      const protectedBuilds = await referencedBuilds();
      for (const report of await dependencies.workspace.listReports()) {
        const buildIds = await dependencies.compiler.listBuildIds(report.reportId);
        const currentBuildId = await dependencies.compiler.currentBuildId(report.reportId);
        const entries = [] as { buildId: string; status: string; finishedAt: number; keep: boolean }[];
        for (const buildId of buildIds) {
          const manifest = await dependencies.compiler.readManifest(report.reportId, buildId);
          if (!manifest) {
            // Orphan directory without a readable manifest: safe to remove.
            entries.push({ buildId, status: 'orphan', finishedAt: 0, keep: false });
            continue;
          }
          const finishedAt = Date.parse(manifest.finishedAt ?? manifest.startedAt ?? '') || 0;
          const keep = manifest.status === 'queued' || manifest.status === 'snapshotting' || manifest.status === 'running' || buildId === currentBuildId || protectedBuilds.has(buildId);
          entries.push({ buildId, status: manifest.status, finishedAt, keep });
        }
        const successful = entries.filter(entry => entry.status === 'succeeded' && !entry.keep).sort((a, b) => b.finishedAt - a.finishedAt);
        const failed = entries.filter(entry => entry.status !== 'succeeded' && !entry.keep).sort((a, b) => b.finishedAt - a.finishedAt);
        for (const entry of entries.filter(candidate => candidate.keep)) retained.push(`build:${report.reportId}:${entry.buildId}`);
        for (const entry of successful.slice(DEFAULTS.retainedSuccessfulBuilds)) removed.push(`build:${report.reportId}:${entry.buildId}`);
        for (const entry of failed.slice(DEFAULTS.retainedFailedBuilds)) removed.push(`build:${report.reportId}:${entry.buildId}`);
        for (const entry of successful.slice(0, DEFAULTS.retainedSuccessfulBuilds)) retained.push(`build:${report.reportId}:${entry.buildId}`);
        for (const entry of failed.slice(0, DEFAULTS.retainedFailedBuilds)) retained.push(`build:${report.reportId}:${entry.buildId}`);

        const operations = await dependencies.history.listOperations(report.reportId);
        const cutoff = current - DEFAULTS.historyDays * 86_400_000;
        const prunable = operations.slice(DEFAULTS.minHistoryOperations).filter(operation => Date.parse(operation.createdAt) < cutoff);
        for (const operation of prunable) removed.push(`history:${report.reportId}:${operation.operationId}`);
        for (const operation of operations.filter(candidate => !prunable.includes(candidate))) retained.push(`history:${report.reportId}:${operation.operationId}`);

        let sessionNames: string[];
        try {
          sessionNames = await readdir(dependencies.workspace.layout.edits);
        } catch {
          sessionNames = [];
        }
        for (const name of sessionNames) {
          if (!name.endsWith('.json')) continue;
          const session = await readJson<StoredEditSession>(path.join(dependencies.workspace.layout.edits, name));
          if (session?.reportId !== report.reportId) continue;
          const stale = protectedBuilds.has(session.buildId) && !buildIds.includes(session.buildId);
          if (stale) removed.push(`edit-session:${report.reportId}:${session.editSessionId}`);
        }
      }
      if (!dryRun) {
        for (const item of removed) {
          const [kind, reportId, id] = item.split(':');
          if (!kind || !reportId || !id) continue;
          if (kind === 'build') await rm(path.join(dependencies.workspace.layout.builds, reportId, id), { recursive: true, force: true });
          else if (kind === 'edit-session') await rm(path.join(dependencies.workspace.layout.edits, `${id}.json`), { force: true });
          else if (kind === 'history') await dependencies.history.pruneOperationIds(reportId, [id]);
        }
        diagnostics.push({ severity: 'info', code: 'CLEANUP_DONE', message: `已清理 ${removed.length} 项可重建数据。` });
      } else {
        diagnostics.push({ severity: 'info', code: 'CLEANUP_DRY_RUN', message: `预演：将清理 ${removed.length} 项，保留 ${retained.length} 项。` });
      }
      return { removed, retained, diagnostics };
    },

    async migrateWorkspace(fromVersion: number): Promise<Diagnostic[]> {
      const diagnostics: Diagnostic[] = [];
      if (fromVersion > DEFAULTS.schemaVersion) throw new WorkbenchError('INVALID_INPUT', '工作区版本高于当前服务，拒绝降级。', false, { fromVersion });
      if (fromVersion === DEFAULTS.schemaVersion) return diagnostics;
      const configFile = dependencies.workspace.layout.config;
      const raw = await readJson<{ schemaVersion?: number; workspaceId?: string; root?: string; defaultTemplateId?: string }>(configFile);
      if (!raw || typeof raw.workspaceId !== 'string') throw new WorkbenchError('INVALID_INPUT', '工作区配置缺失或损坏，无法迁移。');
      const backup = `${configFile}.backup-${Date.now()}.json`;
      await writeJsonAtomic(backup, raw);
      await writeJsonAtomic(configFile, {
        schemaVersion: DEFAULTS.schemaVersion,
        workspaceId: raw.workspaceId,
        root: raw.root ?? dependencies.workspace.root,
        defaultTemplateId: raw.defaultTemplateId ?? 'chinese-report',
        createdAt: new Date().toISOString(),
      });
      diagnostics.push({ severity: 'info', code: 'WORKSPACE_MIGRATED', message: `工作区已从版本 ${fromVersion} 迁移到 ${DEFAULTS.schemaVersion}，备份保存在 ${path.basename(backup)}。` });
      return diagnostics;
    },
  };
}

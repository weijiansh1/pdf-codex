import type { BuildManifest, BuildRecord } from '../shared/contracts.js';
import type { BuildQueuePort } from '../shared/ports.js';
import { WorkbenchError } from '../shared/errors.js';
import { newId, nowIso } from './store.js';
import { writeBuildManifest, type Compiler } from './compiler.js';
import type { Workspace } from './workspace.js';

export type BuildQueueDependencies = {
  workspace: Workspace;
  compiler: Compiler;
  onEvent?: (event: { reportId: string; buildId: string; status: BuildRecord['status'] }) => void;
};

type PendingBuild = { reportId: string; buildId: string; revision: string };

/** One TeX build at a time for the whole workspace, remembering dirty revisions. */
export class BuildQueue implements BuildQueuePort {
  private running: (PendingBuild & { controller: AbortController }) | null = null;
  private readonly waiting: PendingBuild[] = [];
  private readonly dirty = new Set<string>();
  private readonly newest = new Map<string, string>();
  private stopping = false;
  constructor(private readonly dependencies: BuildQueueDependencies) {}

  async enqueueBuild(reportId: string, options: { force?: boolean } = {}): Promise<{ buildId: string }> {
    if (this.stopping) throw new WorkbenchError('BUILD_FAILED', '服务正在关闭。');
    const report = await this.dependencies.workspace.getReport(reportId);
    const active = this.running?.reportId === reportId ? this.running : this.waiting.find(build => build.reportId === reportId);
    if (active) {
      if (active.revision !== report.reportRevision || options.force) this.dirty.add(reportId);
      return { buildId: active.buildId };
    }
    if (!options.force) {
      const currentId = await this.dependencies.compiler.currentBuildId(reportId);
      const current = currentId ? await this.dependencies.compiler.readManifest(reportId, currentId) : null;
      if (currentId && current?.status === 'succeeded' && current.reportRevision === report.reportRevision) return { buildId: currentId };
    }
    const buildId = newId();
    await writeBuildManifest(this.dependencies.workspace, {
      reportId, buildId, reportRevision: report.reportRevision, status: 'queued', startedAt: nowIso(), inputVersions: {}, diagnostics: [], protocolVersion: 1, inputPaths: {}, assets: {},
    });
    this.newest.set(reportId, buildId);
    this.waiting.push({ reportId, buildId, revision: report.reportRevision });
    void this.pump();
    return { buildId };
  }

  private async pump(): Promise<void> {
    if (this.running || this.waiting.length === 0) return;
    const next = this.waiting.shift()!;
    const controller = new AbortController();
    this.running = { ...next, controller };
    try {
      const report = await this.dependencies.workspace.getReport(next.reportId);
      const record = await this.dependencies.compiler.run(report, next.buildId, {
        signal: controller.signal,
        onStatus: async status => { this.dependencies.onEvent?.({ reportId: next.reportId, buildId: next.buildId, status }); },
      });
      this.dependencies.onEvent?.({ reportId: next.reportId, buildId: next.buildId, status: record.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : '编译失败。';
      await writeBuildManifest(this.dependencies.workspace, {
        reportId: next.reportId, buildId: next.buildId, reportRevision: next.revision, status: 'failed', finishedAt: nowIso(),
        inputVersions: {}, diagnostics: [{ severity: 'error', code: error instanceof WorkbenchError ? error.code : 'BUILD_FAILED', message }], protocolVersion: 1, inputPaths: {}, assets: {}, detail: message,
      }).catch(() => undefined);
      this.dependencies.onEvent?.({ reportId: next.reportId, buildId: next.buildId, status: 'failed' });
    } finally {
      this.running = null;
      if (this.dirty.delete(next.reportId) && !this.stopping) {
        try {
          const report = await this.dependencies.workspace.getReport(next.reportId);
          const buildId = newId();
          await writeBuildManifest(this.dependencies.workspace, {
            reportId: next.reportId, buildId, reportRevision: report.reportRevision, status: 'queued', startedAt: nowIso(), inputVersions: {}, diagnostics: [], protocolVersion: 1, inputPaths: {}, assets: {},
          });
          this.newest.set(next.reportId, buildId);
          this.waiting.push({ reportId: next.reportId, buildId, revision: report.reportRevision });
        } catch {
          // A report that disappeared while dirty needs no rebuild.
        }
      }
      void this.pump();
    }
  }

  async getBuildStatus(reportId: string, buildId?: string): Promise<BuildManifest> {
    await this.dependencies.workspace.getReport(reportId);
    if (buildId) {
      const manifest = await this.dependencies.compiler.readManifest(reportId, buildId);
      if (!manifest) throw new WorkbenchError('INVALID_INPUT', '找不到该构建记录。', false, { buildId });
      return manifest;
    }
    const candidates = [this.newest.get(reportId), await this.dependencies.compiler.currentBuildId(reportId)].filter((value): value is string => Boolean(value));
    const ids = await this.dependencies.compiler.listBuildIds(reportId);
    candidates.push(...ids);
    const manifests: BuildManifest[] = [];
    for (const candidate of candidates) {
      const manifest = await this.dependencies.compiler.readManifest(reportId, candidate);
      if (!manifest) continue;
      manifests.push(manifest);
    }
    const latest = this.newest.get(reportId);
    const result = manifests.find(manifest => manifest.buildId === latest) ?? manifests.sort((a, b) => (b.startedAt ?? b.finishedAt ?? '').localeCompare(a.startedAt ?? a.finishedAt ?? ''))[0];
    const successful = await this.dependencies.compiler.currentBuildId(reportId);
    if (result) return { ...result, ...(successful ? { currentSuccessfulBuildId: successful } : {}) };
    throw new WorkbenchError('INVALID_INPUT', '该报告还没有构建记录。', false, { reportId });
  }

  async latestSuccessful(reportId: string): Promise<BuildManifest | null> {
    const currentId = await this.dependencies.compiler.currentBuildId(reportId);
    if (!currentId) return null;
    const manifest = await this.dependencies.compiler.readManifest(reportId, currentId);
    return manifest?.status === 'succeeded' ? manifest : null;
  }

  async cancelBuild(reportId: string, buildId: string): Promise<void> {
    if (this.running && this.running.reportId === reportId && this.running.buildId === buildId) {
      this.running.controller.abort();
      return;
    }
    const index = this.waiting.findIndex(build => build.reportId === reportId && build.buildId === buildId);
    if (index >= 0) {
      const [removed] = this.waiting.splice(index, 1);
      const manifest = removed ? await this.dependencies.compiler.readManifest(reportId, removed.buildId) : null;
      if (manifest) await writeBuildManifest(this.dependencies.workspace, { ...manifest, status: 'cancelled', finishedAt: nowIso() });
      return;
    }
    throw new WorkbenchError('INVALID_INPUT', '该构建不在队列中。', false, { buildId });
  }

  hasActiveWork(): boolean {
    return this.running !== null || this.waiting.length > 0;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.dirty.clear();
    this.waiting.length = 0;
    this.running?.controller.abort();
    while (this.running) await new Promise(resolve => setTimeout(resolve, 25));
  }
}

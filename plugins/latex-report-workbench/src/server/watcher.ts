import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { WorkspaceEvent } from '../shared/contracts.js';
import { PRIVATE_DIRECTORIES } from '../shared/config.js';
import type { WatcherPort } from '../shared/ports.js';
import type { Workspace } from './workspace.js';

export type WatcherEvent = { reportId: string; kind: WorkspaceEvent['kind'] };
export type WatcherDependencies = {
  workspace: Workspace;
  onEvent: (event: WatcherEvent) => void;
  /** Debounce window for burst writes such as a formatter saving several files. */
  debounceMs?: number;
};

function ignored(relativePath: string): boolean {
  const parts = relativePath.replaceAll('\\', '/').split('/');
  return parts.some(part => PRIVATE_DIRECTORIES.has(part) || part === '.latex-workspace');
}

/**
 * Watches the reports directory with recursive `fs.watch` and reports a debounced
 * `files-changed` event per report. It never reads or reparses the changed files itself.
 */
export class WorkspaceWatcher implements WatcherPort {
  private watcher: FSWatcher | null = null;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly reportsRoot: string;
  private reportRoots = new Map<string, string>();

  constructor(private readonly dependencies: WatcherDependencies) {
    this.reportsRoot = path.join(dependencies.workspace.root, 'reports');
  }

  private async refreshReports(): Promise<void> {
    const next = new Map<string, string>();
    for (const report of await this.dependencies.workspace.listReports()) {
      const absolute = path.resolve(this.dependencies.workspace.root, report.rootRelativePath).toLowerCase();
      next.set(absolute, report.reportId);
    }
    this.reportRoots = next;
  }

  private reportFor(changed: string): string | null {
    const absolute = path.resolve(changed).toLowerCase();
    for (const [root, reportId] of this.reportRoots) {
      if (absolute === root || absolute.startsWith(`${root}${path.sep}`)) return reportId;
    }
    return null;
  }

  private schedule(reportId: string): void {
    const existing = this.timers.get(reportId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(reportId);
      this.dependencies.onEvent({ reportId, kind: 'files-changed' });
    }, this.dependencies.debounceMs ?? 300);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(reportId, timer);
  }

  async start(): Promise<void> {
    if (this.watcher) return;
    await this.refreshReports();
    this.watcher = watch(this.reportsRoot, { recursive: true, persistent: false }, (_event, filename) => {
      const name = typeof filename === 'string' ? filename : '';
      if (!name || ignored(name)) return;
      const reportId = this.reportFor(path.join(this.reportsRoot, name));
      if (!reportId) {
        // A new report directory appeared; refresh the index and keep watching.
        void this.refreshReports();
        return;
      }
      this.schedule(reportId);
    });
    this.watcher.on('error', () => {
      this.watcher?.close();
      this.watcher = null;
    });
  }

  async stop(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.watcher?.close();
    this.watcher = null;
  }
}

export function createWatcher(dependencies: WatcherDependencies): WorkspaceWatcher {
  return new WorkspaceWatcher(dependencies);
}

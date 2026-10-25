import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { HistoryPage, OperationRecord, UndoRequest } from '../shared/contracts.js';
import type { HistoryPort } from '../shared/ports.js';
import { WorkbenchError } from '../shared/errors.js';
import { nowIso, readJson, sha256, writeBytesAtomic, writeJsonAtomic } from './store.js';
import type { Workspace } from './workspace.js';

export type JournalFileEntry = {
  relativePath: string;
  beforeVersion: string | null;
  afterVersion: string;
  before: Uint8Array;
  after: Uint8Array;
};

export type JournalEntry = {
  operationId: string;
  reportId: string;
  state: 'prepared' | 'committed';
  createdAt: string;
  applied: string[];
  files: { relativePath: string; beforeVersion: string | null; afterVersion: string; beforeFile: string; afterFile: string }[];
};

type OperationsFile = { schemaVersion: 1; operations: OperationRecord[] };
type SnapshotIndex = { schemaVersion: 1; files: { relativePath: string; beforeFile: string; afterFile: string }[] };

const MAX_OPERATIONS_PER_REPORT = 500;

export type RestoreTarget = {
  assertWritable(reportId: string, relativePaths: string[]): Promise<void>;
  restoreFile(reportId: string, relativePath: string, bytes: Uint8Array, expectedVersion: string): Promise<void>;
  readVersion(reportId: string, relativePath: string): Promise<string>;
  removeFile(reportId: string, relativePath: string, expectedVersion: string): Promise<void>;
  recoverTransactions(reportId: string): Promise<unknown>;
  withReportLock<T>(reportId: string, work: () => Promise<T>): Promise<T>;
};

/** Durable operation history, journal and snapshots for one workspace. */
export class HistoryStore {
  constructor(private readonly workspace: Workspace) {}

  private reportDirectory(reportId: string): string {
    return path.join(this.workspace.layout.history, reportId);
  }
  private operationsFile(reportId: string): string {
    return path.join(this.reportDirectory(reportId), 'operations.json');
  }
  private journalDirectory(reportId: string): string {
    return path.join(this.reportDirectory(reportId), 'journal');
  }
  private snapshotDirectory(reportId: string, operationId: string): string {
    return path.join(this.reportDirectory(reportId), 'snapshots', operationId);
  }

  async listOperations(reportId: string): Promise<OperationRecord[]> {
    const file = await readJson<OperationsFile>(this.operationsFile(reportId));
    return file?.operations ?? [];
  }

  async getOperation(reportId: string, operationId: string): Promise<OperationRecord | null> {
    return (await this.listOperations(reportId)).find(operation => operation.operationId === operationId) ?? null;
  }

  async appendOperation(record: OperationRecord): Promise<void> {
    const operations = await this.listOperations(record.reportId);
    const next = [record, ...operations.filter(operation => operation.operationId !== record.operationId)].slice(0, MAX_OPERATIONS_PER_REPORT);
    await writeJsonAtomic(this.operationsFile(record.reportId), { schemaVersion: 1, operations: next } satisfies OperationsFile);
  }

  /** Writes both sides of every file plus the prepared journal before any replacement happens. */
  async beginJournal(reportId: string, operationId: string, files: JournalFileEntry[]): Promise<{ entry: JournalEntry; markProgress: (relativePath: string) => Promise<void> }> {
    const snapshotDirectory = this.snapshotDirectory(reportId, operationId);
    await mkdir(snapshotDirectory, { recursive: true });
    const index: SnapshotIndex = { schemaVersion: 1, files: [] };
    const entryFiles: JournalEntry['files'] = [];
    for (const [index0, file] of files.entries()) {
      const beforeFile = `${index0}-before.bin`;
      const afterFile = `${index0}-after.bin`;
      await writeBytesAtomic(path.join(snapshotDirectory, beforeFile), file.before);
      await writeBytesAtomic(path.join(snapshotDirectory, afterFile), file.after);
      index.files.push({ relativePath: file.relativePath, beforeFile, afterFile });
      entryFiles.push({ relativePath: file.relativePath, beforeVersion: file.beforeVersion, afterVersion: file.afterVersion, beforeFile, afterFile });
    }
    await writeJsonAtomic(path.join(snapshotDirectory, 'index.json'), index);
    const entry: JournalEntry = { operationId, reportId, state: 'prepared', createdAt: nowIso(), applied: [], files: entryFiles };
    await mkdir(this.journalDirectory(reportId), { recursive: true });
    const journalFile = this.journalFile(reportId, operationId);
    await writeJsonAtomic(journalFile, entry);
    return {
      entry,
      markProgress: async (relativePath: string) => {
        if (!entry.applied.includes(relativePath)) entry.applied.push(relativePath);
        await writeJsonAtomic(journalFile, entry);
      },
    };
  }

  private journalFile(reportId: string, operationId: string): string {
    return path.join(this.journalDirectory(reportId), `${operationId}.json`);
  }

  async commitJournal(entry: JournalEntry, record: OperationRecord, _files: { relativePath: string; before: Uint8Array; after: Uint8Array }[]): Promise<void> {
    await this.appendOperation(record);
    entry.state = 'committed';
    await rm(this.journalFile(entry.reportId, entry.operationId), { force: true });
  }

  async listJournal(reportId: string): Promise<JournalEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.journalDirectory(reportId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: JournalEntry[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const entry = await readJson<JournalEntry>(path.join(this.journalDirectory(reportId), name));
      if (entry?.state === 'prepared') entries.push(entry);
    }
    return entries;
  }

  async markRecovered(reportId: string, entry: JournalEntry): Promise<void> {
    await this.appendOperation({
      operationId: entry.operationId,
      reportId,
      origin: 'external',
      state: 'recovered',
      createdAt: nowIso(),
      beforeVersions: Object.fromEntries(entry.files.map(file => [file.relativePath, file.afterVersion])),
      afterVersions: Object.fromEntries(entry.files.map(file => [file.relativePath, file.beforeVersion ?? ''])),
      diffSummary: '检测到未提交事务：已回滚，未完成的修改没有生效。',
    });
    await rm(this.journalFile(reportId, entry.operationId), { force: true });
  }

  async readSnapshot(reportId: string, operationId: string): Promise<{ relativePath: string; before: Uint8Array; after: Uint8Array }[]> {
    const directory = this.snapshotDirectory(reportId, operationId);
    const index = await readJson<SnapshotIndex>(path.join(directory, 'index.json'));
    if (!index) throw new WorkbenchError('INVALID_INPUT', '找不到该操作的快照，无法撤销。', false, { operationId });
    const result: { relativePath: string; before: Uint8Array; after: Uint8Array }[] = [];
    for (const file of index.files) {
      result.push({ relativePath: file.relativePath, before: await readFile(path.join(directory, file.beforeFile)), after: await readFile(path.join(directory, file.afterFile)) });
    }
    return result;
  }

  async pruneOperations(reportId: string, keep: number): Promise<string[]> {
    const operations = await this.listOperations(reportId);
    const removed: string[] = [];
    for (const operation of operations.slice(keep)) {
      await rm(this.snapshotDirectory(reportId, operation.operationId), { recursive: true, force: true });
      removed.push(operation.operationId);
    }
    if (removed.length) {
      await writeJsonAtomic(this.operationsFile(reportId), { schemaVersion: 1, operations: operations.slice(0, keep) } satisfies OperationsFile);
    }
    return removed;
  }

  async pruneOperationIds(reportId: string, ids: string[]): Promise<void> {
    const operations = await this.listOperations(reportId);
    for (const operation of operations.filter(record => ids.includes(record.operationId))) await rm(this.snapshotDirectory(reportId, operation.operationId), { recursive: true, force: true });
    await writeJsonAtomic(this.operationsFile(reportId), { schemaVersion: 1, operations: operations.filter(record => !ids.includes(record.operationId)) } satisfies OperationsFile);
  }

  async reportDirectories(): Promise<string[]> {
    try {
      return (await readdir(this.workspace.layout.history, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

export function createHistory(store: HistoryStore, target: () => RestoreTarget): HistoryPort {
  return {
    async list(reportId: string, cursor?: string, limit = 20): Promise<HistoryPage> {
      const operations = await store.listOperations(reportId);
      const start = cursor ? operations.findIndex(operation => operation.operationId === cursor) + 1 : 0;
      const page = operations.slice(start, start + limit);
      const last = page.at(-1);
      const hasMore = last ? operations.findIndex(operation => operation.operationId === last.operationId) + 1 < operations.length : false;
      return hasMore && last ? { operations: page, nextCursor: last.operationId } : { operations: page };
    },
    async undoOperation(input: UndoRequest): Promise<OperationRecord> {
      const writer = target();
      return writer.withReportLock(input.reportId, async () => {
      const existing = await store.getOperation(input.reportId, input.undoOperationId);
      if (existing) return existing;
      const targetOperation = await store.getOperation(input.reportId, input.operationId);
      if (!targetOperation) throw new WorkbenchError('INVALID_INPUT', '找不到要撤销的操作。', false, { operationId: input.operationId });
      // Undo dependencies in reverse commit order: restore the old entry before
      // removing a newly created main file that the current manifest still uses.
      const snapshots = (await store.readSnapshot(input.reportId, input.operationId)).reverse();
      if (snapshots.length === 0) throw new WorkbenchError('INVALID_INPUT', '该操作没有可恢复的快照。');
      await writer.assertWritable(input.reportId, snapshots.map(snapshot => snapshot.relativePath));
      const files = targetOperation.beforeVersions;
      for (const snapshot of snapshots) {
        const expected = input.expectedCurrentVersions[snapshot.relativePath];
        if (!expected) throw new WorkbenchError('INVALID_INPUT', `撤销必须提供 ${snapshot.relativePath} 的当前版本。`, false, { relativePath: snapshot.relativePath });
        const after = targetOperation.afterVersions[snapshot.relativePath];
        if (after && expected !== after) throw new WorkbenchError('FILE_VERSION_CONFLICT', '文件已有后续修改，撤销不会覆盖较新内容。', true, { relativePath: snapshot.relativePath, expected: after, actual: expected });
        if (await writer.readVersion(input.reportId, snapshot.relativePath) !== expected) throw new WorkbenchError('FILE_VERSION_CONFLICT', '文件已有后续修改，整批撤销未写入。', true);
      }
      const entry = await store.beginJournal(input.reportId, input.undoOperationId, snapshots.map(snapshot => ({
        relativePath: snapshot.relativePath,
        beforeVersion: input.expectedCurrentVersions[snapshot.relativePath] ?? null,
        afterVersion: targetOperation.beforeVersions[snapshot.relativePath] === null ? '' : sha256(snapshot.before),
        before: snapshot.after,
        after: snapshot.before,
      })));
      try { for (const [index, snapshot] of snapshots.entries()) {
        const expected = input.expectedCurrentVersions[snapshot.relativePath]!;
        if (targetOperation.beforeVersions[snapshot.relativePath] === null) await writer.removeFile(input.reportId, snapshot.relativePath, expected);
        else await writer.restoreFile(input.reportId, snapshot.relativePath, snapshot.before, expected);
        await entry.markProgress(snapshot.relativePath);
        void index;
      } } catch (error) { await writer.recoverTransactions(input.reportId); throw error; }
      const record: OperationRecord = {
        operationId: input.undoOperationId,
        reportId: input.reportId,
        origin: 'undo',
        state: 'committed',
        createdAt: nowIso(),
        beforeVersions: Object.fromEntries(snapshots.map(snapshot => [snapshot.relativePath, input.expectedCurrentVersions[snapshot.relativePath] ?? null])),
        afterVersions: Object.fromEntries(snapshots.map(snapshot => [snapshot.relativePath, targetOperation.beforeVersions[snapshot.relativePath] === null ? '' : sha256(snapshot.before)])),
        diffSummary: `撤销「${targetOperation.diffSummary.slice(0, 120)}」`,
      };
      await store.commitJournal(entry.entry, record, []);
      return record;
      });
    },
  };
}

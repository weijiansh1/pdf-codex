import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';

/** Shared workspace-side storage helpers for the report service. */
export const WORKSPACE_DIR_NAME = '.latex-workspace';

export type WorkspaceLayout = {
  root: string;
  dir: string;
  config: string;
  registry: string;
  contexts: string;
  history: string;
  builds: string;
  runtime: string;
  diagnostics: string;
  edits: string;
  operations: string;
  locks: string;
  service: string;
};

export function workspaceLayout(root: string): WorkspaceLayout {
  const dir = path.join(root, WORKSPACE_DIR_NAME);
  const runtime = path.join(dir, 'runtime');
  return {
    root,
    dir,
    config: path.join(dir, 'config.json'),
    registry: path.join(dir, 'reports.json'),
    contexts: path.join(dir, 'contexts'),
    history: path.join(dir, 'history'),
    builds: path.join(dir, 'builds'),
    runtime,
    diagnostics: path.join(dir, 'diagnostics'),
    edits: path.join(dir, 'edits'),
    operations: path.join(dir, 'operations'),
    locks: path.join(runtime, 'locks'),
    service: path.join(runtime, 'service.json'),
  };
}

export async function ensureLayout(layout: WorkspaceLayout): Promise<void> {
  for (const directory of [layout.dir, layout.contexts, layout.history, layout.builds, layout.runtime, layout.diagnostics, layout.edits, layout.operations, layout.locks]) {
    const info = await lstat(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error(`工作台存储目录必须是实际目录：${directory}`);
    await mkdir(directory, { recursive: true });
  }
}

export function newId(): string {
  return randomUUID();
}

export function shortId(id: string): string {
  return id.replaceAll('-', '').slice(0, 8);
}

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export type JsonReadResult<T> = { state: 'ok'; value: T } | { state: 'missing' } | { state: 'corrupt'; raw: string };

/** Reads JSON without hiding corruption: callers decide whether to rebuild or fail. */
export async function readJsonState<T>(file: string): Promise<JsonReadResult<T>> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    throw error;
  }
  try {
    return { state: 'ok', value: JSON.parse(raw) as T };
  } catch {
    return { state: 'corrupt', raw };
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  const result = await readJsonState<T>(file);
  return result.state === 'ok' ? result.value : null;
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

export async function writeBytesAtomic(file: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}

const RETRY_DELAYS_MS = [100, 250, 500] as const;
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Same-directory temporary write followed by rename, with the bounded retry the plan
 * requires for Windows file locks. Never deletes the original to force a replace.
 */
export async function replaceFileWithRetry(file: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      const retryDelay = RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined || !RETRYABLE_CODES.has(code)) {
        await rm(temporary, { force: true });
        throw error;
      }
      await delay(retryDelay);
    }
  }
}

/** Serializes work per key (report path, report id) inside the single service process. */
export class KeyedMutex {
  private readonly queues = new Map<string, Promise<unknown>>();
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(key, next.then(() => undefined, () => undefined));
    return next;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** One durable record per idempotent client operation; retries must return the first result. */
export type OperationLedgerRecord = { operationId: string; kind: string; reportId?: string; createdAt: string; [key: string]: unknown };

export async function readLedger(layout: WorkspaceLayout, operationId: string, kind: string): Promise<OperationLedgerRecord | null> {
  const record = await readJson<OperationLedgerRecord>(path.join(layout.operations, `${operationId}.json`));
  return record && record.kind === kind && record.operationId === operationId ? record : null;
}

export async function writeLedger(layout: WorkspaceLayout, record: OperationLedgerRecord): Promise<void> {
  await writeJsonAtomic(path.join(layout.operations, `${record.operationId}.json`), record);
}

export async function listLedger(layout: WorkspaceLayout, kind: string): Promise<OperationLedgerRecord[]> {
  let names: string[];
  try {
    names = await readdir(path.join(layout.operations));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: OperationLedgerRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = await readJson<OperationLedgerRecord>(path.join(layout.operations, name));
    if (record?.kind === kind) records.push(record);
  }
  return records;
}

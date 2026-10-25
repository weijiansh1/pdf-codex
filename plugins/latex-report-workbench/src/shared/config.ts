export const DEFAULTS = Object.freeze({ protocolVersion: 1, schemaVersion: 1, host: '127.0.0.1', port: 4317,
  outlineDebounceMs: 300, saveDebounceMs: 800, compileDebounceMs: 800, contextDebounceMs: 150,
  maxTextBytes: 2_097_152, maxBuildInputBytes: 209_715_200, maxPdfBytes: 33_554_432, assetChunkBytes: 262_144,
  compileTimeoutMs: 120_000, maxCompileTimeoutMs: 600_000, maxConcurrentBuilds: 1, historyDays: 30,
  minHistoryOperations: 20, retainedSuccessfulBuilds: 5, retainedFailedBuilds: 3, idleShutdownMs: 600_000,
  sessionHeartbeatMs: 30_000, maxContextCharacters: 2000, maxAutomaticRepairRounds: 3, maxTreeDepth: 32, maxFiles: 5000,
});
export const PRIVATE_DIRECTORIES = new Set(['.git', 'node_modules', '.latex-workspace', 'exports', '.build']);
export const INTERMEDIATE_FILE = /\.(aux|bcf|blg|fdb_latexmk|fls|log|synctex(?:\.gz)?|toc|xdv)$/i;
export type WorkspaceLimits = { readonly [K in keyof typeof DEFAULTS]: (typeof DEFAULTS)[K] extends number ? number : string };
export type WorkspaceConfig = { schemaVersion: 1; workspaceId: string; root: string; defaultTemplateId: string; limits: WorkspaceLimits };
export type ReportSettings = { compileTimeoutMs: number; autoCompile: boolean; layout: 'pdf-first' | 'split'; bibliography: 'auto' | 'bibtex' | 'biber' | 'none' };

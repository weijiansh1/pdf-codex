export const ERROR_CODES = ['INVALID_INPUT', 'GENERATED_OUTPUT_READ_ONLY', 'INTERNAL_ERROR', 'FEATURE_NOT_IMPLEMENTED', 'REPORT_NOT_FOUND', 'INVALID_REPORT_CONFIG', 'ROOT_MISMATCH', 'PATH_OUTSIDE_WORKSPACE', 'UNSUPPORTED_ENCODING', 'FILE_NOT_FOUND', 'FILE_TOO_LARGE', 'FILE_VERSION_CONFLICT', 'SELECTION_STALE', 'SELECTION_AMBIGUOUS', 'CONTEXT_NOT_BOUND', 'HOST_FEATURE_UNAVAILABLE', 'BUILD_FAILED', 'BUILD_TIMEOUT', 'SYNCTEX_NOT_FOUND', 'ASSET_TOO_LARGE', 'OPERATION_ALREADY_APPLIED', 'PDF_TEXT_NOT_REVERSIBLE', 'PDF_EDIT_SESSION_STALE', 'PROTECTED_TOKEN_CHANGED', 'PDF_EDIT_NOT_SUPPORTED', 'UNAUTHORIZED'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type ErrorEnvelope = { code: ErrorCode; message: string; retryable: boolean; details?: Record<string, unknown> };
export class WorkbenchError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly retryable = false, public readonly details?: Record<string, unknown>) { super(message); this.name = 'WorkbenchError'; }
}
export function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof WorkbenchError) return { code: error.code, message: error.message, retryable: error.retryable, ...(error.details ? { details: error.details } : {}) };
  return { code: 'INTERNAL_ERROR', message: '操作失败，请查看本地诊断。', retryable: false };
}
export function notImplemented(feature: string): never { throw new WorkbenchError('FEATURE_NOT_IMPLEMENTED', `${feature}已定义接口，尚未实现。`, false, { feature }); }

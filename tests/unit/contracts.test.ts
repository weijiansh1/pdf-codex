import { describe, expect, it } from 'vitest';
import { patchRequestSchema, selectionInputSchema, pdfEditCommitSchema } from '../../plugins/latex-report-workbench/src/shared/contracts.js';
const id = '11111111-1111-4111-8111-111111111111';
const hash = 'a'.repeat(64);
const patch = { reportId: id, contextId: id, operationId: id, scope: 'selection', selectionId: id,
  files: [{ relativePath: 'chapters/绪论.tex', expectedVersion: hash, edits: [{ range: { start: 0, end: 2 }, replacement: '文字' }] }] };
describe('write contracts', () => {
  it('rejects an unbound selection and an unexplained whole-report write', () => {
    expect(patchRequestSchema.safeParse({ ...patch, selectionId: undefined }).success).toBe(false);
    expect(patchRequestSchema.safeParse({ ...patch, scope: 'report' }).success).toBe(false);
    expect(patchRequestSchema.safeParse({ ...patch, scope: 'report', scopeReason: '用户要求统一全篇术语' }).success).toBe(true);
  });
  it('rejects overlapping edits, traversal and reversed UTF-16 ranges', () => {
    expect(patchRequestSchema.safeParse({ ...patch, files: [{ ...patch.files[0], edits: [patch.files[0]!.edits[0], { range: { start: 1, end: 3 }, replacement: '' }] }] }).success).toBe(false);
    expect(patchRequestSchema.safeParse({ ...patch, files: [{ ...patch.files[0], relativePath: '../other.tex' }] }).success).toBe(false);
    expect(patchRequestSchema.safeParse({ ...patch, files: [{ ...patch.files[0], edits: [{ range: { start: 3, end: 1 }, replacement: '' }] }] }).success).toBe(false);
  });
  it('requires a build identity for a PDF selection', () => {
    const input = { reportId: id, contextId: id, viewId: id, kind: 'pdf-text', candidateTargets: [] };
    expect(selectionInputSchema.safeParse(input).success).toBe(false);
    expect(selectionInputSchema.safeParse({ ...input, buildId: id }).success).toBe(true);
  });
  it('does not accept source offsets or duplicate runs from a PDF editor', () => {
    const input = { editSessionId: id, contextId: id, operationId: id, expectedFileVersion: hash, projectionVersion: hash, changes: [{ runId: id, text: '100%' }] };
    expect(pdfEditCommitSchema.safeParse(input).success).toBe(true);
    expect(pdfEditCommitSchema.safeParse({ ...input, sourceRange: { start: 0, end: 100 } }).success).toBe(false);
    expect(pdfEditCommitSchema.safeParse({ ...input, changes: [...input.changes, ...input.changes] }).success).toBe(false);
  });
});

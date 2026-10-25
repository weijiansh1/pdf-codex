import { expect, it } from 'vitest';
import { decodeText } from '../../plugins/latex-report-workbench/src/server/files.js';
it('keeps a raw-byte hash while normalizing Chinese, BOM, CRLF and emoji', () => {
  const raw = Buffer.from('\uFEFF第一段\r\n😀文字\r\n');
  const result = decodeText('中文.tex', raw);
  expect(result.text).toBe('第一段\n😀文字\n');
  expect(result.bom).toBe(true);
  expect(result.eol).toBe('crlf');
  expect(result.fileVersion).toMatch(/^[a-f0-9]{64}$/);
  expect(result.fileVersion).not.toBe(decodeText('中文.tex', Buffer.from(result.text)).fileVersion);
});
it('rejects invalid UTF-8 and recognises mixed line endings', () => {
  expect(() => decodeText('旧稿.tex', Buffer.from([0xc0, 0xaf]))).toThrow();
  expect(decodeText('混合.tex', Buffer.from('甲\r\n乙\n')).eol).toBe('mixed');
});

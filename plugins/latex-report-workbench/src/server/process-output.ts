/** Native TeX Live tools on Chinese Windows can emit ACP/GBK instead of UTF-8. */
export function decodeProcessOutput(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder(process.platform === 'win32' ? 'gb18030' : 'utf-8').decode(bytes); }
}

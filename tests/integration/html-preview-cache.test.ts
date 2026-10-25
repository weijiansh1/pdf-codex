import { expect, it, vi } from 'vitest';
import { readFile, writeFile, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../helpers/workspace.js';

it('reuses preview resources but invalidates images even when size and mtime are preserved', async () => {
  const f = await fixture();
  try {
    const config = JSON.parse(await readFile(path.join(f.reportRoot, '.latex-report.json'), 'utf8'));
    await writeFile(path.join(f.reportRoot, '.latex-report.json'), JSON.stringify({ ...config, mainFile: 'main.html' }));
    await writeFile(path.join(f.reportRoot, 'main.html'), '<p>结果</p><img src="chart.svg">');
    const file = path.join(f.reportRoot, 'chart.svg');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="50" height="30" fill="red"/></svg>';
    await writeFile(file, svg);
    const spy = vi.spyOn(f.app.workspace, 'getReport');
    try {
      const first = await f.app.call('report_preview', { reportId: f.reportId });
      spy.mockClear();
      const second = await f.app.call('report_preview', { reportId: f.reportId });
      expect(second.html).toBe(first.html);
      expect(spy).toHaveBeenCalledTimes(1); // One authoritative revision scan for unchanged input.
      const old = await stat(file);
      await writeFile(file, svg.replace('red', 'tan')); await utimes(file, old.atime, old.mtime);
      const third = await f.app.call('report_preview', { reportId: f.reportId });
      expect(third.assets['chart.svg']).not.toBe(first.assets['chart.svg']);
    } finally { spy.mockRestore(); }
  } finally { await f.close(); }
});

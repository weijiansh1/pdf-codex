import { expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fixture } from '../helpers/workspace.js';
import { selectionImage } from '../../plugins/latex-report-workbench/src/server/selection-image.js';
import type { Compiler } from '../../plugins/latex-report-workbench/src/server/compiler.js';
import type { BuildManifest } from '../../plugins/latex-report-workbench/src/shared/contracts.js';

function rotatedPdf(): Buffer {
  const stream = '1 0 0 rg 0 50 100 50 re f';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Rotate 90 /Resources << >> /Contents 4 0 R >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

it('crops the actual rotated build page and rejects rectangles outside its bounds', async () => {
  const f = await fixture();
  try {
    const buildId = randomUUID(), assetId = randomUUID(); const pdf = rotatedPdf();
    const build = (f.app.services.compiler as Compiler).pathsFor(f.reportId, buildId);
    await mkdir(build.out, { recursive: true }); await writeFile(path.join(build.out, 'main.pdf'), pdf);
    const manifest: BuildManifest = { protocolVersion: 1, reportId: f.reportId, buildId, status: 'succeeded', reportRevision: 'a'.repeat(64), inputPaths: {}, inputVersions: {}, diagnostics: [], assets: { [assetId]: { assetId, kind: 'pdf', fileName: 'out/main.pdf', bytes: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex') } } };
    await writeFile(build.manifest, JSON.stringify(manifest));
    const { selection } = await f.app.call('selection_set', { reportId: f.reportId, contextId: f.contextId, viewId: f.viewId, kind: 'pdf-region', buildId, pdfRegion: { page: 1, rect: [0, 0, 100, 50] }, candidateTargets: [] });
    const [image] = await selectionImage(f.app, selection); const png = Buffer.from(image!.data, 'base64');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([75, 150]);
    const expected = path.join(f.root, 'expected-region');
    await promisify(execFile)('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-png', '-r', '108', '-x', '75', '-y', '0', '-W', '75', '-H', '150', path.join(build.out, 'main.pdf'), expected], { shell: false, windowsHide: true });
    expect(png.equals(await readFile(`${expected}.png`))).toBe(true);
    await expect(selectionImage(f.app, { ...selection, pdfRegion: { page: 1, rect: [0, 0, 300, 100] } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  } finally { await f.close(); }
});

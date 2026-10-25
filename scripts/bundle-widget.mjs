import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('plugins/latex-report-workbench/dist/ui');
let html = await readFile(path.join(root, 'index.html'), 'utf8');
const replacements = [];
for (const match of [...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g)]) {
  const relative = match[1].replace(/^\//, '');
  if (!relative.startsWith('assets/') || relative.includes('..')) throw new Error('Unexpected script asset');
  const js = await readFile(path.join(root, relative), 'utf8');
  const marker = `<!--BUNDLE_${replacements.length}-->`;
  replacements.push([marker, `<script type="module">${js.replaceAll('</script', '<\\/script')}</script>`]);
  html = html.replace(match[0], marker);
}
for (const match of [...html.matchAll(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/g)]) {
  const relative = match[1].replace(/^\//, '');
  if (!relative.startsWith('assets/') || relative.includes('..')) throw new Error('Unexpected CSS asset');
  const marker = `<!--BUNDLE_${replacements.length}-->`;
  replacements.push([marker, `<style>${await readFile(path.join(root, relative), 'utf8')}</style>`]);
  html = html.replace(match[0], marker);
}
if (/<script[^>]+src=|<link[^>]+href=/.test(html)) throw new Error('Widget still references external assets');
for (const [marker, content] of replacements) html = html.replace(marker, () => content);
await writeFile(path.join(root, 'widget.html'), html);
console.log('Self-contained MCP UI resource built.');

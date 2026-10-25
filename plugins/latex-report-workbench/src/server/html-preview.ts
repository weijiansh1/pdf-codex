import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { HtmlPort, ContextsPort } from '../shared/ports.js';
import type { ToolArguments } from '../shared/contracts.js';
import { escapeHtml, htmlAttribute, htmlBlocks, htmlElements, htmlEditableRuns, isHtmlReport, renderHtmlDocument } from '../shared/html-report.js';
import { WorkbenchError } from '../shared/errors.js';
import { resolveSafePath } from './path-policy.js';
import type { Workspace } from './workspace.js';
import type { FileService } from './files.js';
import type { HistoryStore } from './history.js';
import { sha256 } from './store.js';
import type { HtmlPreview } from '../shared/contracts.js';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
export function createHtmlPreview({ workspace, files, contexts, history }: { workspace: Workspace; files: FileService; contexts: ContextsPort; history: HistoryStore }): HtmlPort {
  const previews = new Map<string, { revision: string; preview: HtmlPreview }>();
  const resources = new Map<string, { value: string; bytes: number }>();
  let cachedBytes = 0;
  async function source(reportId: string) {
    const report = await workspace.getReport(reportId);
    if (!isHtmlReport(report.mainFile)) throw new WorkbenchError('INVALID_INPUT', '当前报告使用 LaTeX，请使用 PDF 预览。');
    return files.readTextFile(reportId, report.mainFile);
  }
  async function target(input: ToolArguments<'html_select'>) {
    await contexts.validateBinding(input);
    const snapshot = await source(input.reportId);
    if (snapshot.fileVersion !== input.expectedVersion) throw new WorkbenchError('FILE_VERSION_CONFLICT', '网页已有新版本，请刷新后重试。', true);
    const block = htmlBlocks(snapshot.text).find(value => value.blockId === input.blockId);
    if (!block) throw new WorkbenchError('INVALID_INPUT', '内容块不存在，请刷新网页预览。');
    return { snapshot, block };
  }
  return {
    async preview(reportId) {
      const started = performance.now();
      const report = await workspace.getReport(reportId);
      if (!isHtmlReport(report.mainFile)) throw new WorkbenchError('INVALID_INPUT', '当前报告使用 LaTeX，请使用 PDF 预览。');
      const cached = previews.get(reportId);
      if (cached?.revision === report.reportRevision) return { ...cached.preview, renderMs: Math.round((performance.now() - started) * 10) / 10 };
      const root = await resolveSafePath(workspace.root, report.rootRelativePath);
      const snapshot = await files.readTextAtRoot(root, report.mainFile);
      const assets: Record<string, string> = {};
      let bytes = 0;
      for (const element of htmlElements(snapshot.text)) {
        const css = element.tagName === 'link' && htmlAttribute(element, 'rel') === 'stylesheet';
        const name = htmlAttribute(element, css ? 'href' : 'src');
        if ((!css && element.tagName !== 'img') || !name || name.startsWith('data:') || /^[a-z]+:|^[/\\]/i.test(name) || Object.hasOwn(assets, name)) continue;
        let pathname: string;
        try { pathname = decodeURIComponent(name.split(/[?#]/, 1)[0]!).replaceAll('\\', '/'); }
        catch { throw new WorkbenchError('INVALID_INPUT', '网页资源路径的百分号编码无效。'); }
        if (/^[a-z]+:|^\//i.test(pathname)) throw new WorkbenchError('PATH_OUTSIDE_WORKSPACE', '网页资源必须在报告目录内。');
        const relative = path.posix.join(path.posix.dirname(snapshot.relativePath.replaceAll('\\', '/')), pathname);
        const mime = MIME[path.extname(pathname).toLowerCase()];
        if (!mime && !(css && /\.css$/i.test(pathname))) continue;
        const file = await resolveSafePath(root, relative);
        const size = (await stat(file)).size;
        bytes += size;
        if (size > 5_242_880 || bytes > 16_777_216) throw new WorkbenchError('ASSET_TOO_LARGE', '网页预览图片总量超过 16 MiB 或单张超过 5 MiB。');
        const version = workspace.scannedVersion(root, report.reportRevision, relative);
        const cacheKey = `${file}:${version}:${css ? 'css' : mime}`;
        const resource = version ? resources.get(cacheKey) : undefined;
        if (resource) assets[name] = resource.value;
        else {
          const raw = await readFile(file);
          if (raw.length !== size || raw.length > 5_242_880 || (version && sha256(raw) !== version)) throw new WorkbenchError('FILE_VERSION_CONFLICT', '网页资源在读取期间发生变化，请刷新。', true);
          const value = css ? raw.toString('utf8') : `data:${mime};base64,${raw.toString('base64')}`;
          assets[name] = value;
          if (version) { const bytes = Buffer.byteLength(value); resources.set(cacheKey, { value, bytes }); cachedBytes += bytes; }
          while (cachedBytes > 32 * 1024 * 1024) { const key = resources.keys().next().value!; cachedBytes -= resources.get(key)!.bytes; resources.delete(key); }
        }
      }
      if ((await workspace.getReport(reportId)).reportRevision !== report.reportRevision) throw new WorkbenchError('FILE_VERSION_CONFLICT', '读取预览时原稿或资源已更新，请刷新。', true);
      const rendered = renderHtmlDocument(snapshot.text, assets);
      const { generatedFrom } = report;
      const preview = { reportId, relativePath: snapshot.relativePath, ...(generatedFrom ? { generatedFrom } : {}), fileVersion: snapshot.fileVersion, text: snapshot.text, ...rendered, assets, renderMs: Math.round((performance.now() - started) * 10) / 10 };
      previews.delete(reportId); previews.set(reportId, { revision: report.reportRevision, preview });
      while (previews.size > 4) previews.delete(previews.keys().next().value!);
      return preview;
    },
    async select(input) {
      const { snapshot, block } = await target(input);
      return { selection: await contexts.setSelection({ reportId: input.reportId, contextId: input.contextId, viewId: input.viewId, kind: 'source', selectedText: block.text, candidateTargets: [{ relativePath: snapshot.relativePath, range: block.range, expectedVersion: snapshot.fileVersion }] }) };
    },
    async edit(input) {
      await contexts.validateBinding(input);
      const existing = await history.getOperation(input.reportId, input.operationId);
      if (existing) return { operation: existing, buildId: null };
      const { snapshot, block } = await target(input);
      const node = htmlElements(snapshot.text).find(node => node.sourceCodeLocation?.startOffset === block.range.start)!;
      let edits: { range: { start: number; end: number }; replacement: string }[];
      if (input.formula !== undefined) {
        const attr = node.sourceCodeLocation?.attrs?.['data-tex'];
        if (block.formula === undefined || !attr) throw new WorkbenchError('INVALID_INPUT', '只有显式 data-tex 公式可以使用公式编辑。');
        edits = [{ range: { start: attr.startOffset, end: attr.endOffset }, replacement: `data-tex="${escapeHtml(input.formula)}"` }];
      } else if (input.changes) {
        const runs = htmlEditableRuns(node);
        if (!block.editable || new Set(input.changes.map(change => change.runId)).size !== input.changes.length) throw new WorkbenchError('INVALID_INPUT', '文本节点不可编辑或重复。');
        edits = input.changes.flatMap(change => {
          const run = runs.find(run => run.runId === change.runId);
          if (!run) throw new WorkbenchError('INVALID_INPUT', '文本节点不存在或属于受保护结构，请刷新。');
          return run.text === change.text ? [] : [{ range: run.range, replacement: escapeHtml(change.text) }];
        });
      } else {
        if (!block.editable || !node.childNodes.every(child => child.nodeName === '#text')) throw new WorkbenchError('INVALID_INPUT', '富文本请按可编辑文字节点修改，以保留公式、格式和引用。');
        edits = [{ range: block.contentRange, replacement: escapeHtml(input.text!) }];
      }
      const operation = await files.applyPatchInternal({ reportId: input.reportId, contextId: input.contextId, scope: 'report', scopeReason: '用户在网页预览中修改指定文字块', operationId: input.operationId,
        files: [{ relativePath: snapshot.relativePath, expectedVersion: snapshot.fileVersion, edits }] }, 'source-editor');
      return { operation, buildId: null };
    },
  };
}

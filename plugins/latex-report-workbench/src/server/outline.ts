import path from 'node:path';
import type { Diagnostic, FileSnapshot, OutlineNode, OutlineResult, SourceTarget } from '../shared/contracts.js';
import { DEFAULTS } from '../shared/config.js';
import { WorkbenchError } from '../shared/errors.js';
import type { FilesPort, OutlinePort } from '../shared/ports.js';
import { normalizeRelativePath } from './path-policy.js';
import type { Workspace } from './workspace.js';
import { htmlBlocks, isHtmlReport } from '../shared/html-report.js';

const HEADING_LEVELS: Record<string, number> = { part: 1, chapter: 2, section: 3, subsection: 4, subsubsection: 5 };
const SKIP_ENVIRONMENTS = new Set(['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment', 'filecontents', 'filecontents*']);
const FORMAT_ONLY_COMMANDS = new Set(['textbf', 'textit', 'textsl', 'textrm', 'textsf', 'texttt', 'textsc', 'emph', 'mbox', 'hbox', 'textup', 'textmd', 'textnormal', 'protect', 'thanks']);
const ANCHOR_LENGTH = 120;

export type HeadingEvent = {
  kind: 'heading';
  name: string;
  level: number;
  star: boolean;
  title: string;
  titleRange: { start: number; end: number };
  commandRange: { start: number; end: number };
};
export type IncludeEvent = { kind: 'include'; command: 'input' | 'include'; target: string; range: { start: number; end: number } };
export type ScanEvent = HeadingEvent | IncludeEvent;

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function skipComment(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && text[cursor] !== '\n') cursor += 1;
  return cursor;
}

function readGroup(text: string, start: number): { content: string; contentStart: number; contentEnd: number; next: number } | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  for (let cursor = start; cursor < text.length; cursor += 1) {
    const character = text[cursor]!;
    if (character === '\\') {
      cursor += 1;
      continue;
    }
    if (character === '%' && !isEscaped(text, cursor)) {
      cursor = skipComment(text, cursor) - 1;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return { content: text.slice(start + 1, cursor), contentStart: start + 1, contentEnd: cursor, next: cursor + 1 };
    }
  }
  return null;
}

function skipOptionalArgument(text: string, start: number): number {
  if (text[start] !== '[') return start;
  let depth = 0;
  for (let cursor = start; cursor < text.length; cursor += 1) {
    const character = text[cursor]!;
    if (character === '\\') {
      cursor += 1;
      continue;
    }
    if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return start;
}

/** Small lexical scanner: understands comments, escapes, groups and verbatim-like environments. */
export function scanTex(text: string): { events: ScanEvent[]; diagnostics: Diagnostic[]; includeOnly: string[] } {
  const events: ScanEvent[] = [];
  const diagnostics: Diagnostic[] = [];
  const includeOnly: string[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (character === '%' && !isEscaped(text, index)) {
      index = skipComment(text, index);
      continue;
    }
    if (character !== '\\') {
      index += 1;
      continue;
    }
    const commandStart = index;
    let cursor = index + 1;
    let name = '';
    while (cursor < text.length && /[A-Za-z@]/.test(text[cursor]!)) {
      name += text[cursor];
      cursor += 1;
    }
    if (!name) {
      index += 1;
      continue;
    }
    if (name === 'begin') {
      const group = readGroup(text, cursor);
      if (group && SKIP_ENVIRONMENTS.has(group.content.trim())) {
        const environment = group.content.trim();
        const closing = text.indexOf(`\\end{${environment}}`, group.next);
        if (closing < 0) {
          diagnostics.push({ severity: 'warning', code: 'OUTLINE_UNCLOSED_ENVIRONMENT', message: `环境 ${environment} 没有找到结束标记，后续内容按原样扫描。` });
        } else {
          index = closing + `\\end{${environment}}`.length;
          continue;
        }
      }
      index = group ? group.next : cursor;
      continue;
    }
    const star = text[cursor] === '*';
    const afterStar = star ? cursor + 1 : cursor;
    if (name === 'includeonly') {
      const group = readGroup(text, afterStar);
      if (group) includeOnly.push(...group.content.split(',').map(value => value.trim()).filter(Boolean));
      index = group ? group.next : afterStar;
      continue;
    }
    const level = HEADING_LEVELS[name];
    if (level) {
      const titleStart = skipOptionalArgument(text, afterStar);
      const group = readGroup(text, titleStart);
      if (group) {
        events.push({ kind: 'heading', name, level, star, title: group.content, titleRange: { start: group.contentStart, end: group.contentEnd }, commandRange: { start: commandStart, end: group.next } });
        index = group.next;
        continue;
      }
      diagnostics.push({ severity: 'warning', code: 'OUTLINE_HEADING_WITHOUT_TITLE', message: `\\${name} 缺少标题参数，已跳过。` });
      index = afterStar;
      continue;
    }
    if (name === 'input' || name === 'include') {
      const group = readGroup(text, afterStar);
      if (group) {
        events.push({ kind: 'include', command: name, target: group.content.trim(), range: { start: commandStart, end: group.next } });
        index = group.next;
        continue;
      }
    }
    index = cursor;
  }
  return { events, diagnostics, includeOnly };
}

const DISPLAY_WRAPPERS = new Set(['textbf', 'textit', 'textsl', 'textrm', 'textsf', 'texttt', 'textsc', 'emph', 'textup', 'textmd', 'textnormal', 'mbox', 'hbox']);

/** Turns a heading into display text without pretending to be a full TeX interpreter. */
export function displayTitle(raw: string): { title: string; macroGenerated: boolean } {
  let macroGenerated = false;
  let text = raw;
  // \texorpdfstring{display}{bookmark}
  text = text.replaceAll(/\\texorpdfstring\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, (_match, display: string) => display);
  for (let round = 0; round < 6; round += 1) {
    const before = text;
    text = text.replaceAll(new RegExp(String.raw`\\(${[...DISPLAY_WRAPPERS].join('|')})\s*\{([^{}]*)\}`, 'g'), (_match, _name: string, inner: string) => inner);
    if (text === before) break;
  }
  for (const match of text.matchAll(/\\([A-Za-z@]+)/g)) {
    const name = match[1]!;
    if (!FORMAT_ONLY_COMMANDS.has(name)) macroGenerated = true;
  }
  text = text.replaceAll('~', ' ').replaceAll('\\,', ' ').replaceAll('\\ ', ' ').replaceAll('\\\\', ' ').replaceAll(/--+/g, '—').replaceAll(/\s+/g, ' ').trim();
  if (macroGenerated) return { title: text || raw, macroGenerated: true };
  return { title: text, macroGenerated: false };
}

function findLabel(text: string, from: number): string | undefined {
  const window = text.slice(from, from + 240);
  const match = /^\s*\\label\s*\{([^{}]*)\}/.exec(window);
  return match?.[1];
}

type Segment = { relativePath: string; text: string; fileVersion: string; startOffsetInReading: number };
type HeadingRef = { segmentIndex: number; event: HeadingEvent; ordinalInFile: number; label?: string; display: string; macroGenerated: boolean };

export type OutlineDependencies = { workspace: Workspace; files: FilesPort };

export function createOutline(dependencies: OutlineDependencies): OutlinePort {
  return {
    async buildOutline(reportId: string): Promise<OutlineResult> {
      const report = await dependencies.workspace.getReport(reportId);
      if (isHtmlReport(report.mainFile)) {
        const snapshot = await dependencies.files.readTextFile(reportId, report.mainFile);
        const headings = htmlBlocks(snapshot.text).filter(block => block.level);
        const nodes: OutlineNode[] = [];
        const stack: OutlineNode[] = [];
        headings.forEach((heading, index) => {
          const end = headings.slice(index + 1).find(next => next.level! <= heading.level!)?.range.start ?? snapshot.text.length;
          const range = { start: heading.range.start, end };
          const node: OutlineNode = { nodeId: `html:${heading.blockId}`, title: heading.text, level: heading.level!, relativePath: snapshot.relativePath, headingRange: heading.range,
            bodySpans: [{ relativePath: snapshot.relativePath, range, fileVersion: snapshot.fileVersion, exactText: snapshot.text.slice(range.start, range.end), prefix: snapshot.text.slice(Math.max(0, range.start - 120), range.start), suffix: snapshot.text.slice(range.end, range.end + 120) }], children: [], warnings: [] };
          while (stack.length && stack.at(-1)!.level >= node.level) stack.pop();
          if (stack.length) stack.at(-1)!.children.push(node); else nodes.push(node);
          stack.push(node);
        });
        return { nodes, diagnostics: [] };
      }
      const diagnostics: Diagnostic[] = [];
      const snapshots = new Map<string, FileSnapshot>();
      const segments: Segment[] = [];
      const headings: HeadingRef[] = [];
      const visitedStack: string[] = [];
      const includeOnly = new Set<string>();
      let filesRead = 0;
      const readFile = async (relativePath: string): Promise<FileSnapshot | null> => {
        const normalized = normalizeRelativePath(relativePath);
        const cached = snapshots.get(normalized);
        if (cached) return cached;
        if (++filesRead > DEFAULTS.maxFiles) throw new WorkbenchError('FILE_TOO_LARGE', '章节索引文件数超过上限。');
        try {
          const snapshot = await dependencies.files.readTextFile(reportId, normalized);
          snapshots.set(normalized, snapshot);
          return snapshot;
        } catch (error) {
          if (error instanceof WorkbenchError && (error.code === 'FILE_NOT_FOUND' || error.code === 'UNSUPPORTED_ENCODING')) {
            diagnostics.push({ severity: 'warning', code: 'OUTLINE_INCLUDE_MISSING', message: `无法读取 ${normalized}：${error.message}`, relativePath: normalized });
            return null;
          }
          throw error;
        }
      };
      const visit = async (relativePath: string, depth: number): Promise<void> => {
        if (depth > 32) {
          diagnostics.push({ severity: 'warning', code: 'OUTLINE_DEPTH_LIMIT', message: `include 深度超过上限，${relativePath} 未展开。`, relativePath });
          return;
        }
        const snapshot = await readFile(relativePath);
        if (!snapshot) return;
        if (visitedStack.includes(snapshot.relativePath)) {
          diagnostics.push({ severity: 'warning', code: 'OUTLINE_INCLUDE_CYCLE', message: `检测到 include 循环：${[...visitedStack, snapshot.relativePath].join(' → ')}`, relativePath: snapshot.relativePath });
          return;
        }
        visitedStack.push(snapshot.relativePath);
        const segmentIndex = segments.push({ relativePath: snapshot.relativePath, text: snapshot.text, fileVersion: snapshot.fileVersion, startOffsetInReading: 0 }) - 1;
        const { events, diagnostics: scanDiagnostics, includeOnly: localIncludeOnly } = scanTex(snapshot.text);
        for (const file of localIncludeOnly) includeOnly.add(normalizeRelativePath(file));
        for (const diagnostic of scanDiagnostics) diagnostics.push({ ...diagnostic, relativePath: snapshot.relativePath });
        let ordinal = 0;
        for (const event of events) {
          if (event.kind === 'heading') {
            const { title, macroGenerated } = displayTitle(event.title);
            const label = findLabel(snapshot.text, event.commandRange.end);
            headings.push({ segmentIndex, event, ordinalInFile: ordinal, display: title || '（空标题）', macroGenerated, ...(label === undefined ? {} : { label }) });
            ordinal += 1;
            if (macroGenerated) diagnostics.push({ severity: 'info', code: 'OUTLINE_MACRO_TITLE', message: `标题包含宏，显示可能不完整：${event.title}`, relativePath: snapshot.relativePath });
            continue;
          }
          const target = event.target;
          if (!target || /[\\{}$]/.test(target)) {
            diagnostics.push({ severity: 'warning', code: 'OUTLINE_DYNAMIC_INCLUDE', message: `\\${event.command}{${target}} 不是静态文件名，未展开。`, relativePath: snapshot.relativePath });
            continue;
          }
          const base = path.posix.dirname(snapshot.relativePath);
          const resolved = normalizeRelativePath(target.endsWith('.tex') ? target : `${target}.tex`);
          const finalPath = normalizeRelativePath(base === '.' ? resolved : path.posix.join(base, resolved));
          if (!finalPath.startsWith('../') && finalPath !== '..') await visit(finalPath, depth + 1);
          else diagnostics.push({ severity: 'warning', code: 'OUTLINE_INCLUDE_OUTSIDE', message: `\\${event.command} 目标超出报告范围，未展开。`, relativePath: snapshot.relativePath });
        }
        visitedStack.pop();
      };
      await visit(normalizeRelativePath(report.mainFile), 0);
      // Body spans run from the end of a heading to the next heading of the same or higher level.
      const nodes: OutlineNode[] = [];
      const stack: OutlineNode[] = [];
      const flat: OutlineNode[] = [];
      for (const heading of headings) {
        const nodeId = heading.label
          ? `${heading.event.commandRange.start}::${segments[heading.segmentIndex]!.relativePath}#${heading.label}`
          : `${segments[heading.segmentIndex]!.relativePath}#h${heading.event.level}-${heading.ordinalInFile}`;
        const node: OutlineNode = {
          nodeId,
          title: heading.display,
          level: heading.event.level,
          relativePath: segments[heading.segmentIndex]!.relativePath,
          headingRange: heading.event.titleRange,
          bodySpans: [],
          children: [],
          warnings: [],
          ...(heading.label === undefined ? {} : { label: heading.label }),
        };
        while (stack.length && stack[stack.length - 1]!.level >= node.level) stack.pop();
        const parent = stack[stack.length - 1];
        if (parent) parent.children.push(node);
        else nodes.push(node);
        stack.push(node);
        flat.push(node);
      }
      const bodyRanges: { node: OutlineNode; start: { segment: number; offset: number }; end: { segment: number; offset: number } }[] = [];
      for (const [index, heading] of headings.entries()) {
        const node = flat[index]!;
        let end = { segment: segments.length - 1, offset: segments[segments.length - 1]!.text.length };
        for (let cursor = index + 1; cursor < headings.length; cursor += 1) {
          const next = headings[cursor]!;
          if (next.event.level <= heading.event.level) {
            end = { segment: next.segmentIndex, offset: next.event.commandRange.start };
            break;
          }
        }
        bodyRanges.push({ node, start: { segment: heading.segmentIndex, offset: heading.event.commandRange.end }, end });
      }
      for (const range of bodyRanges) {
        range.node.bodySpans = spansFor(range.start, range.end, segments);
      }
      if (includeOnly.size) {
        const mainRelative = normalizeRelativePath(report.mainFile);
        for (const file of includeOnly) {
          if (file !== mainRelative) diagnostics.push({ severity: 'info', code: 'OUTLINE_INCLUDEONLY', message: `\\includeonly 可能使 ${file} 未参与当前编译。`, relativePath: file });
        }
      }
      return { nodes, diagnostics };
    },
  };
}

function spansFor(
  start: { segment: number; offset: number },
  end: { segment: number; offset: number },
  segments: Segment[],
): SourceTarget[] {
  const spans: SourceTarget[] = [];
  if (!segments.length) return spans;
  const push = (segmentIndex: number, from: number, to: number) => {
    const segment = segments[segmentIndex];
    if (!segment) return;
    const clampedFrom = Math.max(0, Math.min(from, segment.text.length));
    const clampedTo = Math.max(clampedFrom, Math.min(to, segment.text.length));
    if (clampedTo <= clampedFrom && !(clampedTo === clampedFrom && segments.length === 1)) return;
    spans.push({
      relativePath: segment.relativePath,
      range: { start: clampedFrom, end: clampedTo },
      fileVersion: segment.fileVersion,
      exactText: segment.text.slice(clampedFrom, clampedTo),
      prefix: segment.text.slice(Math.max(0, clampedFrom - ANCHOR_LENGTH), clampedFrom),
      suffix: segment.text.slice(clampedTo, Math.min(segment.text.length, clampedTo + ANCHOR_LENGTH)),
    });
  };
  if (start.segment === end.segment) push(start.segment, start.offset, end.offset);
  else {
    push(start.segment, start.offset, segments[start.segment]?.text.length ?? 0);
    for (let cursor = start.segment + 1; cursor < end.segment; cursor += 1) push(cursor, 0, segments[cursor]?.text.length ?? 0);
    push(end.segment, 0, end.offset);
  }
  return spans;
}

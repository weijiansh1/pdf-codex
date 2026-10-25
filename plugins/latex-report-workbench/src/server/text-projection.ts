import type { Diagnostic, FileSnapshot, TextProjection, TextProjectionRun, TextRange } from '../shared/contracts.js';
import { WorkbenchError } from '../shared/errors.js';
import type { TextProjectionPort } from '../shared/ports.js';
import { sha256 } from './store.js';

/** Commands whose braced argument may contain normal editable prose. */
const FORMAT_WRAPPERS = new Set(['textbf', 'textit', 'textsl', 'textrm', 'textsf', 'texttt', 'textsc', 'emph', 'textup', 'textmd', 'textnormal', 'mbox', 'hbox', 'part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'title', 'author']);
/** Commands that must never be touched by leaf text editing. */
const PROTECTED_ARGUMENT_COMMANDS = new Set(['cite', 'citep', 'citet', 'ref', 'eqref', 'pageref', 'autoref', 'label', 'includegraphics', 'url', 'href', 'input', 'include', 'inputminted', 'lstinputlisting', 'footnotemark', 'nbsp', 'hspace', 'vspace', 'index', 'glossary', 'bibliography', 'bibliographystyle', 'documentclass', 'usepackage', 'newcommand', 'renewcommand', 'def', 'let', 'caption', 'begin', 'end', 'item', 'columnwidth']);
const PROTECTED_ENVIRONMENTS = new Set(['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*', 'math', 'displaymath', 'verbatim', 'verbatim*', 'lstlisting', 'minted', 'comment', 'tikzpicture', 'figure', 'figure*', 'table', 'table*', 'algorithm', 'tabular', 'tabular*', 'thebibliography', 'filecontents', 'filecontents*']);
const LITERAL_LETTER_COMMANDS: Record<string, string> = { textbackslash: '\\', textasciitilde: '~', textasciicircum: '^', textless: '<', textgreater: '>', textbar: '|', textbraceleft: '{', textbraceright: '}' };
const LITERAL_SYMBOL_COMMANDS = new Set(['%', '&', '_', '#', '$', '{', '}', ' ', ',', ';', ':', '!']);
/** Dash ligatures and non-breaking space stay untouched so the source keeps its typography. */
const TYPOGRAPHY_TOKENS = ['---', '--', '``', "''", '~'];

export function escapeLatexText(text: string): string {
  let output = '';
  for (const character of text.replaceAll('\r\n', '\n').replaceAll('\n', ' ')) {
    switch (character) {
      case '\\': output += '\\textbackslash{}'; break;
      case '{': output += '\\{'; break;
      case '}': output += '\\}'; break;
      case '$': output += '\\$'; break;
      case '&': output += '\\&'; break;
      case '#': output += '\\#'; break;
      case '^': output += '\\textasciicircum{}'; break;
      case '_': output += '\\_'; break;
      case '%': output += '\\%'; break;
      case '~': output += '\\textasciitilde{}'; break;
      default: output += character;
    }
  }
  return output;
}

export function unescapeLatexText(raw: string): string {
  let output = '';
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (character !== '\\') {
      output += character;
      continue;
    }
    const next = raw[index + 1] ?? '';
    if (LITERAL_SYMBOL_COMMANDS.has(next)) {
      if (next === '\\') { output += '\\'; index += 2; continue; }
      output += next === ' ' || next === ',' || next === ';' || next === ':' || next === '!' ? ' ' : next;
      index += 1;
      continue;
    }
    let name = '';
    let cursor = index + 1;
    while (cursor < raw.length && /[A-Za-z@]/.test(raw[cursor]!)) {
      name += raw[cursor];
      cursor += 1;
    }
    if (name && Object.hasOwn(LITERAL_LETTER_COMMANDS, name)) {
      output += LITERAL_LETTER_COMMANDS[name]!;
      if (raw.startsWith('{}', cursor)) cursor += 2;
      index = cursor - 1;
      continue;
    }
    output += character;
  }
  return output;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function readGroupEnd(text: string, start: number, limit: number): number | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  for (let cursor = start; cursor < limit; cursor += 1) {
    const character = text[cursor]!;
    if (character === '\\') { cursor += 1; continue; }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return null;
}

function readBracketEnd(text: string, start: number, limit: number): number | null {
  if (text[start] !== '[') return null;
  let depth = 0;
  for (let cursor = start; cursor < limit; cursor += 1) {
    const character = text[cursor]!;
    if (character === '\\') { cursor += 1; continue; }
    if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return null;
}

function readCommandName(text: string, start: number, limit: number): { name: string; next: number } {
  if (text[start] === '\\') {
    const symbol = text[start + 1] ?? '';
    if (!/[A-Za-z@]/.test(symbol)) return { name: symbol, next: start + 2 };
  }
  let cursor = start + 1;
  let name = '';
  while (cursor < limit && /[A-Za-z@]/.test(text[cursor]!)) {
    name += text[cursor];
    cursor += 1;
  }
  return { name, next: cursor };
}

type RawRun = { kind: 'editable' | 'protected'; raw: string; start: number; end: number; literal?: string };

type ScanResult = { runs: RawRun[]; reversible: boolean; diagnostics: Diagnostic[] };

/**
 * Splits a source range into untouched protected tokens and editable plain-text runs.
 * The scanner is deliberately small: anything it does not recognise becomes protected text
 * and marks the projection as not reversible instead of guessing.
 */
export function scanProjectionRuns(text: string, range: TextRange): ScanResult {
  const runs: RawRun[] = [];
  const diagnostics: Diagnostic[] = [];
  let reversible = true;
  let editableCharacters = 0;
  const limit = Math.min(range.end, text.length);
  let pendingEditable: { start: number; raw: string; literal: string } | null = null;

  const flush = () => {
    if (!pendingEditable) return;
    runs.push({ kind: 'editable', raw: pendingEditable.raw, start: pendingEditable.start, end: pendingEditable.start + pendingEditable.raw.length, literal: pendingEditable.literal });
    editableCharacters += pendingEditable.raw.length;
    pendingEditable = null;
  };
  const pushEditable = (index: number, raw: string, literal: string) => {
    if (!pendingEditable) pendingEditable = { start: index, raw: '', literal: '' };
    pendingEditable.raw += raw;
    pendingEditable.literal += literal;
  };
  const pushProtected = (start: number, end: number) => {
    flush();
    runs.push({ kind: 'protected', raw: text.slice(start, end), start, end });
  };

  let index = range.start;
  while (index < limit) {
    const character = text[index]!;
    if (character === '%' && !isEscaped(text, index)) {
      let cursor = index;
      while (cursor < limit && text[cursor] !== '\n') cursor += 1;
      pushProtected(index, cursor);
      index = cursor;
      continue;
    }
    if (character === '$') {
      const display = text[index + 1] === '$';
      const delimiter = display ? '$$' : '$';
      let cursor = index + delimiter.length;
      let found = -1;
      while (cursor < limit) {
        if (text[cursor] === '\\') { cursor += 2; continue; }
        if (text.startsWith(delimiter, cursor)) { found = cursor + delimiter.length; break; }
        cursor += 1;
      }
      if (found < 0) {
        reversible = false;
        diagnostics.push({ severity: 'warning', code: 'PROJECTION_UNBALANCED_MATH', message: '公式定界符没有闭合，已按受保护内容处理。' });
        pushProtected(index, limit);
        index = limit;
        break;
      }
      pushProtected(index, found);
      index = found;
      continue;
    }
    if (character === '\\') {
      const { name, next } = readCommandName(text, index, limit);
      if (name === '\\') { pushProtected(index, Math.min(limit, index + 2)); index = Math.min(limit, index + 2); continue; }
      if (name === '(' || name === '[') {
        const closer = name === '(' ? '\\)' : '\\]';
        const found = text.indexOf(closer, next);
        if (found < 0) { reversible = false; diagnostics.push({ severity: 'warning', code: 'PROJECTION_UNBALANCED_MATH', message: '数学环境没有闭合，已按受保护内容处理。' }); pushProtected(index, limit); index = limit; break; }
        pushProtected(index, found + closer.length);
        index = found + closer.length;
        continue;
      }
      if (LITERAL_SYMBOL_COMMANDS.has(name)) { pushEditable(index, text.slice(index, next), name); index = next; continue; }
      if (Object.hasOwn(LITERAL_LETTER_COMMANDS, name)) {
        let cursor = next;
        if (text.startsWith('{}', cursor)) cursor += 2;
        pushEditable(index, text.slice(index, cursor), LITERAL_LETTER_COMMANDS[name]!);
        index = cursor;
        continue;
      }
      if (FORMAT_WRAPPERS.has(name)) {
        let cursor = next;
        if (text[cursor] === '*') cursor += 1;
        while (cursor < limit && /\s/.test(text[cursor]!)) cursor += 1;
        if (text[cursor] === '[') {
          const bracket = readBracketEnd(text, cursor, limit);
          if (bracket === null) { reversible = false; diagnostics.push({ severity: 'warning', code: 'PROJECTION_UNBALANCED_GROUP', message: `\\${name} 的可选参数没有闭合。` }); pushProtected(index, limit); index = limit; break; }
          cursor = bracket;
        }
        const groupEnd = readGroupEnd(text, cursor, limit);
        if (groupEnd === null) { reversible = false; diagnostics.push({ severity: 'warning', code: 'PROJECTION_UNBALANCED_GROUP', message: `\\${name} 的参数没有闭合。` }); pushProtected(index, limit); index = limit; break; }
        pushProtected(index, cursor + 1);
        const inner = scanProjectionRuns(text, { start: cursor + 1, end: groupEnd - 1 });
        runs.push(...inner.runs);
        diagnostics.push(...inner.diagnostics);
        if (!inner.reversible) reversible = false;
        editableCharacters += inner.runs.filter(run => run.kind === 'editable').reduce((sum, run) => sum + run.raw.length, 0);
        pushProtected(groupEnd - 1, groupEnd);
        index = groupEnd;
        continue;
      }
      if (PROTECTED_ARGUMENT_COMMANDS.has(name)) {
        let cursor = next;
        for (let guard = 0; guard < 4; guard += 1) {
          if (text[cursor] === '*') { cursor += 1; continue; }
          if (text[cursor] === '[') {
            const bracket = readBracketEnd(text, cursor, limit);
            if (bracket === null) { reversible = false; break; }
            cursor = bracket;
            continue;
          }
          if (text[cursor] === '{') {
            const groupEnd = readGroupEnd(text, cursor, limit);
            if (groupEnd === null) { reversible = false; break; }
            cursor = groupEnd;
            continue;
          }
          break;
        }
        if (name === 'begin') {
          const groupStart = text.indexOf('{', next);
          const environment = groupStart >= 0 ? text.slice(groupStart + 1, text.indexOf('}', groupStart)) : '';
          if (PROTECTED_ENVIRONMENTS.has(environment)) {
            const closing = `\\end{${environment}}`;
            const closingIndex = text.indexOf(closing, cursor);
            if (closingIndex >= 0) {
              pushProtected(index, closingIndex + closing.length);
              index = closingIndex + closing.length;
              continue;
            }
            reversible = false;
            diagnostics.push({ severity: 'warning', code: 'PROJECTION_UNCLOSED_ENVIRONMENT', message: `环境 ${environment} 没有结束标记，已按受保护内容处理。` });
            pushProtected(index, limit);
            index = limit;
            break;
          }
        }
        pushProtected(index, Math.max(cursor, next));
        index = Math.max(cursor, next);
        continue;
      }
      // Unknown command: keep it visible but never claim reversibility.
      let cursor = next;
      for (let guard = 0; guard < 2; guard += 1) {
        if (text[cursor] === '[') {
          const bracket = readBracketEnd(text, cursor, limit);
          if (bracket === null) break;
          cursor = bracket;
          continue;
        }
        if (text[cursor] === '{') {
          const groupEnd = readGroupEnd(text, cursor, limit);
          if (groupEnd === null) break;
          cursor = groupEnd;
          continue;
        }
        break;
      }
      reversible = false;
      diagnostics.push({ severity: 'warning', code: 'PROJECTION_UNKNOWN_COMMAND', message: `\\${name} 不在可编辑白名单内，只允许阅读或改用源码编辑。` });
      pushProtected(index, Math.max(cursor, next));
      index = Math.max(cursor, next);
      continue;
    }
    if (character === '{' || character === '}') {
      reversible = false;
      diagnostics.push({ severity: 'warning', code: 'PROJECTION_UNBALANCED_GROUP', message: '分组括号不配对，已停止把该范围当作可逆正文。' });
      pushProtected(index, index + 1);
      index += 1;
      continue;
    }
    let typography: string | null = null;
    for (const token of TYPOGRAPHY_TOKENS) {
      if (text.startsWith(token, index) && (token !== '~' || !isEscaped(text, index))) { typography = token; break; }
    }
    if (typography) {
      pushProtected(index, index + typography.length);
      index += typography.length;
      continue;
    }
    pushEditable(index, character, character);
    index += 1;
  }
  flush();
  if (editableCharacters === 0) reversible = false;
  return { runs, reversible, diagnostics };
}

export function projectionVersionOf(fileVersion: string, runs: TextProjectionRun[]): string {
  return sha256(JSON.stringify({ fileVersion, runs: runs.map(run => [run.kind, run.text, run.sourceRange.start, run.sourceRange.end]) }));
}

/** Builds the reversible projection of one source range inside a snapshot. */
export function buildTextProjectionFrom(snapshot: FileSnapshot, sourceRange: TextRange): TextProjection {
  if (sourceRange.start < 0 || sourceRange.end < sourceRange.start || sourceRange.end > snapshot.text.length) throw new WorkbenchError('INVALID_INPUT', '投影范围超出文件内容。', false, { length: snapshot.text.length });
  // SyncTeX returns source lines, which can begin inside a multiline math environment,
  // macro argument or comment. Inspect the enclosing syntax before scanning that line.
  const enclosing = scanProjectionRuns(snapshot.text, { start: 0, end: snapshot.text.length }).runs.find(run => run.kind === 'protected' && run.start < sourceRange.end && run.end > sourceRange.start && (run.start < sourceRange.start || run.end > sourceRange.end));
  if (enclosing) {
    const run: TextProjectionRun = { runId: runIdFor(0, sourceRange, snapshot.text.slice(sourceRange.start, sourceRange.end)), kind: 'protected', text: snapshot.text.slice(sourceRange.start, sourceRange.end), sourceRange, protectedTokenId: `token-${sha256(enclosing.raw).slice(0, 16)}` };
    return { sourceRange, fileVersion: snapshot.fileVersion, projectionVersion: projectionVersionOf(snapshot.fileVersion, [run]), runs: [run], reversible: false, diagnostics: [{ severity: 'warning', code: 'PROJECTION_PROTECTED_CONTEXT', message: '该行位于公式、命令参数或注释内部，请在源码中编辑。' }] };
  }
  const scan = scanProjectionRuns(snapshot.text, sourceRange);
  const runs: TextProjectionRun[] = scan.runs.map((run, index) => {
    const sourceRange0 = { start: run.start, end: run.end };
    const text = run.kind === 'editable' ? unescapeLatexText(run.raw) : run.raw;
    return run.kind === 'editable'
      ? { runId: runIdFor(index, sourceRange0, text), kind: 'editable' as const, text, sourceRange: sourceRange0 }
      : { runId: runIdFor(index, sourceRange0, text), kind: 'protected' as const, text, sourceRange: sourceRange0, protectedTokenId: `token-${sha256(run.raw).slice(0, 16)}` };
  });
  const diagnostics = [...scan.diagnostics];
  if (!scan.reversible && !diagnostics.some(diagnostic => diagnostic.severity === 'warning')) {
    diagnostics.push({ severity: 'info', code: 'PROJECTION_NOT_REVERSIBLE', message: '该范围包含无法安全反向转换的结构，请在源码中编辑。' });
  }
  return { sourceRange, fileVersion: snapshot.fileVersion, projectionVersion: projectionVersionOf(snapshot.fileVersion, runs), runs, reversible: scan.reversible, diagnostics };
}

function runIdFor(index: number, range: TextRange, text: string): string {
  const digest = sha256(`${index}:${range.start}:${range.end}:${text}`).slice(0, 12);
  return `00000000-0000-4000-8000-${digest.padEnd(12, '0').slice(0, 12)}`;
}

export function createTextProjection(): TextProjectionPort {
  return { buildTextProjection: (snapshot, sourceRange) => buildTextProjectionFrom(snapshot, sourceRange) };
}

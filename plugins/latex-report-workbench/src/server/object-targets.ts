import type { Diagnostic, FileSnapshot, LocateResult, RegionRequest, SourceTarget } from '../shared/contracts.js';
import type { ObjectsPort, SyncTexPort } from '../shared/ports.js';
import type { Compiler } from './compiler.js';
import type { FileService } from './files.js';
import { resolveLiveRange } from './pdf-edit.js';
import { normalizeRelativePath } from './path-policy.js';
import type { Workspace } from './workspace.js';

export type ObjectTargetDependencies = { workspace: Workspace; compiler: Compiler; synctex: SyncTexPort; files?: FileService };
export type { ObjectsPort } from '../shared/ports.js';

export type EnvironmentSpan = { name: string; start: number; end: number; beginEnd: number; contentEnd: number };

function isEscaped(text: string, index: number): boolean {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) count += 1;
  return count % 2 === 1;
}

/**
 * Lexical `\begin`/`\end` pairing that ignores comments and escaped braces. It is not a TeX
 * interpreter; it only needs to answer "which environment contains this offset?".
 */
export function scanEnvironments(text: string): EnvironmentSpan[] {
  const stack: EnvironmentSpan[] = [];
  const spans: EnvironmentSpan[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (character === '%' && !isEscaped(text, index)) {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (character !== '\\') {
      index += 1;
      continue;
    }
    const match = /^\\(begin|end)\s*\{([^{}]*)\}/.exec(text.slice(index));
    if (!match) {
      index += 1;
      continue;
    }
    const name = match[2]!.trim();
    const commandEnd = index + match[0].length;
    if (match[1] === 'begin') {
      stack.push({ name, start: index, end: text.length, beginEnd: commandEnd, contentEnd: text.length });
    } else {
      for (let cursor = stack.length - 1; cursor >= 0; cursor -= 1) {
        if (stack[cursor]!.name !== name) continue;
        const span = stack.splice(cursor, 1)[0]!;
        span.end = commandEnd;
        span.contentEnd = index;
        spans.push(span);
        break;
      }
    }
    index = commandEnd;
  }
  for (const span of stack) spans.push(span);
  return spans.sort((a, b) => a.start - b.start || b.end - a.end);
}

export function innermostEnvironment(spans: EnvironmentSpan[], offset: number): EnvironmentSpan | null {
  let best: EnvironmentSpan | null = null;
  for (const span of spans) {
    if (span.start <= offset && offset <= span.end && (!best || span.end - span.start < best.end - best.start)) best = span;
  }
  return best;
}

function targetFor(snapshot: FileSnapshot, relativePath: string, range: { start: number; end: number }): SourceTarget {
  return {
    relativePath,
    range,
    fileVersion: snapshot.fileVersion,
    exactText: snapshot.text.slice(range.start, range.end),
    prefix: snapshot.text.slice(Math.max(0, range.start - 120), range.start),
    suffix: snapshot.text.slice(range.end, Math.min(snapshot.text.length, range.end + 120)),
  };
}

/**
 * Turns a PDF rectangle into the TeX environment that produced it: SyncTeX finds the line,
 * the lexical scan finds the enclosing `figure`/`table`/`equation` block. When either step
 * cannot decide, the candidate list stays empty or carries the diagnostic reason.
 */
export function createObjectTargets(dependencies: ObjectTargetDependencies): ObjectsPort {
  return {
    async resolveRegionTargets(input: RegionRequest): Promise<LocateResult> {
      const diagnostics: Diagnostic[] = [];
      const candidates: SourceTarget[] = [];
      await dependencies.workspace.getReport(input.reportId);
      for (const region of input.regions) {
        const [x0, y0, x1, y1] = region.rect;
        const point = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
        const located = await dependencies.synctex.locatePdfTarget({ reportId: input.reportId, buildId: input.buildId, page: region.page, point });
        diagnostics.push(...located.diagnostics);
        if (located.candidates.length === 0) {
          diagnostics.push({ severity: 'info', code: 'REGION_UNMAPPED', message: `第 ${region.page} 页的框选没有可映射的源码位置。` });
          continue;
        }
        if (located.candidates.length > 1) {
          diagnostics.push({ severity: 'warning', code: 'REGION_AMBIGUOUS', message: `第 ${region.page} 页的框选对应 ${located.candidates.length} 个候选，请改用源码选择。` });
        }
        for (const candidate of located.candidates) {
          // The PDF belongs to a frozen build; the selection must point at live bytes.
          let snapshot: FileSnapshot | null = null;
          if (dependencies.files) snapshot = await dependencies.files.readTextFile(input.reportId, candidate.relativePath).catch(() => null);
          if (!snapshot) {
            diagnostics.push({ severity: 'warning', code: 'REGION_LIVE_FILE_MISSING', message: `无法读取 ${candidate.relativePath}，候选被忽略。`, relativePath: candidate.relativePath });
            continue;
          }
          const live = resolveLiveRange(snapshot, candidate);
          if (!live) {
            diagnostics.push({ severity: 'warning', code: 'REGION_STALE', message: `${candidate.relativePath} 已更新，无法安全重定位该框选。`, relativePath: candidate.relativePath });
            continue;
          }
          const spans = scanEnvironments(snapshot.text);
          const environment = innermostEnvironment(spans, live.start);
          if (!environment) {
            diagnostics.push({ severity: 'info', code: 'REGION_NO_ENVIRONMENT', message: `第 ${region.page} 页的位置不在 figure/table/equation 等环境中。`, relativePath: candidate.relativePath });
            candidates.push(targetFor(snapshot, normalizeRelativePath(candidate.relativePath), live));
            continue;
          }
          candidates.push(targetFor(snapshot, normalizeRelativePath(candidate.relativePath), { start: environment.start, end: environment.end }));
        }
      }
      const distinct = new Set(candidates.map(candidate => `${candidate.relativePath}:${candidate.range.start}:${candidate.range.end}`));
      const confidence: LocateResult['confidence'] = candidates.length === 0 ? 'unmapped' : distinct.size > 1 ? 'ambiguous' : 'nearby';
      return { confidence, candidates, diagnostics };
    },

    async attachSelectedRegionImage(): Promise<{ attached: boolean; reason?: string }> {
      // The host image channel is unverified; the caller must keep the textual target usable.
      return { attached: false, reason: '当前桌面宿主的图像上下文尚未验证，框选不会作为图片传给模型；文本定位仍然可用。' };
    },
  };
}

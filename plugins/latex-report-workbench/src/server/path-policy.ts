import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { relativePathSchema } from '../shared/contracts.js';
import { PRIVATE_DIRECTORIES } from '../shared/config.js';
import { WorkbenchError } from '../shared/errors.js';

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function normalizeRelativePath(relativePath: string): string {
  return relativePath.replaceAll('\\', '/');
}

export function isSafeRelativePath(relativePath: string): boolean {
  return relativePathSchema.safeParse(relativePath).success;
}

export type ResolveOptions = {
  /**
   * Allows the final path segment to be absent so a new file or directory can be created.
   * Parent directories are still fully resolved and checked.
   */
  allowMissingLeaf?: boolean;
};

/**
 * Resolves a workspace-relative path, rejecting traversal, absolute paths, private
 * directories and every symlink or junction along the way. `allowMissingLeaf` keeps the
 * new-file case safe by verifying all existing parents.
 */
export async function resolveSafePath(root: string, relativePath: string, options: ResolveOptions = {}): Promise<string> {
  if (!relativePathSchema.safeParse(relativePath).success) throw new WorkbenchError('PATH_OUTSIDE_WORKSPACE', '路径不是有效的范围内相对路径。');
  const canonicalRoot = await realpath(root);
  const parts = normalizeRelativePath(relativePath).split('/');
  let current = canonicalRoot;
  for (const [index, part] of parts.entries()) {
    if (PRIVATE_DIRECTORIES.has(part.toLowerCase())) throw new WorkbenchError('PATH_OUTSIDE_WORKSPACE', '此目录不属于报告可访问内容。');
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const isLeaf = index === parts.length - 1;
        if (isLeaf && options.allowMissingLeaf) return current;
        throw new WorkbenchError('FILE_NOT_FOUND', '目标文件不存在。');
      }
      throw error;
    }
    if (info.isSymbolicLink()) throw new WorkbenchError('PATH_OUTSIDE_WORKSPACE', '不允许通过符号链接或 junction 访问目标。');
    const resolved = await realpath(current);
    if (!isInside(canonicalRoot, resolved)) throw new WorkbenchError('PATH_OUTSIDE_WORKSPACE', '路径超出允许范围。');
  }
  return current;
}

/** Confirms that an absolute path (which may not exist yet) stays inside the workspace root. */
export async function assertInsideWorkspace(root: string, absolutePath: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  const parent = path.dirname(path.resolve(absolutePath));
  try {
    const resolvedParent = await realpath(parent);
    if (!isInside(canonicalRoot, resolvedParent)) throw new WorkbenchError('PATH_OUTSIDE_WORKSPACE', '目标路径超出工作区范围。');
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    if (!isInside(path.resolve(canonicalRoot), path.resolve(parent))) throw new WorkbenchError('PATH_OUTSIDE_WORKSPACE', '目标路径超出工作区范围。');
  }
}

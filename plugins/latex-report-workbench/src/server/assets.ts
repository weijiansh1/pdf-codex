import { open } from 'node:fs/promises';
import path from 'node:path';
import type { AssetChunk, AssetRequest } from '../shared/contracts.js';
import type { AssetsPort } from '../shared/ports.js';
import { DEFAULTS } from '../shared/config.js';
import { WorkbenchError } from '../shared/errors.js';
import { isInside } from './path-policy.js';
import type { Compiler } from './compiler.js';

/** Streams registered build artifacts to the panel in bounded chunks. */
export function createAssets(compiler: Compiler): AssetsPort {
  return {
    async readAssetChunk(input: AssetRequest): Promise<AssetChunk> {
      const manifest = await compiler.readManifest(input.reportId, input.buildId);
      if (!manifest) throw new WorkbenchError('FILE_NOT_FOUND', '找不到该构建，无法读取资产。', false, { buildId: input.buildId });
      const asset = manifest.assets[input.assetId];
      if (!asset) throw new WorkbenchError('FILE_NOT_FOUND', '该资产不属于此构建。', false, { assetId: input.assetId });
      if (asset.kind === 'pdf' && asset.bytes > DEFAULTS.maxPdfBytes) {
        throw new WorkbenchError('ASSET_TOO_LARGE', `PDF 超过 ${Math.round(DEFAULTS.maxPdfBytes / 1024 / 1024)} MiB 的桥接预览上限。`, false, { bytes: asset.bytes });
      }
      const paths = compiler.pathsFor(input.reportId, input.buildId);
      const file = path.resolve(paths.directory, asset.fileName);
      if (!isInside(path.resolve(paths.directory), file)) throw new WorkbenchError('PATH_OUTSIDE_WORKSPACE', '资产路径超出构建目录。');
      if (input.offset > asset.bytes) throw new WorkbenchError('INVALID_INPUT', '请求偏移超出资产长度。', false, { bytes: asset.bytes });
      const remaining = asset.bytes - input.offset;
      const length = Math.min(input.maxBytes, remaining);
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, input.offset);
        const nextOffset = input.offset + length < asset.bytes ? input.offset + length : null;
        return { bytesBase64: buffer.toString('base64'), nextOffset, totalBytes: asset.bytes };
      } finally {
        await handle.close();
      }
    },
  };
}

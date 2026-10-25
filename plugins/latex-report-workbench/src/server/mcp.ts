import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { OpenAIUiToolMetadata } from '@openai/mcp-extensions/server';
import { readFile } from 'node:fs/promises';
import { toolInputs } from '../shared/contracts.js';
import { TOOL_CATALOG, TOOL_NAMES } from '../shared/tool-catalog.js';
import { toErrorEnvelope } from '../shared/errors.js';
import type { Application } from './application.js';
export const UI_RESOURCE_URI = 'ui://latex-report-workbench/v0.1.0/workbench.html';
export function createMcpServer(app: Pick<Application, 'call'>, widgetPath: string): McpServer {
  const server = new McpServer({ name: 'latex-report-workbench', version: '0.1.0' });
  for (const name of TOOL_NAMES) {
    const spec = TOOL_CATALOG[name];
    const openaiUi: OpenAIUiToolMetadata = { entrypoints: [{ type: 'thread' }] };
    server.registerTool(name, {
      title: spec.title,
      description: spec.implemented
        ? `${spec.title}。本地服务已实现；文件、编译与选区状态都在同一个工作区服务中校验。`
        : `${spec.title}。接口已定义，尚未实现，将返回 FEATURE_NOT_IMPLEMENTED。`,
      inputSchema: toolInputs[name],
      annotations: { readOnlyHint: spec.readOnly, destructiveHint: !spec.readOnly, openWorldHint: false },
      _meta: { ui: { visibility: spec.visibility, ...(spec.rendersUi ? { resourceUri: UI_RESOURCE_URI } : {}) }, ...(spec.rendersUi ? { 'openai/ui': openaiUi } : {}) },
    }, async (input: unknown) => {
      try {
        const result = await app.call(name, input);
        // Future PDF asset bytes belong to the UI bridge, never model-visible text/structured content.
        if (name === 'workspace_asset_read' && 'bytesBase64' in result) return { content: [{ type: 'text' as const, text: '构建资产分块已传给工作台。' }], structuredContent: { totalBytes: result.totalBytes, nextOffset: result.nextOffset }, _meta: { 'latex/assetChunk': result } };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { ...result } };
      }
      catch (error) { const envelope = toErrorEnvelope(error); return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(envelope) }], structuredContent: { error: envelope } }; }
    });
  }
  registerAppResource(server, 'workbench', UI_RESOURCE_URI, { description: '报告工作台：章节与文件树、源码编辑、PDF 预览与 PDF 原位改字', mimeType: RESOURCE_MIME_TYPE }, async () => ({ contents: [{ uri: UI_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(widgetPath, 'utf8'), _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } }] }));
  return server;
}

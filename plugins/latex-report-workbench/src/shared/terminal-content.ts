import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Binary images are MCP content, never a base64 paragraph in the model's text context. */
export function terminalToolContent(result: Record<string, unknown>): CallToolResult {
  const { visualImages, ...metadata } = result;
  const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(metadata) }];
  if (Array.isArray(visualImages)) for (const value of visualImages) {
    const image = value as { mimeType?: string; data?: string };
    if (image.mimeType === 'image/png' && typeof image.data === 'string') content.push({ type: 'image', mimeType: image.mimeType, data: image.data });
  }
  return { content, structuredContent: metadata };
}

import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApplication } from '../../plugins/latex-report-workbench/src/server/application.js';
import { createMcpServer } from '../../plugins/latex-report-workbench/src/server/mcp.js';
it('keeps future asset bytes in UI metadata rather than model-visible content', async () => {
  const app = await createApplication(process.cwd());
  const chunk = { bytesBase64: 'cHJpdmF0ZS1wZGYtYnl0ZXM=', nextOffset: null, totalBytes: 17 };
  // A deterministic future-port response exercises the actual MCP serialization boundary.
  app.services.assets = { readAssetChunk: async () => chunk };
  const server = createMcpServer(app, 'unused-widget-path'); const client = new Client({ name: 'asset-boundary-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const id = '11111111-1111-4111-8111-111111111111';
    const result = await client.callTool({ name: 'workspace_asset_read', arguments: { reportId: id, buildId: id, assetId: id, offset: 0, maxBytes: 100 } });
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify({ content: result.content, structuredContent: result.structuredContent })).not.toContain(chunk.bytesBase64);
    expect(result._meta?.['latex/assetChunk']).toEqual(chunk);
  } finally { await client.close(); await server.close(); }
});

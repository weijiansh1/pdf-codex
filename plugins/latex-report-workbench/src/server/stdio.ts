import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { connectWorkspaceService } from './service-client.js';
import { workspaceArgument } from './daemon.js';
import { createMcpServer } from './mcp.js';
try {
  // Same process state as the HTTP entry: one application per workspace root.
  const app = await connectWorkspaceService(workspaceArgument());
  const server = createMcpServer(app, fileURLToPath(new URL('../../dist/ui/widget.html', import.meta.url)));
  await server.connect(new StdioServerTransport());
} catch (error) { console.error(error instanceof Error ? error.message : 'MCP initialization failed'); process.exitCode = 1; }

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { toolInputs } from '../shared/contracts.js';
import { TERMINAL_TOOLS } from './terminal.js';
import { terminalToolContent } from '../shared/terminal-content.js';

const endpoint = process.env.LATEX_TERMINAL_ENDPOINT;
const sessionId = process.env.LATEX_TERMINAL_SESSION;
const secret = process.env.LATEX_TERMINAL_SECRET;
if (!endpoint || new URL(endpoint).hostname !== '127.0.0.1' || new URL(endpoint).protocol !== 'http:' || !sessionId || !secret) throw new Error('缺少本地终端会话绑定。');
const server = new McpServer({ name: 'latex_terminal', version: '0.1.0' }, { instructions: '每一轮先调用 terminal_target。报告读写均经过绑定的工作台；选区写入不允许扩大为报告范围。工具错误应向用户说明。' });
for (const name of ['terminal_target', ...TERMINAL_TOOLS] as const) {
  server.registerTool(name, { description: name === 'terminal_target' ? '读取当前网页绑定的报告、contextId、selectionId、源码选区范围、版本和可用于一次修改的 suggestedOperationId UUID。每轮修改之前必须调用。' : `${name}：仅操作网页当前绑定报告；读取当前 fileVersion 后提交条件 patch。HTML 保存即时刷新网页，日常不要编译；LaTeX 保存自动编译。`, inputSchema: name === 'terminal_target' ? z.object({}).strict() : toolInputs[name], annotations: { readOnlyHint: name !== 'report_apply_patch' && name !== 'report_compile', destructiveHint: name === 'report_apply_patch', openWorldHint: false } }, async input => {
    try {
      const response = await fetch(`${endpoint}/api/terminal/mcp`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, name, input }), signal: AbortSignal.timeout(120000) });
      const result = await response.json() as { ok: boolean; result?: Record<string, unknown>; error?: unknown };
      return result.ok ? terminalToolContent(result.result ?? {}) : { isError: true, content: [{ type: 'text', text: JSON.stringify(result.error) }] };
    } catch { return { isError: true, content: [{ type: 'text', text: '本地终端工具连接失败；请检查工作台服务并重新启动终端。' }] }; }
  });
}
await server.connect(new StdioServerTransport());

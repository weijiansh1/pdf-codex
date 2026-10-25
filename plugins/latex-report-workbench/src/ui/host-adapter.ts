import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';
import type { ToolArguments, ToolName, ToolResults, HostCapabilities, SelectionContext } from '../shared/contracts.js';
import type { HostAdapter } from '../shared/ports.js';
import { WorkbenchError } from '../shared/errors.js';
import { ToolCallError, type ToolClient } from './api.js';
import type { ErrorEnvelope } from '../shared/errors.js';

/**
 * Adapter for the Codex desktop panel. Capability answers come from the MCP Apps handshake,
 * so an unsupported host produces an explicit HOST_FEATURE_UNAVAILABLE instead of a silent no-op.
 * Whether the real desktop advertises these capabilities is still recorded as unverified.
 */
export class DesktopHostAdapter implements HostAdapter, ToolClient {
  private readonly bridge = new App({ name: 'latex-report-workbench', version: '0.1.0' });
  private readonly transport = new PostMessageTransport(window.parent, window.parent);
  private connection?: Promise<void>;
  private connect() { return this.connection ??= this.bridge.connect(this.transport); }
  private async capabilities() {
    await this.connect();
    return this.bridge.getHostCapabilities();
  }
  async call<N extends ToolName>(name: N, input: ToolArguments<N>): Promise<ToolResults[N]> {
    await this.connect();
    const response = await this.bridge.callServerTool({ name, arguments: input });
    if (response.isError) {
      const text = response.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      const envelope = response.structuredContent?.error as ErrorEnvelope | undefined;
      throw new ToolCallError(envelope?.message ?? text, envelope);
    }
    if (name === 'workspace_asset_read') {
      const chunk = response._meta?.['latex/assetChunk'];
      if (!chunk || typeof chunk !== 'object' || !('bytesBase64' in chunk)) throw new Error('宿主没有返回私有资产分块。');
      return chunk as ToolResults[N];
    }
    if (!response.structuredContent) throw new Error('宿主没有返回结构化工具结果。');
    return response.structuredContent as ToolResults[N];
  }
  async detectCapabilities(): Promise<HostCapabilities> {
    const capabilities = await this.capabilities();
    // Presence of a capability object is the host's own declaration; a missing handshake still
    // means the panel is running outside the desktop host.
    return {
      threadPanel: Boolean(capabilities),
      updateModelContext: Boolean(capabilities?.updateModelContext),
      sendMessage: Boolean(capabilities?.message),
      assetTransport: capabilities?.serverTools ? 'bridge' : 'copy-only',
    };
  }
  async updateSelectionContext(context: SelectionContext | null): Promise<void> {
    const capabilities = await this.capabilities();
    if (!capabilities?.updateModelContext) throw new WorkbenchError('HOST_FEATURE_UNAVAILABLE', '当前宿主没有声明 ui/update-model-context 能力，选区只保存在本地服务中。');
    const summary = context
      ? [{ type: 'text' as const, text: `报告工作台当前修改对象：${context.summary}` }]
      : [{ type: 'text' as const, text: '报告工作台当前没有选中的修改对象。' }];
    await this.bridge.updateModelContext({
      content: summary,
      structuredContent: context
        ? { workbenchSelection: { reportId: context.reportId, contextId: context.contextId, selectionId: context.selectionId, kind: context.kind, status: context.status } }
        : { workbenchSelection: null },
    });
  }
  async sendUserRequestedMessage(prompt: string): Promise<void> {
    const capabilities = await this.capabilities();
    if (!capabilities?.message) throw new WorkbenchError('HOST_FEATURE_UNAVAILABLE', '当前宿主没有声明 ui/message 能力，工作台不会代替用户发送聊天消息。');
    const result = await this.bridge.sendMessage({ role: 'user', content: [{ type: 'text', text: prompt }] });
    if (result.isError) throw new WorkbenchError('HOST_FEATURE_UNAVAILABLE', '宿主拒绝了这条工作台消息。');
  }
  async close() { await this.transport.close(); }
}

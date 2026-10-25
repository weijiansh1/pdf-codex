import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTerminal, type TerminalProcess } from './terminal-process.js';
import type { Application } from './application.js';
import { resolveCodex, reportOnlyMcpArguments, standaloneTuiArguments, type TerminalLaunch } from './codex-launch.js';
import { codexEnvironment } from './terminal-network.js';
import { terminalBindingSchema, terminalFrameSchema, toolInputs, type TerminalBinding, type TerminalEvent, type TerminalSession, type ToolName } from '../shared/contracts.js';
import type { TerminalPort } from '../shared/ports.js';
import { WorkbenchError } from '../shared/errors.js';
import { isHtmlReport } from '../shared/html-report.js';
import { selectionImage } from './selection-image.js';

export const TERMINAL_TOOLS = ['report_open', 'report_tree', 'report_read', 'report_context_get', 'report_apply_patch', 'report_compile', 'report_build_status', 'report_history'] as const;
type Session = { info: TerminalSession; binding: TerminalBinding | null; bindingRevision: number; pty: TerminalProcess; secret: string; replay: string; attachedBefore: boolean; listeners: Set<(event: TerminalEvent) => void>; lastSeen: number };
function denied(message: string): never { throw new WorkbenchError('UNAUTHORIZED', message); }

/** Workspace daemon owns PTYs. The CLI's MCP proxy cannot acquire a broader write scope. */
export class TerminalService implements TerminalPort {
  private readonly sessions = new Map<string, Session>();
  private readonly creating = new Map<string, Promise<TerminalSession>>();
  private readonly maintenance: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private readonly app: Application, private readonly options: { launch?: () => Promise<TerminalLaunch>; endpoint?: () => string } = {}) {
    this.maintenance = setInterval(() => {
      for (const [id, s] of this.sessions) if (!s.listeners.size && Date.now() - s.lastSeen > 30 * 60_000) void this.stop(id).then(() => this.sessions.delete(id));
    }, 60_000); this.maintenance.unref();
  }
  private session(id: string): Session { const s = this.sessions.get(id); if (!s) throw new WorkbenchError('INVALID_INPUT', '终端会话不存在，请重新启动。'); return s; }
  get(id: string): TerminalSession { return { ...this.session(id).info }; }
  private running(id: string): Session { const s = this.session(id); if (s.info.state !== 'running') throw new WorkbenchError('INVALID_INPUT', '终端已经退出，请重新启动。'); return s; }
  private async validate(binding: TerminalBinding) {
    terminalBindingSchema.parse(binding);
    await this.app.workspace.getReport(binding.reportId);
    await this.app.services.contexts.validateBinding(binding);
    const selection = await this.app.services.contexts.getContext(binding.contextId);
    if (binding.selectionId) {
      if (!selection || selection.selectionId !== binding.selectionId || selection.validity !== 'valid' || selection.reportId !== binding.reportId) throw new WorkbenchError('SELECTION_STALE', '终端目标已失效，请重新选择。');
    } else if (selection) throw new WorkbenchError('SELECTION_STALE', '当前视图已有选区，请绑定该选区或先明确清除。');
    return selection;
  }
  async create(binding: TerminalBinding): Promise<TerminalSession> {
    if (this.closed) throw new Error('终端服务已关闭。');
    await this.validate(binding);
    const key = `${binding.viewId}:${binding.reportId}`;
    const existing = [...this.sessions.values()].find(s => s.info.viewId === binding.viewId && s.info.reportId === binding.reportId && s.info.state === 'running');
    if (existing) return { ...existing.info };
    if (this.creating.has(key)) return this.creating.get(key)!;
    const creating = this.start(binding);
    this.creating.set(key, creating);
    try { return await creating; } finally { this.creating.delete(key); }
  }
  private async start(binding: TerminalBinding): Promise<TerminalSession> {
    if ([...this.sessions.values()].filter(s => s.info.state === 'running').length + this.creating.size >= 8) throw new WorkbenchError('INVALID_INPUT', '最多同时运行 8 个报告终端，请先结束闲置会话。');
    const launch = await (this.options.launch ?? resolveCodex)();
    const environment = this.options.launch ? process.env : await codexEnvironment();
    const [mcpArguments, tuiArguments] = this.options.launch ? [[], []] : await Promise.all([reportOnlyMcpArguments(launch, environment), standaloneTuiArguments(launch, environment)]);
    if (this.closed) throw new Error('终端服务已关闭。');
    const report = await this.app.workspace.getReport(binding.reportId);
    const sessionId = randomUUID(); const secret = randomBytes(32).toString('hex');
    const bridge = fileURLToPath(new URL(`./terminal-stdio${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url));
    const bridgeArgs = [...(bridge.endsWith('.ts') ? ['--import', 'tsx'] : []), bridge];
    const htmlInstructions = report.generatedFrom
      ? `网页 ${report.mainFile} 是生成输出，禁止直接写入；生成源是 ${report.generatedFrom}。先读取生成源再修改，不执行生成器或附件脚本。若选区绑定生成页，请用户打开生成源重新选择或清除选区后再修改。保存生成源后由原项目流程重新生成网页。`
      : `当前是 HTML 报告，入口为 ${report.mainFile}，直接修改 HTML/CSS；公式可使用 data-tex 属性。保存后网页自动更新。`;
    const instructions = '你在报告工作台的网页终端内。用户需要中文报告协作。每一轮先调用 terminal_target 获取当前 reportId/contextId/selectionId；只能通过 latex_terminal 的 report_read/report_context_get/report_apply_patch 修改报告。不得通过 shell、apply_patch 或其他文件工具直接写报告。没有目标或工具返回失效时停止写入并请用户重新选择。读取 fileVersion 后按 UTF-16 LF 左闭右开偏移提交事务；operationId 必须是 UUID，每次修改使用新 UUID，也可使用 terminal_target 的 suggestedOperationId。选区时 scope=selection；无选区时 scope=report 并用用户要求作 scopeReason。保留公式、引用、宏结构及 HTML 结构。' + (isHtmlReport(report.mainFile) ? htmlInstructions + '日常修改不要调用 report_compile，不要生成 .tex，不要等待 PDF。导出可选择保留网页样式的 PDF 或语义 LaTeX PDF。LaTeX 导出支持语义标题/columns/column/表格、公式、本地 PNG/JPEG/PDF 和自动转换的 SVG；完整 CSS 样式请用网页 PDF。选中图表时 terminal_target 可附带真实图像，应直接查看该图像。' : '当前是 LaTeX 报告，写入成功自动编译，可用 report_build_status 查看诊断。');
    const args = [...launch.args, ...mcpArguments, ...tuiArguments, ...(!this.options.launch ? ['--no-alt-screen', '-C', path.join(this.app.workspace.root, report.rootRelativePath), '--sandbox', 'read-only', '--ask-for-approval', 'on-request', '-c', 'features.apps=false', '-c', `developer_instructions=${JSON.stringify(instructions)}`, '-c', `mcp_servers.latex_terminal={command=${JSON.stringify(process.execPath)},args=${JSON.stringify(bridgeArgs)},env_vars=["LATEX_TERMINAL_ENDPOINT","LATEX_TERMINAL_SESSION","LATEX_TERMINAL_SECRET"],startup_timeout_sec=30}`] : [])];
    // node-pty launches directly with argv and a hidden ConPTY on Windows; no shell or visible console.
    const pty = await spawnTerminal(launch.file, args, { name: 'xterm-256color', cols: 100, rows: 28, cwd: this.app.workspace.root, env: { ...environment, TERM: 'xterm-256color', COLORTERM: 'truecolor', LATEX_TERMINAL_ENDPOINT: this.options.endpoint?.() ?? '', LATEX_TERMINAL_SESSION: sessionId, LATEX_TERMINAL_SECRET: secret } });
    const s: Session = { info: { sessionId, reportId: binding.reportId, viewId: binding.viewId, state: 'running' }, binding, bindingRevision: 0, pty, secret, replay: '', attachedBefore: false, listeners: new Set(), lastSeen: Date.now() };
    this.sessions.set(sessionId, s);
    const emit = (event: TerminalEvent) => { for (const receive of s.listeners) receive(event); };
    pty.onData(data => { s.replay = (s.replay + data).slice(-524288); emit({ type: 'output', data }); });
    pty.onExit(({ exitCode }) => { s.info = { ...s.info, state: 'exited', exitCode }; s.lastSeen = Date.now(); s.secret = ''; emit({ type: 'exit', exitCode }); });
    return { ...s.info };
  }
  async bind(id: string, binding: TerminalBinding) {
    const s = this.running(id); s.binding = null; const revision = ++s.bindingRevision;
    if (s.info.reportId !== binding.reportId || s.info.viewId !== binding.viewId) denied('终端不能切换到另一份报告或视图。');
    await this.validate(binding);
    if (revision !== s.bindingRevision || s.info.state !== 'running') denied('目标已变化，请重新绑定。');
    s.binding = binding;
  }
  suspend(id: string) { const s = this.session(id); s.binding = null; s.bindingRevision++; }
  async request(id: string, prompt: string, expectedBinding?: TerminalBinding, submit = false) {
    const s = this.running(id); const binding = s.binding;
    if (!binding) denied('先绑定当前选择，再发送修改要求。');
    if (expectedBinding && (binding.reportId !== expectedBinding.reportId || binding.viewId !== expectedBinding.viewId || binding.contextId !== expectedBinding.contextId || binding.selectionId !== expectedBinding.selectionId)) denied('发送目标已变化，请重新填入。');
    const selection = await this.validate(binding);
    if (s.binding !== binding) denied('目标已变化，请重新发送。');
    if (!prompt.trim() || prompt.length > 12000) throw new WorkbenchError('INVALID_INPUT', '修改要求需要 1—12,000 字符。');
    // Target IDs/ranges already live in terminal_target. Keep the user's terminal input short.
    const report = await this.app.workspace.getReport(binding.reportId);
    const html = isHtmlReport(report.mainFile);
    if (s.binding !== binding) denied('目标已变化，请重新发送。');
    const message = `${prompt.trim()}\n${selection ? '只修改当前选区' : '处理当前报告'}；先读取 terminal_target，用工作台事务保存${html ? report.generatedFrom ? `生成源 ${report.generatedFrom}，保留生成页，无需编译。` : ' HTML，无需编译。' : '并查看编译结果。'}`;
    // The UI's Send action requests submit; legacy API callers may still fill the composer only.
    this.input(id, `\x1b[200~${message.replaceAll('\r\n', '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')}\x1b[201~`);
    if (submit) {
      await new Promise(resolve => setTimeout(resolve, 80));
      await this.validate(binding);
      if (s.binding !== binding || s.info.state !== 'running') denied('发送前目标已变化，请重新发送。');
      this.input(id, '\r');
    }
  }
  input(id: string, data: string) { terminalFrameSchema.parse({ type: 'input', data }); const s = this.running(id); s.lastSeen = Date.now(); s.pty.write(data); }
  resize(id: string, cols: number, rows: number) { terminalFrameSchema.parse({ type: 'resize', cols, rows }); this.running(id).pty.resize(cols, rows); }
  subscribe(id: string, receive: (event: TerminalEvent) => void) {
    const s = this.session(id); s.lastSeen = Date.now();
    if (s.replay) receive({ type: 'output', data: s.replay, replay: s.attachedBefore });
    s.attachedBefore = true;
    if (s.info.state === 'exited') receive({ type: 'exit', exitCode: s.info.exitCode ?? -1 });
    s.listeners.add(receive);
    return () => { s.listeners.delete(receive); s.lastSeen = Date.now(); };
  }
  authenticate(id: string, secret: string): boolean {
    const s = this.sessions.get(id); if (!s || !s.secret || s.info.state !== 'running') return false;
    const a = Buffer.from(secret); const b = Buffer.from(s.secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  async call(id: string, name: ToolName | 'terminal_target', input: unknown): Promise<unknown> {
    const s = this.running(id); const binding = s.binding; const revision = s.bindingRevision;
    if (!binding) denied('当前目标正在切换或有未保存草稿，请在工作台重新绑定。');
    const selection = await this.validate(binding);
    if (name === 'terminal_target') {
      const report = await this.app.workspace.getReport(binding.reportId);
      const visualImages = await selectionImage(this.app, selection);
      await this.validate(binding);
      if (s.binding !== binding || s.bindingRevision !== revision || s.info.state !== 'running') denied('图像准备期间目标已变化，请重新读取当前选择。');
      return { ...binding, workspaceId: this.app.workspace.workspaceId, selection, suggestedOperationId: randomUUID(), report, ...(visualImages.length ? { visualImages, visualContext: { attached: true, count: visualImages.length, mimeType: 'image/png' } } : {}) };
    }
    if (!(TERMINAL_TOOLS as readonly string[]).includes(name)) denied('网页终端未开放此工具。');
    const parsed = toolInputs[name].parse(input);
    if ('reportId' in parsed && parsed.reportId !== binding.reportId) denied('工具只能操作绑定报告。');
    if ('contextId' in parsed && parsed.contextId !== binding.contextId) denied('工具上下文与终端目标不匹配。');
    if (name === 'report_apply_patch') {
      const patch = toolInputs.report_apply_patch.parse(input);
      if (binding.selectionId ? patch.scope !== 'selection' || patch.selectionId !== binding.selectionId : patch.scope !== 'report' || patch.selectionId !== undefined) denied('修改范围必须与工作台当前目标一致。');
    }
    if (name === 'report_context_get' && 'selectionId' in parsed && parsed.selectionId !== binding.selectionId) denied('选区与终端目标不匹配。');
    if (s.binding !== binding) denied('修改目标已变化，请重新读取。');
    return this.app.call(name, parsed, name === 'report_apply_patch' ? { validateWrite: () => {
      if (s.info.state !== 'running' || s.binding !== binding || s.bindingRevision !== revision) denied('写入前终端目标已暂停或改变，修改未提交。');
    } } : undefined);
  }
  async stop(id: string) {
    const s = this.session(id); s.binding = null; s.secret = '';
    if (s.info.state !== 'running') return;
    s.info = { ...s.info, state: 'exited', exitCode: -1 };
    s.pty.kill();
    // ConPTY shutdown is asynchronous. Wait for the owned process before deleting its workspace.
    const alive = () => { try { process.kill(s.pty.pid, 0); return true; } catch { return false; } };
    const deadline = Date.now() + 2000;
    while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
    if (alive() && process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(s.pty.pid), '/T', '/F'], { shell: false, windowsHide: true }).catch(() => undefined);
    for (const receive of s.listeners) receive({ type: 'exit', exitCode: s.info.exitCode ?? -1 });
  }
  hasActiveWork() { return [...this.sessions.values()].some(s => s.info.state === 'running'); }
  async close() { this.closed = true; clearInterval(this.maintenance); await Promise.allSettled([...this.creating.values()]); await Promise.allSettled([...this.sessions.keys()].map(id => this.stop(id))); this.sessions.clear(); }
}

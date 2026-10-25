# 数据、工具与业务接口

维护源为 plugins/latex-report-workbench/src/shared/contracts.ts、ports.ts、tool-catalog.ts。协议及配置版本为 1，TypeScript/Zod 是唯一契约来源，输入 strict。

ID 为 UUID，版本为原始字节 SHA-256。源码范围是规范化 LF 文本的 UTF-16 [start,end)，不是字节；行/列从 1 开始。PDF 页从 1 开始，rect 为 [xMin,yMin,xMax,yMax]，以未旋转页面左上角 big point 表示。不能把 PDF 底左原点坐标直接交给 SyncTeX。

## 29 个工具

| 工具组 | 工具 | 当前行为 |
|---|---|---|
| 工作区 | probe_echo、workspace_status、workbench_open、report_list、report_open | 真实状态/报告；仅 workbench_open 关联 UI 资源 |
| 报告管理 | report_create、report_import | 模板创建/根目录内注册、幂等 operationId |
| 源码/导航 | report_tree、report_read | files/outline 双树、UTF-8/BOM/EOL、范围与版本 |
| 修改 | report_context_get、report_apply_patch、report_history、report_undo | 权威选区、条件 patch、真实历史、条件撤销 |
| 编译 | report_compile、report_build_status | 入队与真实状态、当前成功构建 |
| 定位 | report_locate_pdf、report_locate_source | 配套 build 的双向候选/页框 |
| 导出 | report_export | 成功 PDF 或当前/冻结源码 ZIP |
| 面板会话（app） | context_bind、selection_set、selection_clear、session_keepalive | context/view、权威范围、清除及保活 |
| 源码保存（app） | draft_save | baseVersion 条件保存，复用事务并编译 |
| 资产（app） | workspace_asset_read | 256 KiB 默认分块，MCP 字节仅在私有元数据 |
| 原位改字（app） | pdf_edit_open、pdf_edit_commit、pdf_edit_cancel | 唯一映射、可逆 runs、版本提交、no-op/取消 |
| 框选（app） | objects_resolve_region、objects_attach_image | 环境候选；图像当前 attached:false |

app-only 是 UI 可见性元数据，不等于授权；本地 HTTP 按 Bearer 及 context 校验。宿主是否实施可见性隔离仍需原生验收。

## 修改与版本

scope:selection 必须有 selectionId；scope:report 必须有来自用户实际意图的 scopeReason。重复文件项、重叠/越界 edits 拒绝。新文件仅报告作用域内 [0,0) 插入，expectedVersion:null，目标必须不存在。服务器校验报告绑定与实际文件哈希，operationId 保证成功提交幂等。

PDF 提交只发送 editSessionId、contextId、operationId、expectedFileVersion、projectionVersion 和 runId/text。未知/受保护 run 拒绝；输入按纯文本转义。unchanged 返回 operation:null、buildId:null，不创建历史/构建。

导出返回 relativePath/reportRevision/buildId?。指定 buildId 的 ZIP 与 PDF 都取该冻结构建；当前源码在导出期间变化则拒绝。

## 端口与生命周期

Workspace/Files/Outline/Contexts/History/Compiler/BuildQueue/SyncTex/Assets/TextProjection/PdfEdit/Objects/Export/Cleanup/Watcher/HostAdapter 在 ports.ts 定义，application 统一装配。BuildQueue.hasActiveWork 用于服务生命周期；history writer 的恢复/删除是内部组合能力。

operation prepared → committed，未提交恢复记 recovered；build queued → snapshotting → running → succeeded/failed/cancelled。selection 有 valid/stale/ambiguous/unmapped。PDF 保存状态与成功构建状态分开。

错误 {code,message,retryable,details?}。MCP 返回 isError 与 structuredContent.error；HTTP 返回 {ok:false,error}。UI 保留结构化 code 用于冲突草稿处理。

## HTTP

| 端点 | 行为 |
|---|---|
| GET /health | PID、workspaceId、protocolVersion |
| GET /api/bootstrap | 同源页面令牌与功能状态 |
| POST /api/tools/<name> | Bearer、JSON、协议、Host/Origin、strict 输入 |
| GET /api/events?since=N | 已鉴权有限事件流轮询 |
| POST /api/terminal/sessions | Bearer 鉴权；校验 TerminalBinding，创建/恢复视图的报告会话 |
| POST /api/terminal/sessions/:id/bind | 当前目标或 null 暂停；失效 revision 不可恢复权限 |
| POST /api/terminal/sessions/:id/request | prompt + 预期 binding；重新校验后按字面填入终端 |
| POST /api/terminal/sessions/:id/stop | 结束会话，等待隐藏 host 退出 |
| WS /api/terminal/socket | Host/Origin、首帧限时 attach 鉴权；input/resize/output/exit；回放标记 |
| POST /api/terminal/mcp | 独立会话凭证，仅允许 9 个绑定报告工具，调用同一 app |
| GET / 和 UI assets | 只暴露 UI，不映射报告目录 |

显式非 1 的旧协议拒绝；兼容未带版本头的普通 MCP 代理以前的本地调用，当前 UI 与代理都会带版本 1。workspace events 仍为有限轮询；终端使用真实 WebSocket。TerminalPort 定义生命周期，WriteGuard 仅由内部组合根传入事务，不能作为 HTTP/MCP 参数指定。真实宿主能力表在 host-capabilities.json。

## HTML 工具（2026-10-25）

三项均为 app 可见工具，使用既有 /api/tools/:name 和 stdio 契约；不建立平行应用。

| 工具 | 输入与结果 |
|---|---|
| report_preview | reportId → 原稿、fileVersion、过滤后的 html、带范围的 blocks、本地资源映射、renderMs |
| html_select | reportId/contextId/viewId/expectedVersion/blockId → 服务端校验后绑定 SelectionRecord |
| html_edit | 相同目标 + text/operationId → 版本事务 operation，buildId:null；客户端不能传入写回偏移 |
| report_export | format 新增 latex-zip；HTML pdf 未指定 buildId 时编译最新版本，latex-zip 导出含生成 TeX 的构建源码 |

HtmlPort 维护 preview/select/edit；HTML 模式按 mainFile 扩展名识别，不修改 manifest schema。静态 /html-preview.js 与 UI 一起打包，仅读取 iframe DOM、发送选择和文字事件，不直接访问报告文件或工具令牌。

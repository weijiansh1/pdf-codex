# 发布流程

源码与发布资产使用同一版本号，位于 package.json 和插件元数据。首个版本为 v0.1.0，采用 MIT 许可证。

## 构建与验收

1. 安装 Node.js 24+ 和项目依赖。真实完整测试还需要浏览器、Pandoc、TeX、Poppler。
2. 依次运行 `typecheck`、`test`、`build`、`package:plugin`、`verify:package`。
3. 运行 `package:release`。它将最新本机缓存转换为当前平台/架构的可移植包，附带启动器、MIT、依赖声明和 SHA256。
4. 运行 `verify:release`。它把程序复制到无项目 node_modules 的中文临时目录，从不同 cwd 启动两次，核对同一 PID，测试真实 HTTP/stdio、模板/公式、网页 PDF 和原生 PTY。

运行包不包含 Node.js 或账号。不要将本机 `package:plugin` ZIP 直接上传为通用运行包：其 MCP 配置固定到打包电脑的路径。发布资产应使用 `latest-release.json` 中的 ZIP 和 SHA256SUMS.txt。

## 首次推送与 GitHub Release

检查待提交文件仅含软件、模板、测试及公开说明。用户报告、内部验收截图、会话、凭证、历史、本机 marketplace 和构建输出应留在本地。

将经过验证的提交推到目标仓库后，在该提交创建 `v<version>` 标签。GitHub Release 上传 `pdf-codex-v<version>-<platform>-<arch>.zip` 与 `SHA256SUMS.txt`；说明 Node 版本、适用系统、可选依赖、启动方式与已验收范围。

同时上传 `pdf-codex-<version>.tgz`，用户可直接 `npm install -g <GitHub资产下载地址>`，然后运行 `pdf-codex`。安装包的bin入口默认在用户当前目录工作；ZIP启动器默认在解压目录工作。verify:release包含离线全局安装、bin入口、当前目录和原生SVG检查。

发布后检查远端 tag/commit、资产大小、下载文件 SHA256。源代码 ZIP 由 GitHub 根据 tag 提供；它需要安装依赖和构建，与预编译运行包分开说明。

如需额外发布到npm registry，由维护者先完成npm登录及发布所需认证，再对已验证TGZ执行npm publish；GitHub Release发布不依赖npm登录。不要将尚未发布到registry的短名称命令写成可用入口。

## v0.1.0 首发范围

- Windows x64 可移植运行包；Node.js >=24。
- HTML 论文/横版编辑、公式、文件/章节树、同页 Codex 终端、版本事务和历史。
- 网页 PDF 导出排除侧栏目录；保留可选 LaTeX 工作流。
- 本地浏览器与 MCP stdio 为已验收入口；原生 MCP Apps 安装/宿主聊天桥接另行验收。

# 发布流程

源码与发布资产使用同一版本号，位于package.json和插件元数据。当前为coPDF v0.2.1，包和命令名为copdf，采用MIT许可证。旧PDF Codex v0.1.0下载保留，GitHub仓库地址不变。

默认分发采用GitHub公开Release：用户下载ZIP或通过TGZ完整地址执行npm安装，不需要账号或2FA。npm官方注册表发布是可选的维护者操作，不作为使用前提。

## 构建与验收

1. 安装 Node.js 24+ 和项目依赖。真实完整测试还需要浏览器、Pandoc、TeX、Poppler。
2. 依次运行 `typecheck`、`test`、`build`、`package:plugin`、`verify:package`。
3. 运行 `package:release`。它将最新本机缓存转换为当前平台/架构的可移植包，附带启动器、MIT、依赖声明和 SHA256。
4. 运行 `verify:release`。它把程序复制到无项目 node_modules 的中文临时目录，从不同 cwd 启动两次，核对同一 PID，测试真实 HTTP/stdio、模板/公式、网页 PDF 和原生 PTY。

运行包不包含 Node.js 或账号。不要将本机 `package:plugin` ZIP 直接上传为通用运行包：其 MCP 配置固定到打包电脑的路径。发布资产应使用 `latest-release.json` 中的 ZIP 和 SHA256SUMS.txt。

## 首次推送与 GitHub Release

检查待提交文件仅含软件、模板、测试及公开说明。用户报告、内部验收截图、会话、凭证、历史、本机 marketplace 和构建输出应留在本地。

将经过验证的提交推到目标仓库后，在该提交创建 `v<version>` 标签。GitHub Release上传 `copdf-v<version>-<platform>-<arch>.zip` 与 `SHA256SUMS.txt`；说明Node版本、适用系统、可选依赖、启动方式与已验收范围。

同时上传 `copdf-<version>.tgz`，提供无需登录的npm完整地址安装。包内附USAGE.md和COLLABORATION.md。bin入口默认在用户当前目录工作；ZIP启动器默认在解压目录工作。verify:release包含离线全局安装、bin入口、当前目录和原生SVG检查。

发布后检查远端 tag/commit、资产大小、下载文件 SHA256。源代码 ZIP 由 GitHub 根据 tag 提供；它需要安装依赖和构建，与预编译运行包分开说明。

发布到npm registry前，维护者完成npm登录及发布所需认证，再对已验证TGZ执行 `npm publish <TGZ路径> --access public --registry=https://registry.npmjs.org/`。先用 `--dry-run` 核对名称、版本和内容；发布后检查registry中的dist.integrity与本地产物一致，安装 `copdf@<version>` 并验证CLI。不要从私有的源码根package.json直接发布。

## v0.1.0 首发范围

- Windows x64 可移植运行包；Node.js >=24。
- HTML 论文/横版编辑、公式、文件/章节树、同页 Codex 终端、版本事务和历史。
- 网页 PDF 导出排除侧栏目录；保留可选 LaTeX 工作流。
- 本地浏览器与 MCP stdio 为已验收入口；原生 MCP Apps 安装/宿主聊天桥接另行验收。

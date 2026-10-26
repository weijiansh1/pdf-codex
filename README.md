# coPDF

**在同一个网页里写报告、与 Codex 协作、即时预览，完成后导出 PDF。**

日常以 HTML 为主稿，普通改字和公式编辑直接更新预览；交付时可保留网页样式导出 PDF，也可使用 Pandoc / LaTeX 排版。报告、资源和版本历史保存在你选择的本地目录。

[协作指南](docs/collaboration.md) · [使用说明](docs/usage.md) · [下载 v0.2.1](https://github.com/weijiansh1/pdf-codex/releases/tag/v0.2.1) · [提交问题](https://github.com/weijiansh1/pdf-codex/issues) · [MIT 许可证](LICENSE)

下载和安装使用GitHub公开发布包，不需要账号或2FA。npm短包名 `copdf` 尚未发布，命令安装使用下面的完整下载地址。

## 一条命令安装（无需账号）

运行包支持 **Windows x64 / Node.js 24+**。在终端执行：

```powershell
npm.cmd install -g https://github.com/weijiansh1/pdf-codex/releases/download/v0.2.1/copdf-0.2.1.tgz
```

然后进入你存放报告的目录，运行：

```powershell
copdf.cmd
```

浏览器会打开工作台，报告保存在当前目录的 `reports/`。也可以执行 `copdf --workspace "D:\我的报告"` 指定已存在的目录，`copdf --help` 查看参数。依赖已经包含在安装包中，无需Git、npm账号或发布权限。支持直接运行脚本的终端，也可用 `npm install -g <上面的完整地址>` 和 `copdf`。

## 下载压缩包使用

预编译运行包适用于 **Windows x64**，需要 **Node.js 24+**。

1. 安装 [Node.js 24 或更高版本](https://nodejs.org/)。
2. 从 [Releases](https://github.com/weijiansh1/pdf-codex/releases/tag/v0.2.1) 下载 `copdf-v0.2.1-windows-x64.zip`。
3. 完整解压到一个可写目录，双击 **启动工作台.cmd**。
4. 浏览器打开工作台后，从“目录”新建报告。文件默认保存在解压目录的 `reports/`。

运行包已包含工作台依赖，无需 npm install。网页 PDF 使用本机 Edge/Chrome；与 Codex 对话需要本机可用且已登录的 Codex CLI。首次使用时在内嵌终端处理目录信任或登录提示。

希望将报告放在独立目录时，先创建该目录，再执行：

```powershell
node start.mjs --workspace "D:\我的报告"
```

同一工作目录重复启动会复用已有服务。下载包不包含 Node.js、Codex、浏览器或 TeX。升级和可选依赖见 [安装说明](docs/installation.md)。

## 能做什么

- **论文与横版报告：** 新建连续论文、横版一页 HTML 或多文件 LaTeX，浏览文件树与章节目录。
- **直接改字与公式：** 双击网页文字或标题编辑，Enter / Ctrl+S 保存；data-tex 公式输入即时渲染。源码编辑和磁盘修改会更新预览。
- **网页内 Codex：** 展开 Codex 面板，在真实终端对话；选择段落、公式、图表或源码后发送修改要求。修改经过版本事务保存，可查看历史和撤销。
- **阅读与预览：** 侧栏占独立空间，正文自适应；可拖动分隔条，局部刷新预览并保留阅读位置。
- **导出 PDF：** 主入口保留 HTML/CSS、SVG 和公式，移除侧边导航并恢复正文页宽；连续论文输出 A4，横版报告保留设定页尺寸。
- **保留 LaTeX 流程：** 编译、PDF.js 预览、SyncTeX 定位及受支持正文的原位改字；公式、引用和宏结构受到保护。

网页终端使用独立 CLI 会话，复用本机已有登录。它通过同一工作区服务中的限定报告工具写入；浏览器刷新可重连，切换报告恢复对应会话。网页终端与 Codex 桌面当前聊天分别维护对话。

## 从源码运行

```powershell
git clone https://github.com/weijiansh1/pdf-codex.git
cd pdf-codex
npm.cmd ci
npm.cmd run build
npm.cmd run workbench
```

macOS/Linux 可使用 `npm`；其他平台需在本机安装依赖和构建，首发只对 Windows x64 完成运行包验收。

开发界面：`npm.cmd run dev`。HTTP、stdio、开发入口均复用同一个工作区 daemon。源码启动器默认使用仓库根目录作为工作目录。

## 按需安装

| 使用方式 | 额外工具 |
|---|---|
| HTML 编辑、公式即时预览 | 无 |
| 网页样式 PDF | Edge / Chrome，可用 `LATEX_BROWSER_EXECUTABLE` 指定 |
| 网页内 Codex | 已登录且可用的 CLI，可用 `LATEX_CODEX_EXECUTABLE` 指定 |
| LaTeX 排版 PDF | Pandoc、latexmk、XeLaTeX；文献按需使用 biber |
| LaTeX 双向定位 | SyncTeX |
| LaTeX PDF 对象截图 | Poppler 的 pdftoppm / pdfinfo |

HTML 日常编辑不调用 TeX。“可选：LaTeX 排版 PDF”保留语义标题、表格、公式和图片，完整 CSS 外观使用主入口“导出 PDF”。

## 数据与当前范围

报告放在 `reports/<report>/`；每份报告有稳定 ID 和入口文件。`.latex-workspace/` 保存运行状态、历史、草稿与恢复记录。备份时保留这两个目录。保存冲突会保留草稿，不覆盖磁盘上的新版本。

原稿中的脚本和外部请求在预览中被禁用。使用 Codex 时，你发送的要求和选定内容会交给所用模型；本项目不附带账号、API key 或模型额度。

本地浏览器、真实 stdio、Windows 原生终端、中文 TeX 及网页 PDF 已验收。**Codex 原生 MCP Apps 面板安装和宿主消息桥接仍需单独验证**；当前推荐使用本地浏览器入口。任意扫描 PDF、复杂宏或跨页内容不保证能直接改字。

## 开发与发布

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run package:plugin
npm.cmd run verify:package
npm.cmd run package:release
npm.cmd run verify:release
```

完整测试需要上表中的 TeX、Pandoc、浏览器和 Poppler；也可分别运行 `test:unit`、`test:integration`、`test:tex`。`verify:release` 会在独立中文目录验证搬移后的启动、同一 daemon、HTTP/stdio、原生终端和真实网页 PDF。

发布包路径记录在 `.latex-workspace/packages/latest-release.json`，包含 ZIP、npm TGZ 和 `SHA256SUMS.txt`。`package:plugin` 生成的本机插件缓存与可移植发布包分别维护；打包不会自动安装或修改全局设置。npm发布使用经过验收的TGZ，由维护者完成登录及发布认证；安装不需要npm账号。

源码入口：`plugins/latex-report-workbench/src/{shared,server,ui}/`。更多内容见 [架构](docs/architecture.md)、[接口](docs/interfaces.md)、[排版约定](docs/report-style.md)、[故障排查](docs/troubleshooting.md)和[发布说明](docs/releasing.md)。

## 许可证

[MIT](LICENSE)，Copyright (c) 2026 weijiansh1。运行包附有第三方依赖声明。Codex、Node.js、浏览器、TeX 工具及其服务使用各自许可和账号条款。

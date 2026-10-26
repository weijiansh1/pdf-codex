# coPDF

在浏览器里写报告、预览网页和使用 Codex；需要交付时导出 PDF。

完整操作教程见包内 **USAGE.md**，协作流程见 **COLLABORATION.md**；也可打开 [在线使用说明](https://github.com/weijiansh1/pdf-codex/blob/main/docs/usage.md)。

## npm 安装

也可以用一条命令安装，无需手动解压：

```powershell
npm.cmd install -g https://github.com/weijiansh1/pdf-codex/releases/download/v0.2.1/copdf-0.2.1.tgz
copdf.cmd
```

`copdf`默认在终端当前目录保存报告；可用 `--workspace` 指定已存在的工作目录，`--help` 查看参数。需要Windows x64和Node.js 24+。下载安装不需要登录或2FA，npm短包名尚未发布，请使用上面的完整地址。

## Windows x64 启动

1. 安装 [Node.js 24 或更高版本](https://nodejs.org/)。
2. 将本压缩包完整解压到一个可写目录，例如 `D:\PDF-Codex`。
3. 双击 **启动工作台.cmd**，浏览器会打开本机工作台。
4. 在“目录”中新建论文网页或横版报告。文件保存在解压目录的 `reports/`。

运行包已包含工作台依赖，无需执行 npm install。不要只从压缩包中拖出单个启动器。升级时将新版本解压到新目录，再指定已有工作目录。

也可以在终端执行：

```powershell
node start.mjs
node start.mjs --workspace "D:\我的报告"
node start.mjs --workspace "D:\我的报告" --no-open
```

指定的工作目录需已存在；工作台会创建其 `reports/` 与 `.latex-workspace/`。同一目录重复启动会复用已有服务。不要在服务运行期间搬移整个工作目录。升级后先关闭旧服务，再运行新版本；运行中的旧服务会继续被复用。

## 按需准备工具

| 功能 | 需要 |
|---|---|
| HTML 编辑和预览 | Node.js 24+ |
| 网页样式 PDF | Microsoft Edge 或 Google Chrome |
| 网页内 Codex | 本机可用且已登录的 Codex CLI；也可发现桌面端随附 CLI |
| LaTeX 排版 PDF | Pandoc、TeX Live/MiKTeX、latexmk、XeLaTeX |
| LaTeX PDF 对象截图 | Poppler 的 pdftoppm/pdfinfo |

展开“Codex”后点“启动 Codex”，在内嵌终端完成首次目录信任或登录。每份报告使用独立会话。普通改字保存即时更新网页；主菜单“导出 PDF”保留网页样式，不需要 TeX。

当前运行包针对 Windows x64。其他平台请从源码构建。本地浏览器是主要入口；原生 MCP Apps 桌面宿主安装仍需单独验证。mcp.json 供支持 PLUGIN_ROOT 的宿主使用，LATEX_REPORT_WORKSPACE 可指定报告工作目录；浏览器使用不需要安装插件。

## 数据与反馈

报告和历史都保存在本机。使用 Codex 时，选定内容会按你的操作交给所用模型。备份时同时保留 `reports/` 与 `.latex-workspace/`；后者含撤销和恢复记录，不要用删除它的方式修复普通错误。

源码、使用说明、反馈：[weijiansh1/pdf-codex](https://github.com/weijiansh1/pdf-codex)。本项目采用 MIT 许可证；依赖声明见 THIRD-PARTY-NOTICES.txt。Codex、浏览器、Node.js 和 TeX 工具使用各自许可及账号服务。

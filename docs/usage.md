# coPDF 使用说明

coPDF 把报告正文、源码、文件目录和 Codex 终端放在同一个网页里。日常编辑 HTML，保存后直接看效果；需要交付时再导出 PDF。

本说明适用于v0.2.1，预编译运行包支持Windows x64、Node.js 24+。GitHub项目地址仍为 [weijiansh1/pdf-codex](https://github.com/weijiansh1/pdf-codex)。

安装包通过GitHub Release提供。npm短包名尚未发布，请使用下面的完整TGZ地址或ZIP。怎样提出要求和检查修改，见[协作指南](https://github.com/weijiansh1/pdf-codex/blob/main/docs/collaboration.md)。

## 1. 安装前准备

| 使用方式 | 需要准备 |
|---|---|
| HTML 编辑、公式和预览 | Node.js 24+ |
| 网页样式 PDF | Microsoft Edge 或 Google Chrome |
| 网页内 Codex | 本机可用且已登录的 Codex CLI；工作台也会尝试发现桌面端随附 CLI |
| LaTeX 排版 PDF | Pandoc、latexmk、XeLaTeX，文献按需使用 biber |
| LaTeX 定位和对象截图 | SyncTeX、Poppler 的 pdftoppm/pdfinfo |

HTML日常编辑和网页PDF导出不需要TeX。

## 2. 安装并打开工作台

### npm 安装

安装好 [Node.js](https://nodejs.org/) 后，在 PowerShell 执行：

```powershell
npm.cmd install -g https://github.com/weijiansh1/pdf-codex/releases/download/v0.2.1/copdf-0.2.1.tgz
```

创建一个保存报告的目录，进入它，再启动：

```powershell
New-Item -ItemType Directory -Path "D:\我的报告" -Force
Set-Location "D:\我的报告"
copdf.cmd
```

浏览器会自动打开工作台。npm 命令默认以终端当前目录作为工作目录：报告在 `reports/`，历史与运行状态在 `.latex-workspace/`。

也可以指定一个已经存在的工作目录：

```powershell
copdf.cmd --workspace "D:\我的报告"
```

常用参数：

```powershell
copdf.cmd --no-open
copdf.cmd --help
copdf.cmd --version
```

`--no-open`只启动服务并输出地址。PowerShell示例使用 `.cmd`；支持直接运行脚本的终端，也可输入 `npm install -g <上面的完整地址>` 和 `copdf`。

### ZIP 安装

从 [v0.2.1发布页](https://github.com/weijiansh1/pdf-codex/releases/tag/v0.2.1) 下载 `copdf-v0.2.1-windows-x64.zip`，完整解压到可写目录，双击 **启动工作台.cmd**。

ZIP 启动器默认在解压目录保存报告。程序和报告分开存放时，在解压目录运行 `node start.mjs --workspace "D:\我的报告"`。

服务优先使用 `http://127.0.0.1:4317`，端口被占用时会选择其他可用端口。以启动输出中的实际地址为准。同一工作目录重复启动会复用已有服务。

## 3. 创建第一份报告

1. 点击顶部 **目录**，再点 **新建报告**。
2. 填写 **报告标题**，选择 **编辑方式**，点 **创建**。
3. 创建后，在 **当前报告** 列表切换到它。
4. 双击正文中的示例文字，输入自己的内容并保存。

| 模板 | 适合什么 |
|---|---|
| 论文网页 · 连续阅读 | 论文、课程报告、较长文档 |
| 横版一页 · 展示报告 | 一页展示、实验数据分析、汇报稿 |
| LaTeX · 编译预览 | 已有 TeX 工作流、需要按 TeX 模板排版 |

报告目录通常是：

```text
工作目录/
├─ reports/
│  └─ 某份报告/
│     ├─ .latex-report.json
│     ├─ main.html
│     ├─ paper.css          # 取决于模板，也可能用内联样式
│     ├─ assets/            # 可自行添加的图片、图表
│     └─ exports/           # 导出的 PDF 和源码包
└─ .latex-workspace/        # 历史、草稿、运行状态和恢复记录
```

已有工程用 **注册已有目录** 登记，填写相对工作区的目录和入口文件。待注册文件应在当前工作目录内；登记不会搬动外部工程。

## 4. 界面入口

| 入口 | 用途 |
|---|---|
| 目录 | 切换、新建或注册报告，浏览文件/章节，查看修改历史 |
| 源码 | 编辑 HTML、CSS 或 TeX，也可选择源码交给 Codex |
| Codex | 启动同页终端，输入要求或发送当前选区 |
| 选择内容 | 在网页中选择段落、公式、图或表 |
| 刷新预览 | 重读网页或最新成功 PDF，保留阅读位置及其他面板 |
| 导出 | 输出 PDF、LaTeX 工程或源码包 |

侧栏会占用独立空间，正文随窗口调整。可拖动分隔条改变大小；窄窗口会改为上下排列。

顶部 **网页编辑 · main.html** 表示日常保存直接更新网页；**LaTeX · PDF** 表示预览来自 TeX 编译。

## 5. 修改文字、公式和排版

**文字：** 双击文字或标题编辑，按 Enter / Ctrl+S 保存，或点 **保存**。放弃本次修改时点 **取消改字**。HTML 改字后直接更新网页，不等待 TeX 编译。

**公式：** 双击可编辑公式，输入 LaTeX，查看实时结果再保存。例如：

```latex
q = \frac{1}{2}\rho V^2
```

源码也可声明公式块：

```html
<div class="equation" data-tex="q = \frac{1}{2}\rho V^2" data-display="block"></div>
```

公式编辑器用于 `data-tex` 块；已有复杂 HTML 公式可从源码修改，或选择后交给 Codex。

**样式与图片：** 展开 **源码**，从文件树选择 `main.html`、CSS 或对应资源。正文写在 HTML，字体、间距和图表大小通常在 CSS。图片路径相对于 HTML，例如 `assets/chart.svg`；资源应放在该报告目录内。

预览支持本地图片和 SVG，不运行报告脚本或外部请求。动态图表需先生成静态 SVG/图片，再放入报告。

## 6. 和 Codex 一起修改

### 开始对话

1. 展开 **Codex**，点击 **启动 Codex**。
2. 在终端里完成需要的目录信任或登录提示。
3. 直接输入要求并按 Enter 对话。

网页终端复用本机 Codex 登录，维护自己的对话记录。它与 Codex 桌面当前聊天分别维护会话。

### 只修改选中内容

1. 勾选预览区的 **选择内容**，点选段落、公式、图或表。
2. 核对目标卡片，确认选中了要改的内容。
3. 在终端下方的要求框填写修改要求。
4. 点 **发送给 Codex**，或按 Ctrl+Enter。

可直接使用这些要求：

> 只修改选中的段落，缩短到三句话，保留原来的数据和结论。

> 把选中图表的标题和坐标轴字体放大，保留所有数据点和单位。

> 只调整这个公式附近的说明，补充每个符号的含义。

要修改整份报告，先清除选区，确认目标卡片显示当前报告，再发送。例如：

> 把当前报告整理成一页横版展示稿，保留图表、数据和结论，正文使用较大的字号。

选区还在绑定、有未保存草稿或版本已变化时，先保存并重新确认目标。需要执行批准时，在终端内核对并确认。

**中断**发送 Ctrl+C，**结束**关闭该报告的终端。刷新可以重连，切换报告会恢复对应会话；回放长度有限，重要结论应写进报告。

## 7. 刷新、历史和撤销

通常保存后自动更新。需要重新读取磁盘时，点 **刷新预览**，无需刷新整个网页。HTML 刷新不编译；PDF 刷新读取最新成功构建，也不主动编译。

在目录面板查看 **修改历史**，找到记录后点 **撤销**。文件已有后续修改时，先核对当前稿件，避免覆盖新内容。

保存冲突会保留草稿。先查看磁盘新稿，再决定如何合并，完成后重新保存。

## 8. 导出 PDF 和源码

**推荐流程：** 保存全部修改 → **导出 → 导出 PDF**。工作台通过 Edge/Chrome 保留网页中的字体、颜色、SVG 和公式，排除侧边导航。连续论文输出 A4，横版保留设定页尺寸。

文件写入该报告的 `exports/`，界面会提示文件名。每次生成独立文件；已导出的 PDF 不会跟随后续改字更新，交付前重新导出一次。

**可选：LaTeX 排版 PDF** 会生成导出快照，再通过 Pandoc/TeX 排版语义标题、段落、表格、公式和图片。完整 CSS 外观使用主入口的网页 PDF。

交付原稿可选 **导出源码包**，交付生成的 TeX 工程可选 **导出 LaTeX 包**。

已有 `.tex` 报告先编译再预览。支持的正文可点 **编辑文字** 写回源码并重新编译；特殊宏、公式和引用从源码入口修改。

## 9. 备份、升级和卸载

备份整个工作目录，至少同时保留 `reports/` 和 `.latex-workspace/`。前者保存原稿/资源，后者保存历史、草稿和恢复信息。

更新时使用新发布页中TGZ的完整地址，例如：

```powershell
npm.cmd install -g https://github.com/weijiansh1/pdf-codex/releases/download/v0.2.1/copdf-0.2.1.tgz
```

先保存内容，启动新版前关闭旧服务。旧服务仍运行时，启动器会复用它，不会自动结束你的终端。具体步骤见 [安装与升级](https://github.com/weijiansh1/pdf-codex/blob/main/docs/installation.md)。

卸载命令程序：

```powershell
npm.cmd uninstall -g copdf
```

报告保存在自己的工作目录里，卸载命令程序不会删除这些文件。

## 10. 常见问题

| 现象 | 先做什么 |
|---|---|
| PowerShell 提示无法运行脚本 | 使用本文的 `npm.cmd` 和 `copdf.cmd` |
| 找不到 `copdf.cmd` | 确认安装完成，再重新打开终端 |
| 网页没有自动打开 | 执行 `copdf.cmd --no-open`，手动打开输出的地址 |
| 导出找不到浏览器 | 安装 Edge/Chrome，或用 `LATEX_BROWSER_EXECUTABLE` 指定 |
| Codex 无法启动 | 检查 CLI 和登录，查看终端错误；可用 `LATEX_CODEX_EXECUTABLE` 指定 |
| 修改后没有更新 | 先保存再刷新预览，核对当前报告和入口文件 |
| 列表里没有原报告 | 核对 `--workspace` 是否指向原工作目录 |
| PDF 仍是旧内容 | 保存草稿、重新导出，并打开刚提示的新文件 |

更多环境问题见 [故障排查](https://github.com/weijiansh1/pdf-codex/blob/main/docs/troubleshooting.md)。反馈时附软件版本、操作步骤和相关错误，只分享问题所需的报告片段。

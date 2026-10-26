# 安装与升级

安装后的完整流程见 [coPDF使用说明](usage.md)：新建报告、直接改字、公式、Codex选区修改、导出与备份。

## npm 命令安装

安装 Node.js 24+ 后执行：

```powershell
npm.cmd install -g copdf
```

进入报告工作目录，运行 `copdf.cmd`。默认读取当前目录，不在全局安装目录存报告。也可传 `--workspace "D:\我的报告"`、`--no-open`、`--help` 或 `--version`。运行包为Windows x64，依赖已经打包，不需要Git或npm登录。终端可直接运行脚本时，也可用 `copdf`。

更新时执行 `npm.cmd install -g copdf@latest`；先保存内容并关闭原服务，再运行命令。卸载用 `npm.cmd uninstall -g copdf`，报告仍在原工作目录。

## Windows x64 运行包

从 [v0.2.0 发布页](https://github.com/weijiansh1/pdf-codex/releases/tag/v0.2.0) 下载ZIP。安装Node.js 24+，完整解压，再双击启动器。无需下载源码或安装npm依赖。

工作台优先使用 `http://127.0.0.1:4317`，端口已占用时会选择可用端口，启动窗口输出实际地址。只监听本机回环地址。

双击启动器使用解压目录保存报告；也可执行 `node start.mjs --workspace "D:\我的报告"`。指定目录须已存在。`--no-open` 只启动服务并输出地址，不打开浏览器。启动器使用自身所在位置查找程序，不依赖终端当前目录。

## 首次写报告

1. 展开“目录”，新建论文网页或横版报告。
2. 双击文字编辑，Enter / Ctrl+S 保存；公式块可填写 LaTeX 公式。
3. 展开“Codex”，点击“启动 Codex”，在终端完成需要的登录或信任提示。
4. 在网页勾选“选择内容”，点选要改的内容后发送要求；也可以要求修改整份报告。
5. 点“导出 → 导出 PDF”，文件写入该报告的 `exports/`。

## 可选环境变量

| 变量 | 用途 |
|---|---|
| LATEX_BROWSER_EXECUTABLE | Edge/Chrome 可执行文件绝对路径 |
| LATEX_CODEX_EXECUTABLE | Codex CLI 可执行文件绝对路径 |
| LATEX_PDFTOPPM_EXECUTABLE | Poppler pdftoppm 路径 |
| LATEX_PDFINFO_EXECUTABLE | Poppler pdfinfo 路径 |
| LATEX_REPORT_WORKSPACE | 可移植包 MCP 入口使用的工作目录 |

环境变量只影响对应进程。浏览器启动器用 `--workspace` 选择目录。插件宿主还需提供 `PLUGIN_ROOT`；原生 MCP Apps 安装和界面桥接没有作为首发主要入口验收。

## 备份与升级

关闭编辑并保存草稿后，备份完整的 `reports/` 和 `.latex-workspace/`。后者包含事务恢复及历史，不能只备份 PDF。

将新版本解压到新目录；先关闭旧服务，再以 `node start.mjs --workspace "原工作目录"` 启动。若旧服务仍运行，启动器会复用它，不会强制结束终端或替换运行中的代码。工作台没有自动升级服务。

## 源码安装

仓库根目录执行 `npm ci`、`npm run build`、`npm run workbench`。双击仓库内的启动器需要先完成安装和构建。可选 TeX、Pandoc 和 Poppler 不随运行包分发。

首发运行包为 Windows x64；其他系统从源码构建，需按平台安装浏览器、Codex 和可选排版工具。跨平台构建不等于该平台已经完成实际使用验收。

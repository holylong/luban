# luban

<p align="center">
  <img src="docs/assets/luban-logo.png" alt="luban Logo" width="480" />
</p>

luban 是一个 AI 分布式通用助手：通过 Mesh 自动发现局域网节点、同步项目文件，将任务交给其他电脑执行并跟踪远程进度与结果。它能读代码、改文件、运行命令，把一个想法做到能运行、能验证；终端、桌面和浏览器都能用，也支持手机远控。

![luban 终端界面：对话、功能介绍与任务执行状态](docs/luban.png)

## 亮点

- **执行过程看得见**：任务计划、命令输出，以及每处改动的文件路径、行号和前后对比。
- **多端可用**：终端 TUI、桌面 App、浏览器工作台，共享同一个项目与同一套会话。
- **多台电脑协作**：自动发现局域网节点，把任务交给其他电脑执行并同步项目文件。
- **手机远控**：用手机浏览器或 Android 客户端下发任务、查看进度、确认操作。
- **模型自由**：云端与本地模型、OpenAI 兼容、Anthropic、Responses，也可复用 Codex 账号。
- **按需扩展**：技能、MCP 与编辑器集成。

## 安装

| 平台 | 下载 | 启动 |
| --- | --- | --- |
| Linux x64 / arm64 | `luban-cli_<版本>_<arch>.deb`<br>`luban-desktop_<版本>_<arch>.deb` | `luban`<br>`luban-desktop` |
| Windows x64 | `luban-cli-<版本>-win-x64.zip`<br>`luban-desktop-<版本>-win-x64.zip` | `luban.cmd`<br>`luban-desktop.cmd` |
| macOS x64 / arm64 | `luban-cli-<版本>-mac-<arch>.zip`<br>`luban-desktop-<版本>-mac-<arch>.zip` | `./luban`<br>打开 `luban Desktop.app` |

安装包都自带 Node.js，解压或安装后即可运行。macOS 首次打开若被 Gatekeeper 拦截，执行 `xattr -dr com.apple.quarantine .`。

从源码安装（Node.js 20 或更高版本）：

```bash
npm install
npm run build
npm link
```

## 快速开始

```bash
luban                                              # 在当前项目启动
luban /path/to/project                             # 指定项目
luban . --yes --prompt "运行测试并修复失败"         # 一句话跑一次任务
```

启动后直接输入任务，例如「解释这个项目的入口」。执行中还能继续补充要求，或用 `/queue <任务>` 排队。

常用命令：`/models` 选模型 · `/sessions` 恢复会话 · `/diff` 看改动 · `/export` 导出记录 · `/skin` 换皮肤 · `/report weekly` 生成周报 · `/help` 查看全部命令。

## 配置模型

全新安装即可在 `/models` 里选择内置 provider（codex、opendesign、opencode-go / zen、deepseek、dashscope，以及本地 Qwen / Strata）。密钥用环境变量或 `~/.luban/config.json` 提供，可参考 [配置示例](config.example.json)。

- Open Design：设置 `OPEN_DESIGN_API_KEY`，选择 `opendesign/gpt-6-luna` 等模型
- OpenCode Go / Zen：设置 `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`
- 自定义 OpenAI 兼容接口：配置 `base_url`、`api_key_env` 与 `models`
- Codex 账号：安装官方 Codex CLI 后运行 `luban login codex`，再选择 `codex/default`（默认直连 Codex 后端，比每次启动 `codex exec` 快数倍；`LUBAN_CODEX_MODE=cli` 可退回旧行为）

协议切换（Responses / Messages）、内置模型清单、额度与重连等细节见 [详细参考](docs/reference.md#配置)。

## 桌面代码工作台

从源码构建后运行 `npm run desktop -- /path/to/project`，或打开安装包中的 luban Desktop。通过菜单「文件 → 打开项目文件夹」切换工作区。

- **文件浏览与编辑**：左侧文件树、中间多标签文本编辑器、行号、Tab 缩进；`⌘/Ctrl+P` 搜索文件，`⌘/Ctrl+S` 保存，`⌘/Ctrl+W` 关闭标签。快速打开最多索引 5000 个文件，跳过 `.git`、`node_modules`、`dist`。
- **保存保护**：未保存内容显示圆点，关闭、刷新或切换项目时确认；保存前校验磁盘版本，拒绝覆盖外部修改。冲突时先复制需要保留的内容，再选择「重新读取磁盘」。仅支持现有的 UTF-8 文本文件（最多 1 MB），不编辑符号链接或二进制文件。
- **命令控制台**：底部「命令 $」输入框输入命令，按 Enter 或点击「运行」执行；输入行固定保留，打开控制台时自动聚焦。若显示「未检测到桌面连接」，请使用或重启 luban Desktop（浏览器预览不支持执行本机命令）。实时查看标准输出、错误输出、退出状态；默认按 Markdown 展示结论、表格及代码块，宽表格横向滚动，可切换「原始输出」保留日志换行与空格。可停止进程并回看命令历史；`⌘/Ctrl+反引号` 折叠。命令以当前用户权限在项目目录执行，**不是安全沙箱，也不是交互式 PTY 终端**；不要运行不可信命令。最多并行 3 个命令，单命令输出达到 1 MB 自动停止；切换项目或退出时清理子进程。
- **桌面主题**：左侧项目下方的「主题」下拉复用 CLI `/theme` 的完整配色目录（含深色与浅色），选择后编辑器、对话、控制台、审批和修改对比立即一起换色。偏好保存到同一份 `node-preferences.json`，桌面刷新/重启及下次 CLI 启动沿用；运行中的另一客户端不会被强制刷新。配置里的 `theme.colors` 覆盖仍保留。仅移植配色，不包含终端专用加载动画。
- **选择模型与推理强度**：输入框工具栏提供模型下拉；支持原生推理强度的模型旁显示 `Default / low / medium / high` 等档位，Codex 按模型提供 `xhigh / max / ultra` 等选项。不支持的档位不显示且服务端拒绝提交。选择按模型写入 `node-preferences.json`，下一轮生效，刷新和重启后保留；不影响已经运行的一轮。切到未配置密钥的模型时任务会报错，不会静默回退。
- **连续会话**：桌面左侧只保留「文件 / 会话」，执行轮次按 `session_id` 合并，不再每条指令新增一条菜单项。点击会话后，右侧同一条可滚动时间线同时显示历史与本轮执行，不再切换「会话 / 运行」页签。下方输入框续写同一份记录，只有「＋ 新会话」或 `⌘/Ctrl+K` 才新开上下文。执行中对话随新内容和工具记录增高自动跟随到底部；手动向上翻阅暂停跟随，回到底部恢复。执行中可草拟消息，当前一轮结束或停止后再发送，避免并发覆盖会话。空草稿不会显示。
- **代码修改与助手协作**：中间工作区通过「代码 / 当前修改」标签共享同一块区域，不再上下分屏。收到新的编辑记录时自动展示当前这次修改的文件（路径、增删数、行号、前后内容），下一次修改会替换当前展示，不汇总此前文件或历史会话的修改。点击代码标签或打开文件可返回编辑器。编辑器始终保持挂载，未保存内容不会因切换丢失；对比只读。所有文件的完整编辑记录仍保留在右侧 Agent 中，历史会话重新打开后也能查看。编辑区可让助手检查当前文件；未保存内容不会自动发送给模型，请先保存。底部「任务信息」保留执行日志。

这是桌面 IDE 的首版基础能力，目前使用轻量文本编辑器，尚不包含 Monaco/LSP 补全、断点调试、完整交互终端与跨重启编辑缓冲区恢复。浏览器端不会获得桌面文件写入和命令 IPC 权限。

## 浏览器与脚本

```bash
luban web /path/to/project --host 127.0.0.1 --port 8642   # 打开 http://127.0.0.1:8642/
luban . --prompt "解释这个项目的入口"                      # 只读的脚本模式
```

## 更多

皮肤与加载宠物、日报 / 周报 / 月报、局域网协作、手机远控、插件与编辑器接入、完整配置与开发验证，见 [详细参考](docs/reference.md)。

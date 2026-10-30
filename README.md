# luban

<p align="center">
  <img src="docs/assets/luban-logo.png" alt="luban Logo" width="480" />
</p>

luban 是一个 AI 通用助手：读代码、改文件、运行命令，把一个想法做到能运行、能验证。终端、桌面和浏览器都能用，多台电脑与手机也能一起协作。

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

## 浏览器与脚本

```bash
luban web /path/to/project --host 127.0.0.1 --port 8642   # 打开 http://127.0.0.1:8642/
luban . --prompt "解释这个项目的入口"                      # 只读的脚本模式
```

## 更多

皮肤与加载宠物、日报 / 周报 / 月报、局域网协作、手机远控、插件与编辑器接入、完整配置与开发验证，见 [详细参考](docs/reference.md)。

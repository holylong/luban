# luban

Node.js/TypeScript 版 luban。它使用 Ink 渲染风格的终端工作台，原生实现了
Python luban 的局域网发现、节点通信、远程任务和工作区同步。

需要 **Node.js 20 或更高版本**。模型侧支持 OpenAI 兼容的 Chat Completions、
Anthropic Messages、Responses API，以及通过官方 Codex CLI 使用 ChatGPT 订阅账号；交互侧提供交互式 TUI、非交互 `--prompt`
和浏览器工作台三种入口，共用同一套会话与 Mesh job 存储。

### ChatGPT Plus 登录 Codex

先安装官方 Codex CLI，使 `codex` 在 PATH 中可用。运行 `luban login codex`，在浏览器中用 ChatGPT Plus 账号完成登录。新配置可参考 [config.codex.example.json](config.codex.example.json)；如果已有 `~/.luban/config.json`，只需将其中的 `model` 字段改为：

```json
{
  "model": {
    "active": "codex/gpt-6-sol",
    "reasoning_effort": "xhigh"
  }
}
```

`active` 选择模型，`reasoning_effort` 是该模型的二级推理强度，可写 `low`、`medium`、`high`、`xhigh`、`max`，支持的模型还可选 `ultra`；省略时使用 Codex CLI 的默认设置。运行 `luban` 即按配置启动，也可用 `luban --model codex/gpt-6-sol` 临时指定模型。在 TUI 中输入 `/models`，先选择 Codex 模型，再选择推理强度；选择结果会保存到 `~/.luban/node-preferences.json`，供下次启动使用。内置模型有 `codex/default`、`codex/gpt-6-astra`、`codex/gpt-6-sol`、`codex/gpt-6-luna`，实际可用性以账号和 Codex CLI 为准；也可用 `codex/<模型名>` 指定 CLI 支持的其他模型。

`codex/default` 使用 `~/.codex/config.toml` 中的默认模型；未在 luban 中设置 `reasoning_effort` 时，也使用其中的默认推理强度，例如 `model_reasoning_effort = "high"`。`LUBAN_CODEX_EFFORT=xhigh luban` 可覆盖本次进程的推理强度。这个后端复用 Codex CLI 的登录状态，无需 OpenAI API key；登录失效时重新运行 `luban login codex`。当前每次模型调用会启动一次 CLI，回答在调用完成后显示，暂不支持图片附件。

在 TUI 中，`/status` 显示当前模型、会话上下文估计和 ChatGPT Codex 额度剩余比例、重置时间、可用重置卡数量；`/status <peer>` 查询 mesh 节点。`/usage` 显示额度和每日 token 活动，`/usage weekly` 和 `/usage cumulative` 可切换统计周期。`/usage reset` 会先显示确认界面；按 Enter 才尝试使用一张可用重置卡，Esc 取消。请求完成后会重新读取额度。额度、用量和重置卡通过官方 Codex App Server 获取，不读取或复制本地登录令牌。

## 目录

- [特性总览](#特性总览)
  - [终端工作台（TUI）](#终端工作台tui)
  - [Agent 运行时](#agent-运行时)
  - [工具、权限与安全](#工具权限与安全)
  - [代码智能与项目规则](#代码智能与项目规则)
  - [局域网协作（Mesh）](#局域网协作mesh)
  - [Web 工作台](#web-工作台)
  - [集成（MCP / 编辑器 / 兼容）](#集成mcp--编辑器--兼容)
- [安装](#安装)
- [配置](#配置)
- [日常交互](#日常交互)
- [运行时的实时反馈](#运行时的实时反馈)
- [速度与规划](#速度与规划)
- [局域网协作](#局域网协作)
  - [远程任务和本地任务一样可见](#远程任务和本地任务一样可见)
  - [排障](#排障)
- [原生 Web 后台](#原生-web-后台)
- [手机远控：服务器、节点与 Android 客户端](#手机远控服务器节点与-android-客户端)
- [脚本模式](#脚本模式)
- [运行中补充指令](#运行中补充指令)
- [代码导航与项目规则](#代码导航与项目规则)
- [长任务与恢复](#长任务与恢复)
- [插件与编辑器接入](#插件与编辑器接入)
- [安全边界](#安全边界)
- [开发验证](#开发验证)
- [项目结构](#项目结构)

## 特性总览

### 终端工作台（TUI）

- `AUTO` / `AGENT` / `ASK` 三种工作模式，`Shift+Tab` 直接切换。
- **单一记录流**：对话、工具调用、文件编辑与状态提示按真实发生顺序排成一条时间线，共用一个滚动位置；不再是"对话窗口 + 执行详情窗口"两块拼接，结论也不再重复置顶，`/details` 只控制工具输出的完整程度。
- 输入框支持多行：粘贴整段文本会原样进入（`\r\n`/`\r` 统一为换行、制表符展开为空格），`Ctrl+J` 或 `Shift+Enter` 换行，`Enter` 提交。输入框高度受屏幕约束（最多约屏幕的 1/3），并随光标滚动，长文本粘贴后再也不会把光标和尾部顶出屏幕；多行时光标可用 ↑↓ 移动，单行时 ↑↓ 仍是历史召回。工作中可继续输入补充指令，`/queue` 排队下一任务，待处理消息随会话保存。
- 鼠标滚轮、**拖动右侧滚动条**或 `PageUp`/`PageDown` 翻阅整条历史。滚动条常驻在主面板右缘（`│` 轨道、`█` 滑块）：按住拖动即按比例滚动，点击轨道上下翻页，滑块位置与百分比读数始终反映当前视口。复制输出有三种方式：**在输出区拖选、松开即复制**（选中行高亮且保留语法颜色，和 opencode 一样）；`Ctrl+Y` 复制上次回答（运行中也可用）；`/copy` 复制回答与最近工具记录。按住 `Shift` 拖选则走终端原生选区。滚动位置经过钳制，不会出现“滚过头后要往回滚很多格才动”的空转。
- `/plan` 显示任务计划面板，`/verify` 打开验证记录面板（逐条列出测试命令、通过/失败、输出摘要，并显示计划验证门禁状态），`/pending` 查看待处理指令，`/diff` 查看工作区 Git 变更；退出/切换会话会清理受管理的后台进程。
- `/` 命令发现、Tab 补全、`Ctrl+P` 模型选择、`Ctrl+O` 会话选择。
- `!command` 直接 shell，不经过模型。
- JSON 会话持久化、最近会话选择器与 `--resume` 恢复。

### Agent 运行时

- OpenAI-compatible Chat Completions + SSE 流式响应，以及原生 Anthropic Messages；支持多 provider/多模型。
- 工具循环：文件读写、精确编辑、glob、grep、目录、shell。
- 严格检查 SSE 完成标记、错误事件、输出截断和工具参数，断流不会误报成功；连接在输出中途断开时保留已收到内容并让模型接着写，不再丢掉整段回答。
- 通用 Agent runtime：任务内上下文压缩（含工具定义预算）、瞬时错误退避重试、并行只读工具调用；网关漏传的 DeepSeek XML 风格工具调用会被还原成真正的调用而不是当作正文。
- 压缩通知只在一次任务首次丢弃历史时写入记录（`Compacted N older messages`），之后每一步的再次压缩只更新工作行里的累计条数；否则长任务会把「Compacted 2 older messages」按步数刷满整条历史。
- **并行只读工具**：同一条消息里连续的只读调用（读文件、搜索、列目录等）真正并发执行，写与 shell 保持严格串行；结果仍按调用顺序写入记录。
- `update_plan` / `read_plan` 维护任务计划，`record_verification` / `read_verification` 记录测试命令与通过状态；计划与验证随会话保存、压缩保留，未验证成功会明确标注。`@截图.png` 以原生视觉部件发给视觉模型（OpenAI/Anthropic/Responses 三客户端全支持，8MB 上限，会话只存路径）。
- 大工具结果自动归档（`tool_output.retention_days`/`max_bytes` 自动清理，默认 7 天/500MB），`read_tool_output` 按页回读，避免为找回日志重复执行命令。
- 可选会话历史镜像（`history.enabled`）：把每条消息追加进 SQLite，用 `luban history` 或 `GET /api/history` 检索历史，会话 JSON 始终是权威记录。
- CLI/TUI 在工具调用前后保存进度；中断后恢复会补齐消息协议并标注执行状态未知。

### 工具、权限与安全

- 显式 ASK 在运行时限制为只读，即使 `--yes` 也不放行写入、shell、网络和委派。
- **非零退出码按数据返回**：`bash` 结果以 `[exit code: N]` 标记，不再把 `grep` 未命中、`git diff --quiet`、`test -f` 这类正常非零退出报成 TOOL ERROR；只有命令真的跑不起来（超时、被杀、沙箱拦截、spawn 失败）才算工具失败。
- 交互审批带超时（默认 600 秒，可配置），无人应答会明确拒绝而不是无限挂起；默认权限模式为 `edits`（工作区内改文件不再逐次询问，shell 与网络仍会询问），审批界面里按 `a` 可在本次会话内不再询问。
- `allow` / `deny` 持久权限规则；deny 规则始终优先于会话信任。
- 写入、shell 和网络工具只需一次会话信任确认；`--yes` 可直接关闭询问。`bash` 带软沙箱：拦截毁灭性命令、工作区外写入/重定向和自定义 deny，可选禁用网络与 `bwrap` 后端（非 OS 容器，见[安全边界](#安全边界)）。
- 安全统一 diff、免授权 Git 上下文、后台命令查询/终止和独立上下文子 Agent。
- 不创建 commit 的 Git 工作树 checkpoint/revert（含未跟踪文件，50 MiB 安全上限）。
- `bash pty:true` 经 `script(1)` 分配真 PTY（`[ -t 1 ]` 为真，curses/进度条可用；前台限定，与 OS 沙箱后端互斥）。`delegate_task` 支持 `use_worktree` 把写任务隔离到临时 git worktree，`auto_merge` 自动合入（冲突文件存 `.luban/conflicts/` 双副本），`delegate_tasks` 可并行运行 2～4 个只读研究/审查子 Agent；子任务步数计入父任务总预算，父取消会回收。
- 原生 `web_fetch`（HTML 文本化、超时和 2 MiB 响应上限）。

### 代码智能与项目规则

- `code_intelligence`：TS/JS 语言服务（含 project references 展开）+ 可配置 LSP（`lspServers`，诊断支持 pull/push）+ `scope_glob` 单体仓分片 + 超时/`max_results`预算 + 可选子进程隔离（`code_intelligence.worker`，卡死可杀不影响主进程）。
- 文件工具按路径加载子目录 AGENTS.md/CLAUDE.md；首次或规则变更时先让模型阅读再编辑。

### 局域网协作（Mesh）

- 原生 LAN Mesh：UDP 广播/组播发现、静态联系人、HMAC 鉴权和重放防护；收到的和交接出去的远程任务都在主流程里展开完整执行过程（计划、模型调用、工具、内联改动记录）。
- Python 兼容的 TCP 帧协议、持久化远程 job、租约续期、超时和取消。
- `git`/分块两种工作区同步、SHA-256 校验、三方合并和冲突副本。
- Agent 可直接调用 `mesh_get_peers`、`mesh_handoff`、`mesh_ask_all`、`mesh_sync_*`。

### Web 工作台

- 原生 HTTP 后台和浏览器工作台：节点、peers、jobs、workspace、sync、chat、contacts API。
- React + Vite 浏览器工作台：事件流（SSE）实时转录、工具调用卡片、内联编辑记录（文件路径 / 增删计数 / 行号，左右对比：左侧删除、右侧新增）、Markdown 与代码高亮、文件查看器、Git 变更视图、会话浏览、工作区文件树。
- Web 端交互审批：写文件、shell、网络工具会在此页面等待允许/拒绝，审批内容含工具名、风险与参数；`--web-port` 同时把审批带到浏览器。
- `web`/`serve` 守护模式，或让 TUI 通过 `--web-port` 同进程提供 Web 服务。
- 手机远控：同一局域网可直连电脑，异地可通过公网中继与节点拨出隧道；Android APK 或浏览器 `/m/` 控制台都能下发指令、看实时状态、审批与取消。

### 集成（MCP / 编辑器 / 兼容）

- 工作区/用户级 `SKILL.md` 技能，以及标准输入输出型 MCP Server 桥接；仓库自带[股票持仓监控场景插件](plugins/stock-monitor/README.md)。
- stdio 与 Streamable HTTP MCP，支持持久 session、SSE 响应和自定义认证 headers；`mcpMaxTools`/`mcp.lazy` 控制 schema 预算，`mcp_search_tools` 按需检索，`read_image` 报告视觉能力。
- 编辑器接入：`luban acp` 以 stdio 提供 Agent Client Protocol，配套 VS Code 扩展见 `editors/vscode/`。
- 可选保留 `--backend`，用于兼容旧的 Python Web API 自动化。
- 非交互 `--prompt` 模式，适合脚本和 CI。

## 安装

### Linux 桌面安装包（x64 / arm64）

Linux 安装包按用途命名，选对应架构即可：

| 文件名 | 安装后入口 | 内容 |
| --- | --- | --- |
| `luban-cli_<版本>_<架构>.deb` | `luban` 或 `luban-cli` | 终端 Agent，内置 Node.js |
| `luban-desktop_<版本>_<架构>.deb` | 应用菜单中的 luban Desktop，或 `luban-desktop` | 图形工作台，内置 Node.js 和 Electron |

双击 `.deb` 安装，或运行 `sudo apt install ./release/luban-cli_<版本>_<架构>.deb` / `sudo apt install ./release/luban-desktop_<版本>_<架构>.deb`。两个安装包可以同时安装。桌面版左侧是项目文件树，中间是带行号和语法高亮的只读代码预览，右侧是 Agent 对话与执行记录。首次启动默认打开家目录；菜单「文件 → 打开项目文件夹」（`Ctrl+O`）可选择项目，之后会记住上次项目。也可以执行 `luban-desktop /path/to/project`。

维护者在 Linux 上运行 `npm ci && npm run package:linux`，会在 `release/` 同时生成两种安装包；也可以单独运行 `npm run package:linux:cli` 或 `npm run package:linux:desktop`。源码开发时可先 `npm run build`，再用 `npm run desktop -- /path/to/project` 启动桌面版。桌面图标使用与 Android App 相同的 L 形标识，Web/PWA 图标也保持一致。

### 从源码安装

需要 Node.js 20 或更高版本。

```bash
cd luban
npm install
npm run build      # 服务端 tsc + 前端类型检查 + vite 打包，可用 scripts/build.mjs 单独运行
npm link
```

`npm run build` 由 `scripts/build.mjs` 驱动，跨平台且分两步：服务端编译（必需）与浏览器
工作台打包。若 `vite`/`react-dom` 未安装，构建会给出明确提示并跳过前端，服务端照常产出，
浏览器端回退到内置单文件控制台。可用 `npm run build:server` / `npm run build:web` 单独执行。

前端工作台源码在 `src/web/client/`，构建产物输出到 `dist/web-ui/`（与 TypeScript 的
`dist/web/` 分开，避免互相覆盖）。只改前端时可以用：

```bash
npm run build:web        # 只重新打包前端
npm run dev:web          # Vite 开发服务器，/api 代理到 127.0.0.1:8642
npm run typecheck        # 服务端 + 前端类型检查
```

前端不依赖 `@vitejs/plugin-react`：Vite 内置的 esbuild 已能按 automatic JSX runtime
编译 TSX，少一个插件就少一条会在 `npm install` 阶段引发 peer 冲突的依赖边。代价是
`npm run dev:web` 下修改组件会整页刷新，而不是 Fast Refresh 保留组件状态。

安装后：

```bash
# 在项目目录里直接启动，进入交互 TUI（类似 opencode）
luban
# 也可以显式指定其他工作区
luban ~/dev/my-project --resume
luban . --model deepseek/deepseek-chat
luban . --mesh-name build-linux --mesh-port 7890
```

不想全局 link 时，可以直接：

```bash
npm run dev -- ~/dev/my-project
node dist/cli.js ~/dev/my-project
```

## 配置

默认读取 `~/.luban/config.json` 和工作区下的 `.luban/config.json`。下面的格式
与 Python luban 兼容：

```jsonc
{
  "node": {
    "name": "build-linux",
    "host": "0.0.0.0",
    "port": 7890,
    "udp_port": 7891,
    "capabilities": ["shell", "files", "agent", "linux"]
  },
  "model": { "active": "local/qwen3-coder", "max_tokens": 64000 },
  "providers": {
    "local": {
      "options": {
        "baseURL": "http://127.0.0.1:8000/v1",
        "apiKey": "sk-local"
      },
      "models": {
        "qwen3-coder": { "name": "Qwen3 Coder" }
      }
    },
    "deepseek": {
      "api_key_env": "DEEPSEEK_API_KEY",
      "base_url": "https://api.deepseek.com/v1",
      "models": ["deepseek-chat"]
    },
    "responses": {
      "api": "responses",
      "base_url": "https://api.openai.com/v1",
      "models": ["gpt-5"]
    },
    "anthropic": {
      "api": "anthropic",
      "api_key_env": "ANTHROPIC_API_KEY",
      "base_url": "https://api.anthropic.com/v1",
      "models": ["claude-sonnet-4-20250514"]
    }
  },
  "contacts": [
    { "name": "win-testbox", "host": "192.168.1.30", "port": 7890, "udp_port": 7891 }
  ],
  "mesh": { "token_env": "LUBAN_MESH_TOKEN" },
  "permission": {
    "allow": ["bash:git *", "bash:npm test*"],
    "deny": ["bash:rm -rf *", "write_file:.env"]
  },
  "sandbox": { "mode": "soft", "allowNetwork": true, "allowOutsideWorkspace": false, "backend": "auto", "docker_image": "", "deny": ["kubectl.*prod"] },
  "lspServers": { "python": { "command": "pyright-langserver", "args": ["--stdio"], "languages": ["python"] } },
  "code_intelligence": { "worker": false },
  "tool_output": { "retention_days": 7, "max_bytes": 524288000 },
  "history": { "enabled": false, "directory": "", "max_messages_per_session": 0 },
  "mcp": { "max_tools": 64, "lazy": false },
  "mcpServers": {
    "filesystem-extra": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/opt/shared"],
      "env": {},
      "trusted": true
    },
    "remote-tools": {
      "url": "https://tools.example.com/mcp",
      "headers": { "Authorization": "Bearer replace-me" },
      "trusted": true
    }
  },
  "sync": {
    "mode": "auto",
    "chunk_size": 65536,
    "conflict_policy": "auto"
  },
  "projects": {
    "myapp": "/srv/work/myapp"
  },
  "max_workers": 2,
  "job_timeout_seconds": 600,
  "queue_timeout_seconds": 300,
  "theme": "nord"
}
```

`theme` 可以是配色 id（`midnight` / `nord` / `dracula` / `sakura` / `bordeaux` / `plum` /
`gruvbox` / `tokyo-night` / `catppuccin` / `amber` / `contrast` / `solarized-dark` /
`solarized-light` / `github-light`），也可以是别名（`default` / `dark` / `light` /
`high-contrast` / `solarized` / `tokyo` / `crt` / `樱花粉` / `酒红` / `梅子紫`）。只想改
个别颜色时用对象写法，只覆盖写出的键，其余沿用该配色：

```jsonc
{ "theme": { "id": "tokyo-night", "colors": { "accent": "#7aa2f7", "dim": "#8b93b8" } } }
```

配色优先级：`--theme` > `LUBAN_THEME` > `/theme` 保存的选择（`~/.luban/node-preferences.json`）
> `config.json` 的 `theme`。TUI 里用 `/theme` 打开选择器可以对着色块挑；换配色即时生效，
不需要重启。

模型相关的可靠性参数也可以放在 `model` 中：`context_window`（默认 128K）、
`context_reserve`（默认 16K）、`semantic_compaction`（默认开启）和 `max_retries`（默认 3）。MCP 当前支持标准的 stdio
JSON-RPC server。标记为 `trusted` 的服务保持持久连接，其工具会以 `mcp_<server>_<tool>`
直接注册给模型；未信任服务只能在用户批准后通过 `mcp_list_tools` / `mcp_call` 使用。

长时间运行的 shell 命令会使用 `bash` 的 `background` 参数，并由
`get_background_task` / `stop_background_task` 管理。技能与插件的发现路径见
[插件与编辑器接入](#插件与编辑器接入)。

配置优先级：CLI `--model` > `LUBAN_MODEL` > Node 偏好 > `model.active`。
`~/.luban/config.json` 可以由 Python 和 Node 两个版本直接共用。设置了 Mesh token 时，
所有节点必须使用相同的 `LUBAN_MESH_TOKEN`。
完整示例见 [config.example.json](config.example.json)，其中 `model.active` 已选择 Codex；
只需 Codex 登录和模型设置时，使用 [config.codex.example.json](config.codex.example.json)。

### OpenCode Go

luban 内置 `opencode-go` provider：只要在本机找得到 OpenCode 的凭据（`OPENCODE_API_KEY`
环境变量，或 OpenCode 在 `$XDG_DATA_HOME/opencode/auth.json`（旧版为 `account.json`）里
保存的 `opencode-go` key），就会自动注册订阅里的模型，无需手写配置。用 `Ctrl+P`
选 `opencode-go/kimi-k3` 这类 id 即可，也可以在 `model.active` 里写死。

Go 订阅的模型走同一个 base URL，但分属三种协议：多数是 OpenAI 兼容的
`chat/completions`，`@ai-sdk/anthropic` 模型（如 `qwen3.8-flash`、`minimax-m3`）走
Messages，`@ai-sdk/openai` 模型（GPT / Grok / Muse Spark）走 Responses。luban 按模型
自动选择，配置里给单个模型写 `"api": "anthropic" | "responses" | "openai"` 也能覆盖。
GPT Luna 这类推理模型不接受显式 `temperature`，内置定义用
`"capabilities": { "temperature": false }` 标注，luban 会省略该字段；自己配置模型时
同样可以这样写。请求还需要带上 `x-opencode-session` 头，内置 provider 已自动附上；
自己配置时照 `config.example.json` 写上即可。要退回自己的 key，直接在 `providers`
里定义同名 `opencode-go`，它会覆盖内置定义。

## 日常交互

| 操作 | 作用 |
|---|---|
| `Shift+Tab` | 循环切换 AUTO / AGENT / ASK |
| `Ctrl+P` | 打开模型选择器 |
| `Ctrl+O` | 打开会话选择器 |
| `Ctrl+Y` | 复制上次回答到剪贴板（运行中也可用）；任意输出用终端 `Shift+拖选` 原生复制 |
| `Ctrl+J` | 在输入框插入换行，多行任务/贴代码用 |
| `@path` | 文件补全（Tab）+ 提交时自动附带内容，最多 5 个 |
| 底栏 `ctx` | 当前会话 token 占上下文窗口比例，≥85% 变红 |
| `↑` / `↓` | 召回本次输入历史 · `resume`/切换会话后仍可从用户消息恢复 |
| `PgUp` / `PgDn`（上翻也可用 `Ctrl+K`） | 翻阅历史消息或执行详情 |
| `Esc` | 取消当前 Agent 运行 |
| `/new` | 新会话 |
| `/clear` | 清空当前对话并开始新会话（先保存，等同 `/new`） |
| `/mode auto\|agent\|ask` | 切换工作模式 |
| `/models` / `/sessions` | 打开对应选择器 |
| `/queue <任务>` | 当前任务结束后再执行；空闲时立即开始 |
| `/pending` | 查看保存在当前会话中的待处理消息（运行中补充指令也会显示在正文区） |
| `/copy` | 复制上次回答 + 最近工具结果（OSC52 直达剪贴板，另存 `~/.luban/last-copy.md`） |
| `/export [文件名|路径]` | 导出当前会话为 Markdown，含元信息、逐文件改动摘要表、每处改动的行号与前后内容、任务计划与验证门禁、验证记录（失败输出也会保留）以及完整对话（默认当前目录 `luban-export-<项目>-<sessionId>.md`；可指定文件名或路径，省略 `.md` 会自动补全，运行中也可用） |
| `/plan` | 显示或隐藏任务计划面板（含验证状态） |
| `/verify` | 打开验证记录面板（测试命令、通过/失败、输出摘要与门禁状态） |
| `/details` | 展开或收起执行详情 |
| `/diff` | 查看工作区 Git 变更（文件列表 + unified diff） |
| `/branch [n]` | 分叉当前会话，保留前 n 条非系统消息（工具断点自动修复） |
| `/theme [名称]` | 切换配色；不带参数打开选择器：`↑`/`↓` 逐行预览（整个界面即时换色，含色块与 `当前` 标记），列表超过一屏时随光标滚动并提示还有多少个配色，`Enter` 确认并写入 `~/.luban/node-preferences.json`，`Esc` 放弃预览恢复原配色。名称支持别名如 `light` / `dark` / `solarized` / `樱花粉` / `酒红` / `梅子紫` |
| `/settings` | 显示模式、模型、配色、工作区和后端 |
| `/status` | 查看本地模型、上下文估计、Codex 额度与可用重置卡 |
| `/usage [daily\|weekly\|cumulative]` | 查看 Codex 额度和对应周期的 token 用量 |
| `/usage reset` | 确认后尝试使用一张可用的 Codex 重置卡 |
| `/permissions ask\|edits\|allow` | 切换当前进程的工具确认策略 |
| `/peers` | 查看自动发现及静态配置的节点 |
| `/ping <peer>` / `/status <peer>` | 检查节点与远端 worker/job 状态 |
| `/message <peer> <内容>` | 向节点发送消息并取得送达回执；收发两端的 TUI 都会显示消息正文 |
| `/inbox` | 查看最近收到的 Mesh 消息（TUI 中也会常驻显示） |
| `/sync push <peer> [auto\|git\|chunk]` | 将当前项目同步到对端 |
| `/sync pull <peer> [auto\|git\|chunk]` | 从对端同步当前项目 |
| `/handoff <peer> <任务>` | 让对端 Agent 执行任务并等待结果 |
| `/ask-all <任务>` | 并发询问全部已知节点 |
| `/jobs` / `/jobs <id>` / `/cancel-job <id>` | 列出最近 Mesh 任务、展开某个任务的完整执行过程，或取消本机接收的任务 |
| `/add-contact <name> <host> <tcp> [udp]` | 保存跨网段联系人 |
| `/mesh` | 在本机会话与 Mesh 活动视图之间切换 |
| `/help` | 显示快捷键与命令帮助 |
| `/exit` | 保存并退出 |
| `!git status --short` | 直接执行 shell |

权限对话中：`y` 仅允许本次，`a` 信任整个会话（之后所有工具不再重复确认），`n` 拒绝。
也可以使用 `/permissions allow` 在当前进程放行，或启动时添加 `--yes`。

会话标题由模型总结：新建会话时标题是首条用户消息的第一行，第一轮运行结束后 Agent 会用一次
不携带工具的轻量请求把这段对话概括成一个短标题，顶栏与 `/sessions` 选择器随即显示新名字。
以“继续”、单个词或大段日志开头的会话因此不会再被叫成“继续”。标题会写入会话记录并标记来源，
之后的每次逐步保存都不会再用首行把它覆盖掉；模型不可用或回答不像标题时保留原有首行标题，
同一会话也不会为此反复重试。这次调用只产生一次很小的 token 开销，照常计入底栏计数。

## 运行时的实时反馈

推理模型思考时可能长时间没有可见输出，只有一个转圈很容易被当成卡死。现在这一行会说明**当前处于哪一步、是第几次模型调用、已经等了多久**，并把模型的思考内容以**单行**实时刷新出来（不进入转录、不写入会话）：

```
⠓ 等待模型响应 #3 模型返回 HTTP 429，0.4s 后重试（第 2/4 次）        本步 0s · 总 128s
⠙ 推理中 Looking at the repository. I should check README.md first    本步 12s · 总 140s · 1.4k 字
⠹ 生成回复 现在修改 config.ts 的默认值                                本步 3s · 总 143s
⠸ 执行工具 #4 Shell · npm run build                                  已运行 22s · 总 165s
```

四种阶段分别是 `等待模型响应` / `推理中` / `生成回复` / `执行工具`。**模型调用一旦超过 25s 没有任何输出，这一行会转成黄色并显示"已 Xs 无输出"**——等待不是思考，必须看得出来。

配套的还有两条：每一次重试和每一次流挂起，客户端都会把原因写成一条状态记录（"模型返回 HTTP 429，0.4s 后重试（第 2/4 次）"、"模型已 600s 没有任何输出，已中断本次请求（服务端可能卡住或网络中断）"）。这些记录会**按发生顺序插入转录流**并可滚动回看，而不是只闪一下——否则运行结束时你只看得到"任务失败"，看不到为什么。

回答流同样按 80ms 合并刷新，不再每个 token 重绘整屏。TUI 以增量渲染（Ink `incrementalRendering`）只重写发生变化的行，流式输出时不再整屏擦除重绘，慢终端上也不闪。浏览器工作台底部同样显示 `等待模型响应 · 第 N 次模型调用` 与"已 Xs 无输出"。

### 输出被截断不再等于任务失败

提供商在输出上限处截断回复（`finish_reason: length`）时，以前整轮直接失败，已经生成的内容
全部丢弃。现在会**保留已生成的部分**，写入会话后让模型接着写，并把两段拼成一个完整答案：

```
· 模型输出被输出上限截断（推理 8120 字 / 正文 1240 字），已保留并继续
✓ 任务已完成 · 3 步 · 4 次模型调用 · 41.2s
```

- 被截断的回复里若含工具调用，一律**不执行**（参数可能写了一半），而是重新请求。
- 连续 3 次仍被截断，或**推理占满了整个输出预算、正文为空**时，会暂停并给出可执行建议：

  ```
  ⏸ 已暂停（2 步），发送"继续"恢复
  模型的推理占满了输出上限（推理 9032 字 / 正文 0 字），没有留下正文，继续重试只会重复截断。
  请降低 reasoning_effort/thinking，或提高 max_tokens。
  ```

  遇到这种报错，通常是**推理 token 也计入 max_tokens**：关掉兼容接口的 `thinking`，或把 `max_tokens` 提到网关真实上限（很多网关会静默截断到自己的上限）。当前 OpenAI 兼容客户端不发送 `reasoning_effort`，只改这个配置项不会生效。

最后，流式回复无输出的等待上限是 `thinking_timeout`（默认 600s，单位秒），首字节等待上限是 `timeout`（默认 300s，与 opencode 一致），可在模型配置里调整：

```json
{ "model": { "timeout": 300, "thinking_timeout": 600, "max_retries": 5 } }
```

单次输出上限 `max_tokens` 会**封顶在 32000**（与 opencode 的 `OUTPUT_TOKEN_MAX` 一致）：上限过大只会让推理模型想得更久、让网关为请求预留更多 KV cache，从而拖慢每一轮；把它设得更大也不会改变实际封顶值。

### 连接中断不再丢掉已生成的内容

模型服务在输出中途断开（SSE 还没收到 `finish_reason`/`[DONE]` 就结束），或长时间无输出被空闲超时中断时，
以前整轮报错、已经收到的文字全部丢弃——自建或局域网模型服务在高负载下掉流时最常见。现在只要已经收到
正文、推理或工具调用片段，就**保留已收到的内容**并让模型接着写，和输出上限截断走同一条继续路径：

```
· 模型连接在输出中途中断，已保留 1240 字并继续
✓ 任务已完成 · 3 步 · 4 次模型调用 · 41.2s
```

- 中断时若只有半截工具调用，一律**不执行**，而是重新请求。
- 连续 3 次仍然中断会暂停，并提示检查网络与模型服务稳定性、或换用更稳定的 provider。
- 只有“一个 token 都没收到就断开”才按错误处理，避免把服务不可用当成正常完成。
- 收到响应头**之前**的连接失败仍按原有退避重试（`max_retries`，默认 3），并在转录流里写明原因。

对自建、经网关或排队较久的模型，可以适当调大首字节等待与重试次数：

```json
{ "model": { "timeout": 300, "thinking_timeout": 600, "max_retries": 5 } }
```

### 网关漏传的工具调用会被还原

部分 OpenAI 兼容网关（多见于 DeepSeek 系列）不会把模型 XML 风格的工具调用翻译成
`tool_calls`，而是把它当作普通正文返回，形如：

```
<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="bash">
<｜｜DSML｜ parameter name="command" string="true">ls -la</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>
```

以前 luban 会把这段标记当回答打印出来，工具根本不执行，模型却以为已经做过——用户只能事后发现
“上次那个 edit 没落盘”。现在客户端会识别这种块，把它还原成真正的工具调用并从正文里去掉，
`bash` / `edit_file` / `apply_patch` 等照常执行；普通回答不含这种标记时完全不受影响。

## 速度与规划

默认不再强制 Agent 先调用 `update_plan`：那是一次完整的模型往返，长任务值得、单步任务纯粹是开销。三种模式：

```json
{ "planning": "auto" }
```

| 模式 | 行为 |
|---|---|
| `auto`（默认） | 只有确实跨多步时才规划，明确允许单步任务跳过 |
| `always` | 每个非平凡任务都先 `update_plan`（旧行为，多一次往返） |
| `off` | 完全不规划 |

命令行 `--planning off|auto|always`，环境变量 `LUBAN_PLANNING`。

`model.thinking` 可设为 `true`（所有请求开启）或 `false`（所有请求关闭）。未设置或设为 `"auto"` 时，luban 在本地按最新用户请求选择，不额外调用模型；明确简单的请求关闭思考，不确定或涉及修复、分析、测试等工作的请求开启思考。如果简单任务的工具失败，下一次模型调用会开启思考。自动选择为非思考时，单次输出上限最多 16384 token、无输出等待最多 45 秒。用户强制指定 `true` 或 `false` 时，仍使用自己配置的 token、超时和重试设置。目前此开关通过 OpenAI 兼容接口的 `chat_template_kwargs.enable_thinking` 传给模型；Anthropic 与 Responses 客户端尚未接入对应控制。

明确要求把当前 Git 仓库提交并推送到已配置的上游时，Agent 可以直接使用 `git_publish`：一次工具调用完成暂存、必要时提交和推送，只需一次执行审批。它要求工作区就是仓库根目录，且当前分支已有上游；不执行强制推送。

每轮结束会报告往返次数与耗时，把"感觉慢"变成数字：

```
[4 steps · 4 model calls · 0.5s · 0.1s/call]      # --prompt 模式 stderr
✓ 任务已完成 · 4 步 · 4 次模型调用 · 12.3s          # TUI 结论行
```

同一个任务在两个工具里各跑一次，比较 `model calls` 和 `s/call` 就能分清是**往返太多**还是**单次太慢**。

## 局域网协作

Mesh 默认随 TUI 或 `--prompt` 模式启动。处于同一局域网且 UDP 端口一致的节点会自动
发现；广播不可达时使用 `/add-contact` 或配置 `contacts`。

```bash
# A 节点
luban ~/dev/myapp --mesh-name linux-a

# 同步上下文后交接任务
/sync push windows-b auto
/handoff windows-b 在 Windows 上运行测试并报告失败
```

### 远程任务和本地任务一样可见

TUI 默认显示本机会话，输入的指令、流式回复和最终回复都留在本地视区。Mesh 的消息数量和活动任务显示在一行状态栏中，远端消息不会自动切走本地对话。使用 `/mesh` 在本机会话与 Mesh 视图之间切换；输入新的本地问题会自动返回本机会话。Mesh 消息的收发记录在重开 TUI 后也会恢复。`luban serve` 同样打印执行步骤和输出；用 `/details` 可手动切换工具详情。

别人交给你的任务、以及你交接出去的任务，都可**在 Mesh 视图里展开完整的执行过程**，和本地
任务用同一套渲染：模型调用次数、推理与回复的实时单行、工具调用（`Shell` / `Edit` 等，
含参数与输出摘要）、**内联改动记录**（文件路径、增删行数、行号、修改前后内容）、以及
任务计划。

```
📥 来自 windows-b · 在 Windows 上运行测试并报告失败
› {"plan":[{"step":"检查仓库","status":"in_progress"},{"step":"运行测试","status":"pending"}]}
  ✓ Shell · 完成 · 12.4s
    $ npm test
    ↳ 3 passing
⠸ 📥 windows-b 执行工具 #4 Shell · npm test              已运行 12s · 总 45s
  Task plan · 📥 windows-b
  → 检查仓库
  ○ 运行测试
✓ 任务完成 · 4 次模型调用
```

细节：

- Mesh 视图底部会显示远程任务的阶段行（`等待模型响应` / `推理中` / `生成回复` / `执行工具`），带同伴名字，超时无输出同样会变黄并提示。
- 右侧 Task plan 面板在远程任务制定计划后显示 `Task plan · 📥 <同伴>` 及其步骤。
- `/jobs` 列出最近任务，`/jobs <job-id>` 打开 Mesh 视图并展开指定任务。远端任务更新不会切走本机会话；`/mesh` 返回本地。
- 推理内容与本地一致：只在实时行显示，不写入转录、不落盘。
- 交接出去的任务现在也有本地记录（`source=你 → target=同伴`），因此同样会出现在 `/jobs`、Web 工作台和 Mesh 视图里；对方的结构化事件会随轮询回传，而不是只回传日志文本。

Node 与 Python 节点可双向发现、ping、消息、同步和交接任务。迁移期间可以混合运行，
但同一台机器不要同时启动两个同名节点，否则其他机器无法区分它们；请先停止旧 Python
节点，或给 Node 临时指定不同名字：

```bash
luban . --mesh-name my-laptop-node --mesh-port 0
```

`--no-mesh` 可只启动本地 Agent。旧 Web 桥接仍可通过
`--backend http://127.0.0.1:8080` 使用，但原生协作不需要它。

### 排障

先在两台机器上各跑一次：

```bash
luban mesh            # 打印本节点昭告的地址、广播目标，并逐个探测联系人
```

它会区分两类失败——这两类原因完全不同，以前都只显示"超时"：

- `could not be reached`：连接根本没建立 —— 路由不通、被防火墙拦、或对端没在跑。
- `connected but no reply`：连接建立了但对端不回应 —— 说明那个地址/端口上**有别的程序在应答**（代理/VPN 拦截、端口被占用、或对端跑在别的端口）。

常见坑：

- **代理 / VPN 接管了局域网地址**。用 `ip route get <对端IP>` 确认走的是哪个网卡；如果显示 `dev tun0`/`dev FlClash` 之类而不是局域网网卡，把该地址或私有网段（`10.0.0.0/8`、`192.168.0.0/16`、`172.16.0.0/12`）加入代理的直连/绕过规则。
- **UDP 广播只在同一子网内有效**。跨子网必须配 `contacts` 静态联系人（`/add-contact` 或 `~/.luban/config.json`）。luban 会向每个网卡各自的子网广播地址（如 `192.168.1.255`）发送，而不只是跟着默认路由的 `255.255.255.255`。
- **两端 token 必须一致**（`mesh.token`）；不一致时对方的广播会被静默丢弃，表现为"找不到节点"。

## 原生 Web 后台

完全替代 Python `luban web`：

```bash
# Node Mesh + Agent worker + Web API + 浏览器控制台
luban web ./demo --host 127.0.0.1 --port 8642

# 只运行 Node Mesh/worker 守护进程
luban serve ./demo
  luban acp ./demo    # Agent Client Protocol over stdio（编辑器接入，见 editors/vscode/）

# TUI 和 Web 后台共享同一个 Node 进程
luban ./demo --web-port 8642
```

打开 `http://127.0.0.1:8642/`。浏览器里的任务直接进入 Node Job Store 和 Agent worker，
不会请求 Python 服务。默认仅监听本机；只有明确需要局域网浏览器访问时才使用
`--host 0.0.0.0`。

兼容及扩展 API：

| 方法 | API | 功能 |
|---|---|---|
| GET | `/api/node`、`/api/peers` | 节点和局域网伙伴 |
| GET | `/api/jobs`、`/api/jobs/:id` | Job 列表、日志和结果 |
| POST | `/api/jobs`、`/api/jobs/:id/cancel` | 本地执行或取消任务 |
| GET | `/api/workspace?project=...` | 安全浏览项目文件树 |
| POST | `/api/sync`、`/api/chat`、`/api/contacts` | 同步、消息和联系人 |
| POST | `/api/ping`、`/api/status`、`/api/handoff` | 节点诊断和任务交接 |
| GET | `/api/events` | SSE 事件流：job、job-log、job-event、peer、chat |
| GET | `/api/jobs/:id/stream?since=N` | 结构化事件重放（每个事件带单调 `seq`） |
| GET/POST | `/api/approvals` | 查询/答复浏览器交互审批 |
| GET | `/api/file`、`/api/file-versions` | 读取工作区文件与 Git HEAD 版本 |
| GET | `/api/diff`、`/api/sessions`、`/api/sessions/:id` | Git 变更、会话列表与会话详情 |

## 手机远控：服务器、节点与 Android 客户端

手机端使用 `/m/` 控制台；Android APK 是这个控制台的安装版。**模型、任务、会话和工作区始终在运行 `luban web` 的电脑上**，APK 和公网中继都不执行任务。

| 场景 | 连接路径 | 需要运行的进程 |
|---|---|---|
| 手机与电脑在同一局域网 | APK/浏览器 → 电脑 `luban web` | 电脑上的 Web 服务 |
| 手机使用移动网络或异地 Wi-Fi | APK/浏览器 → HTTPS 中继 `luban relay` ← 电脑主动拨出隧道 | 公网服务器上的中继、电脑上的 Web 服务 |

两种方式都先在运行 Node.js 的机器上准备 luban（Node.js ≥20）。公网方式需要在**服务器和电脑各安装一次**；[模型配置](#配置)只需放在电脑上。构建需要开发依赖，即使机器设置了 `NODE_ENV=production` 也要包含它们。

```bash
cd /path/to/luban
npm ci --include=dev
npm run build
```

### 方案 A：同一局域网，手机直连电脑

电脑上创建一个重启后不变的访问令牌，并启动 Web 服务。示例端口 `18765` 可以换成未占用的端口；`--no-mesh` 适用于已有另一个 luban Mesh 节点占用端口的情况。

```bash
cd /path/to/luban
mkdir -p ~/.config/luban
umask 077
printf 'LUBAN_WEB_TOKEN=%s\n' "$(openssl rand -hex 24)" > ~/.config/luban/remote.env
chmod 600 ~/.config/luban/remote.env
set -a; . ~/.config/luban/remote.env; set +a
node dist/cli.js web /path/to/project --no-mesh --host 0.0.0.0 --port 18765
```

手机和电脑接入同一个局域网，在 APK 的“地址”页输入 `http://<电脑局域网IP>:18765/m/?token=<LUBAN_WEB_TOKEN>`。`0.0.0.0` 是监听地址，`127.0.0.1` 只指手机自身，都不能填进手机地址。令牌可从 `~/.config/luban/remote.env` 读取；把令牌链接只交给受信任的设备。令牌文件只需生成一次，普通服务重启不要重新生成。局域网 HTTP 会明文传输令牌和请求，离开受信任局域网应使用下面的 HTTPS 中继。

要让服务在登录后自动启动，可创建 `~/.config/systemd/user/luban-web.service`，将下面的绝对路径替换为本机路径：

```ini
[Unit]
Description=luban Web for phone
Wants=network-online.target
After=network-online.target

[Service]
WorkingDirectory=/absolute/path/to/luban
EnvironmentFile=%h/.config/luban/remote.env
ExecStart=/absolute/path/to/node /absolute/path/to/luban/dist/cli.js web /absolute/path/to/project --no-mesh --host 0.0.0.0 --port 18765
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now luban-web.service
systemctl --user status luban-web.service
```

若需在用户尚未登录时也自动启动，管理员还需为该用户开启 systemd linger（`loginctl enable-linger <用户名>`）。

### 方案 B：公网 HTTPS 中继，手机随处访问

公网服务器需要域名、对该域名有效的 TLS 证书，以及允许手机访问中继端口的入站规则。下面直接让中继在 `8788` 端口提供 HTTPS；证书文件必须可由运行中继的用户读取，证书更新后需要重启中继以重新读取。电脑只需能主动连接该地址，不需要开放入站端口。

**公网服务器：**固定两把不同的令牌，分别给手机和电脑使用；不要把令牌写进公开仓库或 systemd 单元文件。

```bash
cd /path/to/luban
mkdir -p ~/.config/luban
umask 077
printf 'LUBAN_RELAY_ACCESS_TOKEN=%s\nLUBAN_RELAY_NODE_TOKEN=%s\n' \
  "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > ~/.config/luban/relay.env
chmod 600 ~/.config/luban/relay.env
set -a; . ~/.config/luban/relay.env; set +a
node dist/cli.js relay --host 0.0.0.0 --port 8788 \
  --public-url https://relay.example.com:8788 \
  --https --tls-key /path/to/key.pem --tls-cert /path/to/cert.pem
```

`LUBAN_RELAY_ACCESS_TOKEN` 是手机访问令牌；`LUBAN_RELAY_NODE_TOKEN` 是电脑接入令牌。启动输出会给出“手机访问”链接和“节点连接”命令。

**运行模型和工作区的电脑：**从服务器安全地复制节点令牌到本机 `~/.config/luban/node.env`（文件权限 `600`），然后启动节点。下面的 `--port 0` 为本机 Web 后台选空闲端口；隧道会使用实际端口。TLS 证书由系统信任时无需 `--relay-ca`。

```bash
cd /path/to/luban
mkdir -p ~/.config/luban
umask 077
printf 'LUBAN_RELAY_NODE_TOKEN=%s\n' '<从服务器复制的节点令牌>' > ~/.config/luban/node.env
chmod 600 ~/.config/luban/node.env
set -a; . ~/.config/luban/node.env; set +a
node dist/cli.js web /path/to/project --no-mesh --host 127.0.0.1 --port 0 \
  --relay https://relay.example.com:8788
```

要让两端长期运行，可分别在公网服务器和电脑上创建下面的 systemd 用户单元。替换示例中的 Node、luban、项目、证书路径及域名；令牌仍只放在权限为 `600` 的环境文件中。

公网服务器的 `~/.config/systemd/user/luban-relay.service`：

```ini
[Unit]
Description=luban HTTPS relay
Wants=network-online.target
After=network-online.target

[Service]
WorkingDirectory=/absolute/path/to/luban
EnvironmentFile=%h/.config/luban/relay.env
ExecStart=/absolute/path/to/node /absolute/path/to/luban/dist/cli.js relay --host 0.0.0.0 --port 8788 --public-url https://relay.example.com:8788 --https --tls-key /path/to/key.pem --tls-cert /path/to/cert.pem
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

电脑的 `~/.config/systemd/user/luban-node.service`：

```ini
[Unit]
Description=luban node connected to relay
Wants=network-online.target
After=network-online.target

[Service]
WorkingDirectory=/absolute/path/to/luban
EnvironmentFile=%h/.config/luban/node.env
ExecStart=/absolute/path/to/node /absolute/path/to/luban/dist/cli.js web /absolute/path/to/project --no-mesh --host 127.0.0.1 --port 0 --relay https://relay.example.com:8788
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

在各自机器上执行 `systemctl --user daemon-reload` 和 `systemctl --user enable --now <对应服务名>`；用 `systemctl --user status <对应服务名>` 检查状态。如需无人登录时自动启动，开启该用户的 systemd linger。手机只访问中继，**不要**把电脑的 `127.0.0.1` 地址填进 APK。

**手机：**在 APK 中输入中继打印的 `https://relay.example.com:8788/login?token=<手机访问令牌>`。首次访问会把令牌换成 HttpOnly Cookie 并进入 `/m/`；之后 App 在本机加密保存最近连接，重启可以直接连接。若清除 App 数据或令牌失效，需要重新输入完整令牌链接。

#### 当前部署：39.105.10.158

本仓库的公网中继部署在 `https://39.105.10.158`（443 端口）。服务器运行中继；每个电脑端 TUI 自己开启一个 loopback Web 服务并主动连接中继，退出该 TUI 时它的服务和隧道一起结束。把设置写入 `~/.luban/config.json`，凭据单独放在权限为 `600` 的 `~/.config/luban/relay.env`：

```json
{
  "remote": {
    "enabled": true,
    "relay_url": "https://39.105.10.158",
    "node_token_env": "LUBAN_RELAY_NODE_TOKEN",
    "node_token_file": "/home/skyer/.config/luban/relay.env",
    "host": "127.0.0.1",
    "port": 0
  }
}
```

配置好后直接运行 `luban /path/to/project`。TUI 中输入 `/token` 显示**当前实例**的登录链接；在两个目录或两个终端分别运行时会注册成两个独立节点，令牌和远程任务各自固定到对应实例。手机端可以使用这一个实例的工作目录、项目、模型和任务存储。无需单独运行 `luban web` 或安装电脑端 systemd 常驻单元。

节点令牌由中继部署时写入 `~/.config/luban/relay.env`；公网中继 IP 证书由服务器上的 `luban-renew-cert.timer` 自动续期。检查中继可运行 `systemctl status luban-relay.service luban-renew-cert.timer`。IP 或服务器变化时，需要更新这里的 `remote.relay_url` 并重新申请证书。

### Android APK 的构建、安装与使用

桌面和移动端客户端统一放在 `apps/`，Android APK 源码位于 `apps/android-app/`。它通过 Android WebView 使用服务端的 `/m/` 控制台。Android SDK 与 JDK 17 用于构建；下面产出可直接安装的调试版 APK。多台设备连接 ADB 时，先运行 `adb devices` 找到目标序列号。

```bash
cd /path/to/luban/apps/android-app
ANDROID_HOME="$HOME/Android/Sdk" ./gradlew assembleDebug
adb devices
adb -s <设备序列号> install -r app/build/outputs/apk/debug/app-debug.apk
```

首次打开 App，输入方案 A 的电脑链接或方案 B 的中继“手机访问”链接，点“连接”。连接成功后，点顶部“连接记录”即可查看最近连接；点一条记录即可重连，也能删除过期记录。列表只显示不含令牌的地址，重连链接使用 Android Keystore 加密保存在本机，最多保留 12 条。页面上的项目选择器决定任务的工作区；输入指令后可看实时输出、工具调用、任务列表和审批，也可取消或继续任务。令牌失效时需重新输入完整链接。Android WebView 只信任系统证书和用户明确安装的 CA，证书错误不会被忽略。

调试 APK 适合自用和测试；正式分发需自行配置 Android release 签名。任务和界面由 luban 服务提供，APK 不包含模型；只更新 Web 界面时重新构建并重启服务即可，APK 无需重装。

### 浏览器安装 PWA 与自签证书

不用 APK 时，手机浏览器也能打开同一链接。浏览器要把 `/m/` 作为 PWA 安装到主屏幕，需要受信任的 HTTPS 安全上下文；局域网 HTTP 可在 APK 中使用，但不能作为可靠的 PWA 安装方式。推荐使用对访问域名有效、手机系统已信任的证书。

局域网测试可运行 `luban relay --host 0.0.0.0 --port 5399 --https --tls-dir /path/to/tls-dir` 生成覆盖本机局域网 IP 的证书。把其中的 `ca.pem` 安装为手机受信 CA 后，浏览器和 APK 才能验证它；电脑节点连接该中继时再加 `--relay-ca /path/to/tls-dir/ca.pem`。`--tls-dir` 保留证书供重启复用。仅在浏览器里点“继续访问”不会使证书变成受信任证书。

鉴权细节：

- 令牌可从 `Authorization: Bearer`、`x-luban-token` 头、`?token=` 查询参数或 Cookie 任一入口提供；带令牌的链接访问一次后即换成 HttpOnly Cookie 并重定向，之后地址栏不再暴露令牌。
- 令牌比较使用常量时间算法；同一来源地址连续失败会触发限流（429），成功后计数清零。
- 中继到节点的本机请求会剥掉手机侧 Cookie/Authorization 与中继凭据头，节点的本机令牌不会出现在手机可见的任何响应里。
- 本机 `luban web` 绑定非 loopback 时若未显式给 `--token` 会自动生成并打印；纯本机使用（127.0.0.1）默认不设令牌。
- 重启后保持登录应固定令牌：本机 Web 用 `LUBAN_WEB_TOKEN`，中继用 `LUBAN_RELAY_ACCESS_TOKEN` 和 `LUBAN_RELAY_NODE_TOKEN`，电脑连接中继也可用 `LUBAN_RELAY_NODE_TOKEN`。显式 `--token`、`--node-token`、`--relay-token` 参数优先于对应环境变量。令牌文件权限设为 `600`。

排障：

| 现象 | 检查 |
|---|---|
| APK 打不开/连接失败 | 确认 `luban web` 或中继仍在运行；手机可访问其 IP/域名和端口；局域网电脑 IP 改变时更新 App 地址；手机链接不要使用 `127.0.0.1` 或 `0.0.0.0`。systemd 部署时查看 `systemctl --user status <服务名>` 和 `journalctl --user -u <服务名> -n 50` |
| 手机显示 401 | 重新输入带手机访问令牌的完整链接；本机直连用 `LUBAN_WEB_TOKEN`，公网中继用 `LUBAN_RELAY_ACCESS_TOKEN`，不要使用节点令牌 |
| 公网中继显示节点离线 | 检查电脑到中继的出站连接、`--relay` URL 和节点令牌；中继重启后节点会自动重连 |
| 指令提交后无响应 | 查看电脑端 `luban web` 日志中的任务状态和 `relay:` 错误；确认模型服务在电脑上可用 |
| HTTPS 证书不受信任 | 使用有效的域名证书；自签场景需在手机安装 `ca.pem`，电脑节点加 `--relay-ca <ca.pem>` |
| 浏览器没有 PWA 安装入口 | 确认通过受信任的 HTTPS 打开；如果只需 Android 安装版，直接安装 APK |

## 脚本模式

```bash
# 默认拒绝写入/shell，适合只读分析
luban . --prompt "解释这个项目的入口"

# 明确允许工具修改
luban . --yes --prompt "运行测试并修复失败"
```

## 运行中补充指令

TUI 工作时直接输入消息，会在下一工具/模型边界送给 Agent；尚未执行的旧工具调用会被跳过，
让模型根据新指令重新判断。正在执行的工具不会被自动撤回，需要立即停止时使用 Esc。
`/queue <任务>` 会保留当前任务，等它正常给出最终回答后再逐个执行队列任务。
新任务沿用当前运行的模式与权限，每次接收新输入重新分配模型调用步数。

补充指令和排队任务会即时显示在正文区的“补充指令”面板（含类型、时间和内容），不再只是一条 notice；
`handleEvent(input)` 送达后也会同步更新该面板。待处理输入保存在会话的 `pendingInputs` 中。取消、错误或达到步数上限后仍保留未处理输入；
恢复会话后发送“继续”即可继续处理，`/pending` 可查看队列。会话选择器仅列出当前工作区的记录。
等待权限确认时仍需先允许、拒绝或取消该确认，再输入新指令。

输入框支持 `↑` / `↓` 召回历史（含 `/` 命令和运行中补充指令），`resume`/切换会话后从用户消息自动恢复。
输出复制有三种方式：**在输出区拖选、松开即复制**（选中行高亮且保留语法颜色，和 opencode 一样）；`Ctrl+Y`（运行中也可用）或 `/copy` 复制上次回答和最近工具结果，两者都优先尝试 OSC52 与系统剪贴板工具；
按住 `Shift` 拖选则绕过鼠标上报，走终端原生选区。
鼠标滚轮翻执行详情（并自动展开 `/details`）。

`/plan` 切换计划面板；底栏显示待处理输入数量。后台任务可跨普通对话轮次继续运行，`send_background_input` 可向运行中任务写 stdin（交互式 CLI/REPL）；
取消所属运行、退出、切换模型/权限或新建会话时会终止受管理的进程。
Unix 使用进程组终止，Windows 使用 `taskkill /T /F`；Windows 分支尚未在本次 Linux 环境实测。
主动脱离进程组的守护进程不受这套清理机制保证，它也不构成系统级沙箱。

## 代码导航与项目规则

Agent 可调用 `code_intelligence`，例如：

```json
{"operation":"definitions","path":"src/main.ts","line":10,"column":8}
```

`references` 查询引用；`symbols` 列出文件符号；`diagnostics` 检查指定文件的语法和类型错误。
行号和 UTF-16 列号从 1 开始。当前支持 TS/JS，每次查询读取最新文件，不执行项目脚本。
最近的工作区内 tsconfig/jsconfig 决定项目范围；单文件上限 2 MB，项目最多 2,000 个根源文件。
其他语言及大型 monorepo 的完整项目引用分析仍需扩展。

文件读写、精确编辑和 diff 会检查适用的子目录规则。若规则尚未送给模型或已经变化，
这次编辑会返回“未执行”，加载规则后由模型调整或重试；不需要额外用户审批。
shell/MCP 内部操作不经过这个逐路径入口。

## 长任务与恢复

多步骤任务可让 Agent 使用 `update_plan` 记录实施和验证步骤，使用 `read_plan` 查看未完成工作。
计划属于当前会话，正常保存、取消及 `--resume` 恢复后继续可见，压缩不会丢弃计划。
计划中的“完成”是任务记录，实际测试输出才是验证依据。

工具返回值超过 24,000 字符时保存到 `~/.luban/tool-output-node/`，预览包含归档 UUID。
Agent 可用 `read_tool_output` 回读（`offset` / `next_offset` 为 UTF-8 字节位置），无需重新运行原命令。
工具自身已有的输出采集上限仍生效；归档按 `tool_output.retention_days`（默认 7 天）与
`max_bytes`（默认 500 MB）自动清理，超限时从最旧的开始删除。

会话 JSON 仍是唯一权威记录，resume、branch、导出和 Web 接口都读它。把 `history.enabled`
设为 `true` 后会额外把每条消息追加写入 `<history.directory 或 ~/.luban>/history.sqlite`，
让长会话的历史在增长过程中可被查询，而不是每步重写整个 JSON。该镜像按会话记录逐条追加：
条目被压缩、`/branch` 裁掉或工具结果被替换导致列表变短时，会先删除该会话的旧行再从当前位置重建，
不保留 JSON 里已经不存在的记录。`max_messages_per_session`（`0` 表示不裁剪）可给单会话设上限，
超出的最旧行会随写入删除。数据库写入失败时镜像自行停用并在 stderr 说明原因，会话 JSON 不受影响。

```sh
luban history [path]              # 最近的镜像会话（时间、ID、条数、项目、标题）
luban history -q "关键词"          # 检索消息正文，默认每行首行、200 字符
luban history -q "关键词" --full   # 打印完整消息
luban history -p myapp -n 50      # 按项目过滤并调整条数
```

`luban history` 只读打开数据库，关闭写入时也能查询已存在的镜像。Web 控制台通过
`GET /api/history?q=<关键词>&project=<项目名>&limit=<条数>` 使用同一份数据。

CLI/TUI 逐步保存到原有会话目录。如果进程在工具执行后、结果保存前退出，恢复记录会明确
提示“执行状态未知”，Agent 应检查现状后决定下一步。Mesh job 仍使用原有 job/log 保存机制。

ASK 只允许标记为只读的内置工具；AUTO 不会因为任务描述未命中关键词而变成只读。
可信 MCP 仍按配置初始化。文件路径检查和工具权限规则不构成系统级 shell 沙箱，
细节见[安全边界](#安全边界)。

### 长任务与多实例运行

- 达到步骤上限后会保存总结并显示 `paused`；TUI 中发送“继续”可恢复。总结请求失败时也会保存明确的暂停提示，不把中间分析当作最终结果。
- Node Mesh 任务、远程轮询和 Web 工作台使用相同的 `paused` 状态。新任务逐步保存执行历史，暂停后可在 Web 点击“继续任务”，或调用 `mesh_resume_job`（远程任务提供 `peer`）恢复同一任务 ID；用 `mesh_poll_job` 查看状态和结果。服务重启后仍可从保存的历史续跑，重复续跑请求只接受一次。缺少历史的旧任务不能续跑，旧版 Python 节点不支持新增续跑协议。
- 普通 CLI/TUI 使用默认 Mesh 端口时，端口被占用会自动分配空闲 TCP 端口、独立节点名和 `jobs/instances/<实例 UUID>` 任务目录。已有实例及任务保持运行，UDP 发现仍使用配置的发现端口。显式传入 `--mesh-port` 或使用 daemon 时仍要求绑定指定端口。
- Unix 上的 `bash` 工具统一使用 `/bin/bash` 并启用 `pipefail`，前台和后台命令行为一致，不受登录 Shell 为 sh/fish 的影响；系统需安装 Bash。Windows 仍使用 cmd。
- Web 控制台提供 `/diff?project=<项目名>` 代码变更页，按当前 Git HEAD 显示修改文件列表和带颜色的 unified diff；任务完成后可直接打开该地址审阅修改。

从 v0.4.3 开始，TUI 每次执行 `write_file`、`edit_file`、`apply_patch` 后会直接展开 `Edited 文件 (+新增 -删除)` 和带行号的红绿差异。内容来自执行前后的文件，适用于未提交文件和非 Git 目录。终端宽度足够时（可用宽度 ≥ 72 列）差异以左右对比显示：左侧是删除/未变的旧行，右侧是新增/未变的新行，中间用 `│` 分隔，一眼即可看出某一行被替换成了什么；窄终端自动回退为单栏 unified 列表，保证代码不被挤成碎片。执行详情默认展开，可用 PageUp/PageDown 或鼠标滚轮翻阅，`/details` 用于收起或重新展开完整输出；新记录随会话保存，压缩上下文后仍可恢复。任务结束后会固定显示“已完成 / 已失败 / 已暂停 / 已取消”状态，成功时展示最终回答，失败或暂停时直接展示原因。大改动的预览最多保留每文件 160 行，每行最多 300 字符，并注明省略。升级前未保存原文的历史编辑无法还原当时的完整差异。Shell/MCP 内部的文件修改尚不生成这种逐次编辑记录。

复杂任务默认最多执行 200 个 Agent/AUTO 工具轮次；可在 `~/.luban/config.json` 设置 `max_steps`，范围为 1–2000。Agent 会在预算用尽时生成总结并暂停，只有明确完成或发生错误才会正常结束，不能安全地无限运行。

Qwen/OpenAI 兼容服务可在 `model` 中设置 `"thinking": true`、`false` 或 `"auto"`（默认），请求会发送 `chat_template_kwargs.enable_thinking`。长会话默认在 80 条消息前主动压缩，可通过 `max_history_messages` 调整；Qwen 的默认 `context_window` 为 262144，也可按服务端实际容量显式覆盖。`max_tokens` 是单次输出上限，应小于总上下文窗口并为输入历史保留空间。

## 插件与编辑器接入

luban 的“插件”由两部分组合：`SKILL.md` 约束流程，MCP Server 提供工具。

- **技能**：从项目的 `.luban/skills/*/SKILL.md`、`.agents/skills/*/SKILL.md` 和 `~/.luban/skills/*/SKILL.md` 发现，用于把特定场景的分析流程固定下来。
- **股票持仓监控插件**（`plugins/stock-monitor/`）：用 Skill 约束深套/加减仓分析流程，并用 stdio MCP 接入延迟行情、仓位诊断与自选持仓扫描，可复制安装，用法见[插件说明](plugins/stock-monitor/README.md)。扫描为主动调用，不是脱离进程的行情推送服务。
- **编辑器**：`luban acp <workspace>` 通过 stdio 提供 Agent Client Protocol；仓库自带 VS Code 扩展（`editors/vscode/`），可用 `npm run package:vscode` 打包。

## 安全边界

luban 的沙箱与权限是**协作防护**，不是系统级隔离容器：不要用它执行不受信任的代码。

- **权限模式**：`ask` / `edits`（默认）/ `allow` 决定写入、shell、网络工具是否需要确认；`--yes` 等效于全部放行，`deny` 规则始终优先于会话信任。显式 ASK 模式在运行时强制只读，即使 `--yes` 也不放行写入、shell、网络和委派。
- **软沙箱**：`bash` 会拦截毁灭性命令、工作区外的写入/重定向和自定义 `deny` 规则，可选禁用网络，`sandbox.backend` 可选 `bwrap`。这些约束运行在当前用户权限之内，拦截的是命令模式，不是内核能力。
- **路径检查**：文件工具的 `resolveInside` 拒绝 `..` 与软链逃逸工作区；但 shell/MCP 内部的文件操作不经过这个入口。
- **进程清理**：退出或切换会话会终止受管理的后台进程组（Unix 使用进程组，Windows 使用 `taskkill /T /F`；Windows 分支未在 Linux 环境实测）；主动脱离进程组的守护进程不受保证。
- **Web 后台**：默认只监听 `127.0.0.1`，且没有任何内置认证；只有需要局域网浏览器访问时才使用 `--host 0.0.0.0`。
- **Mesh**：使用 HMAC 鉴权与重放防护，各节点的 `LUBAN_MESH_TOKEN` 必须一致；不要在不信任的网络上开启协作。

## 开发验证

```bash
npm test          # 72 文件 / 390 用例（另有 1 个按平台跳过）
npm run eval      # 脚本化评测集（单文件/跨文件/失败恢复/只读拒绝，无需付费 API）
npm run typecheck
npm run build
```

界面行为用真实 PTY 跑（Ink 需要 TTY），都在 `scripts/` 下，失败即非零退出：

```bash
python3 scripts/tui-smoke.py         # 启动横幅与各面板
python3 scripts/tui-wheel-smoke.py   # 滚轮 / 拖动滚动条 / PageUp 翻页
python3 scripts/tui-input-smoke.py   # 多行输入与光标
python3 scripts/tui-export-smoke.py  # /export 内容完整性
python3 scripts/tui-mouse-smoke.py   # 鼠标点击/编码不应插入字符
python3 scripts/tui-stall-smoke.py   # 四个阶段、重试提示、流挂起提示、输出截断后继续（见"运行时的实时反馈"）
python3 scripts/tui-mesh-smoke.py    # 两个真实节点：远端任务的计划/工具/阶段/结果是否照常展示
```

会话保存在 `~/.luban/sessions-node/`，不会与 Python 版的 JSONL 会话相互覆盖。

## 项目结构

```
src/
  cli.tsx            命令行入口（TUI / web / serve / mesh / acp）
  core/              Agent 运行时、工具、配置、会话、沙箱、LSP、MCP
    mesh/            UDP 发现、TCP 帧协议、远程 job 与工作区同步
  ui/                Ink TUI（转录、执行时间线、滚动条、输入框、计划/验证面板）
  web/               HTTP 后台与 API；client/ 为 React + Vite 浏览器工作台
  evals/             脚本化评测集
scripts/             构建脚本与真实 PTY 冒烟测试
plugins/             可复制安装的场景插件（SKILL.md + stdio MCP Server）
editors/             编辑器集成（VS Code 扩展，走 `luban acp`）
```

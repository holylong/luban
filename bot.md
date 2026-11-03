# 本机常驻 Bot 与造物主（v2.0）

Bot 复用 luban 的模型配置与 Agent，通过磁盘队列接收任务，不需要保持 TUI 打开，也不开放网络端口。

## 桌宠即身体（桌面 App）

`npm run desktop -- /absolute/project` 启动桌面工作台时，同一个进程会拉起 `luban bot run`，桌宠就是这个后台身体。在这具身体里它自称「造物主」：bot 任务的系统提示词与身份纠正句都改用造物主，前台 TUI / 工作台仍然是编码 Agent。

- 宠物头顶的「造物主」状态灯：未启动（没有 worker）、待命（worker 在跑、队列空闲）、干活中（正在执行）、出错（worker 退出，点开看错误）、锁残留（锁在但进程没了，需手动确认后删除）。由桌面 App 启动的 worker 在标题里标注；LaunchAgent 或终端启动的 worker 只会被显示，不会被抢占或杀掉。
- 点状态灯展开面板：机器负载与内存占用、正在执行的任务与运行时长、各进程的活跃 agent（PID、深度、任务、运行时长、已花 token，深度 0 为主 agent）、worker 的直接子进程（PID 与命令行）、线程数与进程 RSS，以及最近任务的状态/结果/本次 token（输入+输出）。模型调用次数另存于状态记录。队列里的任务用 `luban bot add ...` 提交，桌宠只读展示。
- 子 agent 是进程内的 `AgentRunner`，没有独立 PID，因此面板按 PID 分组列出所属进程。能看到的进程是 worker（node dist/cli.js bot run）、桌面后端，以及它们拉起的 shell / PTY / Codex 子进程。线程数来自 `ps -M`，仅 macOS 显示。bot 里调用 delegate_task 仍需权限文件授权，否则子 agent 不会启动。
- worker 每秒写一次 `~/.luban/bot/status.json`（pid 与当前任务）；每个 luban 进程（worker、桌面后端）在 `~/.luban/agents/<pid>.json` 维护本进程的活跃 agent 与实时 token（最多约 1.5 秒延迟），进程退出时删除。任务的 token 总量随状态写入 `~/.luban/bot/tasks/<id>/state.json` 的 `usage`。桌面 App 只读这些文件，不参与调度；崩溃残留的文件因 PID 已死而被忽略。
- bot 任务完成时气泡播报“造物主完成：…”（只在桌宠没有自己的交互任务时）。
- 退出 App 会向自己启动的 worker 请求停止，最多等待 4 秒再退出；正常响应时会中止当前回合并释放 `worker.lock`。若执行引擎未响应，不保证强制清理进程或锁，需人工确认状态。
- 若 worker 已由 LaunchAgent 或终端启动，桌宠只显示它的状态，不会重复启动；退出 App 也不会杀掉它。

## 桌宠的交互任务

桌宠也可以直接吃任务，走的是工作台交互通道，不进入 bot 队列：

- 点击机器人脸部或“主界面 / 审批”打开主窗口；拖动顶部标题移动宠物。
- 可输入任务、拖入纯文字，或拖入最多 4 个 UTF-8 文本/代码文件（每个不超过 128KB）。拖入只准备附件，点击“喂给 luban”才读取并提交文件内容给当前模型；不支持 PDF、图片、文件夹。
- 有附件的任务使用只读模式；纯文字任务使用 Agent 模式，启用现有工作台交互审批，**不读取 bot/permissions.json**。文件中的内容只作为分析数据，但这不是对提示注入的安全保证。
- 每次一个桌宠任务，处理中显示咀嚼动画；气泡显示结果，需要审批/回答问题时提示回主界面。主界面自动选择新任务，可看完整记录、停止任务。结果使用纯文本显示，不执行返回的 HTML。
- 关闭主窗口仅隐藏，后台与桌宠保持运行；选择“文件 → 退出”才退出。切换项目会停止原后端及当前任务；未保存编辑仍保留原有切换/退出确认。
- 任务记录复用工作台会话；桌宠仅跟踪当前进程中最后一个任务，重启不自动恢复气泡。尚无开机自启、透明区域鼠标穿透、系统状态/空闲自主工作，也没有语音功能。

## 启动与任务

```sh
luban bot run
# 在另一个终端：
luban bot add "阅读项目并总结待办" -w /absolute/project
luban bot add "检查项目风险并给出报告" -w /absolute/project --every 3600 --timeout 600
luban bot add "生成今日摘要" -w /absolute/project --at '2026-12-01T09:00:00+08:00'
luban bot list
luban bot cancel <task-id>
```

- 同一 LUBAN_HOME 只允许一个 worker，串行执行；无需运行 worker 也能提交任务。
- 默认任务超时 900 秒；周期最短 60 秒，从上次成功完成时计时，不补跑错过的周期。
- 失败、取消、超时或中断后停止周期；检查结果后重新提交。崩溃时运行中的任务标为 interrupted，绝不盲目重放副作用。
- 任务和最近结果存储在 `~/.luban/bot/tasks/`；会话另存至现有 SessionStore。`list` 输出 JSON；桌宠面板提供只读摘要，尚无完整任务管理界面、系统通知或聊天平台入口。
- Ctrl+C / SIGTERM 停止 worker 并请求取消当前任务。取消与超时依赖执行引擎响应 AbortSignal，并非操作系统级强杀保证。

## 权限与费用

后台使用 ask 权限模式，不继承 `LUBAN_ALLOW_TOOLS=1` 或项目内 allow 规则。普通无需审批的读取工具仍可工作。需审批的操作必须匹配你维护的独立权限文件；未匹配就记录申请并拒绝，本次任务标记失败，不悬空等待、不自动重放。工作区外访问关闭，但这不是 OS 沙箱，仍以当前用户运行；仅提交可信任务并谨慎配置 MCP。

### 独立权限文件与申请

运行 `luban bot permissions` 初始化并验证 `~/.luban/bot/permissions.json`，已有文件不会被覆盖。你手动编辑授权，例如（替换真实绝对项目路径和有效期）：

```json
{
  "version": 1,
  "grants": [
    {
      "workspace": "/absolute/project",
      "tool": "bash",
      "args": { "command": "npm test", "timeout": 120 },
      "expiresAt": "2026-12-01T00:00:00+08:00"
    }
  ],
  "emergency": []
}
```

工具名、全部参数和项目必须精确匹配，不支持通配符或命令前缀；参数对象的键顺序不影响匹配。每次审批重新读取文件，删除规则立即阻止后续审批；已经开始的操作不会因此被终止。文件缺失默认不授权，格式错误或未知字段则拒绝授权。系统重启等强制人工确认操作不因文件规则而自动通过。

用 `luban bot requests` 查看申请：包含 taskId、项目、工具、完整参数和原因。审阅后可手工把对应操作写入 grants，设置有效期，再重新提交任务；不会自动续跑旧任务。申请文件是审计记录，不是可执行审批单，历史 pending 不代表仍有任务等待。当前没有弹窗、推送或自动批准命令。申请中可能有命令或文件内容，请勿把密码写进任务。

`emergency` 单独保留预授权应急规则，普通任务不会读取这一组权限，也不能靠提示词声称“紧急”提权。当前尚无紧急事件监测/执行器，因此应急规则暂不会自动执行；之后只有明确的应急入口才能匹配，未匹配只告警申请。

权限文件是应用层约束，不是 OS 安全边界。不要授权能够修改此文件的写操作，也不要把 `bash`/脚本授权理解为无副作用保证：即使 `npm test` 也可执行项目脚本。仅对可信项目和已审阅命令授权；不应把整个用户主目录设为工作区。

按现有配置调用模型会产生用量；建议先用一次性任务测试，再启用周期任务。当前有每任务超时，但没有每日 token/金额预算。用量来自提供方回报，Bot 结果只统计当前 runner 的请求，不保证覆盖委派子 agent、异常退出或未回报的 token，也不是费用账单；旧任务无法补算。不要把 API key 放进任务文本。

## macOS 登录自动启动（显式安装）

在完成构建/安装后，使用实际 CLI（不是 tsx 开发入口）生成 LaunchAgent：

```sh
mkdir -p "$HOME/Library/LaunchAgents"
luban bot service > "$HOME/Library/LaunchAgents/dev.luban.bot.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.luban.bot.plist"
```

这是当前用户登录后启动，不是登录前的系统服务；机器休眠期间不执行任务。退出终端仍可运行。服务引用当前 Node 和 CLI 的绝对路径，搬动安装目录后需卸载并重新生成。只保存 PATH 和 LUBAN_HOME，不复制 API 密钥；服务需使用配置可读取的凭证或另行配置所需环境变量。

日志：`~/.luban/bot/service.log`（当前需自行清理/轮转）。停止并取消自动启动：

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.luban.bot.plist"
rm "$HOME/Library/LaunchAgents/dev.luban.bot.plist"
```

如果进程被强杀，worker.lock 会保留以防重复执行。先用其中 pid 确认旧进程已停止，再手动移除 `~/.luban/bot/worker.lock` 目录并重启。不要在 worker 运行时删除锁。自定义 LUBAN_HOME 时路径相应改变。Windows/Linux 暂时使用 `bot run`，可由自己的服务管理器托管，不自动安装服务。

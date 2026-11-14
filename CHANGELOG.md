## 2.5.3 — 2026-11-14

- 修复 Creator 重启后「电脑操控」其实没恢复：合并顺序把子进程的 `enabled:false` 放在持久化状态之后，保存的开关每次都被覆盖成关闭。
  - 新增 `restoredComputer()` 统一这处判断：子进程没起来时以 creator.json 为准，起来后以子进程上报为准。
  - 真实 Electron 验证：`creator.json` 写 `{"computer":true}` 启动显示「电脑操控已开启」，写 `false` 启动显示「电脑操控已关闭」。
- 「授权」页的已记住授权现在真的看得见也收得回：空队列时也渲染队列头与页签，`RememberedApprovals` 单独成组件并带回归测试；点一次「清空已记住的授权」会同时清空页面与 creator.json，并保持操控开关不变（真实窗口点过一遍）。
- 修掉首次打开时 Mac 上却写「这台机器不支持电脑操控（只有 macOS）」：子进程没启动前 `supported` 被写死为 false，现在按平台判断，于是提示回到「还没打开电脑操控」。
- `npm run smoke:creator` 现在自带 creator.json 种子与断言：重启后开关为开、授权页列出 `computer、bash`、一键清空后 `allowed` 为空且 `computer` 仍为 true。

## 2.5.2 — 2026-11-14

- Creator 记住用户在窗口里点过的「允许」：下次启动新会话时同一工具不再每次询问，改为一条状态说明；在「授权」页可以看到已记住的列表并一键清空。
  - 只记工具名，不记参数；重启类命令（`approvalOnceOnly`）永远按次询问，也顺带修正了以前允许后返回 `always` 会被 agent 拒绝的问题。
  - 记住的授权不能绕过「电脑操控」开关：开关关掉时照样拒绝。点「拒绝」会撤销该工具的旧记忆。
- Creator 重启后保留「电脑操控」开关：窗口先用 creator.json 里保存的状态渲染，再等子进程的上报覆盖，不再显示成关闭而要求重新打开。
- 新增 drive 授权记忆、开关边界、重启命令按次确认、允许列表解析与 Creator 记忆函数的回归测试。

## 2.5.1 — 2026-11-14

- 桌面版 AI 自动展示的「当前修改」改为临时视图：任务完成、失败、取消、暂停或切换任务后恢复之前的页签；编辑器始终保留挂载，不丢失已打开文件和未保存草稿。用户手动选择的页签不会在收尾时被强制关闭。
- 右侧对话支持点击 HTTP(S) 网址、Markdown 文件链接和行内代码文件路径：桌面网址交给系统浏览器，当前项目文件交给系统应用；文件打开失败显示提示。主进程校验窗口来源及网址协议，文件仍受项目目录边界检查，禁止执行自定义协议。
- 新增修改视图生命周期及链接识别、打开和拒绝越界路径回归测试。

## 2.4.20 — 2026-11-14

- 修复桌面交互时误报 `job was still active when the Node process restarted`：桌面窗口与常驻后台共用任务目录，另一个实例启动不代表原任务所属进程已退出。
  - 新任务及续跑任务记录 `owner_pid`；启动清理只将明确已退出（ESRCH）的进程所属活跃任务标为失败。所有者仍存活、权限不足或旧记录缺少 PID 时保守保留，不再误伤其他窗口的任务。
  - 添加共享目录回归测试，覆盖存活所有者、排队任务、旧记录与真实退出的子进程；续跑测试确认所有者 PID 已更新。

## 2.4.19 — 2026-11-13

- 桌面版「终端」横向撑破代码列、压住右侧会话栏：面板宽度改为跟着列走，xterm 不再按出生时的列数硬撑。
  - 复现：真实 Electron 窗口在 1500px 下正常，缩到 900px 时 `.desktop-terminal` 仍是 734px 宽（右边缘 991），直接盖住从 580 开始的 Agent 栏，页面 scrollWidth 也还报 900 —— 因为溢出被上层裁掉，只有肉眼看得见。
  - 根因两层：`.desktop-console-pane` / `.desktop-terminal-panel` / `.desktop-terminal` 都没有 `min-width: 0`，列 flex 容器的交叉轴被 xterm 的固定 `cols×cellWidth` 顶开，面板跟着内容变宽；面板一宽 `fit()` 量到的就是「变宽后的自己」，xterm 永远收不回来（宽度自洽的死循环）。
  - 修法：`min-width: 0` 补到 console→pane→panel→holder 整条链；`fit()` 与首次建网格都改用新函数 `terminalWidth(holder, 所属 .desktop-console)` 取两者较小值，网格再宽也不会大过真正的列宽。`.desktop-terminal` 保留 `overflow: hidden` 作为兜底（console 本身不裁，否则高度拖拽条的 5px 抓取区会被切掉）。
  - 实测（`npm run probe:desktop:terminal`，真 Electron + 真 pty）：1500px 96×23、900px 40×23（面板 316、xterm 304，Agent 栏 580 起分毫未犯）、1180px 77×23、再放大回 120×23——列数双向跟随面板。
  - 新增 `src/web/client/desktop-terminal.test.ts`（12 例：`terminalWidth` 取小、隐藏面板回退、316px 列算 40 列而旧算法给 95 列、CSS 四层 `min-width: 0` 守卫）+ `scripts/desktop-terminal-probe.cjs` 真窗口回归探针。

## 2.4.18 — 2026-11-13

- 常驻后台默认让手机按 IP 直连：`--host 0.0.0.0`、固定端口 8642。
  - 2.4.17 的后台监听 `127.0.0.1` + 随机端口：手机在局域网里按 `http://<电脑IP>:<端口>/m/` 根本连不上，而且每次重启端口都变，手机里存的地址必然失效——「关掉终端也能连」只对中继成立。
  - `ensureDaemon` 默认改为 `--host 0.0.0.0 --port 8642`（`--host` / `--port` 或 `LUBAN_DAEMON_HOST` / `LUBAN_DAEMON_PORT` 可改）；`DaemonState` 记下绑定的网卡，旧状态文件缺这个字段时按 `127.0.0.1` 处理，不会被误报成局域网可达。
  - `luban daemon start` 新增 `--host/--port`，输出把每张网卡的链接连同令牌一起打印（`http://192.168.1.10:8642/m/?token=…`），并提示「同一网络里拿到链接的人都能操控这台电脑」；`daemon url` 同样列出全部链接。
  - `phoneLinks()`：循环地址在前，按绑定的网卡过滤——`--host 127.0.0.1` 时只给本机链接，绝不打印一张连不上的局域网地址。
  - 实测：`daemon start` 后 `lsof -iTCP:8642` 显示 `TCP *:8642 (LISTEN)`；`http://192.168.1.10:8642/m/?token=…` 返回 200（2381B）并引用 `assets/mobile-N6T0ecwJ.js`，同地址 `/api/sessions` 无令牌 401，`/api/node` 带令牌返回 2.4.17 与项目表。
  - 新增 `src/core/daemon-command.test.ts`（2 例：多网卡链接与令牌编码、只广播真正监听的地址），`daemon.test.ts` 增加绑定网卡/端口与旧状态迁移断言（15 例）。
  - 顺带修掉 `luban … | head` 的 EPIPE 崩溃：标准输出管道被 reader 关掉时安静退出（退出码 0），不再打印 `unhandled exception: write EPIPE`。

## 2.4.17 — 2026-11-13

- 常驻后台 `luban daemon`：一台机器一个入口，关掉终端/App 手机也连得上。
  - 之前只有两种后台：`luban web` 前台进程，和桌面 App 每个窗口一个 `--parent-pid` 子进程——两者都跟着自己的进程死，手机过一会儿再打开就只剩一张连不上的设备卡片。
  - `src/web/daemon.ts`：`~/.luban/daemon/state.json`（0600，pid/端口/令牌/出生目录/版本）作为唯一交接；健康检查是带令牌请求 `/healthz`（进程活着 ≠ 服务可用）；`mkdir ensure.lock` 做互斥，30s 过期锁可回收；后来者读到健康后台就复用并只把当前目录注册成项目（`POST /api/projects`）。
  - `luban daemon [status|start|add|stop|logs|url]`（`src/core/daemon-command.ts`）：`start` 幂等，`url` 直接给出带令牌的 `/m/` 链接，`status` 列出项目表、版本、模型和运行时长；崩溃留下的 state.json 遇到死 pid 会被清掉而不是被当成“没响应”。
  - 自动拉起：交互式 `luban` 启动时后台 ensure（`LUBAN_NO_DAEMON=1` 可关），失败只进 `daemon.log` 不打断 TUI 首帧；桌面 App 每个窗口 `daemon start <目录>`，窗口自己的后台改回纯本地——一个设备只占一个中继槽位，槽位留给常驻后台。
  - 子进程即 `luban web … --daemon-child`（新增隐藏参数）：绑定后用 `writeDaemonState` 立刻公布地址再拨中继；退出时只在 state.json 仍记着自己时才删除（`clearDaemonStateIfOwner`），不会删掉接替者的地址。
  - 实测：`daemon start /tmp/dh2/ws1` → pid 49617、port 65476、PPID=1；`add ws2` 后项目表 2 项；`/m/` 200、`/api/sessions?project=ws2` 200、无令牌 401；TUI（PTY）启动 8s 内自动起后台，退出 TUI 后 `healthz` 仍 200；`daemon stop` 后 state.json 消失、进程退出。
  - 新增 `src/web/daemon.test.ts`（13 例）：state 文件权限与校验、死 pid/哑服务区分、复用并注册目录、陈旧状态换新子进程（参数/detached/令牌环境/锁释放）、超时后杀子进程、真实 `stopDaemon` 杀进程、`clearDaemonStateIfOwner` 只删自己的、`/api/node` 项目表解析、日志尾部。

## 2.4.16 — 2026-11-13

- 通用 agent 化：不再用正则替模型做决定。删掉三处机械路径，一句话原样进模型。
  - `DriveSession.say()` 里「5 分钟后提醒我下班」的拦截删掉了（`handleReminderSentence`）：以前这句话在模型之前被解析成队列项，好处是模型挂了也能响，代价是它必须认识每一种说法、没法反问、模型根本看不到这句话。现在由模型自己换算 `in/at/every` 再调 `schedule`，`notify:true` 的纯提醒到点仍然零模型调用。
  - `screenIntent()` 关键词分流删掉：每个回合都是 `toolset: "all"`（文件、命令、MCP、computer），该截屏还是该读文件由模型判断，不再按「计算器/访达/浏览器」这类词预先收窄工具。
  - `src/core/bot-schedule.ts` + `src/core/reminder-text.ts`（及各自单测，共 4 个文件）整体删除；`remind.ts` 只留队列/间隔/通知这些基础能力（`scheduleReminder`、`ensureBotWorker`、`describeMoment`），`luban bot add --in/--every/--remind` 保持不变。
  - Creator 输入框只剩一句话：去掉「现在/定时/每隔」选择器、`datetime-local`、分钟输入、识别到的排期青绿标签和 `reminderIntent` 判断，派发时只提交 `{prompt, workspace}`；排期完全由模型的 `schedule` 调用决定，队列变成 agent 排期的落点而不是人填表单的产物。`creator-schedule.ts` 里随之没人用的 `everyLabel` 删除。
  - 提示词（`DRIVE_PROTOCOL`）改成「工具不够用就自己造」：一次性的事写脚本进工作区用 `bash` 跑，反复要用的做法写成 `.luban/skills/<名字>/SKILL.md`，下次用 `list_skills` / `read_skill` 读回来——能力靠模型长出来，不靠往 agent 里塞功能。
  - 新增 `drive.test.ts` 用例钉住这条行为：提醒句必须交给 runner（`usage.calls === 1`）、不产生任何 `tool` 事件、不在 `bot/tasks` 里偷偷建任务。顺带修好 `creator.tsx` 的挂载守卫（`typeof document === "undefined"`），`creator-task.test.tsx` 从此能在 node 环境跑起来（2 例）。
  - 文档同步：`docs/creator.md`（一句话派发、不做句子分流、自建 skill）、`docs/reference.md`（提醒不再由正则解析）。

## 2.4.15 — 2026-11-13

- 「5 分钟后提醒我下班」不再写成系统日历事件：排进 luban 自己的队列，跨平台。
  - 之前提示词让模型 `bash` + `osascript` 往「日历」或「提醒事项」里写一条——只在 macOS 上有，换到 Windows/Ubuntu 就白排；写在系统应用里 `luban bot list` 看不见、窗口里取消不了；而且一句话提醒还要跑一次模型。
  - 新增 `schedule` 工具（`src/core/remind.ts`）：`{text:"提醒我下班", in:"5m", notify:true}` → 一条 `kind:"notify"` 的队列任务，到点直接发系统通知，**不花模型调用**；到点真要干活的去掉 `notify`，仍是普通 agent 任务。时间写法支持 `5m / 90s / 2h / 1h30m / 5 分钟 / 1天`，也接受带时区的绝对 `at`。
  - 通知本身跨平台（`src/core/notify.ts`，有单测）：macOS `osascript display notification`、Linux `notify-send`、Windows PowerShell WinRT toast；没有通知器时任务照样记录完成，不因为「没弹出」把任务判失败。
  - worker 不在跑时 `schedule` 会顺手拉起（`ensureBotWorker`，不抢 LaunchAgent 的锁），并明确告诉模型「到点会响 / 先跑 luban bot run」。`luban bot add` 加了 `--in <5m>` 与 `--remind`，命令行也能排纯提醒。
  - 提示词改成「定时/提醒/闹钟一律用 schedule，别碰日历、提醒事项、osascript、crontab、at」，眼睛和手的窄工具集里也保留 `schedule`（提醒不是屏幕任务，不该被逼进日历 App）。窗口时间线把这一动作显示成「定时提醒 +5m · 提醒我下班」。
  - 实测：`bot add "提醒我喝水" --in 8s --remind` + `bot run`，到点 200 ms 内完成，`runs.jsonl` 只有 `result:"提醒我喝水"`、无 usage（零模型调用），通知由 osascript 成功弹出。

## 2.4.14 — 2026-11-13

- 造物主改名 `Creator`，图标换成青绿，不再和 luban 长得一模一样。
  - 之前 `.app` 显示名是「造物主」、包名 `Luban Creator`，和 luban 共用同一个 1024 图标（只是套了个默认色）——菜单栏/Dock 里两个图标并排分不出来。
  - 现在：`Creator.app`（CFBundleDisplayName `Creator`，id `com.luban.creator` 不变，DMG 卷名 `Creator <version>`）、窗口标题 `Creator`、菜单栏文字 `Creator · 忙/待命/未启动`、右键菜单与工作区选择框也一起改名。
  - 图标：新增 `assets/creator-app-1024.png`（青绿 #287F6D，图形保留 luban 的轮廓）→ `AppIcon.icns`；窗口左上角 logo 与菜单栏图标（18/36px）同步换成 `creator-icon.png` / `tray.png` / `tray@2x.png`。luban 本体仍是深蓝 #0D172A + 金色图形。
  - 界面内的中文文案（「造物主，我帮你…」）不动：改的是应用名，不是产品口吻。

## 2.4.13 — 2026-11-13

- 操控会话不再「所有指令都先截屏分析」：一句话进来先判断该用哪种手。
  - 旧行为（2.4.12）：drive 会话固定 `toolset: "computer"`，提示词第一句就是「windows → screenshot」。于是「你叫什么名字」「整理个文档」「设个闹钟」都会先去看屏幕——用户说的「处理个文档还截屏分析」「老是在截图分析」就是这一条。
  - 现在按句子分流（`screenIntent()`，有单测）：句子里真的在说屏幕上的东西（截屏/窗口/点击/计算器/访达/浏览器…）→ 这一轮只给 `computer`（眼睛和手，没有 shell，避免 osascript 猜坐标）；其余（问答、文档、代码、定时/提醒）→ 给全套工具（文件、bash、MCP）。
  - 修掉一个让窄工具集形同虚设的 bug：`delegate_task` / `ask_user` 是在构造函数剪枝之后才注册的，所以「只有眼睛和手」的会话里其实还能委派和提问——实测模型干脆不点、去委派。现在 `runLoop` 开头重新剪一次，窄就是窄。
  - 提示词改成先规划再动手：只问一句 → 一个工具都不调；文档/代码 → 文件工具，不截屏；**定时/提醒/闹钟 → 用命令排进系统**（`osascript` 写日历/提醒事项，或 `luban bot add --at …` 排后台任务），不要盯屏幕；只有真要动界面才 `windows → screenshot → click`。
  - 实测（本机真模型 + 造物主 bridge）：`你叫什么名字？` → 1 步 / 0 工具 / 0 截图 / 10 秒；`把 meeting.md 整理成三条要点写进 summary.md` → `read_file` + `write_file` / **0 截图** / 18 秒，产出正确；`设个明天早上 8 点的闹钟叫我起床` → 6 次 bash 在「日历」和「提醒事项」里各写一条 08:00 的提醒 / **0 截图** / 68 秒（读回提醒事项确认真是 2026-11-14 08:00）；`在计算器里算 6*7` → 点击序列 + 截图确认 **42** / 32 秒。
  - 窗口 smoke 增加 `CREATOR_SMOKE_UI`：真的往输入框里打字点发送，再断言气泡和回复出现——「窗口能不能正常交互」现在是被测过的。

## 2.4.12 — 2026-11-13

- 造物主终于能「替人操控电脑」，走的是 workbuddy 那条路：只有眼睛和手。
  - 反例先记着：旧 `luban drive` 跑「打开计算器输入 12*34」时，9 次工具调用全是 `bash`/`osascript`（pgrep 找进程、System Events 读窗口位置、用 PIL 量截图像素），**一次点击都没有**——会话里塞着 bash、编辑器和一百多个 MCP 工具，模型自然去写脚本。
  - 现在操控会话固定 `toolset: "computer"`：只留 `computer` / `read_image` / `attach_image`，MCP 发现直接跳过；普通会话行为不变（`AgentRunner` 加了一个可选 `toolset`，`keepComputerTools()` 可测）。
  - `computer {action:"windows"}` 返回前台应用、每个窗口的 x/y/宽/高和屏幕点尺寸；`computer {action:"app", name}` 直接启动/唤起应用，取代 `open -a` 和 `osascript`。
  - 截图结果同时给 `pixels` 与 `screen`（点尺寸、scale），并且新增 `origin`：截图裁剪的左上角在屏幕上的位置，屏幕坐标 = origin + 图内偏移。之前模型拿 Retina 像素当坐标，或者反过来反复换算窗口阴影偏移。
  - 截图自动附加到当前请求：跑完 `screenshot` 下一步就是图片，不再 read_image → attach_image 两次往返。
  - 修掉一个会卡死的真 bug：`luban drive` 的 stdin 命令是串行队列，`approve`/`stop` 排在它们要解锁的那一轮后面——点了「允许」什么也不会发生。现在审批与停止插队，`pumpCommands()` 抽出可测。
  - 审批语义对齐窗口：第一次「允许」覆盖本会话，回一条状态说明，不再逐次弹窗。
  - 提示词写清循环、单位、坐标来源；允许坐标已确定时一条回复里连发多个动作；并明确「截图一定送到了，不要因为觉得没看到图就重复截图」。
  - 造物主窗口接上这条会话：`apps/creator/drive.cjs` 一条 `luban drive` 子进程 + IPC，面板显示动作时间线、截图缩略图（主进程把相对路径按会话工作区解析后转成 data URL）和允许卡；`say` 的本地回显与子进程回显去重，不再显示两遍。
  - 新增 `npm run smoke:creator:drive`：真 Electron 窗口里发一句「在计算器里算 6*7」，断言面板真画出了动作、截图缩略图和审批卡。
  - 真机验证（本机 macOS + 真模型，结果都用截图/OCR 独立核对）：`12*34` → 6 次点击 1/2/×/3/4/=、14 步、显示 **408**；`7*8` → 11 步 / 5 次点击 / 3 张截图、显示 **56**；经造物主 bridge 跑 `9*9` → 24 秒 / 5 次点击（一条回复连发）/ 2 张截图、显示 **81**（窗口当时被挪到 1050,76，模型按新位置算的坐标）；creator smoke：13 条动作 / 6 张缩略图 / 1 张允许卡。
  - 已知未做：模型偶尔仍会重复截图或补一次多余的 `attach_image`（flash 的稳定性问题，提示词已压制，未根治）；CLI 路径的屏幕荧光圈仍未接（沿用之前的已知问题）。

## 2.4.11 — 2026-11-13

- 造物主终于能回答「我那些定时任务到底排上没排上、跑没跑」——以前窗口只有进行中/结果/授权三个页签，`每晚 23:00`、`每 6 小时` 这类排期只在任务卡里含糊显示一句，执行历史完全看不到：
  - 新增「全部计划」抽屉：左栏 `计划（n）` 徽章（n = 后台任务总数，这就是那个「显示个数、点开看详情」的入口）和输入卡下方 `计划 n` 都能打开它；抽屉顶部一行总览「4 条 · 循环 3 · 一次 1 · 正在跑 1 · 待触发 2」。
  - 分组列出 `循环任务` / `一次任务`：每条给排期（`每天 23:00` / `每周一 09:00` / `每 6 小时` / `一次 · 今天 14:41`）、下次触发（`下次 今天 23:00` / `马上执行` / `正在执行（14:34 开始）`）和已执行次数；展开后是工作区、超时、间隔、取消按钮，以及**逐次执行历史**：时间区间、成功/失败、调用次数与 tokens、结果摘要，点开是完整结论文本（Markdown）。
  - 输入框能直接说排期：「现在」模式下句子里带时间就自动排期——`每天 6 点提醒我` → `每天 06:00`、`5 分钟后提醒我下班` → 一次性任务、`每 6 小时扫一次 buglist` → `每 6 小时`；派发前在输入卡下方显示青绿标签预览（`每天 06:00 · 首次 …`），派发后弹「已排入：每天 06:00 · 下次 今天 06:00」，预约成功与否不用再靠猜。
  - 任务卡元信息固定为 `状态 · 排期 · 下次触发 · n 次执行`，取消按钮不再和排期挤在一行。
  - 排期文案抽成 `src/web/client/creator-schedule.ts`（纯函数，无 React），`creator-schedule.test.ts` 12 例锁住：每天/每周/每 N 小时/每 N 分钟/一次的措辞，下次触发的三种说法（下次/马上执行/正在执行），以及「每天 6 点」被解析成 `every=1天, at=下次 06:00` 后回读仍是 `每天 06:00`。空态、列表态、抽屉三张截图与 `*.rects.json` 全部由 `--smoke`（`CREATOR_SMOKE_PLANS=1`）产出：抽屉宽 520、贴右、700 高不滚动，4 条计划 + 2 条执行记录实测渲染。

## 2.4.10 — 2026-11-13

- 造物主窗口按 workbuddy.jpg 的版式重做（上一版只是一张竖排卡片，布局和参考完全不同）：
  - 用 Vision OCR + 逐像素量测把参考图（2890×1736）拆成坐标：侧栏占宽 19%、右侧居中内容列 58%、标题在窗口高 12% 处、输入卡 37%、建议胶囊 66%、底部声明 94%。新窗口 980×700（原 460×700），侧栏 200pt + 内容列 568pt，比例与参考一致。
  - 左侧栏：logo + 「发现应用」胶囊、选中态「新建任务」、进行中/结果/授权/权限策略四行（带计数徽章）、「任务（n）」逐条队列（状态点 + 时间）、「空间（n）」工作区、底部后台状态胶囊 + 用户行（青绿圆头像 + 收起）。
  - 右侧：居中 36px 标题「造物主，我帮你」+ 办公/开发/设计 分段控件；下面一排快捷胶囊；输入卡（20px 圆角、placeholder「今天帮你做些什么？ @ 添加上下文，/ 调用技能与指令」、左下 ＋、右下圆形发送键，未输入时变灰）；卡下一行「选择工作空间 / 默认权限」；再下面 4 条「↗」建议胶囊；底部居中「内容由 AI 生成，请核实重要信息」。
  - 配色按参考取样收敛：画布 #ffffff、侧栏 #f9f9fb、胶囊 #f7f7f8、发丝线 #ececf0（与参考差 1–2 个色阶）。
  - 有队列时自动收起 hero/快捷/建议，内容顶到 22pt 处；空态与列表态都在 700pt 内不出现滚动条（实测 scrollH == clientH == 700）。
  - `apps/creator/main.cjs`：窗口 980×700（min 760×520）、底色改白；`--smoke` 额外写出 `*.rects.json`（各区块 x/y/w/h、滚动高度、胶囊尺寸），版式回归不靠肉眼。

## 2.4.9 — 2026-11-13

- 造物主窗口换成参照 WorkBuddy 的浅色版式（原来的深色控制台版式太像后台管理页）：
  - 整页改成浅色：`#f7f8f9` 底 + 纯白卡片 + 极浅描边，只用一层柔和的投影分层次；`color-scheme` 与窗口底色（`apps/creator/main.cjs` 的 `#0e1117` → `#f7f8f9`）一起换掉，启动时不再闪一块深色。
  - 空队列时是真正的欢迎页：居中 26px 标题「造物主，替你跑腿」+ 一句说明，下面三张「↗」建议圆角胶囊，点一下就把那句话填进输入框；有任务时自动收起，把空间还给列表。
  - 输入区改成一张浮起的白卡（16px 圆角、聚焦时描边加深）：4 行占位「今天帮你做些什么？」，左下角是工作区胶囊（带文件夹图标）和时间选择，右下角是圆形青绿发送键（不可用时变灰而不是消失）。
  - 页签换成 macOS 分段控件（灰底 + 选中项白底投影），任务卡改成白底细边 + 悬停投影，状态点/元信息字号与颜色重排；结果区、授权卡、footer 同步改成浅色可读的对比度。
  - 列表态输入框收成 2 行，给队列让出高度。

## 2.4.8 — 2026-11-13

- 重做造物主窗口的视觉（460×700 下原来松松垮垮、footer 挤成两行、通篇同一层次的灰）：
  - `creator.css` 整套换掉：主色改成 logo 的青绿（`#4ed6b8`），底色加一层顶部微光，面板/分隔线分三层明暗；窗口 44pt 标题栏 + 30pt 状态栏，列表占满中间。
  - 输入区改成 2 行、短占位「让它做什么？」；右侧是青绿实心「派发」按钮（不可用时仍保留轮廓而不是消失），旁边一个 `⏎ 派发` 提示；工作区/时间选择收成 24pt 的小控件。
  - 任务卡：13px 标题（两行截断）、11px 元信息用 `·` 分隔、状态点带呼吸动画；「取消」改成悬停才出现，卡片默认不再挂满按钮。
  - 页签：计数改成小圆角徽章，选中页签用青绿下划线；结果区、授权卡（黄色左侧条 + 等宽 args）和空状态同步重做。
  - footer 的队列路径改成单行省略号，「收起」不再竖排换行——这正是原来最刺眼的一处。
  - `apps/creator/main.cjs` 窗口底色跟随新配色（`#0e1117`）。

## 2.4.7 — 2026-11-13

- 造物主补上图标：以前菜单栏只有「待命/忙/未启动」几个汉字，窗口里也只有文字，看不出是哪个程序。
  - `apps/creator/assets/tray.png`（18px）与 `tray@2x.png`（36px）：从 `assets/luban-app-1024.png` 裁掉透明边再缩放，`apps/creator/main.cjs` 用它建菜单栏状态项，状态字仍跟在图标后面；文件缺失时退回空图，不阻断启动。
  - `src/web/client/creator.tsx` / `creator.css`：窗口标题栏的「造物主」前加 16px logo（复用 `public/icon-192.png`），不再是纯文字标题。
  - 打包时 `apps/creator` 整目录进 bundle，图标随包分发；`.app` 的 `AppIcon.icns` 仍是 2.4.6 起就有的 luban 图标。
  - `apps/creator/bot.test.mjs` 新增一例：断言两张 PNG 存在、尺寸为 18/36、且是带透明的 RGBA。
  - 顺带修掉同一处的隐患：`apps/creator/bot.cjs` 起 worker/调 CLI 时优先用 `LUBAN_NODE_BIN`（打包后的 app 就指到包内 node），在 Electron 里没有自带运行时则给子进程加 `ELECTRON_RUN_AS_NODE=1`，不再让 CLI 以 Electron 主进程身份跑。

## 2.4.6 — 2026-11-13

- `npm run release` 在 macOS 一次产出三个程序：CLI ZIP、`luban-desktop-<v>-mac-<arch>.dmg`、以及新的 `luban-creator-<v>-mac-<arch>.dmg`（`Luban Creator.app`，显示名「造物主」）。
  - `scripts/package-macos.mjs`：`buildApp()` 改为按 `APP_SPECS` 生成 bundle（`com.luban.desktop` / `com.luban.creator`，入口 `apps/desktop` / `apps/creator`），两个 app 共用包内 Node 运行时和 CLI，DMG 失败同样回退 ZIP；新增 `packageVariant("creator")` 与 `npm run package:macos:creator`。
  - `scripts/release.mjs`：新增 `--kind creator`；macOS 下 `--kind all` 默认三个产物并带 ZIP 回退，`--kind creator` 在其他平台直接报「macOS-only」，linux/windows 的默认行为保持两个产物不变。
  - `apps/creator/bot.cjs`：`cliPath()` 优先使用 `LUBAN_CLI`，打包后的造物主用它自带的 CLI，而不是仓库路径。
  - `scripts/release.test.mjs`：mac 矩阵断言三产物与三回退项，并断言非 macOS 的 `--kind creator` 报错。

## 2.4.5 — 2026-11-13

- 造物主变成独立常驻程序（`apps/creator/`，`npm run creator`），不再依附桌面工作台：菜单栏一个入口，点开是自己的窗口——派任务、看进度、看结果，没有项目树/编辑器/预览。
  - `apps/creator/main.cjs`：Electron 托盘应用。工具栏文字形状态项（待命/忙/未启动）、关窗即隐藏、单实例、`app.dock.hide()`，窗口关闭不影响后台任务；菜单可手动拉起 worker、打开队列目录、打开 `permissions.json`、退出造物主。
  - `apps/creator/bot.cjs`：只读队列（`request.json` / `state.json` / `cancel` 标记）+ 经 `luban bot add|cancel|permissions` 写入，绝不另造一套格式；`ensureWorker()` 在无 LaunchAgent 时以 `detached` 拉起 `luban bot run`，已有系统托管时不抢锁；`workerStatus()` 用锁目录 pid 判活、用 `status.json` 心跳判「卡住」。
  - `src/web/client/creator.{html,tsx,css}`：Vite 第三个入口。`现在 / 定时 / 每隔 N 分钟` 派发，`进行中 / 结果 / 授权` 三个页签，结果用 Markdown 渲染（沿用 2.4.4 的分节规则），授权页列出被拒绝的调用与参数。
  - `npm run smoke:creator`：真 Electron 渲染并截图，同时断言窗口文本里出现队列中的任务，防止「有像素没内容」。
- 文档新增 `docs/creator.md`：构架、用法、无人值守的授权边界（精确 args 授权，`bash` 无法用一条授权覆盖，需要新增窄工具）、定时语义与失败不重放。
- 新增 `apps/creator/bot.test.mjs`（5 例）：队列排序/无状态按排队/取消标记优先/worker 停-活-卡住/经 CLI 落盘与 60s 下限。

## 2.4.4 — 2026-11-13

- 修掉「桌面版右侧回复/结论就是一坨文字」：`src/web/client/markdown.tsx` 以前把整段合并成一个 `<p>`，现在按模型真实的写作习惯分块。
  - `**契约**：正文` 这种加粗引导语识别成小节标题（`h3.md-lead`），正文另起一段——回复第一次有了主次；`**契约**（`path.ts`）：…` 里的括注渲染成标题旁的小字，不再孤立地悬在段首。
  - 段落内换行遇到句末标点（。！？；…!?;:）就断开成新段落，所以「一句一行」的回答不再被拼成一行；加粗整句（如 `**是的，可以。**`）仍按强调处理，不会被误升级成标题。
  - 折行拼接按语言决定空格：中文之间不加空格（以前是「修复了 A。 修复了 B。」这种夹着空格的一坨），英文单词之间仍保留空格。
- 排版：`.md p` 行高 1.75（窄栏 1.8）、段间距 8px、`li` 行高 1.7；`.md-lead` 用主题主色、上间距 13px，标题与其正文之间收 2px。
- 新增 `src/web/client/markdown.test.tsx`（7 例），用真实 job 结果里出现的写法覆盖上述规则；把 `markdown.tsx` 回退到上一版后其中 5 例变红。

## 2.4.3 — 2026-11-13

- 修掉「终端里跑的任务弹 ask_user，手机上只看到提问、没法选也没法输入，两边一起卡住」：
  - `QuestionBroker` 新增 `open(jobId, question, signal?)`，返回 `{ id, answer, close }`——终端保留自己的输入框，同时把同一个提问发布到 Web 广播；`request()` 改为基于它实现，行为不变。
  - `ApprovalBroker` 同样新增 `open(jobId, tool, args)`（终端版不带 600s 超时，由终端弹窗决定生命周期），`request()` 依旧带超时。
  - TUI 的 `askUser` / `approveTool` 现在优先广播：手机「交互」页出现同样的选项与「允许一次 / 本会话允许 / 拒绝」，**先回答的一方生效**，另一端的弹窗自动收起；终端作答时 `close()` 撤回手机那份，反之手机作答直接让终端那一轮继续跑。
  - `cli.tsx` 把 TUI 已有的两个 broker 注入 `App`（Web/中继没开时传空，纯终端行为与之前一致）。
- 新增 `src/ui/app-question-bridge.test.tsx`（真实 TUI + mock runner）：手机替终端回答 `ask_user` → 运行继续且广播清空；终端按 `1` 作答 → 手机那份同时被撤回；手机拒绝终端等待的审批 → 审批回调收到 `deny`。`src/web/question.test.ts` 增加 3 例（发布即出现在 `pending`、所有者先答时 `close()` 撤回、任务中断时自动移除）。
- 文档：`docs/reference.md` 的 Web 工作台与 API 表补说明（`/api/questions`、终端任务可被手机接答）。

## 2.4.2 — 2026-11-13

- 讲清并落实平台边界：电脑操控只做 macOS。新增 `computerSupported()`（`src/core/computer.ts`）作为唯一判断点——`begin()` / `act()` / `screenshot()` / `checkPermissions()` 在非 macOS 直接抛「只支持 macOS（当前是 linux）」这种一句话错误，不再让模型看到 `swiftc: command not found`；`createTools()` 在非 macOS **不注册** `computer` 工具；`POST /api/computer` 开启请求返回 400；TUI `/computer` 先说明原因再返回；客户端药丸本来就只在 `platform === "darwin"` 时渲染。
- `LUBAN_COMPUTER=1` 在非 macOS 只打印一行提示并忽略，无头运行不会因此失败。
- 新增三个「其他平台」用例：`computerSupported` 只在 darwin 为真、非 darwin 的 `begin/act` 抛可读错误且不会真的开启、`createTools()` 在 linux 下少且只少 `computer` 一个工具（`read_image` 等仍在）。
- 文档 `docs/computer-control.md` 增「平台支持」表：Linux/Windows 上除电脑操控外的功能（编译、测试、mesh、relay、手机端）都照常。

## 2.4.1 — 2026-11-13

- 修掉「CLI 里能操控但看不到光圈」：终端自己现在也会画燃弧。`ComputerControl.begin()` 在 macOS 上拉起 `apps/desktop/native/glow.swift`（按源码哈希编译进 `~/.luban/bin/luban-glow-<hash>`，约 5s，之后复用），`end()` / `requestStop()` / `Ctrl+C` 时关掉；徽标写明「luban 正在操控 · ⌘. 停止」。终端本身覆盖不了别的 App，这是唯一能在 CLI 里显示边框的路径（`~/bin` 里的 `glow.html` 只对 Electron 有效，勿再误用）。
- 燃弧调亮：内圈描边 0.55→0.85 且加粗到 2px、新增 6px 处一圈暗线（0.30）、四条径向渐变带 0.30→0.42、火花带 0.55→0.80 且阴影 16px、徽标底 0.82→0.92。实测（3360×2100 真截屏对比）：边缘 `(23,23,23)→(69,87,112)`，四角 `(77,81,69)→(107,132,155)`，中心像素不变，约 6.5 万采样点变化。
- 停止标志不再被系统事件污染：`glow.swift` 收到 SIGTERM/SIGINT/SIGHUP 或发现父进程消失时只退出，**不写** `~/.luban/computer/stop`；只有人按 `⌘.`（或开关关闭）才写。之前父进程正常结束会顺手写一个停止标志，导致下一会话的第一次操作报「用户已中止」。`stopRim()` 改为等子进程退出后再删标志。
- 桌面端不重复画：检测到 `LUBAN_GLOW_URL`（桌面 App 自己那圈覆盖层）就不起 CLI 覆盖层；`LUBAN_GLOW=off` 可全局关掉；`LUBAN_GLOW_BINARY` 指定现成二进制（测试用）。
- 新增 `src/core/computer.test.ts` 的 `rim overlay` 三例：会话开启就点亮、结束即熄灭且不留停止标志；桌面 App 在场时让位；glow 二进制缺失时操控照常可用。
- 文档 `docs/computer-control.md` 补「终端里也有燃弧」一节，删掉「终端没有燃弧」的旧说法。

## 2.3.20 — 2026-11-13

- 电脑操控补齐非桌面入口（三条路共用同一个停止标志 `~/.luban/computer/stop`；开关本身是每进程的，只对自己那个 agent 放开）：
  - **终端 TUI**：新增 `/computer [on|off|status]`（不带参数在开/关之间切换）。`status` 直接跑 helper 的 `check`，一行打印 `电脑操控：开 · 辅助功能 ✓ · 发送事件 ✓ · 屏幕录制 ✓ · 缩放 2×`；开启后标题栏出现红色 `⌁ 电脑操控`。终端覆盖不了别的 App，所以没有燃弧，靠标题栏 + 工具卡显示。
  - **运行中 `Ctrl+C` / `Esc`** 在中断任务的同时收回电脑操控（写停止标志并置灰状态），和桌面 `⌘.` 语义一致。
  - **无头**：`luban --prompt`、管道输入没有可点的开关，只有 `LUBAN_COMPUTER=1`（或 `on/true/yes`）显式打开，启动时在 stderr 说明；未设置时工具照旧报错。
  - `luban web` / 浏览器工作台沿用桌面那套药丸 + `/api/computer`，无需改动。
- 新增 `src/ui/app-computer.test.tsx`（真实 TUI：`/computer status` 如实报缺屏幕录制、`on` 后 `control.enabled === true` 且标题栏出现 `⌁ 电脑操控`、裸命令切回关闭）；`src/core/computer.test.ts` 增加 `beginFromEnvironment` 用例（未设置/`0` 不开启，`1` 开启）。现在共 8 + 1 + 2 + 5 个电脑操控用例。
- 文档：`docs/computer-control.md` 增「三个入口」对照表。

## 2.3.19 — 2026-11-13

- 新增「电脑操控」：luban 现在可以截屏、移动指针、点击/双击/右键、拖拽、滚轮、打字和按快捷键，和 Codex 一样在需要时接管这台 Mac。所有输入都只经过一个编译型 helper（`apps/desktop/native/computer.swift`，`swiftc` 按源码哈希编译进 `~/.luban/bin`，也可用预编译产物/LUBAN_COMPUTER_HELPER 覆盖），Node 侧不直接注入事件。
- 安全默认：工具在开关关闭时**直接报错**而不是静默无操作；桌面 Agent 栏顶部新增「电脑操控」药丸开关（只在 macOS 出现），开启后屏幕四边燃起蓝色燃弧 + 顶部徽标「luban 正在操控 ⌘. 停止」，`⌘.`（全局快捷键）中止：桌面写 `~/.luban/computer/stop`，后端每个动作前都重读该标志，失控循环在下一步立即中断；关掉后约 0.7s 就熄火。
- Electron：新增透明全屏覆盖窗口 `apps/desktop/glow.html`（`setAlwaysOnTop("screen-saver")`、`setIgnoreMouseEvents`、不抢焦点、全屏/多桌面可见），用 Canvas 画边缘渐变 + 沿边游走的锯齿电弧，`prefers-reduced-motion` 降级；后端（子进程）通过 `LUBAN_GLOW_URL` 回环端点 + `x-luban-glow-token` 把 begin/action/end 事件推过来，不需要跨进程 IPC。
- 权限如实上报：`check` 同时返回 AX、`CGPreflightPostEventAccess()` 与屏幕录制三项，前端缺权限时药丸显示虚线并提示「系统设置 → 隐私与安全性」；`cursor`/`screenshot` 只读，`status` 不要求开关。
- 指针移动改为 `CGWarpMouseCursorPosition` + `.mouseMoved` 双保险：TCC 归属到 launcher 时 `post` 会被静默丢弃（实测 Node 子进程 move 不生效），warp 不依赖授权，所以移动始终精准，post 只负责让窗口感知 hover。
- 新增 `src/core/computer.test.ts`（7 例：未开启拒绝、⌘. 中止与重开、截屏落 `.luban/computer` 且只留 20 张、权限探测、glow begin/action/end、双击/右键动词、helper 定位）、`src/web/computer-endpoint.test.ts`（2 例）、`src/web/client/computer-control.test.tsx`（5 例）。
- 验证：`tsc`（server+client）干净；真实 helper 实测 `check` 全绿、`screenshot` 3360×2100 全屏 PNG、`move` 由 293→333 且可回位；Chrome 渲染 `glow.html` 采样边缘像素为蓝色 (49,74,112)、中心保持背景色；`npx vitest run src/web src/core/computer.test.ts` 59 文件 / 361 用例通过（唯一失败是既有的 macOS tmpdir 符号链接用例）。

## 2.3.18 — 2026-11-12

- 桌面三栏整体收紧，把「很多空间用不上」的地方压回来（1680×1050 实测，只动桌面作用域，手机端不加改动）：
  - 左栏 chrome 238px → 148px：品牌条 54→40、项目区 77→39（标签和「打开文件夹/新窗口」并成一行，只有工作区路径独占一行）、主题选择 67→35（标签与选择并排）、文件/会话标签 40→34；文件行 27→24、分组标题 32→24、「新会话」与列表行内边距同步收敛。
  - 中栏：代码标签 45→32、文件头 54→38、欢迎页 20px 内边距与 24px 标题收到 16/20、编辑信息条 4→3；控制台默认高度 240→190（`DEFAULT_CONSOLE_HEIGHT`），标签条 35→30、格式行 37→21、命令输入行 48→39、折叠高度与标签条等高（30）不再留空带。
  - 右栏：标题条 54→40、会话 tabs 34→28、会话提示 9/14→6/10、消息间距 13→11；composer 164→121（文本框 62→40、chip 行 6→3、发送键 30→24）。
- 新增 `src/web/client/desktop-density.test.ts`：把上面这些上限写成预算（品牌条 ≤40、文件头 ≤38、控制台默认 = 190 且折叠高度 = 标签条高、composer 文本框 ≤40 等），以后再加 padding 会直接变红。
- 验证：`tsc`（server+client）、`npm run build`、`npx vitest run src/web/client`（35 文件 / 222 用例通过）；CDP 在 1680×1050 下逐块复测上述高度。

## 2.3.17 — 2026-11-12

- 桌面右侧 Agent 栏重排，解决「内容显示不全 + 头像在最左边留一条空边」：头像从独立左列挪进名字行（`<div class="head"><div class="avatar">Y</div>你…`），`.msg` 不再是 `26px 1fr` 网格，`.note`/`.thinking-block`/工具卡/结果卡/运行条都不再各自缩进，整个栏只有一个左边缘（实测正文 x=27→13，行宽 501→529）。
- 历史会话的 `session-body` 之前在桌面栏里又补了 15px 内边距，和实时消息差 12px，形成两条左基线；现在统一为 `.desktop-agent .session-body { padding: 0 0 16px }`，banner 也回到同一条线。
- Markdown 表格：外层 `.md-table` 横向滚动，单元格 `min-width: 96px`。之前父级 `overflow-wrap: anywhere` 让表的最大内容宽度塌缩，5 列表格被压到 39px/列、字挤成竖排；现在 5 列各 96–99px，8 列时容器 529px、内容 769px 可左右滚动，不再被右侧裁掉。
- 新增 `src/web/client/desktop-agent-layout.test.tsx`：用 `renderToStaticMarkup` 断言头像在名字行内、`.msg` 没有头像网格列、`session-body` 单左边缘、表格最小列宽与可滚动。
- 验证：`npx tsc -p tsconfig.client.json --noEmit`、`npm run build`、`npx vitest run src/web/client`（34 文件 / 218 用例通过）；CDP 探针在 554px 栏宽下复测左偏移、行宽、表格 5 列/8 列滚动，并确认会话区与输入框无重叠、页面无横向溢出。

## 2.3.16 — 2026-11-12

- 修 `npm run release` 的 Electron 环节卡死：本机缓存里已有校验通过的 `electron-v44.4.5-darwin-x64.zip`（GitHub 地址的缓存目录），而脚本强制用 npmmirror 镜像，URL 不同→缓存键不同→又去重新下 134MB，180 秒超时后整条 release 失败。现在 `ensureElectron` 依次尝试：配置的镜像 → 直接从任意缓存目录里找校验通过的归档并解包（`seedElectronDist`，与 `electron/install.js` 写入 `dist/version`、`path.txt` 的方式一致）→ 官方地址。三者都不可用才报错，报错里带上缓存路径与实际缺的文件。
- `ensureElectron` 改为 async（`scripts/release.mjs`、`scripts/package-windows.mjs` 调用处加 `await`）；新增 `electronCacheRoot` / `electronArchiveName` / `findVerifiedArchive` / `cachedElectronArchive`，缓存目录扫描按名字排序，重试结果稳定。
- 验证：`node --test scripts/release.test.mjs`（7 项通过，新增「不同镜像目录下的同一归档按 sha256 复用、校验不符不采用」）；`npm run release` 在原先失败的同一条命令下产出 2.3.16 的 mac x64 CLI ZIP 与 DMG。

## 2.3.15 — 2026-11-12

- 查清「手机上一条消息接在了不相关的会话上、工作目录还是 /tmp/luban-phone」：本机一直留着一个 `luban web /tmp/luban-phone --relay` 的测试进程（11-11 08:11 起），手机仍钉在它上报的中继节点上，于是会话列表是那个临时目录的测试会话；而任务列表是整机范围的（`/api/jobs` 把 `~/.luban/jobs` 全量返回），所以 Conductor 会话里那句「你帮我看看第二个实验主要是做什么？」在这台手机上看起来像是接着那个测试会话。桌面侧其实是对的：该任务 `project_id=Conductor`、`session_id=20261109131529-vi33k3`、`workspace=/Users/me/Documents/Conductor`。已停掉该残留进程。
- `GET /api/jobs` 支持 `?project=`（`MeshJobStore.list` / `MeshRuntime.jobs` 增加项目过滤；没有 `project_id` 的旧任务仍然可见）。不带参数仍是整机视图，桌面控制台行为不变；手机按当前工作区拉取任务，不再把别的项目的会话列进自己的任务流。
- `continuationForPrompt` 现在把**被打开会话自己的 project** 带进接续请求（之前丢弃 project，`project_id` 回退成手机当前工作区）：手机停在一个工作区、看着另一个工作区的会话时，下一条指令不会再跑错目录。
- 修一个自动选会话的抢跑：点了任务但任务详情还没回来时，`job` 是空的，自动选会话会趁机把一个无关会话设成「待接续」；现在任务列表里存在的选中任务也算「活动视图」。
- 验证：新增 `src/web/jobs-scope.test.ts`（同一台机器上 conductor / luban-phone / 旧任务三种记录的过滤矩阵，去掉过滤时该用例变红）、`mobile-continue.test.ts`「带被打开会话自己的 project」；`npx tsc -p tsconfig.json --noEmit`、`npx tsc -p tsconfig.client.json --noEmit`、`npm run build`、`vitest src/web src/core/mesh`（383 passed，仅 `server.test.ts` 那个 macOS `/var` 与 `/private/var` 旧有失败）通过。

## 2.3.14 — 2026-11-12

- 定位「ssh 里一直闪」的真正来源：手机远控的中继日志走 `console.error`，Ink 对 console 的处理是「擦掉整帧 + 写这行 + 整帧重画」，链路抖动时每 2～3 秒一次，远端看到的就是整屏闪一下。日志改为交给 TUI（`subscribeRelayLog`），在状态区占一行最多 8 秒，不再碰终端帧；无 TUI 时仍写 stderr。
- `terminal-output.ts` 增加兜底：只有行擦除（`2K`/`1A`/`G`）不含内容的写入直接丢弃，并让紧随其后的整帧重画补齐。任何来源的 console 输出都不会再先擦空屏幕；`\u001b[2J` 之类整屏清除仍原样下发。
- 服务器实测（203.0.113.7:22，120×74 PTY）：修复前 13 秒内 5 次 `erase2k=74` + 每次 20KB 整帧重画，修复后仅剩按行重画。
- 验证：新增 `terminal-output.test.tsx`「丢弃整帧擦除后仍整帧重画」与 `app-relay-notice.test.tsx`「中继日志进状态行、不进 console」；`npx tsc -p tsconfig.json --noEmit`、`npm run build`、`vitest src/ui src/web` 通过。

## 2.3.13 — 2026-11-11

- 修「ssh 打开还是闪烁」里的可修部分：绝对行重画原先只在「帧高 = 终端行数 - 1」时启用，对话框、短画面等其它高度会退回 Ink 的「擦除整帧再重画」，正是闪的来源。现在只要帧放得下终端（`1 ≤ 帧高 ≤ 行数`）都按绝对行重画，并只重画内容变化的行。
- 新增 `LUBAN_TUI_TRACE=/tmp/tui.log`：每次写入记一行，`absolute rows=3/24 painted=1 bytes=…` 表示按行重画 1 行，`ink bytes=… rows=… erase2k=…` 表示这次落入 Ink 原始路径，`erase2k>0` 或 `control` 标记能直接看出是哪类写入触发整屏擦除。上限 4000 行，写文件失败不影响界面。
- 验证：`terminal-output.test.tsx` 新增「非 rows-1 高度也按绝对行重画（不含 `2K`）」与「trace 文件记录两类写入」两条；`npx tsc -p tsconfig.json --noEmit`、`npm run build`、`vitest src/ui/*` 全绿。

## 2.3.12 — 2026-11-11

- 修「ssh 到 Ubuntu 跑 luban，样式传不过去」：`ssh` 默认只转发 `TERM`，不转发 `COLORTERM`，颜色库据此把远端会话判成 16 色甚至无色。新增 `src/ui/terminal-capabilities.ts` 统一判定（`NO_COLOR`/`FORCE_COLOR`/`TERM=dumb` 优先，`truecolor`/`24bit` → 24 位色，`*256color` → 256 色，其余远端 TTY → 256 色，本机保持保守推断），并由 `src/ui/terminal-boot.ts` 在 Ink 加载前把色号直接设到 chalk：不能用 `FORCE_COLOR`，color 库对它的任何值都跳到 24 位色，只支持 256 色的终端会把 `38;2;r;g;b` 显示成无色。实测同一条 `<Text color="#7aa2f7">` 在 `TERM=xterm` 的远端会话下从无 SGR 变成 `38;5;111`。
- 修「控制台闪烁」：整屏重画。`terminal-output.ts` 原来每帧把每一行（皮肤底色整行）重写一遍，一次按键约 3.9 KB；现在只重画内容变化的行，窗口尺寸变化/外部日志/二进制写入立即全量重画，另外每 120 帧全量重画兜底。实测 41 行界面按一个键从 ~3880 B 降到 23 B（2 行）。Ink 6 自己已经用 DECSET 2026 包帧，所以没有重复添加同步序列。
- 新增 `LUBAN_TERM_INFO=1` 打印一行判定依据（`TERM`/`COLORTERM`/是否 ssh/最终色号），`LUBAN_MASCOT=0` 仍可单独关闭背景图；`chalk` 提升为显式依赖（5.6.2）。
- 验证：`src/ui/terminal-capabilities.test.ts`（色号判定矩阵、远端兜底、`NO_COLOR=0` 例外）、`src/ui/terminal-output.test.tsx`（只重画变化行、尺寸变化全量重画、真实 TUI 一次按键 <6 行且 <400 B）；把 `repaintAll` 强制为 `true` 时这两条新断言会红，恢复后 8 passed。`npx tsc -p tsconfig.json --noEmit`、`tsc -p tsconfig.client.json --noEmit`、`npm run build` 通过。

## 2.3.11 — 2026-11-11

- 修「刚跑完就退出，统计就少一截」：所有退出路径（TUI 退出、一次性 `--prompt` 跑完、`luban web`/`luban serve` 停机、desktop 关窗口时 `--parent-pid` 后端退出、`luban bot run` 停止）现在都会在给退出码之前强制补发一次待上报增量（新增 `flushUsageStatsOnExit`，`force` + 最长等 2 秒，超时的守卫定时器 `unref` 掉，不会拖着终端不关）。
- 顺手修掉一个会算错的并发缺口：`usage-stats.json.lock` 独占账本，同一时刻只有一个进程上报（抢不到就跳过，锁文件超 30 秒视为崩溃残留自动接管）；成功回执改成「按已发送的量从 pending 里**减**」而不是「写回发送前读到的快照」，所以上传途中结束的另一次运行不会被覆盖掉。
- 实测（本地起 127.0.0.1:18999 收包）：`LUBAN_HOME=<tmp> node dist/cli.js stats` 结束前发出 `{"input":77,"output":9,"runs":2}`，账本 pending 归零、reported 15/3/2，整条命令 0.97s；把地址指向没人监听的 19999 端口时同样 0.97s 退出、pending 原样保留、failures=1。
- 验证：`src/core/usage-stats.test.ts` 新增「退出时无视间隔仍上报且第二次不发请求」「并发三个 flush 只发一次」「上传途中记录的新运行不丢」「锁被别人持有则跳过 / 锁文件过期可接管」（15 passed），`npx tsc -p tsconfig.json --noEmit`、`npm run build` 通过。

## 2.3.10 — 2026-11-11

- 修「token 统计不及时、看板刷不出来」：根因是客户端默认 `interval_hours: 6`，而且 `usage_stats.interval_hours` 走的是 `integer()`（`0.25` 被截断成 `0` 再被 `Math.max(1, …)` 抬回 1 小时），所以想调快也调不动。现在默认改成 **15 分钟**（`0.25`），`config.ts` 换成保留小数的 `flexible()`，下限 1 分钟、上限 168 小时；`usage-stats.ts` 同步去掉「最小 1 小时」的夹取。
- 新增 `luban stats` 命令：打印本地账本的待上报/已上报 token 与运行次数、上次尝试与上次成功时间、当前上报地址与间隔；`--push` 忽略间隔立刻补发一次，失败时打印真实原因（新增 `flushUsageStats({ onError })` 钩子，`force` 跳过节流），`--json` 便于脚本排查。
- 实测：`luban stats` 显示 pending 5,242,786 input / 20,430 output · 5 runs；`luban stats --push` 之后服务端 `/api/stats` 立刻从 80,778,883/482,918/38 变成 86,021,669/503,348/43，与本地账本逐字节对齐。
- 验证：`src/core/usage-stats.test.ts` 新增「0.25 小时间隔下 14 分钟跳过、15 分钟放行」「`force` 立即发送 + `onError` 拿到 ECONNREFUSED」；`src/core/config.test.ts` 新增「默认 0.25、小数被保留、<1 分钟被夹到 1 分钟、LUBAN_USAGE_STATS=off 生效」（55 passed）。

## 2.3.9 — 2026-11-11

- 统计服务整体搬出本仓库，独立成 https://github.com/holylong/luban-server （零依赖 ESM、自带 dashboard、`node --test`）：删掉 `src/stats/`、`deploy/luban-stats.service`、`scripts/deploy-stats.sh` 和 `stats:serve` 脚本；客户端协议（`POST /api/report`、`GET /api/stats`、`/health`）与 `usage_stats.url` 不变，线上 18080 继续收数。
- 新仓库的看板重做：7/30/90 天区间、按区间补齐空白日期的柱状图（输入/输出两段）、按天明细只列有上报的日期、版本与平台分布、60 秒自动刷新、390px 手机单页不横向溢出（用 CDP 量 `scrollWidth == clientWidth` 确认，表格各自横向滚动而不是撑破页面）。
- 补齐「连不上统计服务 / relay 也不能影响本地」的回归测试：`usage-stats` 新增一条「服务端接了连接却不回包 → 40 ms 超时后返回 failed、增量原样留在账本、failures=1」；新增 `src/web/tunnel-offline.test.ts`，对端不监听时 `TunnelClient.start()` 仍立即返回（<500 ms）、状态落到 offline 并打 `relay unavailable`，`stop()` 干净退出。
- 验证：`npx vitest run src/core/usage-stats.test.ts src/web/tunnel-offline.test.ts`（10 passed）、`npm run build`、`npx tsc -p tsconfig.json --noEmit`；`grep` 确认仓库里已无 `src/stats` / `luban-stats` / `stats:serve` 残留。

## 2.3.8 — 2026-11-11

- 修手机 WebView 版里「会话记录一长，发送按钮就没了」：`.m-compose` 是 `display: grid` 却没写 `grid-template-columns`，隐式 `auto` 轨道按最宽子元素的 max-content 定宽，而底部那行摘要正好印着会话标题、工作区路径和模式 —— 标题一长，整个输入区被撑到 410px（屏宽 390px），右边的 ↑ 按钮被 `.m-app { overflow: hidden }` 切掉。现在 `.m-compose` 用 `minmax(0, 1fr)` 固定成屏宽，`.m-compose-summary` 补 `width: 100%; min-width: 0; overflow: hidden`，`.m-compose-box` 补 `max-width: 100%`。
- 同一个截图里还有第二处超宽：会话标题 `<h3>` 没有换行规则，标题里带一段长路径/哈希时 `.m-main` 会横向滚动（实测内容 614px / 屏宽 390px）。`.m-main-inner` 的 `h1/h2/h3` 加 `overflow-wrap: anywhere`，标题按屏宽换行。
- 验证：用 Chrome 在 390×844 下量同一段标记（`iframe` 固定 390px 宽，部署版 `mobile.css`），修复前 `.m-compose` scrollWidth 410、`.m-send` 右边缘 403（屏宽 390），修复后 390 / 371，`.m-main` 的 scrollWidth 从 614 回到 390；`src/web/client/mobile-layout.test.ts` 新增两条断言（换回旧 CSS 会红，已确认），`npx vitest run`（mobile-layout / collapse / session / continue 共 21 passed）通过。

## 2.3.7 — 2026-11-11

- 203.0.113.7 上的使用统计服务其实从来没装起来：没有 `luban-stats.service`、没有 `/opt/luban-stats`、`ss` 里 18080 也没有监听，所以客户端一直在往一个没人接的端口上报。现在按 `deploy/luban-stats.service` 装好并 `enable --now`，`POST /api/report` → `/var/lib/luban-stats/reports.jsonl` → `GET /api/stats` 全链路打通，`GET /` 看板 200。
- 部署脚本在 macOS 上会把 `._server.js` 这类 AppleDouble 文件一起打进包里、落到 `/opt/luban-stats`；现在打包用 `COPYFILE_DISABLE=1` 加 `--exclude '._*'`。
- 单元里的 `ExecStart=/usr/bin/node` 是写死的，这台机器上根本没有 `/usr/bin/node`（node 在 `/usr/local/bin/node`，systemd 直接 `status` 就起不来）：`deploy/luban-stats.service` 改成 `/usr/bin/env node` 并显式声明 `PATH`，`scripts/deploy-stats.sh` 安装时再把 `ExecStart` 改写成远端 `command -v node` 找到的绝对路径。
- `docs/usage-stats.md` 补上「只有 sudo 普通用户、没有 root 直连」时的等价部署步骤（`203.0.113.7` 的 `deploy` 就是这种情况）。
- 验证：`npm run build:server` 通过；`npx vitest run src/stats src/core/usage-stats.test.ts`（14 passed）；本机另起一份 `dist/stats/server.js` 跑通 health/report/stats/看板；远端 `systemd-analyze verify` 0、`is-enabled=enabled`、`is-active=active`、`curl http://127.0.0.1:18080/health` 返回 `{"ok":true}`，从外网 `curl http://203.0.113.7:18080/health` 也是 200（ufw 未启用、iptables INPUT ACCEPT、安全组已放行），测试上报的数据已从 `reports.jsonl` 清掉并重启确认统计归零。

## 2.3.6 — 2026-11-11

- 新增独立使用统计服务 `src/stats/server.ts`，部署在 203.0.113.7:18080，零依赖、只用 Node 内置模块：`POST /api/report` 收客户端增量，`GET /api/stats` 出汇总 JSON，`GET /` 是中文看板（安装数、7/30 天活跃、总 token、输入/输出分开、最近 30 天按天、按版本、按平台），`GET /health` 供 systemd/监控探活。数据是一个追加写入的 `reports.jsonl`，内存汇总，重启重放日志恢复；按 IP 限流 120 次/分钟，请求体上限 16 KB，可选 `LUBAN_STATS_TOKEN` 给看板加 Bearer 鉴权。
- 客户端新增 `src/core/usage-stats.ts`：`~/.luban/usage-stats.json` 保存随机安装 id、待上报增量、已确认总量；agent 每轮结束在 `finally` 里按 `RunMetrics.requests[].usage` 累加（每次模型调用算一次，含 compaction/handoff，中断的运行也算已产生的部分），默认 6 小时最多上传一次，约 200 字节，空闲且无待报数据时完全不发请求。
- 失败不丢数据也不风暴：上传失败保留增量、间隔按 2 的幂翻倍（最多 16 倍），恢复后一次性补发；全新安装会发一条 0 token 心跳把「装了」和「跑了」区分开。开关：`usage_stats.enabled` / `LUBAN_USAGE_STATS=off`，地址可配 `usage_stats.url` / `LUBAN_USAGE_STATS_URL`。
- 新增 `src/core/usage-stats.test.ts`（8 条：记账、安装 id 稳定、心跳、间隔节流、成功后清零、失败退避、关闭后静默、坏文件恢复）与 `src/stats/server.test.ts`（6 条：去重安装数、输入输出分列、重启重放、坏请求拒绝、活跃窗口、看板与鉴权）；`docs/usage-stats.md` 写明上报字段、配置、接口与部署；`scripts/deploy-stats.sh` + `deploy/luban-stats.service` 一键部署（编译、校验 sha256、装服务、健康检查）。

## 2.3.5 — 2026-11-11

- Mesh 超时不再判失败：`job_timeout_seconds` 到点以前直接 abort 运行、把任务记成 `TIMEOUT after Ns`，手机和 TUI 都弹「任务失败」，一个只是需要更久的正常任务被当成坏了。现在它只在本机任务日志里写一条 `still running after Ns (job_timeout_seconds)` 并推到执行时间线，运行继续跑到自己的结果，`done` / `paused` / `failed` 由真实结果决定。
- 等待远程任务的一边同样按最后状态判断：`mesh_handoff` / `mesh_ask_all` 等不到结束不再发 `job_cancel`、不再把本地镜像记录写成 `failed`，而是返回 `remote job <id> on <peer>: working` 加日志末尾几行和 `stopped waiting after Ns` 说明；发起方随后在后台继续轮询（顺带续着对方租约），对方真正结束后把最终状态与结果写回本地记录，广播行显示 `[working]` 而不是 `[failed]`。
- 排队超时（`queue_timeout_seconds`）仍然算失败：任务根本没开始跑，没有结果可等。真正的中止依旧走明确的两条路径——提交方主动取消、提交方心跳租约过期。
- 新增 `src/core/mesh/runtime.test.ts` 两条用例：运行超过 `job_timeout_seconds` 仍以真实结果收尾；等待超时后既不取消也不判失败，本地记录跟到对方的最终状态。`npx vitest run src/core/mesh`（43 passed / 1 skipped）、`tsc -p tsconfig.json --noEmit` 与 `npm run build` 通过；`docs/reference.md` 补上「超时只报状态，不判失败」一节，`mesh_handoff` / `mesh_ask_all` 的工具说明同步更新。

## 2.3.4 — 2026-11-11

- 修好手机「接续会话」只接一轮就断：打开一条历史会话，第一条指令正常追加，第二条却新建了一个 session，会话列表里凭空多出一条。原因是手机发完一轮为了看实时进度清掉了会话指针，而任务自己记录的 session id 从来没被读回来。现在「下一条指令写进哪个会话」由屏幕上的会话（或当前任务所属的会话）决定，连续派活都落在同一个会话里。
- 会话还在执行时不再被并发派活：以前第二条指令会另起一个任务，同一个工作区被两轮同时改，还落在新会话里；现在直接提示「本轮还在执行，等它结束后再发下一条」，指令留在输入框，不会被吃掉。
- 任务视图顶部补上「接续 · 会话名」，右侧「＋ 新会话」可以明确另起一个会话；输入框下方摘要也跟着显示真正的接续对象，而不是一律写「新会话」。
- 新增 `src/web/client/mobile-continue.ts` 与五条单测（打开会话、任务所属会话、无会话时新建、会话标题回退到任务标题、接续沿用任务的项目），`tsc -p tsconfig.client.json` 与构建通过。

## 2.3.3 — 2026-11-10

- 手机上选一台电脑后直接打开它最新的会话：以前不管那台电脑刚干了什么，进来都是一片空白的「让电脑帮你做什么？」，前一天的工作藏在 设置 → 会话 里。现在设备列表点进去、或在 设置里切换电脑，都会自动接上最新那条会话（按更新时间排第一），输入框变成「继续当前会话…」。
- 自己选过的会话或「新会话」会被记住，不会被自动切换覆盖；live 里正挂着任务时也不会被会话抢走。
- 新增 `src/web/client/mobile-session-pick.ts` 与四条单测（最新会话、已选不覆盖、任务优先、没有会话时留在空白），真机尺寸探针补上「默认打开」检查，并给探针加独立临时 profile，避免上一次的 localStorage 影响结果。

## 2.3.2 — 2026-11-10

- 手机「设备」页不再替离线电脑报活：中继只保留节点最后一次上报，电脑断线后那张卡片还会继续写「正在工作 · 某个会话」，点进去却什么也没有。现在离线节点只显示「离线，状态已停止更新」，终端会话那几行和「N 个进行中」都不再出现，历史任务仍然保留。
- 设置页的模型列表和会话列表改成折叠面板：标题行直接显示当前用的模型（名字 · 供应方）和当前会话（继续：标题），点一下才展开完整列表和推理强度、其它会话。以前两段长列表把整页撑满，换一个模型要滚好几屏。
- 会话改成带时间与会话名的行，选中项高亮；折叠面板带 `aria-expanded`，键盘和读屏都能用。
- 新增 `src/web/client/mobile-collapse.tsx`：「默认收起、标题显示当前值」的折叠面板，补上折叠/展开与无障碍标签的渲染测试。

## 2.3.1 — 2026-11-10

- 修好手机「设备」页看不到终端正在干活：节点以前只上报 mesh 任务，桌面端每一轮对话都是一个任务，所以设备卡片能显示「执行中」；CLI/TUI 的会话在本进程里跑、从不产生任务，于是笔记本明明在写代码，手机上一直写「空闲，等待派活」。现在每次中继上报会同时带上终端里正在跑的会话（标题、项目、最后写入时间，最多 8 条），设备卡片显示「正在工作 · 会话标题」，并与已完成的历史任务并排；「N 个进行中」按任务加终端会话合计。
- 只统计本机（按 luban home 隔离）的会话，跨机器的会话不会串台；桌面端由任务托管、本来就在任务列表里的会话不会重复出现。
- 会话只做轻量投影（id/项目/标题/更新时间），不带会话记录和回放事件，避免每次中继轮询都把整段对话克隆一遍。
- 新增 `src/web/client/mobile-device-card.tsx`：设备卡片抽成组件，补上「终端会话进行中」「任务与终端会话并存」「没有状态上报」等渲染测试。

## 2.2.20 — 2026-11-10

- 桌面端文件树支持右键菜单：打开、在访达中显示（Windows 是资源管理器）、复制路径（真的写进系统剪贴板）、新建文件/新建文件夹、重命名、移到废纸篓。菜单在鼠标位置弹出，贴边时自动翻到内侧；新建和重命名直接在树里就地输入名字，回车提交、Esc 取消，名字按工作区规则校验（不能空、不能带 `/`、不能是 `.`/`..`）。
- 修好右侧会话栏宽度拖不动：以前拖动把「增量」叠加在上一次渲染的值上，React 合批连续 pointermove 后只有最后一个事件生效，所以拖半天只挪一下甚至不动。现在以按下那一刻的宽度为基准加上指针位移，每个移动都按位换算，指针移出把手也继续跟随（pointer capture）；最窄从 300px 放宽到 240px，编辑器一侧不会被压没。
- 会话栏、文件栏、终端三种分隔条共用同一套拖动逻辑，方向键每次移动 24px，并带上 `aria-valuenow`。
- 新增 `scripts/desktop-ui-probe.cjs`：真实 Electron 窗口里验证右键菜单、复制到剪贴板、就地新建文件与拖动收窄（495px → 375px，最窄停在 240px）。

## 2.2.19 — 2026-11-10

- 手机端「接续会话」那条提示压成一行：左边「接续」+ 会话名（超长省略号），右边一个描边胶囊按钮「＋ 新会话」。以前标题和按钮各占一行，白白吃掉聊天的两行高度，按钮还是灰底，几乎看不见。

## 2.2.18 — 2026-11-10

- 手机端一直没跟随的真正原因：滚动跟随在组件挂载时就绑定了容器，而控制台先渲染登录页、登录后才有会话区域，第一次绑定拿到的是空节点且不会重试。现在改为容器出现后再绑定，登录前后都能跟随。
- 顺带把桌面会话区改成同样的绑定方式，避免切换会话时丢绑定。

## 2.2.17 — 2026-11-10

- 会话记录和运行时不再停在开头：以前切一次标签页（内容变矮、滚动位置被夹回去）就会被当成「用户往上翻了」，之后整场任务都不再自动跟随最新内容。现在只有内容高度不变时，才把滚动算成读者自己的操作。
- 打开一个历史会话或接续一个任务会直接落到最新一行，执行过程中持续跟随；手动往上翻则暂停跟随，翻回底部自动恢复。

## 2.2.16 — 2026-11-10

- 修好手机 App 里「已登录却一直显示未登录 · 点右上角重新连接」：账户登录发生在页面内部，不会重新加载文档，原生壳因此收不到 `onPageFinished`。现在页面连上节点后通过 `lubanShell.setConnected(true)` 告诉 App 收起提示；壳也在页面历史变化时重新检查登录 Cookie，老页面同样能恢复。
- 手机控制台不再为系统栏重复留白：外壳已经给 WebView 让出状态栏和手势条，页面里再去加一层安全区，等于白丢一整行高度。现在页面在壳里运行时把安全区归零，头部从 91px 回到 47px，正文多出约 90px。
- APK 版本 1.16.25。

## 2.2.15 — 2026-11-10

- 手机 App 壳（`apps/android-app`）不再常驻「已连接 · 服务器」那条：WebView 占满整屏，连接状态只在「连接中 / 未登录 / 连接失败 / 证书错误」时以浮层药丸出现，连上后自动收起，标题栏那一行的高度全部还给会话记录。菜单改成右上角浮动「⋮」，菜单顶部显示当前状态、正在跑的任务和 App 版本，下面是外观设置、刷新页面、连接记录。
- 页面右上角的「设置」文字去掉（底部「设置」标签本来就在），空出的角落留给 App 的 ⋮；在 App 里打开时自动给标题行右侧留出 46px 避让。
- 「设置」页顶部新增「App」卡片：App 内的页面不再有原生状态条，外观、刷新、连接记录从这里或右上角 ⋮ 打开。
- 会话记录读取更稳：电脑端没能返回 `messages` 时按空记录处理，不再整页白屏（此前在手机上选一张历史会话可能白屏）。

## 2.2.14 — 2026-11-10

- 手机页面把顶部长条压成一行：`● my-mac deepseek-v4.1-flash … 设置`，中继模式、节点、模型选择、发版信息全部从头部移除，头部高度从 106px 降到 47px；这一行本身可以点，直接跳到「设置」。
- 会话记录区随之变大：390×844 的手机上从 548px（65%）增到 620px（73%），打开会话后整屏都是聊天记录，只有底部输入区和标签栏占剩下的空间。
- 「继续会话 / 项目 / 权限」三个下拉和「新建工作区 / 添加已有目录」从输入框上方搬到「设置 → 派活」；输入框上方只留一行摘要（`新会话 · luban · 可改文件` 或 `接续 · 会话标题 · …`），点右侧「派活设置 ›」直达设置页。
- 模型选择不再挤在输入框旁边（那不是随便点的地方），改为「设置」里的模型列表，每项显示 `名称 · 提供方`，当前项高亮。

## 2.2.13 — 2026-11-10

- 修掉手机上“同一条指令出现很多条记录”：桌面端每个窗口的本地服务如果随 app 一起被强杀（崩溃、冒烟测试、强退），进程会变成孤儿并继续轮询中继，手机上就多出一台「my-mac · 临时目录」的设备；这些设备又共用同一个任务目录，于是同一条指令在每张卡片上各出现一次。后端现在带 `--parent-pid`，父进程消失即自行退出（按 ppid 变化判断，不用信号），不再留孤儿。
- 设备卡片只上报“这台设备被派过的任务”（`target` 命中或本实例 `instance_id` 命中），不再把整台机器的共享任务列表复制到每张卡片上。

## 2.2.12 — 2026-11-10

- 当前窗口已经打开项目时，再选一个文件夹会先问：「新窗口打开」「在当前窗口打开」「取消」。选新窗口时当前项目继续运行，选当前窗口会关掉它的本地后端并换成新文件夹（有未保存修改时会先确认），取消则什么都不做；启动时和窗口还没打开项目时不会多问。
- 菜单「文件 → 打开项目文件夹…」（`Ctrl/⌘+O`）、托盘同项和界面上的「打开文件夹…」按钮走同一个询问流程；「新建窗口」和「新窗口…」本身已表明意图，不再弹窗。把文件夹拖给已运行的 luban 时，如果那个文件夹已经开着就直接切到对应窗口。

## 2.2.11 — 2026-11-10

- 修复桌面版「新建窗口」点了没有反应：它先按文件夹查重，发现要打开的正是当前窗口的文件夹时只把那个窗口切到前台，于是一个新窗口都不出现。现在「文件 → 新建窗口」（`Ctrl/⌘+Shift+N`、托盘同项）以当前窗口的文件夹直接开新窗口，左侧「新窗口…」按钮选中的文件夹即使已在别的窗口打开也照样开新窗口。
- 「文件 → 打开项目文件夹…」（`Ctrl/⌘+O`）保留查重：该文件夹已经有窗口时切过去，没有才新建，避免误开重复窗口。

## 2.2.10 — 2026-11-10

- 桌面版可以同时打开多个窗口，每个窗口有自己的项目文件夹、本地后端、文件树、控制台/终端和未保存状态，像 VS Code 一样并排打开不同文件夹。菜单「文件 → 打开项目文件夹…」（`Ctrl/⌘+O`）为所选文件夹开新窗口，已打开同一文件夹的窗口会被切到前台而不是再开一个；`Ctrl/⌘+Shift+N`「新建窗口」和左侧「项目」旁新增的「新窗口…」按钮提供同样入口，「打开文件夹…」仍是把当前窗口换成另一个文件夹。
- 多窗口之间互不影响：IPC、`luban-media://` 预览和终端都按窗口路由到各自的 workspace 与后端端口，切换或关闭一个窗口不会动到其它窗口；托盘、桌宠与 bot 仍然只有一个，桌宠提交的任务记在提交它的那个窗口上，托盘提示显示当前窗口的项目。
- 再次启动 luban（或把文件夹拖到应用图标上）不会再起第二个进程，而是在运行中的窗口里打开该文件夹；同一设备只有一个中继槽位，只有第一个窗口的内置后端带 `--remote`，其余窗口只跑本机服务。
- 新增 `npm run smoke:desktop`：用 Electron 主进程 + 真实本地后端的无界面冒烟脚本，验证双窗口、各窗口 IPC/媒体路由、原地切换文件夹和关闭互不影响。

## 2.2.9 — 2026-11-10

- 修好桌面终端「只能用到一半、下边一片黑」的问题：终端尺寸以前在创建时算一次，之后拖动控制台、拉宽窗口或改字号都不会重新计算，xterm 只画最初的几行，被 CSS 拉满的剩余区域就是黑底，长输出也会被挡住。现在按 xterm 实际字符格尺寸重新测量，面板一变就重算行列并通知 pty 调整大小（`resizeTerminal`），输入换行、`htop`/`vim` 等全屏程序都跟着面板走。
- 打开「终端」标签页时控制台自动长到 420px（原来固定 240px，只有十来行），之后仍可拖动分隔条自由调整；终端右上角显示当前列×行。
- 终端栏新增 `A−`/`A+` 字号按钮（10–18），会记住选择，字号变化后自动重新适配行列。

## 2.2.8 — 2026-11-10

- 修复桌面版查询 Codex 额度总是失败的问题：从 Finder/启动器打开的 luban 拿不到终端里的 PATH，既找不到 `codex`，也会因为 PATH 里没有 node 让 npm 安装的 `codex` 启动脚本以 127 退出。现在会依次查 PATH、常见安装目录和登录 shell 的 PATH，并用 luban 自带的 node 运行 `#!…node` 启动脚本；对话走 HTTP 后端所以一直正常，额度查询是唯一需要启动 CLI 的功能。
- 额度查询失败时不再只显示「无法查询额度」，会给出原因和处理建议（找不到 codex / 未登录 / CLI 版本过旧 / 缺少 node），并附上已脱敏的 CLI 原始报错，便于定位。

## 2.2.7 — 2026-11-10

- 额度卡片显示 Codex 账户可用的重置卡数量；有多张时可在下拉框中选择指定的一张，再点「使用重置卡」并二次确认后重置，重置完成后自动刷新额度。
- 重置请求带幂等键并串行处理：连点或结果未知时重试不会多消耗一张卡；请求失败会提示先刷新额度确认，不会自动重发。
- 重置卡标题与到期日期、可选列表均来自账户返回值，卡片用完后立即隐藏；服务端校验重置卡标识和请求标识后再转发给 Codex。

## 2.2.6 — 2026-11-10

- 桌面选择 Codex 模型时，Agent 区顶部显示账户各额度窗口的剩余百分比、进度条和重置时间；剩余不超过 20% 标红并提示额度偏低。
- 每分钟自动刷新，支持手动刷新，窗口隐藏时暂停查询；后端合并并发请求并缓存一分钟，查询失败保留旧数据并提示，未返回额度时不误报为零。

## 2.2.5 — 2026-11-10

- 桌面文件树按格式显示不同的彩色 SVG 图标：代码、图片、PDF、Word、Excel/CSV、幻灯片、draw.io、音视频、压缩包、配置、Markdown、文本和数据库；文件夹区分展开与收起，未知格式保留通用文件图标。
- 识别大小写后缀、draw.io 复合后缀、`.env`/`.gitignore` 等配置文件和 Dockerfile/Makefile；图标内置，无需联网或额外读取文件内容。

## 2.2.4 — 2026-11-10

- 安装后的应用名统一成 `luban`：macOS 包名从 `luban Desktop.app` 改为 `luban.app`，`CFBundleName`/`CFBundleDisplayName`、DMG 卷名、Windows 版本信息与快捷方式、Linux 应用菜单、托盘提示、菜单栏应用名都只显示 `luban`。
- macOS 应用图标换成圆角版本：`assets/luban-app-1024.png` 按 macOS 图标栅格留边、圆角裁切后生成 `AppIcon.icns`，安装后不再是一个方角深色方块；`assets/luban-512.png` 仍是直角图，继续用于托盘、窗口和 Web UI。
- 桌面上「终端/控制台需要桌面连接」的提示改称 `luban 桌面版`，与新的应用名一致。

## 2.2.3 — 2026-11-10

- 桌面工作台可以预览表格和文档了：`.xlsx`/`.xls` 显示带行号、列标和工作表标签的只读网格，`.docx`/`.doc` 按标题、段落、列表、表格的顺序排成只读文章；超过 400 行、50 列的表格会提示还有多少内容没有显示。
- 新格式走本地解析，不联网：`.xlsx`/`.docx` 直接读 OOXML 包，`.xls`/`.doc` 由新的复合文档（OLE2）读取器解出 BIFF8 单元格和 Word 97 文本片段；解析失败时显示原因，并可「打开外部应用」。
- 版本号规则改成 `MAJOR.MINOR.PATCH`，PATCH 只在 1–20 之间，超过 20 时进位 MINOR 并从 1 重新开始（`2.2.20` 的下一版是 `2.3.1`）；规则写进 AGENTS.md 与 docs/release.md，`npm run release` 用 `versionProblem()` 校验，`2.2.0`/`2.2.21` 会直接失败。
- 新增 office/office-legacy 解析测试（含 XLSX、DOCX 与合成的 CFB/XLS 文档），以及表格、文档渲染用例。

## 2.2.2 — 2026-11-10

- MCP schema 预算默认值从 64 提到 128；仍可用 `mcp.max_tools`（4–256）覆盖，或 `mcp.lazy` 只注册检索调度器。
- 桌面工作台三栏之间加了分隔条，代码区与控制台之间也能拖动调高；窗口变窄时自动收回，布局记在 `luban.desktop.layout`。
- 文件树改为每 2.5 秒轮询根目录和已展开目录（窗口隐藏时暂停），新建或删除的文件不用重启就会显示；刷新按钮与重新展开目录都会重读该目录，不再用首次打开时的缓存。
- 桌宠「造物主」新增隐藏：主界面状态栏按钮、托盘菜单、视图菜单和桌宠右上角 ×，状态写入 `userData/pet.json`，下次启动沿用。

## 2.2.1 — 2026-11-10

- MCP 超出 schema 预算不再当作错误：以前每发一条指令都会弹「MCP startup: MCP schema budget reached (64)」，现在只在真正截断时给一行提示「MCP 工具已注册 N 个，另有 M 个超出 schema 预算，可用 mcp_search_tools / mcp_call 按需调用」，并以状态行显示。
- 同一份超限提示只输出一次，不再按服务器/按工具重复；真正的服务器启动失败仍报错。
- 新增测试覆盖预算截断、静默与失败三条路径。

## 2.2.0 — 2026-11-10

- 手机控制台（/m）的实时进度改成停靠条，固定在输入框上方、标签栏之上，切换标签也能看到；空闲或任务结束后自动消失。
- 会话与任务流在电脑输出时自动跟随到底部；读者上滑看历史时不会被拉回，重新打开任务时回到最新一行。
- WebView 外壳（android-app）的原生状态条通过 `lubanShell` 桥接显示「执行工具 · Shell · npm test · 12s」这类实时进度，停更时提示「等待输出」，结束后恢复「已连接 · 主机」；导航或重载会清掉过期进度。版本 1.16.23。
- 纯原生控制台（android-native）在任务页头部实时显示状态与百分比，并对流式输出跟随滚动到最新一行。版本 1.0.6。

## 2.1.0 — 2026-11-10

- 桌面版支持 PPTX 幻灯片预览：主进程直接解析 OOXML 包（不依赖 Office），按版式绘制文字、形状、图片和演讲者备注，幻灯片内的图片从压缩包按需流式读取。
- 桌面版支持 PDF：用 Chromium 内置查看器内嵌打开；「用系统应用打开」可交给预览/Acrobat 等处理。
- 桌面版支持 draw.io 图形：`.drawio`、`.drawio.svg`、`.drawio.png`（含压缩页面与内嵌 PNG 元数据）解析为可缩放 SVG，含节点、连线、箭头与换行标签。
- 文件预览按扩展名分流：图片/音视频/PDF 走媒体协议，PPTX 与 draw.io 走解析预览，其余仍进入代码编辑器；预览均可一键交给系统应用，且不影响未保存的编辑内容。
- 新增 ZIP/XML 轻量解析与文本换行模块，以及 PPTX、draw.io、预览路由与渲染测试。

## 2.0.37 — 2026-11-09

- 手机端新增工作区入口：可在电脑默认工作区目录新建，或输入电脑上已有目录的绝对路径注册为项目；注册信息写入电脑 config.json，重启后仍可见。
- WebView 与原生 Android 都可从工作区/派活选项进入；选定新工作区后可直接开启新会话，任务在该目录执行。
- Android WebView 1.16.21、原生 UI 1.0.5。

## 2.0.36 — 2026-11-09

- 手机离线不取消电脑已接收的任务；WebView 重连失败保留任务 ID，网络恢复、返回前台和备用轮询均补齐任务状态及执行记录。
- 控制台自动切到手机/网页派发任务的实时执行流，本地对话中也会显示任务阶段；手机设置新增模型列表与推理强度切换，电脑端更新后自动同步。
- WebView 保存草稿和提交待确认标记，响应丢失或应用退出后不自动重复派活；原生 UI 返回前台重新同步历史与进度，离线提示明确区分连接中断与任务失败。
- Android WebView 1.16.20、原生 UI 1.0.4。电脑进程需保持运行；权限确认、用户问题和已有任务超时规则仍有效，不因离线自动授权。

## 2.0.35 — 2026-11-09

- 原生 Android 1.0.2：会话历史与执行进度同屏，展示待授权/待回答提示；保存任务、会话及草稿，回到前台或重建应用后重连原任务，不自动重新派活。
- 提交请求独立于页面生命周期；提交结果不明时保留草稿并阻止重复发送，提示先核对任务。失败或暂停可恢复同一个任务 ID 和会话，保留已执行结果。
- 端侧远程执行发布会话实时事件，桌面当前会话同步历史和进度并阻止并发写入；恢复续接任务不再重复原始指令。端侧需升级本版本，单独更新中继无法替换电脑执行逻辑。
- 后台继续执行指电脑端持久任务，不依赖手机持续轮询；权限确认仍需用户明确授权，后台不会自动放宽权限。

## 2.0.34 — 2026-11-08

- 原生 Android 体验版 1.0.1：恢复页面切换后的底部导航，区分会话列表、记录与任务详情的返回层级。
- 页面请求按代次隔离，离开页面后丢弃迟到响应，停止旧任务轮询；切换设备清理旧项目，切换权限保留输入草稿。WebView 版保留。

## 2.0.33 — 2026-11-08

- Android 安装包版本更新至 1.16.18（11618），重新构建供 MixStore 分发；移动控制台仍从中继加载，布局更新需要单独部署网页资源。

## 2.0.32 — 2026-11-08

- 手机控制台重新整理页头：品牌与版本不换行，实例选择限宽，模型及工作区分行省略，避免长设备名挤出屏幕。
- 派活输入区仅在状态页显示，会话、项目和权限收进默认折叠的「派活选项」；保留草稿及选择，不再遮挡设备、任务、审批和设置页面。
- 修复设备在线状态和任务完成标签被挤成竖排；任务元数据允许换行，底部导航增加选中指示，输入提示不再重复长会话标题。

## 2.0.31 — 2026-11-08

- 修复 Android 壳编译错误：`Uri.Builder` 没有 `removeQueryParameter`，改为重建查询串后再写回 `theme` 参数，`assembleDebug` 通过。
- 手机端 1.16.17 APK 已构建（debug 签名，v2 签名块），并发布到 MixStore 供直接下载安装。

## 2.0.30 — 2026-11-08

- 手机控制台新增主题：深色 / 浅色 / 跟随系统，设置页可选；浅色配色重新推导了底色、卡片、diff 与审批提示，而不是简单反色；`?theme=` 参数可被 App 固定，避免原生窗口与页面配色不一致。
- Android 壳新增「外观设置」页：主题、文字大小（标准 / 大 / 特大，同时放大网页正文）、版本信息；设置即时生效并持久保存，系统深色模式切换时自动跟随。
- Android 壳重做界面：去掉默认灰色按钮，改为真实 App 栏（状态点 + 连接状态 + 溢出菜单）、圆角卡片、圆形图标按钮与涟漪反馈；连接页、连接记录、删除确认都按主题重新绘制。
- 手机页面整体放大字号（正文 16px、标签与工具卡片同步上调），加宽触控区域，底部标签栏图标与文字更大。

## 2.0.29 — 2026-11-08

- 桌面版新增系统托盘图标：单击或双击打开主界面，右键菜单提供「打开主界面 / 显示桌宠 / 打开项目文件夹… / 退出 luban」，悬停提示显示当前项目，解决窗口隐藏后找不到退出入口的问题。
- 关闭主窗口改为隐藏到托盘，后台服务、桌宠与常驻 bot 继续运行；结束进程统一走托盘「退出 luban」或菜单「文件 → 退出」，文件菜单另加「隐藏到托盘」。
- 托盘创建失败（没有状态栏的桌面环境）或启动失败时保持原来的退出行为，不会留下无法关闭的进程。

## 2.0.28 — 2026-11-08

- 修复手机长会话标题和完整项目路径撑出屏幕的问题；会话选择独占一行，项目和权限控件可收缩，发送按钮不再被挤出。
- 过滤实时同步桥中的纯 system 空草稿，并兼容过滤旧电脑返回的零消息会话；打开空记录时明确提示，而非留白。
- 会话列表错误独立展示，避免被设备连接成功状态掩盖；页面头部显示网页版本，便于确认是否已刷新到新部署。

## 2.0.27 — 2026-11-08

- 手机项目选择固定为该电脑实例当前打开的工作区，不再自动选择配置中的首个示例项目（如 myapp），并显示完整目录。
- 切换电脑后丢弃旧设备的迟到 API 响应，避免旧项目、会话和任务覆盖新设备视图。
- 手机会话列表持续轮询更新，读取失败显示错误，不再静默伪装成没有会话。

## 2.0.26 — 2026-11-08

- 手机选择电脑上的会话后会加载完整交互记录，包括用户指令、回答、工具结果和可展开的文件编辑记录，不再只设置接续目标。
- 为 TUI 增加进程内会话同步桥；手机每秒读取当前回答、执行工具和运行状态，断网恢复后自动重试；运行结束切换到持久化记录，避免重复显示。
- 会话正在电脑端执行时禁止从手机并发接续，避免同一会话启动两个 Agent；修复登录后实时事件连接未启动的问题。

## 2.0.25 — 2026-11-08

- `luban login relay` 支持直接跟中继地址：`luban login relay https://203.0.113.7` 不再报 “too many arguments”，`--relay <url>` 写法保持可用。
- 中继地址省略协议时默认按 HTTPS 处理（只有本机回环地址会补 `http://`），省得先被 “必须使用 HTTPS” 挡住。
- 更新 `docs/reference.md` 的登录示例与 `--help` 提示。

## 2.0.24 — 2026-11-08

- 中继账户改为每台电脑保留独立的设备令牌：在第二台、第三台电脑上登录时新增令牌，不再使前面电脑的令牌失效，三台机器可以同时出现在手机设备列表中。
- 兼容升级前只有一个 `device_token_hash` 的账户文件；首次新增令牌后自动迁移，旧令牌继续有效。
- 更新登录提示和文档：新增令牌不会让其他电脑掉线；账户最多保留最近 32 枚令牌。

## 2.0.23 — 2026-11-08

- 修复手机控制台横向溢出：长设备名会把隐式网格列撑宽，导致右侧内容（包括“设置”标签）被裁掉；网格列改为可收缩，长文本和错误提示都能在屏幕内换行。
- 重新构建并部署手机端 CSS，避免 WebView 继续复用旧样式缓存。

## 2.0.22 — 2026-11-08

- 修复 Android WebView 中手机控制台页面偏短、底部黑屏、头部被压扁的问题：布局高度改用 WebView 实际高度，键盘弹出时仍会正确收缩。
- 手机连接失败提示中的长命令现在会自动换行，不再横向溢出屏幕。
- Android 原生壳的状态栏同时识别账户 Cookie 与旧版令牌 Cookie，账户登录后不再误报“未登录”；一键登录会同时清理两种旧会话。

## 2.0.21 — 2026-11-08

- 同一台电脑在不同项目目录运行的多个 luban 会分别注册为独立节点，不再互相顶掉；设备名带上项目目录，手机可以逐个选择并派活。
- 手机设备卡显示最新任务的进度、更新时间与记录数量；切换节点后立即加载该实例的任务和会话，旧版遗留的失效节点 ID 会自动回退到在线实例。
- 实例设备 ID 由机器 ID + 工作区路径稳定生成，重启后仍是同一个节点；升级后需重启旧实例才会按新身份注册。

## 2.0.20 — 2026-11-08

- 新增 TUI 命令 `/relay login [中继地址]`：在终端内依次输入中继地址、邮箱和密码，密码不回显；登录成功后保存设备令牌与 `remote` 配置，重启 `luban` 后自动接入。
- `luban login relay` 增加明确的步骤反馈：邮箱输入后显示「邮箱已记录」，密码提示标注「输入不显示，回车确认」，并在提交后显示「正在登录」。
- 中继登录逻辑抽到共享模块，CLI 与 TUI 复用同一套 Cookie、设备令牌和 0600 文件写入流程。

## 2.0.19 — 2026-11-08

- 新增 `luban login relay`：用邮箱和密码在终端登录中继账户，自动生成本机设备令牌并写入 `~/.config/luban/relay.env`，同时把 `remote.enabled` / `remote.relay_url` 写入 `~/.luban/config.json`；之后直接运行 `luban <项目路径>` 即可接入，无需打开手机或浏览器。
- 密码只通过隐藏输入或 `--password-stdin` 读取，不写入 shell 历史、配置或日志；也支持 `--device-token` 保存已有令牌、`--no-config` 只写环境文件。
- 文档改用通用示例域名，补充电脑端命令行登录与配置文件接入说明。

## 2.0.18 — 2026-11-08

- 修正手机“账户下还没有电脑”提示中的接入命令：只使用账户设备令牌，不再要求中继共享节点令牌。
- 补充电脑端接入账户的文档：手机生成设备令牌后在电脑运行 `luban web ... --relay-device-token`，或把 `LUBAN_RELAY_DEVICE_TOKEN` 写入 `~/.config/luban/relay.env` 并让 TUI 自动接入。

## 2.0.17 — 2026-11-08

- 中继账户注册新增邮箱验证码：`POST /api/auth/send-code` 签发 6 位验证码，10 分钟有效、5 次错误后作废、同一邮箱 60 秒内不可重发、每小时最多 5 封。
- 新增 SMTPS 发信（默认 `smtp.163.com:465`，使用应用专用密码），配置来自 `LUBAN_RELAY_SMTP_EMAIL` / `LUBAN_RELAY_SMTP_PASSWORD`，也可用 `--smtp-email`、`--smtp-password`、`--smtp-host`、`--smtp-port`；密码不写入日志或账户库。
- 配置邮箱后，注册接口必须携带 `code`；登录页仍可直接登录。未配置邮箱的中继保持原有无验证码注册行为。
- 手机注册页新增“发送验证码”按钮、倒计时与验证码输入框；中继通过 `/api/auth/me` 的 `email_verification` 告知客户端是否需要验证码。

## 2.0.16 — 2026-11-08

- 中继新增账户体系：邮箱/密码注册登录、HttpOnly 会话 Cookie、每账户设备登记令牌；账户之间设备与任务严格隔离，旧的一键令牌链接继续可用。
- 电脑首次接入中继时生成稳定设备 ID，重连不会变成新机器；设备列表持久化，离线电脑仍可看到并移出账户。
- 手机控制台新增登录/注册页、设备页和会话接续：登录后可看到账户下所有电脑、在线状态、正在执行的任务，并直接选一台派活。
- 密码用 scrypt、会话与设备令牌用 SHA-256 存储；账户文件权限 `0600`，令牌只在生成时显示一次。
- 新增 `luban relay --accounts <path>`、`--relay-device-token` 和设备令牌生成命令；电脑可只用设备令牌接入中继，无需接触中继的共享节点令牌。

## 2.0.15 — 2026-11-08

- 新安装首次启动自动生成可移植的 `~/.luban/config.json`，沿用现有端口、超时、上下文、同步忽略、worker/step 上限等设置；已有配置永不覆盖，删除后可重新生成。
- 默认配置不含真实 API Key、私有网关 IP、内网节点、relay 地址或项目路径；API Key 仍通过用户目录的鉴权存储或 `/models` 面板维护。
- 默认模型改为免密的 `opencode-zen/deepseek-v4.1-flash-free`，避免没有 Key 的新安装首次对话即失败。
- 安全起见默认权限保持 `edits`（自动批准工作区内编辑），而不是当前机器上的 `allow`；需要完全免审批时自行改为 `allow`。

## 2.0.14 — 2026-11-08

- `/models` provider 列表与模型子菜单新增 `Ctrl+A` 鉴权面板：遮罩设置/更新 API Key、确认删除、打开服务商密钥控制台；自定义 provider 同样支持。
- Codex 可在面板中启动官方 CLI 设备码登录，显示授权链接与设备码，支持取消与失败重试。
- 密钥独立保存到用户目录 `provider-auth.json`，Unix 文件权限 `0600`；不进入项目、会话或输入历史，保存后无需重启，删除后恢复配置/环境/外部凭据。
- 范围为 TUI（含桌面内嵌终端）；独立 Web 模型选择器未新增鉴权表单。

## 2.0.13 — 2026-11-08

- 修复 Windows ZIP 发布流程，改用镜像与缓存优先的依赖安装方式，并补充发布网络辅助脚本与文档。

## 2.0.12 — 2026-11-07

桌面工作台直接播放音频、视频并预览图片；打开超限或二进制文件时给出能照着做的说明，而不是 Electron 的 IPC 报错原文。

### 桌面工作台

- 文件树里点音频（mp3/m4a/wav/flac/ogg/opus…）、视频（mp4/mov/webm/mkv/avi…）就地播放，图片显示预览。通过 `luban-media://` 特权协议流式读取，支持 Range 拖动进度，只读、不参与编辑，也不受文本大小限制。
- 文本编辑器上限从 1 MB 提到 4 MB，锁文件、日志与打包产物都能打开；命令控制台仍是 1 MB。
- 不再显示 `Error invoking remote method 'luban:readFile'` 这类包装：超限、二进制、UTF-16、非 UTF-8、文件已删除、磁盘版本冲突都换成中文说明和下一步操作；轮询与保存共用同一套文案。

## 2.0.11 — 2026-11-07

修复终端拖选复制写不进系统剪贴板、输出区链接点不开。

- 拖选复制：Windows 走 PowerShell `Set-Clipboard`（base64 传参，中文与 emoji 不乱码，`clip.exe` 兜底），macOS 走 `pbcopy`；等待系统工具期间先提示 OSC 52 已发送。
- 输出区链接：单击（按下与松开落在同一链接）用默认浏览器打开，只放行 http/https；`/token` 等只读对话框内的链接同样可点。

## 2.0.0 — 2026-11-03

将 1.x 阶段累计的桌面工作台、常驻 Bot 与运行状态展示收拢为一个大版本。版本号从 1.16.175 升级为 2.0.0。

### 桌面与会话

- 文件树、多标签编辑、语法着色、磁盘版本冲突保护，以及共用中间区域的代码与修改对比视图。
- PTY 终端、命令控制台、多轮会话续接、追加任务排队、折叠思考过程与模型生成会话标题。
- 复用终端的主题与模型配置，保留推理强度选择。

### 常驻 Bot 与造物主

- 桌面 App 自动启动本机 Bot worker；已由终端或服务启动的 worker 保持原有归属。
- 桌宠后台身体自称「造物主」，展示任务队列、最近结果与权限申请，并播报完成结果。
- 展示机器负载、内存、worker 直接子进程、进程 RSS，以及 macOS 线程数量。
- 活跃 Agent 按所属 PID 展示任务、深度、运行时长及已回报的输入/输出 token；Bot 执行结果保存本轮请求用量与调用次数。

### 升级与当前边界

- 继续使用现有配置、会话和 Bot 队列目录；旧记录缺少用量时无法补算历史 token。
- Agent 是进程内运行实例，深度 0 表示主 Agent；子 Agent 没有独立 PID。面板展示数量有上限。
- 当前提供状态观察与既有任务取消能力，尚未覆盖整机所有进程、逐线程详情或任意系统服务管理。
- token 来自提供方返回的 usage；Bot 结果统计当前 runner 的请求，不保证包含委派子 Agent、异常退出或提供方未报告的用量，也不代表费用账单。
- 后台操作仍遵循独立权限文件；委派任务需要相应授权。前台 TUI 与工作台身份保持原有设置。
- 本次本地提交不等于安装包发布；平台安装包与 GitHub Release 由单独的发布流程生成。

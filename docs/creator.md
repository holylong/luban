# 造物主（常驻后台任务）

造物主是一个**独立于桌面工作台**的常驻程序：菜单栏上一个入口，点开是一个只做一件事的窗口——派任务、看进度、看结果。它不打开项目、不带编辑器，也不依赖 `apps/desktop`。

```
造物主（Electron 窗口 + 菜单栏）
        │  读写队列（唯一数据源）
        ▼
~/.luban/bot/tasks/<uuid>/{request.json,state.json}
        │
        ▼
luban bot run（串行 worker，独立进程）
```

- **窗口可以随时关掉**：关窗口只是隐藏，队列和执行都在 worker 进程里；`--smoke` 之外，进程退出也不影响正在跑的任务。
- **worker 是普通 Node 进程**：既可由造物主拉起来（`detached` 子进程），也可交给系统托管（`luban bot service` 生成的 LaunchAgent，`KeepAlive`）。造物主检测到 LaunchAgent 时不再自己拉一份，避免抢锁。
- **同一份队列**：终端里 `luban bot add …` 和窗口里派发的任务是同一种任务，`luban bot list` 一样能看到。

## 使用

```bash
npm run build        # 造物主窗口在 dist/web-ui/creator.html
npm run creator      # 启动造物主（菜单栏出现「待命 / 忙 / 未启动」）
```

窗口里：

- 输入框 **Enter 派发 · Shift+Enter 换行**；派发后自动确保 worker 在跑。
- 工作区：默认最近任务的目录，点 chip 换成任意目录（任务只在这个目录里干活）。
- 时机：`现在` / `定时`（选一个时间点）/ `每隔 N 分钟`（最小 60 秒，和 CLI 一致）。
- 直接说排期：输入框留在「现在」时，句子里带时间就会自己排期——「每天 6 点提醒我」→ `每天 06:00`，「5 分钟后提醒我下班」→ `一次 · 今天 14:41`，「每 6 小时扫一次 buglist」→ `每 6 小时`。识别到的排期先在输入卡下方显示成青绿标签（`scheduleLabel · 首次 …`）再派发，派发后弹一条「已排入：每天 06:00 · 下次 今天 06:00」。
- `进行中` / `结果` / `授权` 三个页签；任务行点开看完整结果（Markdown 渲染）。任务行元信息固定给出状态 · 排期 · 下次触发 · 已执行次数。
- 左栏 `计划（n）`（badge 就是任务总数）打开「全部计划」抽屉：按 `循环任务` / `一次任务` 分组列出每一条后台任务，二行摘要分别是排期和「下次 …· n 次执行」；展开一条能看到工作区、超时、间隔、取消按钮，以及**每次执行的历史**（`runs.jsonl` 逐条：时间区间、状态、调用次数/tokens、结果摘要，点开看完整结果）。这就是「6 点那次扫描到底跑没跑、扫到了什么」的回答处。
- 页脚显示队列目录与「收起」；右上 `⌂` 打开数据目录。

## 操控电脑（和派给后台任务不同）

窗口最上面那个页签是**当下这一刻**的操控会话：一句自然语言，它先判断该用哪种手，再动手。它不排队，是一个 `luban drive` 子进程：

```
造物主窗口（输入框 / 动作时间线 / 截图缩略图 / 允许卡）
        │  IPC：say · approve · stop
        ▼
apps/creator/drive.cjs（派生子进程、逐行解析 JSON 事件）
        │
        ▼
luban drive（按句子分流：screenIntent ? 只有眼睛和手 : 全套工具）
        │
        ▼
luban-computer 助手（CGEvent 点击、截屏）
```

- **不是每个指令都截屏**。分流规则（`screenIntent()`，有单测）：句子里在说屏幕上的东西（截屏/窗口/点击/计算器/访达/浏览器…）才走 `windows → screenshot → click`；其余走普通工具。
  - 问一句「你叫什么名字」→ 一个工具都不调。
  - 「把 meeting.md 整理成三条要点」→ 只用 `read_file` / `write_file`，0 张截图。
  - 「设个明天早上 8 点的闹钟」→ 用 `osascript` 往「日历」「提醒事项」写，或者 `luban bot add --at …` 排后台任务；0 张截图。
  - 屏幕任务这一轮**没有 bash**：给了 shell，模型会用 `osascript`、`pgrep`、PIL 量像素代替点击，一轮下来一次都没点。
- 界面操作的顺序：`windows` 拿前台应用和每个窗口的 x/y/宽/高（屏幕「点」）→ `screenshot`（结果带 `origin`，屏幕坐标 = origin + 图内偏移）→ `app` / `click` / `type` / `key`。
- 截图**自动**作为图片送进模型，不用再 `attach_image`；面板里每次 `screenshot` 都以缩略图贴在动作行下面。
- 第一次动手前弹一张「允许」卡（覆盖本会话），之后不再逐次问；「停止」或 `⌘.` 立刻杀掉子进程。
- 关窗口时子进程一起停；窗口重开时会把子进程已产生的事件重新读回来。

## 无人值守的边界

造物主跑的任务一律按**无人值守**处理，这是刻意设计，不是配置遗漏：

- worker 里 `permissionMode = "ask"`，且清空 `allow` 列表、不继承 `LUBAN_ALLOW_TOOLS` 与项目级审批覆盖；沙箱不允许越出工作区。
- 任何工具调用都要在 `~/.luban/bot/permissions.json` 里有**精确匹配**的授权（`workspace` + `tool` + `args` + 过期时间，没有通配、没有「总是允许」）。
- 没授权时不会被静默执行：调用被拒绝，并在 `bot/permission-requests/` 留一条请求，窗口「授权」页签里能看到它的 `args`。
- 因此「定期扫禅道、扫 GitLab、打 tag 发 release」这类任务，要先给对应工具的精确授权；`bash` 的参数每次都不同，不能靠一条授权覆盖，正确做法是新增窄工具（例如 `gitlab_release`）让参数可枚举。

定时任务的重试语义：任务失败不会自动重放（可能已有副作用），状态记为 `failed` 或 `interrupted`，需要重新派发。

## 定时任务的生命周期

- `every` 表示「成功完成后」再排下一次，不会重叠执行；`--at` 指定第一次执行时间。
- 取消只写一个 `cancel` 标记文件，worker 在当前步骤结束后停止。
- 会话记录照常写入 `~/.luban`，`luban history` 可以回看某次执行。

## 验证

```bash
node --test apps/creator/bot.test.mjs     # 队列读取/取消标记/worker 状态/经 CLI 落盘
npm run build && npm run smoke:creator    # 真 Electron 渲染 + 截图 + 窗口文本断言（含计划抽屉与执行历史）
npm run smoke:creator:drive                # 真跑一轮操控：窗口里一个提示词 → 点屏幕 → 面板断言（动作/截图缩略图/审批）
npx vitest run src/web/client/creator-schedule.test.ts   # 排期文案：每天/每周/每隔/一次 + 下次触发
```

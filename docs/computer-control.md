# 电脑操控（computer 工具）

luban 可以直接操作这台 Mac：截屏、移动指针、点击、拖拽、滚轮、打字、按快捷键。和 Codex 一样，它不是后台偷偷按键——**开关握在人手里**，屏幕边缘会燃起一圈蓝光，`⌘.` 随时收回。

## 打开方式

macOS 启动时默认开启电脑操控（CLI、Web、drive 与独立 TUI）。只读取可信的全局 `~/.luban/config.json` 中 `"computer": { "enabled": true }`，缺省为 true；项目配置不能授予或覆盖此权限。全局设置为 false 可关闭默认开启，`LUBAN_COMPUTER=0` 可明确禁用本次启动，`LUBAN_COMPUTER=1` 可明确启用。`drive --no-computer` 等同于环境变量 0。系统权限仍需用户授权；不支持的平台与启动失败不阻断其他功能。同一进程不会在手动关闭后因另一个入口初始化而重新开启；共享停止标志存在时也不会自动清除，须由用户重新打开开关。

1. Desktop/Web 界面右上角点击「电脑操控」药丸（只在 macOS 出现）。Desktop Agent 栏会保留此开关，其他状态标签在窄栏中隐藏；终端 TUI 可运行 `/computer on`。
2. 第一次使用需要在 **系统设置 › 隐私与安全性** 里给 luban 勾上「辅助功能」和「屏幕录制」；药丸会变成虚线并在悬停时说明还缺哪一项，然后重启 luban。
3. 开启后：

   - 授权本身不点亮燃弧，也不启动覆盖层。只有模型真正执行点击、输入、移动等操作时才显示「luban 正在操控 · ⌘. 停止」；操作完成、失败或取消后立即清除，空闲仍保持授权。status/windows/screenshot/cursor 等只读观察不点亮；
   - `⌘.` 是全局快捷键，即使 agent 正在拖拽也会立刻中止（写入 `~/.luban/computer/stop`，后端每个动作前重读）；
   - 关掉开关或按 `⌘.` 后约 0.7s 熄火。

不开开关时工具**直接报错**（"电脑操控未开启…"），不会静默无操作——agent 会看到原因并按提示请你开开关。

## 平台支持

| 平台 | 电脑操控 | 燃弧 | 其余功能 |
| --- | --- | --- | --- |
| macOS | 可用（AppKit/CoreGraphics，需要辅助功能 + 屏幕录制） | 有 | 不受影响 |
| Linux | **不可用**：没有原生输入后端，`computer` 工具不下发、`/computer` 直接说明原因、`/api/computer` 开启返回 400 | 无 | 编译、测试、mesh、relay、Web 手机端等都照常 |
| Windows | 同上（未来可用 SendInput 实现，尚未做） | 无 | 同上 |

实现上是一条单点判断 `computerSupported()`（`src/core/computer.ts`）：`begin()`/`act()`/`checkPermissions()` 在非 macOS 抛出一句话的错误，`createTools()` 干脆不把 `computer` 放进工具表（模型看不见一个注定失败的），桌面/浏览器工作台的药丸只在 `platform === "darwin"` 时渲染，`LUBAN_COMPUTER=1` 在非 macOS 打印一行提示后忽略。也就是说 Linux/Windows 上不会为了这个功能编译 Swift、也不会注册全局快捷键。

## 三个入口

| 入口 | 开关 | 燃弧 | 中止 |
| --- | --- | --- | --- |
| 桌面 App（含 `luban.web` 的浏览器工作台） | 顶部「电脑操控」药丸 | 全屏四边燃弧 + 徽标 | `⌘.` 全局快捷键 |
| 终端 TUI | `/computer on` / `off` / `status`，标题栏出现 `⌁ 电脑操控` | 四边燃弧（CLI 自己拉起 `luban-glow` 覆盖层） | 运行中 `Ctrl+C` 或 `Esc`，或 `/computer off` |
| 无头 `luban --prompt`、管道输入 | 默认开启；`LUBAN_COMPUTER=0` 禁用本次启动 | 四边燃弧（同上，`LUBAN_GLOW=off` 可关） | `SIGINT` |

开关是**每进程**的（每个入口只对自己那个 agent 放开），但**停止标志是共享文件** `~/.luban/computer/stop`：桌面按了 `⌘.`，终端里的 agent 下一步也会被拒绝，反之亦然。终端或 `LUBAN_COMPUTER=1` 打开的会话不点亮桌面 App 的那圈覆盖层（桌面 App 在场时后端看到 `LUBAN_GLOW_URL` 就让位），而是由 CLI 自己拉起 `luban-glow` 画边框；两者都关了才完全没有光圈——产生输入前请确认你看着的是哪个窗口。

**终端为什么能看到光圈**：终端窗口盖不住别的 App，所以 CLI 只在实际输入操作开始时用 `swiftc` 把 `apps/desktop/native/glow.swift` 编译成 `~/.luban/bin/luban-glow-<hash>`（首次约 5 秒，之后命中缓存）并以不阻止 Node 退出的子进程运行；每个动作的 finally、TUI 卸载、服务停止、`end()` / `Ctrl+C` / `/computer off` / 人按 `⌘.` 时清理。启动编译期间停止也不会留下迟到的覆盖层。覆盖层走 `--parent-pid` 的父进程守护，后端崩了它自己也会退；它不再在 SIGTERM 时写停止标志，只有人按 `⌘.` 才写。`~/bin/luban-glow` 必须在真实的 macOS AppKit 里跑，`glow.html` 只对 Electron 有效。

## 后端结构

| 位置 | 作用 |
| --- | --- |
| `apps/desktop/native/computer.swift` | 唯一注入系统输入的地方。stdin 一行 JSON、stdout 一行 JSON，中文/引号/换行都不必转义进 argv |
| `src/core/computer.ts` | 会话状态、停止标志、helper 编译与调用、截屏落盘与裁剪、glow 通知 |
| `src/core/tools.ts` | `computer` 工具（`status`/`screenshot`/`cursor` 只读；其余动作要开关） |
| `src/web/server.ts` | `GET/POST /api/computer`：状态、开启、关闭、`{"stop":true}` |
| `apps/desktop/glow.html` + `main.cjs` | 桌面 App 的透明全屏覆盖窗口画燃弧；后端经 `LUBAN_GLOW_URL` 回环端点推 begin/action/end |
| `apps/desktop/native/glow.swift` | 终端/无头会话的燃弧覆盖层（AppKit，`--label`、`--stop-file`、`--parent-pid`、`--timeout`） |

helper 按源码 sha256 编译到 `~/.luban/bin/luban-computer-<hash>`（`swiftc` 需要 Xcode 命令行工具）。也可以用 `LUBAN_COMPUTER_HELPER` 指向预编译产物，或者把 `apps/desktop/native/luban-computer` 一起打包，这样没有 Xcode 的机器也能用。

## 动作

```
status            # 权限与开关状态，不需要开关
screenshot        # 全屏，或 region:{x,y,width,height}；落在 <workspace>/.luban/computer/，只留最近 20 张
cursor            # 当前指针坐标
move / click / double_click / right_click / drag / scroll / type / key
```

坐标是**屏幕点**（主屏左上角原点、与截屏同一套刻度；Retina 上 helper 会按 `displayScale` 换算成像素交给 `screencapture`）。先 `screenshot` 再点，别凭坐标猜。

## 一个坑：TCC 归属

`CGEvent.post` 的授权归属到**拉起进程的那个 App**。从终端里跑就是终端，从 `luban.app` 里跑就是 luban.app。如果归属没授权，`post` 会被静默丢弃——事件发出去、指针不动、也不报错。所以 `move` 先 `CGWarpMouseCursorPosition`（不需要授权，位置一定准），再补一个 `.mouseMoved` 让窗口感知 hover；`check` 用 `CGPreflightPostEventAccess()` 如实报告点击/按键会不会生效。

## 验证

```bash
npx vitest run src/core/computer.test.ts src/web/computer-endpoint.test.ts src/web/client/computer-control.test.tsx
echo '{"action":"check"}' | ~/.luban/bin/luban-computer-<hash>
```

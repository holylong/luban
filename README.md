<div align="center">

<img src="docs/assets/luban-logo.png" alt="luban" width="380" />

**A distributed general-purpose AI assistant**

Terminal · Desktop · Browser · Phone — one project, one session

**English** · [简体中文](README.zh-CN.md)

[Install](#install) · [Quick start](#quick-start) · [Bot](#resident-bot) · [Desktop workbench](#desktop-workbench) · [Models](#configure-models) · [Reference](docs/reference.md)

</div>

luban reads code, edits files, runs commands and verifies the result inside your project — it carries an idea all the way to something that runs and can be checked. It can also hand a task to another computer on your LAN.

> macOS [computer control](docs/computer-control.md) is enabled at startup by default (the OS permission is still required). Turn the default off with `computer.enabled: false` or `LUBAN_COMPUTER=0`; a project config cannot grant this.

## Highlights

| Capability | What it means |
| --- | --- |
| **Everything visible** | The plan, command output, and every edit with its file path, line numbers and before/after |
| **One session, four front ends** | Terminal TUI, desktop app, browser workbench, phone remote — progress and approvals stay in sync |
| **Across machines** | Auto-discovers LAN peers, syncs project files, runs a task on another computer |
| **Any model** | Cloud and local models, OpenAI-compatible endpoints, Anthropic, Responses, or reuse a Codex account |
| **Extend on demand** | Skills, MCP, and editor plugins |
| **No hidden permissions** | Commands and file edits run on your machine with your user's rights — this is not a sandbox |

## Same model, same task

One model (`deepseek-flash`), one task (a single-file HTML + Three.js voxel pagoda garden with at least 2000 blocks), one Mac running them one after another. The three final scenes:

<table>
<tr>
<td align="center" width="33%"><img src="docs/assets/bench/luban.jpg" alt="luban output" /><br /><b>luban 2.9.1</b><br />42 KB · 1,252 lines</td>
<td align="center" width="33%"><img src="docs/assets/bench/codex.jpg" alt="codex output" /><br /><b>codex-cli 0.166.0</b><br />76 KB · 2,065 lines</td>
<td align="center" width="33%"><img src="docs/assets/bench/dsh.jpg" alt="dsh output" /><br /><b>dsh 0.2.2-rc.5</b><br />89 KB · 2,445 lines</td>
</tr>
</table>

| | luban 2.9.1 | codex-cli 0.166.0 | dsh 0.2.2-rc.5 |
| --- | --- | --- | --- |
| Wall clock | **11.7 min** (700 s) | 15.1 min (906 s) | 36.4 min (2182 s) |
| Model calls | 45 | 62 commands + 10 file changes + 1 MCP | 123 steps |
| Input tokens | **3,739,845** | 10,557,747 | 18,319,535 |
| Cache hits | 3,210,880 (86%) | 10,343,168 (98%) | 18,245,504 (99.6%) |
| Output tokens | 105,669 (of which reasoning 76,732) | 126,819 (reasoning 69,946) | 174,860 |
| Structure | 50 functions / 18 prop types | 46 / 19 | 68 / 21 |
| Frame detail (edge density) | **0.0235** | 0.0220 | 0.0208 |
| Render check | 0 console errors, canvas 1280×800 | same | same |

How to read it: token counts are each runtime's own accounting, wall clock is `/usr/bin/time -p` on the same machine. Input tokens are mostly the already-written HTML being pushed back into context every step, so the cache-hit rate is what drives real cost. All three produce a working scene that passes a render check without vision; the difference is that luban spent fewer tokens and less wall clock, and its file is smaller in bytes while matching on functions and prop types — written more compactly, not with fewer elements.

Caveats: the prompts share one source (the same `docs/demo-prompt.md` task), and the luban run used a Chinese paraphrase of it. Every number is a single run; variance is not measured.

Reproduce:

```bash
node dist/cli.js -p "$(cat docs/demo-prompt.md)" --yes --model deepseek/deepseek-flash
```

luban's self-check comes from the built-in `render_html` tool: one call returns a screenshot, console errors, canvas/WebGL state and pixel statistics (luminance, saturation, edge density, region map), so a model without vision can still tell whether the page actually draws something.

## Install

| Platform | Package | Start |
| --- | --- | --- |
| macOS x64 / arm64 | `luban-cli-<version>-mac-<arch>.zip`<br>`luban-desktop-<version>-mac-<arch>.dmg` (a `.zip` of the same name if the build host cannot create a DMG) | `./luban`<br />drag `luban.app` into Applications |
| Windows x64 | `luban-cli-<version>-win-x64.zip`<br>`luban-desktop-<version>-win-x64.zip` | `luban.cmd`<br />`luban-desktop.cmd` |
| Linux x64 / arm64 | `luban-cli_<version>_<arch>.deb`<br>`luban-desktop_<version>_<arch>.deb` | `luban`<br />`luban-desktop` |

The packages bundle Node.js, so unpacking or installing is enough. If macOS Gatekeeper blocks the first launch, run `xattr -dr com.apple.quarantine .`.

From source (Node.js 20 or newer):

```bash
npm install && npm run build && npm link
```

## Quick start

```bash
luban                                       # start in the current project
luban /path/to/project                      # start in a given project
luban . --yes --prompt "run the tests and fix the failures"   # one task, one shot
luban web . --port 8642                     # browser workbench
```

After startup, just state the goal, for example "explain this project's entry point". You can keep adding requirements while it works, or queue work with `/queue <task>`.

Common commands: `/models` pick a model · `/sessions` resume a session · `/diff` review changes · `/export` export a transcript · `/theme` change colours · `/skin` change the skin · `/report weekly` generate a weekly report · `/help` list everything.

If startup feels slow, `LUBAN_STARTUP_TRACE=1 luban` prints per-phase timings (`modules` / `config` / `mesh` / `render`, in milliseconds, cold start included). On Windows `modules` usually dominates: antivirus scans every module file read at startup, so dependencies are loaded on demand and a cold start reads ~260 files (early versions read ~840).

## Resident bot

The bot is what makes the desktop pet tick — inside it calls itself the creator. **The desktop app starts a worker automatically**; the status light shows not started / idle / working / error / stale lock, and opening it reveals machine load and memory, active agents, process info, recent task results, token usage and pending approvals. Quitting the app asks the worker it started to stop (a worker started elsewhere is never taken over or stopped).

It also runs entirely without the desktop app:

```bash
luban bot run                                        # start the local background queue
luban bot add "review the project and summarise the risks" -w /path/to/project  # queue from another terminal
```

Scheduling with `--at`, repeating with `--every`, `list` to see results, `cancel` to stop a task. Operations that need approval are granted through a separate permission file; without it they are recorded as requests. Initialise with `luban bot permissions`, inspect requests with `luban bot requests`.

Launch-at-login on macOS and the exact permission boundary are in the [bot guide](bot.md).

## Desktop workbench

The installers start the CLI with `luban` and the desktop app with `luband` (on the Windows/macOS portable packages, add the unpacked directory to `PATH`). From source, run `npm run desktop -- /path/to/project`, or open the `luban` app from the package. Switch workspaces with "Open folder…" on the left or "File → Open project folder" (`Ctrl/⌘ O`); the desktop app restarts its local service and opens the new directory.

| Area | What it does |
| --- | --- |
| **Pet** | Appears when the desktop app starts and launches the bot worker; the creator status light expands into a task and runtime panel, and a speech bubble reports finished bot tasks. Click the robot to open the main window; drop a text or code file and confirm "feed to luban" to have it processed, with the result in a bubble when done. Closing the main window hides it and keeps the pet alive; quit from the file menu |
| **Editor** | File tree plus multi-tab editing, syntax highlighting, `⌘P` quick open, `⌘S` save; saving validates the on-disk version first and refuses silent overwrites |
| **Middle area** | "Code" and "current change" share the same slot, and a new edit shows its diff immediately; the editor is not unmounted, so unsaved content survives |
| **Console** | One-off commands with live output, stop and replay, switchable between Markdown and raw text |
| **Terminal** | A real PTY (xterm.js): prompts, colours, `cd`, `ssh`, `vim` all behave like a normal terminal |
| **Sessions** | Several turns merged into one timeline; you can append instructions mid-run and they queue automatically; reasoning is collapsed by default; the title is named by the model from the task |
| **Theme and model** | Reuses the CLI palettes and model list, supports reasoning-effort levels and remembers the choice |

Details and known limits: [desktop workbench reference](docs/reference.md#桌面工作台).

## Configure models

The default model needs no key (`opencode-zen/deepseek-v4.1-flash-free`), so a fresh install can talk immediately. To use your own model or account:

| Goal | How |
| --- | --- |
| Switch model | `/models`; models with native reasoning effort expose extra levels |
| Set an API key | In `/models` select the provider and press `Ctrl+A`: `K` to enter, `D` to delete, `O` to open the provider's key console |
| Use a Codex account | Install `@openai/codex` first, press `L` in `/models` for device-code login, then choose `codex/default` |
| Point at your own OpenAI-compatible endpoint | Set `base_url`, `api_key_env` and `models` in `~/.luban/config.json`; see [config.example.json](config.example.json) |

**Built-in providers**: `codex`, `deepseek`, `dashscope`, `opencode-go` / `opencode-zen`, `opendesign`, plus local Qwen / Strata. `opendesign` ships a model table but no gateway URL, so set `providers.opendesign.base_url` and `OPEN_DESIGN_API_KEY` first; OpenCode uses `OPENCODE_API_KEY` or `OPENCODE_ZEN_API_KEY`.

**Where keys live**: `~/.luban/provider-auth.json` (or under `LUBAN_HOME`), plaintext locally with mode `0600`, never in project config, input history or sessions. A saved key applies to every model of that provider immediately and takes precedence over config and environment; deleting it falls back to the original source. A running task picks the change up when the turn ends. The model picker in a standalone web workbench has no auth panel.

**First start**: when `~/.luban/config.json` is missing, a portable default is written (port, timeouts, context, sync ignores, worker/step limits, auto-approved edits) with no API keys, internal nodes, private gateways or relay addresses. An existing config is never rewritten; delete it and the next start regenerates it.

Protocol switching, quotas and reconnection: [reference](docs/reference.md#配置).

## Packaging

With dev dependencies installed, `npm run release` builds the CLI and the desktop app for the current system and writes the artifacts and SHA-256 manifest to `release/`.

```bash
npm run release -- --kind desktop   # desktop app only
npm run release -- --dry-run        # show the plan without building
```

Linux, Windows and macOS are supported, and each must build on its own system. Full options and the publishing flow are in the [release guide](docs/release.md). The script never commits, tags or uploads.

## More

LAN collaboration, phone remote, skins and loading pets, daily and weekly reports, MCP and editor integration, the security boundary and development verification are all in the [reference](docs/reference.md). To quickly check a whole chain (model, tools, approvals, rendering, remote control) end to end, see the [self-test prompts](docs/prompts.md). Version history and upgrade notes live in the [changelog](CHANGELOG.md).

## License

[MIT](LICENSE). Third-party dependencies keep their own licences; what ships alongside luban is mostly MIT / ISC / Apache-2.0 / BSD, and the desktop and creator packages also contain Electron and Chromium under their own licences.

# luban VS Code extension (minimal ACP bridge)

Spawns `luban acp` in the open folder and talks newline-delimited
JSON-RPC (`initialize` / `session/new` / `session/prompt` / `session/cancel`,
streaming `session/update` into the `luban` output channel).

## Install (dev)

```bash
npm link   # from luban repo root, so `luban` is on PATH
mkdir -p ~/.vscode/extensions/luban-0.8.0
cp editors/vscode/package.json editors/vscode/extension.js ~/.vscode/extensions/luban-0.8.0/
```

Reload VS Code, open a folder, run `luban: Ask / run a task`.

## Commands

- `luban.ask` — prompt for a task, stream the answer to the output channel.
- `luban.sendSelection` — send the current selection with its file name.
- `luban.sendFile` — ask for a review of the current file (`@`-style path).
- `luban.cancel` — cancel the in-flight prompt.

## Limits

- One session per window; sessions are in-memory (no `--resume` yet).
- Text only; image attach stays in the TUI (`@shot.png`).
- Headless permission semantics: allow with `luban --yes` config,
  otherwise only read tools run unattended.

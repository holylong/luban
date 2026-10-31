# tests

Manual and demo helpers that are not part of the automated suite.

Automated unit/integration tests stay next to the code they cover
(`src/**/*.test.ts`, `src/**/*.test.tsx`) because vitest only collects that
pattern and the tests import their modules through relative paths.

| Path | What it is |
| --- | --- |
| `manual/pty-test.py` | Drives the built CLI (`npm run build` first) through a real pseudo-terminal: types a message, toggles mouse mode twice, quits, and prints the last 25 clean lines. |
| `manual/shot.ps1` | Windows-only screenshot helper: grabs the primary screen, downsamples to 640px wide, writes `%TEMP%\shot.b64` plus `C:\Users\Public\shot.jpg`. |
| `demos/TASK.md` | Example task prompt used for manual end-to-end demos. |
| `demos/ui-preview.mjs` | Renders the TUI execution timeline offline (`node tests/demos/ui-preview.mjs` after a build); `LUBAN_PREVIEW_HOLD=1` keeps it open. |
| `artifacts/game.html` | Standalone canvas toy kept as a sample artifact; open it directly in a browser. |

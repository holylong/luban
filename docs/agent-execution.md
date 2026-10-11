# Agent execution and recovery

Tool requests pass through JSON parsing, schema validation, mode and permission
checks, scoped workspace instructions, cancellation and steering checks, and
execution. Validation supports JSON Schema drafts 7, 2019-09 and 2020-12. It
does not coerce values, insert defaults or silently discard unknown fields.
Explicit empty file content and replacements remain valid; absent values do not.
Built-in tools also validate direct calls from integrations.
`format` annotations are not enforced; tool implementations own semantic checks.
Asynchronous validator extensions are rejected before execution.

Writes and other effects execute sequentially. Each result updates its transcript
slot, emits its inline execution record, and saves the session before the next
effect starts. Consecutive parallel-safe reads execute concurrently; completion
events appear immediately, while result slots preserve the original call order.
Session saves are serialized. A persistence failure stops further effects after
all reads already in flight have settled. Interrupted slots explicitly report an
unknown execution status, so restoring a session does not replay effects.

Explicit and automatically detached background commands share cancellation
ownership with their initiating run. Closing the runner also terminates managed
background processes. Commands with explicit timeouts stay in the foreground.

Isolated subagents start in a detached worktree at HEAD. Successful automatic
merges include unstaged changes, staged changes, binary patches and recursively
enumerated untracked files. Git stdout and stderr stay separate; file lists use
NUL delimiters. Existing empty files count as existing files, and new files use
exclusive creation to avoid overwriting concurrently created parent files.
Non-regular files and paths escaping the workspace are refused.

A worktree is removed only after a completed automatic merge with no conflicts.
Disabled automatic merges, unfinished subtasks, model failures, merge failures,
conflicts and cancellations preserve it and report its path. Conflict copies
retain bytes from both sides under `.luban/conflicts/`. Retained worktrees consume
disk space until the user resolves them and removes them with `git worktree remove`.
Merges proceed per file and can apply clean files while preserving conflicts.
Tracked files changed by a merge produce the same line-numbered inline previews
as direct edits; binary changes report byte sizes. Previews are bounded for the
UI; complete retained files remain available for recovery.

This is workspace tooling, not OS isolation. Shell confinement still depends on
the configured sandbox backend, and a worktree begins at committed HEAD rather
than cloning the parent's uncommitted workspace or installed dependencies.

# luban development

- Increment the package version for each delivered change to luban; keep package.json and package-lock.json aligned. Build before handoff and report the version.
- File edits must display inline execution records with the file path, added/deleted counts, line numbers, and actual before/after changes. Preserve these records when saving and restoring sessions. A workspace Git diff viewer is a separate feature and does not replace inline edit records.
- Keep the plan in the TUI right sidebar. Execution records are a borderless timeline; terminal mouse wheel must open and scroll the execution details.

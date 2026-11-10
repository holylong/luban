# luban development

- 版本号规则（每个交付都要遵守）：版本是 `MAJOR.MINOR.PATCH`，每次交付只把 PATCH 加 1；PATCH 只在 1–20 之间，需要在 20 之上再加一版时改为 MINOR 加 1、PATCH 回到 1（例如 `2.2.20` 的下一版是 `2.3.1`，不是 `2.2.21`）。PATCH 不允许写成 0 或大于 20；MAJOR 只在用户明确要求时变化。递增时用 `npm version patch --no-git-tag-version` 让 package.json 与 package-lock.json 保持一致，并在 CHANGELOG.md 记一条；`npm run release` 会通过 `versionProblem()` 校验，不合规直接失败。详见 docs/release.md「版本号规则」。
- Increment the package version for each delivered change to luban; keep package.json and package-lock.json aligned. Build before handoff and report the version.
- luban/ is its own git repository (remote holylong/luban) nested inside the agi repo, which also tracks luban/ files. All release git operations must run inside luban/; never commit or tag a release from agi, which produces no GitHub Release. Use the `luban-release` skill for the release procedure.
- File edits must display inline execution records with the file path, added/deleted counts, line numbers, and actual before/after changes. Preserve these records when saving and restoring sessions. A workspace Git diff viewer is a separate feature and does not replace inline edit records.
- Keep the plan in the TUI right sidebar. Execution records are a borderless timeline; terminal mouse wheel must open and scroll the execution details.

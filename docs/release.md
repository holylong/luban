# 发布版本打包

版本：2.0.13 起 Windows 默认恢复 ZIP，不再强制构建 SEA EXE 或依赖 7-Zip。

## 版本号规则

版本号固定为 `MAJOR.MINOR.PATCH`，每个交付递增一次 PATCH，不跳号、不用 0：

- PATCH 从 1 数到 20：`2.2.1`、`2.2.2` …… `2.2.20`。
- 下一个交付如果会超过 20，就把 MINOR 加 1、PATCH 回到 1：`2.2.20` 的下一版是 `2.3.1`，不是 `2.2.21`，也不是 `2.3.0`。
- MAJOR 只在用户明确要求时变化，新 MAJOR 的第一个版本是 `3.0.1`；MINOR 同理不单独跳号。
- 版本按「一次可发布的变化」计，不按每个小改动计：一轮工作里连续的小修、重构、文档整理、探针脚本都并进同一次交付、共用同一个版本号；只有对外部使用者有意义的东西才值得占一个版本。一天里连开 26 个版本（`2.7.x` 那天的实际情况）就是在制造空日志。
- 发版前先攒：先把这一批改动做完、跑完验证，再 `npm version patch --no-git-tag-version`（或手工同步 package.json 与 package-lock.json），并在 CHANGELOG.md 顶部加一节，写清用户能感知到的变化。
- 没有用户可见变化的整理（纯文档、纯测试、内部重命名）不单独升版本、不单独发版，跟着下一次真正的交付一起走。
- 版本号必须带一节有内容的 CHANGELOG：`npm run publish:release` 默认把该版本的 CHANGELOG 一节当作更新日志上传，找不到这一节会直接拒绝发布（`--notes` 可显式覆盖），这样 `luban update` 和升级弹窗里不会再出现空日志。
- `npm run release` 启动时用 `versionProblem()` 校验，`2.2.0`、`2.2.21`、`v2.2.3` 这类版本会直接报错退出；`npm run test:release` 覆盖了这些用例。
- 规则从 `2.2.3` 开始生效；CHANGELOG 里更早的 `2.2.0` 等版本是历史记录，不回改。

## 快速开始

先运行 `npm ci --include=dev`（即使 NODE_ENV=production 也安装构建工具），然后运行：

- `npm run release`：当前平台 CLI + Desktop（macOS 另加造物主）；Windows 输出两个便携 ZIP 和 SHA256SUMS。
- `npm run release -- --kind cli`：仅 CLI ZIP，不下载 Electron。
- `npm run release -- --kind desktop`：仅 Desktop ZIP/DMG。
- `npm run release -- --kind creator`：仅造物主 `Creator.app`（`.dmg`，失败回退 `.zip`）。目前只有 macOS 打包脚本支持它，其他平台会明确报错。
- `npm run release -- --dry-run`：查看计划。

Windows 解压后运行 `luban.cmd` 或 `luban-desktop.cmd`。包内自带 Node.js，桌面包另带 Electron，使用者不需要安装 npm。

## 网络受限环境

项目 `.npmrc` 默认使用 `https://registry.npmmirror.com/`，优先使用缓存，限制下载超时与重试。
Windows 打包生产依赖先尝试 npm 离线缓存，缺失时才访问镜像；CLI 和 Desktop 的同一批依赖可复用 npm 缓存。
Electron 安装器优先复用已安装的同版本运行时/下载缓存；下载默认使用 `https://npmmirror.com/mirrors/electron/`。
镜像下载失败时不再直接失败：`scripts/lib/release-network.mjs` 会在整个 Electron 缓存目录里找同版本、sha256 与 `node_modules/electron/checksums.json` 一致的归档，自己解包成 `node_modules/electron/dist`（镜像不同、缓存键不同也能复用），再退回官方地址下载。
不会关闭 TLS 或跳过 Electron 校验。镜像也可能不可达，首次安装不可能保证完全离线。

可用环境变量 `ELECTRON_MIRROR` 覆盖 Electron 镜像，`LUBAN_NPM_REGISTRY` 覆盖 Windows 打包生产依赖源。
初次安装依赖时可使用 `npm ci --include=dev --registry=https://registry.npmmirror.com/`。
如果只有 Electron 无法下载，运行 `npm run release -- --kind cli`，先获得独立可运行的 CLI ZIP。
缓存不完整且没有可访问的镜像时，需要先联网安装依赖，不能凭空生成运行时。

## 实验性 EXE（不属于默认发布）

`npm run release -- --kind exe` 显式尝试 Node SEA 单文件 CLI；`--kind setup` 显式尝试 7-Zip SFX。
这两个选项要求 Windows x64、Node >=25；setup 还需要 7-Zip。仍属实验功能，不保证目标机器可用。
单文件 CLI 的完整皮肤与 Web UI 还依赖 exe 同级的 assets/ 与 web-ui/。
默认 ZIP 发布没有上述 SEA/7-Zip 要求，也不会因实验 EXE 构建失败而中断。

## 其他平台与校验

Linux 输出 CLI/Desktop `.deb`；macOS 输出 CLI `.zip`、Desktop `.dmg`、造物主 `.dmg`（两个 app 失败都回退 `.zip`）。
不支持跨平台/架构构建。每次构建检查 package.json 与 package-lock.json 版本一致，自动构建服务端与 Web UI。
`release/SHA256SUMS-<版本>-<平台>-<架构>-<kind>.txt` 只记录本次新生成的产物。
脚本不会提交、打标签或上传。GitHub 标签发布工作流在目标系统打包，Windows 上传两个 ZIP。

GitHub Release 的正文由 `scripts/release-notes.mjs` 生成：`## 更新内容` 取 CHANGELOG.md 中该版本一节，`## 安装包` 按平台列文件名与用法。打包 job 发布时带上本平台的正文，最后一个 `notes` job 用 `--platform all` 重写成完整正文，两处读的是同一份 CHANGELOG，所以发布页永远不会只剩一坨安装说明。该版本没有 CHANGELOG 一节时脚本直接失败，与 `publish:release` 一致。本地预览：`npm run notes:release -- --version 2.9.6`。

已经发布的 release 正文可以事后补：`npm run notes:release -- --version 2.9.6 --base body.md` 会把该版本 CHANGELOG 一节放到原正文前面，原有安装说明逐字保留（老版本的文件名不会被新规则改写），已经有 `## 更新内容` 的正文不会被再动。`.github/workflows/release-notes-refresh.yml` 用这条命令修所有历史 release，也被 CHANGELOG 的 push 触发，可手动 `workflow_dispatch` 指定版本或 all。

验证命令：`npm run test:release`。打包完成不代表已人工验证 GUI 和安装器。

## 发布到升级服务器（`luban update`）

打包和发布是两步：`npm run release` 只在本地产出文件，`npm run publish:release` 才把它们交给所有客户端。

升级服务就是统计服务（`luban-server` 仓库，通常与 luban 检出在同一层目录），同一台机器两个接口：

| 接口 | 作用 |
| --- | --- |
| `GET /api/update?platform=darwin&arch=x64&kind=cli` | 客户端唯一的问题：我这个平台有没有更新的？返回 `latest`（服务器已知最新版）与 `artifact`（本平台安装包，没有则 `null`）。 |
| `GET /downloads/<file>` | 安装包本体，公开可下，带 `content-length` 与长缓存头。 |
| `PUT /api/admin/artifact?file=<name>` | 上传一个文件，`x-luban-sha256` 必须与收到的字节一致。 |
| `POST /api/admin/release` | 发布清单；只接受已经被 `/downloads/` 校验过的文件。 |

发布步骤：

1. `npm run release -- --kind cli`（要发桌面版再加 `--kind desktop`，造物主加 `--kind creator`）。
2. 首次发布前准备令牌：在服务器 `/etc/luban-server.env` 里设置 `LUBAN_STATS_UPDATE_TOKEN=<随机串>`，升级服务器时用 `LUBAN_STATS_UPDATE_TOKEN=… sudo bash deploy/install.sh …` 传入；本机把它写进 `~/.luban/releases-token`（`chmod 600`），或用环境变量 `LUBAN_RELEASES_TOKEN`。
3. `npm run publish:release -- --version 2.7.12 --notes "这一版改了什么"`。
   `--dry-run` 只列出会上传的文件；`--kind cli` 只发 CLI；`LUBAN_RELEASES_URL` 可临时指向别的服务器。
4. 自检：`LUBAN_UPDATES_URL=<服务器> node dist/cli.js update --json`，再用 `luban update install` 走一次真实下载与替换。

客户端侧：

- `luban update` / `install` / `on` / `off` / `status`；TUI 启动时检查一次（`updates.check` 为真才发请求），有新版才提示，选「稍后」本次不动、「不再提醒」写 `updates.skipped_version`。
- 桌面版：视图 → 检查更新（主进程下载、替换 `.app` 并自动重启），底栏「更新」按钮会自己打开面板并提供升级 / 稍后 / 不再提醒与「启动时检查更新」开关。
- 关掉检测：`luban update off`、桌面面板里的勾选框，或整机 `LUBAN_NO_UPDATE_CHECK=1`。
- 自建服务器：`updates.url` 或 `LUBAN_UPDATES_URL` 指向任意实现了上表接口的地址。

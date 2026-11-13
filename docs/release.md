# 发布版本打包

版本：2.0.13 起 Windows 默认恢复 ZIP，不再强制构建 SEA EXE 或依赖 7-Zip。

## 版本号规则

版本号固定为 `MAJOR.MINOR.PATCH`，每个交付递增一次 PATCH，不跳号、不用 0：

- PATCH 从 1 数到 20：`2.2.1`、`2.2.2` …… `2.2.20`。
- 下一个交付如果会超过 20，就把 MINOR 加 1、PATCH 回到 1：`2.2.20` 的下一版是 `2.3.1`，不是 `2.2.21`，也不是 `2.3.0`。
- MAJOR 只在用户明确要求时变化，新 MAJOR 的第一个版本是 `3.0.1`；MINOR 同理不单独跳号。
- 每个交付都要改版本：`npm version patch --no-git-tag-version`（或手工同步 package.json 与 package-lock.json），再到 CHANGELOG.md 顶部加一节。
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

验证命令：`npm run test:release`。打包完成不代表已人工验证 GUI 和安装器。

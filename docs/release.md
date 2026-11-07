# 发布版本打包

统一入口：`npm run release`。先在源码目录执行 `npm ci`，要求 Node.js >= 20，建议 Node.js 22。
脚本读取 package.json 版本并检查 package-lock.json 是否一致，不会自动修改版本、提交、打标签或上传。

## 使用

```sh
npm run release                           # 当前系统，CLI + Desktop
npm run release -- --kind desktop         # 仅桌面版
npm run release -- --kind cli             # 仅命令行版
npm run release -- --platform linux       # 在 Linux 主机运行
npm run release -- --platform windows     # 在 Windows 主机运行
npm run release -- --platform macos       # 在 macOS 主机运行
npm run release -- --dry-run              # 仅显示目标和产物路径
npm run release -- --help
```

`--platform` 默认为 `auto`，也接受 `win32`、`darwin` 和 `mac` 别名。`--kind` 默认为 `all`。
架构取当前 Node.js 的 `process.arch`，不支持跨系统或跨架构编译；要发布所有平台，在各平台机器或 CI 上分别运行。
不支持的平台、架构和参数会在构建前报错。

| 平台 | 架构 | 产物 | 主机工具 |
| --- | --- | --- | --- |
| Linux | x64 / arm64 | CLI 和 Desktop `.deb` | npm、dpkg-deb、可用的 Node.js LICENSE（或系统 copyright 文件） |
| Windows | x64 | CLI 和 Desktop `.zip` | npm、tar.exe |
| macOS | x64 / arm64 | CLI `.zip`；Desktop `.dmg`（失败时回退 `.zip`） | npm、ditto、hdiutil、sips、iconutil、codesign、PlistBuddy |

脚本复用 `scripts/package-*.mjs`，自动构建服务端和 Web 界面；桌面版会先调用 Electron 安装器确保原生运行时存在，可能需要网络。
只打包 CLI 时不下载 Electron。打包器会安装生产依赖并执行内置 CLI 的版本冒烟检查。
macOS 桌面版先用 `hdiutil` 生成 `.dmg`；镜像创建失败（例如无图形会话的构建机）时自动改为同名的 `.zip`，校验清单按实际产物生成，不会记录缺失的文件。

## 产物与安装

输出在 `release/`，文件名包含版本、平台和架构。每次成功打包还会生成
`SHA256SUMS-<版本>-<平台>-<架构>-<kind>.txt`，只包含本次选择的包，避免混入历史产物。
Linux 可在 `release/` 中用 `sha256sum -c <校验清单>` 校验；macOS 可用 `shasum -a 256 -c <校验清单>`；Windows 可用 `Get-FileHash <包路径> -Algorithm SHA256` 对照校验。

- Linux：`sudo apt install ./release/luban-desktop_<版本>_amd64.deb`，然后从应用菜单或 `luban-desktop` 启动。安装包配置 root 属主的 setuid Chromium 沙箱，不默认关闭沙箱。
- Windows：解压 Desktop ZIP，运行 `luban-desktop.cmd`。
- macOS：打开 Desktop 的 `.dmg`，把卷内的整个文件夹（`luban Desktop.app`、`node`、`app/`）拷到磁盘后打开 App，App 需要同级的 `node` 与 `app/` 才能启动；若只拿到回退的 zip，解压后同样打开 `luban Desktop.app`。当前为 ad-hoc 签名，不是 Apple 公证发行版，Gatekeeper 处理说明见包内 README.txt。

快捷入口：`luban [项目目录]` 启动 CLI，`luband [项目目录]` 启动 Desktop；保留原有桌面长命令兼容。Linux 安装 deb 后可直接运行（两个短命令分别由 CLI 和 Desktop 包提供）；Windows/macOS 便携包需将解压目录加入 PATH，或在解压目录运行 `luband.cmd` / `./luband`，CLI 对应 `luban.cmd` / `./luban`。

安装包内置 Node.js，Desktop 另含 Electron，使用者不需要 npm。打包成功不等于 GUI 启动验证，仍应在目标系统实际安装、启动并检查。

## 远端发布

已有 `.github/workflows/release.yml` 在版本标签触发后，分别在 Linux、Windows 和 macOS（Intel / Apple Silicon）运行统一入口并发布安装包到 GitHub Release。
版本标签必须与 package.json 一致（`v<版本>`）。本地脚本只负责打包，不会触发这些远端操作。
当前工作流上传安装包；校验清单保存在构建机器，手动发布时可将对应清单一并上传。

脚本测试：`npm run test:release`。

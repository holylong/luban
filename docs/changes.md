# 修改记录

## 1.16.75（2026-10-09）

- 生成以榫卯和木工角尺为灵感的 luban Logo，保存至 `assets/luban-logo.png`。
- README 顶部居中展示 Logo，保留简洁的用户说明。
- 版本同步更新至 1.16.75。

验证：`npm run build`、图片引用、版本一致性及 `git diff --check` 均通过。

## 1.16.74（2026-10-09）

- README 增加 OpenCode Go / Zen 密钥设置、默认模型与服务地址说明。
- 增加 OpenAI API 和兼容接口的配置示例，说明地址、模型 ID、密钥和协议选择。
- 对照配置实现及服务官方文档核对示例；版本同步更新至 1.16.74。

验证：构建、JSON 示例格式、版本一致性及 `git diff --check` 均通过。


## 1.16.73（2026-10-09）

- README 增加简短的特色功能介绍，覆盖执行过程、局域网协作、手机远控、任务恢复、模型选择和扩展能力。
- 版本同步更新至 1.16.73。

验证：`npm run build` 和 `git diff --check` 均通过。


## 1.16.72（2026-10-09）

- README 精简为面向用户的安装、模型配置和常用操作说明。
- 原 README 的详细配置、实现说明、历史修复信息和开发验证移至 `reference.md`，保留查阅入口。
- 修改记录独立保存在本文，不写入 README。
- `package.json` 和 `package-lock.json` 版本同步更新至 1.16.72。

验证：`npm run build` 通过（服务端编译、前端类型检查与 Vite 打包）；`git diff --check` 通过。

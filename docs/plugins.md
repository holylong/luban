# 插件商店

插件就是**技能包**:一组 `SKILL.md` 装进 `~/.luban/skills/`,模型在需要时用 `list_skills` /
`read_skill` 自己读进来。装插件不会执行任何代码,只写入 markdown 文件;卸载只删除记账里属于
该插件的目录,手写的技能不受影响。

目录本身是一个静态 JSON 文件,放在公开仓库
[holylong/luban-plugins](https://github.com/holylong/luban-plugins) 的 `plugins.json`。

## 入口

| 位置 | 用法 |
| --- | --- |
| 桌面版 | 状态栏「插件」按钮:搜索框输入即过滤,一行一个插件,按钮是安装 / 更新 / 卸载 |
| 配置文件 | `~/.luban/config.json` 的 `plugins.registry` 指向任意 URL(可以是公司内网镜像、本地文件服务) |
| 环境变量 | `LUBAN_PLUGIN_REGISTRY=https://…/plugins.json`,优先级高于配置文件 |

`plugins.registry` 为空时使用内置默认目录。桌面面板会显示正在用的目录地址,所以镜像看得见。

## 安装做了什么

1. 读目录(服务端缓存 5 分钟,搜索不重复拉取),按 `id` 找到条目。
2. 逐个文件下载 `files[].url`,校验 `sha256` 与 `bytes`。
3. 先写 `<home>/.luban-plugin-<uuid>/` 临时目录,校验全部通过后原子移动到
   `<home>/skills/<skill>/`;任何一步失败都不留下半个技能。
4. 在 `<home>/plugins.json` 记账:插件 id、版本、安装时间、skill 目录、每个文件的 sha256。

账本是卸载的依据,也是“已安装 / 可更新”的来源:目录里的 `version` 比账本里的新,面板就显示
「可更新 1.0.0 → 2.0.0」并给出更新按钮。

## 目录格式

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-11-23T08:00:00.000Z",
  "plugins": [
    {
      "id": "commit-style-zh",
      "name": "中文提交信息",
      "version": "1.0.0",
      "description": "一句话说明用户能获得什么。",
      "author": "luban",
      "license": "MIT",
      "homepage": "https://…",
      "tags": ["git", "中文"],
      "skills": ["commit-style-zh"],
      "files": [
        {
          "path": "skills/commit-style-zh/SKILL.md",
          "url": "https://raw.githubusercontent.com/…/SKILL.md",
          "sha256": "b6ab03c9…",
          "bytes": 1681
        }
      ]
    }
  ]
}
```

- `id` 只允许小写字母、数字、`.`、`_`、`-`;`name` / `version` / `description` 必填。
- `files[].path` 必须以 `skills/` 开头,前缀会被剥掉后再落到 `~/.luban/skills/`。
- 单个文件上限 512KB,一个插件最多 64 个文件,目录最多 500 个插件。
- 只支持 `https://`(回环地址例外,方便本地测试镜像)。

## 发布一个插件

```bash
mkdir -p plugins/my-plugin/skills/my-skill
$EDITOR plugins/my-plugin/plugin.json
$EDITOR plugins/my-plugin/skills/my-skill/SKILL.md
node scripts/build-index.mjs      # 重新生成 plugins.json(重算所有 sha256)
git add -A && git commit -m "feat: 新增 my-plugin"
```

`plugins.json` 是**生成物,不要手改**:仓库 CI 会跑 `node scripts/build-index.mjs --check`,
目录里的 sha256 和文件内容对不上就直接失败——否则客户端安装时会校验报错。

## 安全边界

- 插件只能带来 markdown 指令,装不出新工具、新命令、也不会自动运行。
- 但技能内容会被模型当指令读,等于一份提示词:装之前先读一眼 `SKILL.md`,尤其是来自他人 PR 的插件。
- 目录地址可自建:企业可以只在 `plugins.registry` 里放内网地址,不用默认公开目录。

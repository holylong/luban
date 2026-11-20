# 开源发布前检查清单

把仓库从私有转公开之前按这份清单走一遍。这里**只写检查项和命令，不记录任何具体地址、
账号、家目录或内网路径**——清单本身也会被公开，写进去就等于又泄露一次。

## 1. 凭据与端点

```bash
# 键名扫描：命中的应当全是变量名或示例占位
git grep -nE "(api[_-]?key|secret|password|passwd|token|cookie)\s*[:=]"

# 点分四段地址：只应出现 0.0.0.0 / 127.0.0.1 / 私有网段示例
git grep -nE "\b([0-9]{1,3}\.){3}[0-9]{1,3}\b"

# 域名与隧道地址
git grep -nE "https?://[a-z0-9.-]+\.(com|cn|net|io|dev)"
```

- 内置默认服务地址集中在 `src/core/service-defaults.ts`：确认是否愿意把这些地址当作
  公开默认值；不愿意就把默认值留空，只保留配置项和文档说明。
- 端点必须**可覆盖**：`usage_stats.url`、`remote.relay_url` 以及对应环境变量都要生效，
  否则用户只能改代码。
- 历史提交也要查（私有仓库仍可改写历史）：

```bash
git log --all -p -S"<你的域名或 IP>" --oneline | head
git log --all --oneline | wc -l     # 判断改写历史的代价
```

## 2. 个人信息

```bash
git grep -nE "/Users/|/home/|C:\\\\Users"
git grep -nE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"   # 邮箱
git grep -nE "\b(deploy|me|admin|root)\b"                      # 账号名
git grep -nE "iZ[a-z0-9]+Z|MacBook|WorkStation|\.local\b"        # 主机名
```

- 测试固定数据里的路径一律用 `/tmp/...`、`/Users/me/...`、`/home/me/...` 这类示例。
- 探针脚本不要写死开发机的目录：从 `process.cwd()`、`__dirname` 或环境变量取。
- 文档里的部署示例用 `<user>@<your-server>`、`~/apps/...` 占位，别贴真实用户名与绝对路径。
- 截图（README、`docs/assets/`）逐张看一遍：用户名、路径、令牌、内网地址都会一起进图。

## 3. 仓库卫生

```bash
git ls-files | grep -E "(^|/)(build|dist|\.gradle|node_modules)/|local\.properties$"
git ls-files | wc -l
du -sh .git
```

- 构建产物一律不入库：Android 的 `app/build/`、`.gradle/`、`local.properties`，
  iOS 的 `Pods/`、`DerivedData/`，前端的 `dist/`。
  这些文件里会带完整构建机路径、SDK 位置，甚至旧版本的硬编码地址。
- 入库的二进制（`.apk`、`.dmg`、`.zip`）同样要查：`grep -a` 能直接翻出里面的字符串。
- `.gitignore` 覆盖：构建输出、本地配置、日志、探针/heap 快照、个人截图。
- `docs/` 里的内部运维记录（部署流水、审计快照、事故复盘）逐篇确认是否适合公开。

## 4. 仓库元数据

- 根目录有 `LICENSE`；`package.json` 补齐 `license`、`repository`、`homepage`、`bugs`。
- `README.md` 里的版本号与 `package.json` 一致（不一致会误导安装者）。
- `files` 白名单只包含真正的运行时资源（`dist`、`docs`、插件、README 等）。

## 5. 行为面

- 默认是否向作者的服务上报使用统计；公开版本要么关闭，要么在 README 首屏说明清楚。
- 默认中继地址是否只在配置缺省时使用，且断开连接不影响本地功能。
- 手机端默认服务器地址是否可在应用内修改。
- 首次运行会不会自动拨号/自动上传：默认关闭最省事。

## 6. 公开前的最后一遍

```bash
# 干净克隆，从零验证
git clone <repo> /tmp/oss-check && cd /tmp/oss-check
npm ci && npm run build && npm test

# 提交信息也看一眼：内部项目名、工单号、服务器名
git log --oneline | head -50
```

再确认两件事：要发布的分支已经推送、`docs/release.md` 的发布流程能在干净环境复现。
决定公开后，GitHub 上的 Star/Watch 不能回退，按「不可逆操作」对待。

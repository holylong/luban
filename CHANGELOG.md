## 2.9.14 — 2026-11-26

- 修复长任务轮询被“重复工具调用”守卫误杀：构建、测试跑在后台时，'get_background_task' 在任务结束前每轮都返回同一段“running”输出，旧逻辑满 5 轮就判定模型卡死并中止整个运行，用户只看到 'TOOL ERROR: not executed; repeated tool-call loop stopped'。轮询工具的结果按契约在任务推进前不会变化，现在不再计入重复窗口。
- 轮询仍在运行的任务改为独立计数：连续 8 次结果无变化时提醒模型「继续等可以，但别把每一步都花在轮询上」，连续 30 次完全无变化才停止轮询，并明确告知后台任务没有被中断、发送“继续”可再查看进度。
- 轮询已经结束的任务（status 为 done/failed/stopped）仍按普通重复调用处理，照旧在 5 轮内拦截，避免模型对已完成的任务空转。
- 新增 4 个回归用例：运行中的任务连续 poll 12 轮不再中断、第 8 轮提醒、30 轮才停并保留后台任务、轮询已完成任务仍在 5 轮内拦截。

## 2.9.13 — 2026-11-24

- 新增极简输出模式（'concise'）：工具调用、思考过程、状态提示与编辑记录只在实时行一闪而过，对话里只留下你的问题和最终结论。中间叙述（调用工具前那句“我先读一下文件”）也会被丢弃，只有被后续步骤取代的回答才不保留，避免过程混进结论。
- 终端用 '/concise [on|off]' 切换：不带参数在开/关间切换，选项有参数补全，顶栏出现「极简」标记并隐藏任务计划面板；'luban serve' 的后台运行不再打印工具日志，'luban -p' 一次性运行只输出结论。
- 桌面版与浏览器工作台顶栏新增「极简 · 开/关」按钮（桌面 Agent 列窄布局里也不会被隐藏），对话区按同一规则过滤；手机页面沿用同一设置。隐藏只作用于渲染，运行中的事件一条不丢，中途关掉开关即可恢复完整记录。
- 开关写入 'config.json' 的 'concise' 字段，也可用 'LUBAN_CONCISE=1' 强制开启；同时兼容 'minimal_transcript' 与 'verbosity: "concise"' 等手写写法，终端与桌面共享同一个值。新增 'POST /api/concise' 写入接口，'/api/node' 回报当前状态。
- 新增极简模式回归测试：接口写入与回报、时间线过滤（保留问题/失败/结论、丢弃被取代的叙述）、顶栏按钮状态，以及桌面窄布局的可见性断言。

## 2.9.12 — 2026-11-24

- Windows 的 CLI 和 Creator 也有安装包了：`npm run release` 现在为 cli、desktop、creator 各生成一个 `luban-<变体>-<版本>-win-x64-setup.exe`，与各自的便携 ZIP 并存，不再是只有桌面版能双击安装。
- 三个安装器共用一份 `packaging/windows/installer.iss`，靠 `/DKind` 区分 AppId、安装目录、启动器和安装包名；因此 CLI、桌面版、造物主可以同时装在一台机器上互不覆盖，同一变体的新版仍按固定 AppId 原地覆盖升级。
- CLI 安装器会把安装目录写入当前用户 PATH（卸载时移除），装完直接 `luban` 即可；桌面版与造物主不修改 PATH。发布计划、校验和、GitHub Windows 上传资产与发布说明同步为三个安装器。

## 2.9.11 — 2026-11-24

- Windows Desktop 默认同时生成便携 ZIP 和 `luban-desktop-<版本>-win-x64-setup.exe` 原生安装包。安装到当前用户的固定目录，无需管理员权限；新版双击安装器即可沿用原目录覆盖升级，不必每次解压。提供开始菜单、可选桌面快捷方式及系统卸载项，不删除用户配置和会话。Windows 应用内自动安装尚未实现。
- 安装器采用 Inno Setup 6，不依赖实验性 CLI SEA 或 7-Zip。提供固定版本、SHA-256 校验的编译器准备脚本，默认发布计划、校验和及 GitHub Windows 发布流程纳入桌面安装包；保留 ZIP 用于便携使用及原有更新清单。
- 修复从安装器快捷方式直接启动时的内置 Node.js 和 CLI 路径识别；增加安装器发布回归测试，并修正发布测试在 Windows 上误用 Unix 绝对路径断言的问题。

## 2.9.10 — 2026-11-24

- 补上桌面整窗空白的恢复盲区：原探针只执行 `1`，React 界面被清空但 JavaScript 仍存活时会一直误判正常。现在每 10 秒检查工作台及状态栏是否存在、工作台是否可见，连续两次异常重建窗口并保留本地后端；探针拒绝也计入异常，窗口销毁后忽略旧探针结果，导航和切换项目期间暂停检查。未保存的编辑器内容仍可能在窗口重建时丢失。
- 新增 5 个健康探针回归用例，并扩展真实 Electron 恢复探针：注入渲染进程崩溃、同步死循环和“JS 存活但清空根节点”三类故障。本机分别在 15.9 秒、32.8 秒和 13.9 秒恢复，软件渲染回退启动也通过。此修复覆盖已确认的检测盲区，不代表已定位用户本次白屏的原始触发异常。
- 修正桌面控制台格式栏多余的 CSS 右括号，消除构建中的 CSS 语法告警。

## 2.9.9 — 2026-11-24

- Linux 和 Windows 新增独立的 Creator（造物主）安装包，无需先安装 CLI 或桌面版。Linux 安装 `.deb` 后从应用菜单打开 luban Creator；Windows 解压便携 ZIP 后运行 `luban-creator.cmd`。
- 三端的 `npm run release` 默认生成 CLI、Desktop 和 Creator，仍可用 `--kind creator` 单独打包。GitHub 发版现在也会上传三端的 Creator 包，包括此前只在本地打包的 macOS 版本。

## 2.9.8 — 2026-11-23

- 桌面版能看 CSV/TSV 了：打开 `.csv` / `.tsv` / `.tab`，标题栏出现「表格预览」，`⌘/Ctrl+Shift+V` 与 Markdown 预览同一个键位切换。首行是文字表头时固定显示列名（无表头则用 A / B / C），行号固定在左侧，数字整列右对齐，宽表横向滚动时表头与行号不跟着跑。
- 解析覆盖真实导出文件的边角：分隔符按首行自动识别（逗号 / Tab / 分号 / 竖线，带引号的逗号不算分隔符），支持 `"…"` 引号单元格、`""` 转义、单元格内换行、CRLF 与 UTF-8 BOM；长短不一的行按最宽的补齐，空文件提示切回编辑。
- 预览读编辑器缓冲区，未保存的改动立刻出现在表格里；最多渲染 400 行 × 60 列，超出部分在表下注明「另有 N 行未显示 / N 列未显示」，单个单元格超过 240 字符截断，避免 20 万行导出把窗口卡死。判断与解析在无副作用的 `src/web/client/desktop-csv.ts`，按钮、快捷键与测试共用同一份。
- 配套插件 `csv-preview` 上架 luban-plugins：装好后助手处理 CSV 时先问清用途，按列推断类型、大文件先抽样、说明桌面表格预览只影响显示不影响数据。

## 2.9.7 — 2026-11-23

- 修「升级服务器清单过期就永远显示已是最新」：检查在服务器答 `current` / `no-build` 时再问一次 GitHub 的 `releases/latest`，两者取较新者；版本相同时只有 GitHub 真给出这台机器能装的包才采用它，所以服务器知道新版号却没包时也不会被更旧的资产顶掉。有新版时仍然只问服务器一次，不多发请求。
- 2.9.6 就是这样漏掉的：GitHub Release、8 个安装包、更新日志都齐了，但升级服务器清单还停在 2.9.1，已装 2.9.4 的桌面端因此一直显示「已是最新版本 2.9.4」（那句里的版本号取的是 `state.current`，不是你装到的服务器版本）。现已用 `publish:release --github v2.9.6` 把 2.9.6 的清单补上：8 行直指 GitHub 资产地址与 sha256，不复制 978 MB 字节。
- `.github/workflows/release.yml` 的 `notes` job 末尾新增「Announce the version on the update server」：打 tag 发版会自动跑 `publish:release --version X --github vX`，仓库缺 `LUBAN_RELEASES_TOKEN` secret 时打印一行提示并跳过，fork 不会因此失败。
- 桌面版「插件」窗口终于看得见了：状态栏这两个按钮（插件、更新）在整条状态栏的最左边，面板却按右对齐弹出，380px 宽的列表整个跑到屏幕左边——实测面板左边在 x=-187、搜索框在 x=-174，点「插件」像没反应。现在改成从左边缘弹出，宽度按窗口夹紧，1500px 窗口里面板落在 x=141、搜索框 x=154，700px 窄窗口也整个在屏内；「更新」那个 320px 面板同样修好。回归用例读 `desktop.css` 断言这两条规则还在。
- 回归用例：`src/core/update.test.ts` 新增 3 例（过期清单被 GitHub 覆盖、两侧都不过期时保留服务器答案、同版本只有 GitHub 有包时用它），该文件 27 例全过；`docs/release.md` 补了「清单过期不再冒充最新」与打 tag 自动发布清单两段。

## 2.9.6 — 2026-11-23

- 桌面版编辑器打开 `.md` 终于能看了：标题栏多一个「预览 / 编辑」按钮，只在这七种后缀出现（`md` / `markdown` / `mdx` / `mdown` / `mkd` / `mdwn`），`⌘/Ctrl+Shift+V` 切换，和 VS Code 的 Markdown 预览同一个键位；裸 `⌘V` 仍然只是粘贴。按钮显示的是「切过去的那个模式」，预览时泛蓝高亮。
- 预览读的是编辑缓冲区而不是磁盘文件：没保存的改动边打边渲染，切标签会重置回编辑态，不会在 `.ts` 标签上留下一份过期的 HTML。
- README 里那些 GitHub 仍接受的 HTML（居中 `<div>`、`<sub>` 说明、`<img>` 图标、表格里的 `<br>`）不再原样显示成标签：预览前先做一遍归一化——`<img>`/`<a>` 转成 markdown、注释与 `<script>`/`<style>` 整块丢掉、其余标签剥掉留文字，`<br>` 在表格里变成空格以免把一行拆断。任务列表的 `- [x]` / `- [ ]` 渲染成 ☑ / ☐。
- 文档版式按阅读排，不再套聊天气泡：860px 居中栏、h1/h2 带分隔线、代码块沿用同一个 tokenizer 上色、表格横向滚动、引用块留左侧色条、链接用蓝色并可下划线。空文件显示提示文案，而不是一片空白。
- `![alt](path)` 现在渲染成带图标的链接（`🖼 alt`）：web 地址新开窗口，项目内路径点开就是文件——预览 README 时不会再留一对多余的方括号。这条对聊天里的 markdown 同样生效；渲染依旧是纯 React 元素，没有 `dangerouslySetInnerHTML`。
- 新增 `desktop-markdown.ts`（后缀判定 `isMarkdownPath`、按钮文案 `previewAction`、快捷键 `isPreviewShortcut`）与 `desktop-markdown-view.tsx`；`desktop-markdown.test.tsx` 7 个用例覆盖后缀、按钮状态、快捷键（明确拒绝裸 `⌘V`）、渲染、HTML 归一化、空文件与 CSS 版式，`markdown.test.tsx` 补了图片语法用例。
- 这一版同时带上上一轮没有单独发版的桌面插件商店（2.9.5 的改动一起进这一版）：可搜索的插件列表、安装/更新/卸载后技能直接落到 `~/.luban/skills/` 并被 `list_skills` 立刻看到、目录五分钟缓存、装完不执行任何插件代码。
- 修的是「只能读源码」这件事本身：以前要看渲染效果得切到浏览器，现在同一个面板里 `⌘⇧V` 就够；检查和保存按钮在预览态照旧可用。

## 2.9.5 — 2026-11-23

- 桌面版新增**插件商店**:状态栏「插件」按钮打开一个可搜索的列表,输入即过滤(搜索在服务端做,目录 5 分钟缓存,敲键盘不重复拉取),每行一个技能包,按钮是安装 / 更新 / 卸载。插件就是一组 `SKILL.md`,装进 `~/.luban/skills/` 后 `list_skills` 立刻能看到,不用重启,也不执行任何代码。
- 新增 `src/core/plugins.ts`:目录读取(只走 https,回环地址例外)、按 `files[].sha256` 与字节数校验、先写 `<home>/.luban-plugin-<uuid>/` 再原子移动进 `skills/`(任何一步失败都不留半个技能)、`<home>/plugins.json` 记账(插件 id / 版本 / 安装时间 / skill 目录 / 每个文件哈希)。卸载只删账本里的目录,手写技能不受影响。
- `src/web/server.ts` 增加 `/api/plugins`(带 `q` 搜索与 `refresh=1`)、`/api/plugins/install`、`/api/plugins/uninstall`。目录读不到时仍返回 200 与已安装清单,面板照旧能卸载,并说明是哪个 URL 没应答——离线不是错误状态。
- 目录地址可换:`config.json` 的 `plugins.registry` 或环境变量 `LUBAN_PLUGIN_REGISTRY`,面板会显示正在用的地址,方便内网镜像。空的 `plugins.registry` 走内置默认目录。
- 新增仓库 `holylong/luban-plugins` 存 `plugins.json` 与插件源码:三个示例插件(中文提交信息、SQL 与索引审阅、更新日志撰写),`scripts/build-index.mjs` 从 `plugins/<id>/` 重新生成目录并重算全部 sha256,CI 跑 `--check`,目录与内容不一致就拒绝合并。`docs/plugins.md` 写了格式、发布流程和安全边界。
- 校验是认真做的:`src/core/plugins.test.ts` 11 个用例覆盖搜索(名称/描述/标签/大小写/空查询)、安装落盘与账本、重新安装覆盖旧版本、升级判定、哈希不符拒绝且不落盘、`../` 路径逃逸与超大文件拒绝、卸载只删自己的技能、目录重复 id 报错;`src/web/client/desktop-plugins.test.tsx` 8 个用例覆盖列表文案、已安装/可更新徽标、离线时保留卸载、空搜索结果、按钮忙碌态。另用本地 HTTP 目录跑了真实安装链路:3 个插件装好、搜索「中文」命中 1 个、卸载后目录消失、手改一个字节后安装被 sha256 拦下且 `skills/` 未创建。

## 2.9.4 — 2026-11-23

- 修掉打包版桌面「检查更新 / 升级」必崩的问题：`apps/desktop/main.cjs` 用 `__dirname/../../dist/core` 去动态 import `update.js`。开发检出里这正好是 `dist/core`，但在 `.app` 里 Electron 入口在 `Contents/Resources/app/desktop`、编译产物在 `Contents/Resources/luban/dist`，两者毫无关系——于是点升级直接报 `Cannot find module '/Applications/luban.app/Contents/Resources/dist/core/update.js'`。改为 `const cliDist = dirname(cli)`（`cli` 已经是 `LUBAN_CLI` 或开发检出的 `dist/cli.js`），macOS 入口桩、Windows `.cmd`、Linux 启动脚本本来都会设置 `LUBAN_CLI`，三个平台一次修好，开发检出行为不变。
- 托盘图标、窗口图标原本就按 `dirname(cli)` 找 `web-ui/`，现在更新菜单和它们共用 `cliDist` 一个来源，不再有第二套「dist 在哪」的推断。
- `src/desktop/packaging-names.test.ts` 增加回归用例：`main.cjs` 必须用 `pathToFileURL(cliDist)`，且不允许再出现 `resolve(__dirname, "../../dist/core")`。
- 注意：2.9.3 及更早的桌面版菜单自己就是坏的，升级提示点不开，需要手动下载 2.9.4 覆盖安装一次；之后的版本可以正常在应用内升级。

## 2.9.3 — 2026-11-23

- 用 `docs/demo-prompt.md` 的英文原文重测本机横评（`deepseek/deepseek-flash`，同一台 Mac），README 中英双版的 luban 一列与截图全部换成 2.9.3 的实测：24.0 分钟（1442 s）、128 次模型调用 / 124 步、输入 11,598,594、命中 11,044,224（95.2%）、输出 152,759（推理 94,471）、73 KB / 1,872 行 / 58 个函数 / 25 类道具、边缘密度 0.0237（1280×800，0 console error）、45.8 万个方块。
- 缓存修复的效果第一次在完整任务上兑现：同一任务的 2.9.1 是 86%，2.9.3 是 95.2%，11.6M 输入里只有 554,370 按全价计费；124 步里还夹着 4 次压缩，压缩后的前缀也没有把命中率打崩。
- 也把变慢的部分写清楚：这轮不是最快的一轮（旧版 45 次调用 / 700 s）。`render_html` 自检反复报「画面偏薄」，模型就一直重渲重测补道具，调用数翻到 128 次——换来三家里最密的画面（0.0237 对 codex 0.0220 / dsh 0.0208）与最多的道具类型（25 对 19 / 21）。README 里明确写了「2.9.1 快而略薄，2.9.3 把时间花在画面本身，缓存修复让这种迭代变便宜」。
- 表格新增「全价计费的输入」一行（输入减去命中），因为输入 token 总数掩盖了谁真的在付钱；codex/dsh 两列沿用上一轮同机同版本数据，并在口径说明里写明。

## 2.9.2 — 2026-11-23

- 修掉最伤缓存的一个前缀破坏点：三个传输层（Chat Completions、Responses、Anthropic）原来把所有 system 消息拼成同一条开头消息，而 `update_plan` 把计划记录写在开头之后、`record_verification` 追加在末尾——两者都被折进了开头，于是**一条验证记录就让整个对话从缓存里掉出去**。新增 `src/core/wire.ts` 的 `splitPrompt`：只有稳定开头（系统提示、命中的 AGENTS.md、压缩摘要）进开头消息，`[luban …]` 记录改到请求尾部以用户消息追加。
- 实测（同一个 `deepseek-flash`、`rename-cross-file` 场景、交互日志逐请求比对）：修复前 `record_verification` 之后的请求前缀命中 47.3%，provider 上报 `cached=1152/8538`（13.5%）；修复后同样带验证记录的请求 `cached=8192/8475`（96.7%），整个场景每一步都是 100% 前缀追加。综合 12 步、4 次计划更新 + 2 次验证记录的构造测量，可复用前缀 85.7% → 95.0%。
- Anthropic 客户端补上显式缓存断点：固定开头和对话最后一条各打一个 `cache_control: ephemeral`，此前一条断点都没有，Claude 系模型只能靠运气命中；顺带把空的 system 从请求体里省掉。
- 新增 `wire.test.ts`（计划/验证记录不进开头、未知名 `[luban …]` 记录也不进、运行变长时前缀逐字节不变）并改写 `openai.test.ts` 里断言「合并所有 system」的旧用例，`anthropic.test.ts` 增加断点与尾部记录的断言。
- README 横评里的「luban 缓存 86%」是修复前测的，下一次横评会更新；这一版没有重跑那 700 秒的单次基准，避免在没有新数据时改数字。

## 2.9.1 — 2026-11-23

- README 新增「实测：同一个模型、同一个任务」：把 luban / codex-cli / dsh 三家的最终画面并排展示（`docs/assets/bench/`），并列出端到端耗时、模型调用次数、输入/输出 token、缓存命中率、产物结构、画面边缘密度与渲染复检结果。
- README 拆成双语：`README.md` 为英文默认版，`README.zh-CN.md` 是中文版，两版顶部互相切换；内容与横评数据同步。
- 数据取自同一台 Mac 串行跑的同一任务（体素宝塔花园），token 用各家运行时上报的官方计数：luban 耗时 700 s、输入 3.74M（缓存 86%）、输出 105,669；codex 906 s / 10.56M（98%）/ 126,819；dsh 2182 s / 18.32M（99.6%）/ 174,860。README 里同时标注了口径与「单次运行、方差未测」。

## 2.8.20 — 2026-11-23

- `thin` 的上界按参考画面校准到 0.0215（codex 0.0216–0.0220、dsh 0.0204–0.0208，两个视口实测），让「无告警」真的等于「和参考画面同级」，而不是连参考画面自己都会被判 `thin`。
- 效果（同一 `deepseek-flash`、同一提示词）：luban19 1252 行 / 42.4KB / 函数 50 / 道具 18，边缘密度 0.0235（1440×900）、0.0233（1280×800）；codex 2066 行 / 函数 46 / 道具 19 / 0.0220，dsh 2446 行 / 函数 68 / 道具 21 / 0.0208；上一轮 luban18 只有 925 行 / 函数 25 / 道具 15 / 0.0168。运行中它自己做了 A/B（`test-noshadow`/`test-nosun`）并逐轮把边缘密度从 0.0194 推到 0.0232。
- 仍承认的差距：字节数 42KB 对 76KB/89KB（codex/dsh 每个道具写得更啰嗦），饱和度 0.38 对 codex 的 0.64。

## 2.8.19 — 2026-11-22

- `pixels` 增加分层判定：`sparse`（<0.020，明显只有几块大平面）与新的 `thin`（0.020–0.024，能读但不细腻，0.021–0.022 才是参考画面的水平），并把「一直加道具但数字不动」的诊断写进告警：换构图——拉近相机、加背景层、缩小体素、给每个表面加细节。
- 系统提示加规则 2c：检查仍在抱怨时不许收工；连续两轮数字几乎不动说明问题在构图而非数量，换构图再测，结束时报告最终数值。规则 2b 保留。
- 起因：同一模型下 luban18 连渲染 12 次，边缘密度 0.0105→0.0173 就停在 `sparse` 上收工，而 codex/dsh 是 0.0218/0.0208。数据说明光靠「多加道具」这条指令会平台化，必须换构图和体素精度。

## 2.8.18 — 2026-11-22

- 系统提示新增规则 2b：交付物是「生成出来的东西」（页面、3D 场景、UI、文档、数据集）时，深度本身就是交付物——第一遍就写完整版本，检查通过只是下限不是终点，只有用户要求更少时才做减法。
- `render_html` 的 `sparse` 阈值 0.018 → 0.020，正好卡在参考画面前面（codex 0.0219、dsh 0.0208 通过，luban 0.0147/0.0182 报警），告警文案补上「达标只是下限，要按场景本身是否完整来判断是否收工」。
- 排查结论（同一个 deepseek-flash 直连 API 实测）：单次响应最大 token 预算 128000 会被接受，模型自己写到 8866 token / 29.7KB 就 `finish=stop`；`--thinking off` 会把输出压到 14.5KB/423 行、用时 67s。所以体积下滑不是「没开思考」或「加了输出上限」，而是 2.8.14 起我用 render_html 自检把「一次写完整」的驱动换成了「通过检查就停」——检查项又很容易满足。这一版把停止条件改回内容本身。

## 2.8.17 — 2026-11-22

- `render_html` 的 `pixels` 增加 `edgeDensity`（480×300 原生采样下的邻域对比度）与新告警 `sparse`：画面只有「几块大平面」时直接点名要补什么（栏杆、石块、鸟居、石灯、竹子、雕像、飞鸟、小船），并提醒打散大平面、拉开物体高差。
- 阈值来自实测而非拍脑袋：luban 页面 0.014–0.015、codex 0.022、dsh 0.021，取中间 0.018。同时确认「亮度+饱和度」不足以衡量丰富度——三块大白板也能通过，这正是旧摘要对贫瘠画面报「无警告」的原因。
- 起因：用户指出新版产物虽然更快，但 HTML 从 2065 行量级掉到 685 行、元素明显变少。核查结果：函数数 22 对 codex 46 / dsh 65，缺 koi、鸟居、瓦片、栏杆、竹子等道具，边缘密度低 45%。测试补了「几块大平面要被判 sparse」和「120 个小方块不算 sparse」。

## 2.8.16 — 2026-11-22

- `render_html` 的 `pixels` 升级为「能代替眼睛」的摘要：调色板（5 色 + 占比）、平均饱和度、纯白/纯黑像素占比、3×3 区域亮度与主色，并给出人话 `warnings`（`blank`/`washed-out`/`clipped`/`desaturated`/`flat`/`low-detail`）；统计改用 96×54 采样，ASCII 图仍是 48×16。
- 新增 `render_html.probe`：在页面内求值一段 JS 并返回 JSON，用来核对场景事实（`window.scene.children.length`、`instancedMesh.count`）而不是猜自己写的代码。
- 起因是横向对比：codex 的天空 `#171022`（亮度 20）、luban 是 `#dfeaf3`（231）配 `#e4eef5` 的雾，画面平均亮度 182–194 对 104，饱和度 0.15–0.20 对 0.64；旧摘要只说「不空白」，模型没有可依据的证据。现在同样的四张图跑一遍，luban 两张得到 `washed-out`，codex/dsh 干净——告警和人的判断一致。

## 2.8.15 — 2026-11-22

- `render_html` 增加 `pixels` 文字摘要：平均亮度、distinct 颜色数、最大色块占比、`blank` 标记和 48×16 的 ASCII 明暗图。原因是无视觉模型拿到截图会想尽办法「看」它——三次基线里它试过 `chafa`/`img2txt`/`ollama`，还把 base64 贴给视觉接口，两次 41 秒的 bash 全白费。摘要在页面内用 2D canvas 对截图降采样算出（WebGL 画布直接回读常是空白，截图不会），不需要图像库；`blank` 能一眼看出「什么都没画」和「画了但一片死白」。

## 2.8.14 — 2026-11-22

- 新增 `render_html` 工具：一次调用把本地 HTML（或 URL）丢进无头 Chrome，返回截图、console 错误、未捕获异常、失败请求和 canvas/WebGL 状态。此前要「看看页面对不对」，模型只能用 `bash` 自己拼 Chrome + DevTools + 截图脚本——体素花园实测这一项吃掉 893s 里的 244s（115s/45s/42s/42s 四次长命令）；换成这个工具同一页面 3.4 秒返回，画布 1280×800、WebGL 可用、错误一条不少。零依赖：Node 自带 WebSocket 直连 CDP；按 `LUBAN_CHROME` → Chrome/Chromium/Edge/Brave 顺序找浏览器，找不到明确报错。截图存 `<workspace>/.luban/render/`，无视觉能力的模型会被告知「只报路径和错误，别描述像素」。

## 2.8.13 — 2026-11-22

- 修好思考开关对 DeepSeek 别名无效的问题：判定条件原本只认 `deepseek-v3/v4/chat/reasoner`，`deepseek-flash`、`deepseek-flash-0731` 这类实际在用的别名一个字段都发不出去，`model.thinking` 和自动思考策略对它们等于没有。现在凡 `deepseek-*`（`deepseek-chat` / `-coder` 除外）都按原生 `thinking.type` 下发，`deepseek-flash` 的 `thinking: {type:"disabled"}` 实测让同一请求从 5.9s 降到 1.1s、推理 token 664→0。
- 无头运行结束时的摘要多一行诊断：思考 token 占输出超过 30% 时，一并给出最慢的一次调用是第几次、耗时、占模型时间多少。慢的时候不用再手动翻 40 多次调用去猜是谁拖的。
- 顺带补上 `--planning off|auto|always`：文档一直写着这个参数，但只有 `luban acp` 有，主命令和 `--prompt` 从没接过（`loadConfig` 早就支持 `planning`），现在主命令一并接受并透传。
- 新增一次性思考开关：`luban ... --thinking on|off|auto`（等价于临时覆盖 `model.thinking`，不写回配置），`loadConfig({ thinking })` 走 `parseThinkingOption()`，`on/off/auto` 之外的值一律按 auto 处理。用来对同一任务做 A/B，不必改配置文件。
- 文档把「`max_tokens` 封顶 32000」这条过期说明改掉：默认与硬顶都是 128000，按模型声明与配置取小，被拒时逐级减半并记住该 `provider/model` 的实际上限。`--thinking` 与体素花园实测（44 步 454s、模型 392s、工具 60s、首轮 145s 烧掉 24.6K 推理）一并写进 `docs/reference.md`，并说明关掉思考会让模型退化成重复 bash 循环（实测 16 步后被重复调用保护中止）。
- 测试：`model-controls.test.ts` 增加 `deepseek-flash` 可关、`deepseek-chat` 不动的断言，以及 `--thinking off/on/auto` 覆盖配置的用例。

## 2.8.12 — 2026-11-22

- 输出预算默认值提到最大：`model.max_tokens` 的默认从 64000 改成 128000（等于客户端硬顶 `ABSOLUTE_MAX_OUTPUT_TOKENS`），`src/core/default-config.ts` 的首启模板同步改成 128000，Anthropic 客户端的默认上限也从 32000 提到 128000。此前装了 luban 却没改过配置的人，拿到的是 64K（Anthropic 32K）预算，推理型模型把预算烧在推理上、正文 0 字，任务连挂 6 次就是这么来的——装上就是上限，不用先踩坑再去调大。
- 上限再高也不会每轮都被拒：`noteOutputCeiling()` 记住某个 `provider/model` 实际接受的预算（减半重试成功后写入本进程的 map），`modelOutputCeiling()` 之后直接按它发送。第一轮 128K→64K→…→4K 试出来，第二轮就从 4K 开始，不会重复付同样的代价；`resetOutputCeilings()` 供测试和切换模型时清空。
- 本机 `~/.luban/config.json` 同时修了三处：`model.max_tokens` 32768→128000（就是那次失败的根源）、`providers.deepseek.base_url` 由 `https://api.deepseek.com/chat/completions` 改成 `https://api.deepseek.com/v1`（前者能工作但依赖客户端的容错拼接）、`node.capabilities` 的 `linux` 改成 `darwin`（这台是 macOS，标成 linux 会让 mesh 把 Linux 专用的活派过来）。改前已备份为 `config.json.bak-<时间戳>`。
- 文档：`docs/default-config.md`、`docs/reference.md` 说明默认值等于客户端上限、以及减半后记住上限的行为。
- 测试：`config.test.ts` / `default-config.test.ts` 的默认值断言改为 128000，`openai.test.ts` 增加「减半成功后下一轮直接按 4096 发送」。

## 2.8.11 — 2026-11-22

- 缓存命中终于被统计：OpenAI 兼容、Responses、Anthropic 三类客户端此前只读 `prompt_tokens` / `completion_tokens`，把各家报的缓存字段全丢掉，所以会话里 `cached` 永远是空、状态栏从不显示缓存比例、横评里 luban 的「缓存 0」其实是没有统计而不是没有命中。实际用 `deepseek-flash` 直连验证：同一段 6k token 前缀第二次调用返回 `prompt_cache_hit_tokens: 5888`（`prompt_tokens_details.cached_tokens` 同值）。
- 新增 `usageDetails()`（`src/core/openai.ts`）统一解析四种写法：`prompt_cache_hit_tokens`（DeepSeek）、`prompt_tokens_details.cached_tokens`（OpenAI / DeepSeek）、`input_tokens_details.cached_tokens`（Responses）、`cache_read_input_tokens`（Anthropic），顺带解析 `completion_tokens_details.reasoning_tokens` / `output_tokens_details.reasoning_tokens`。流式路径按「取较大值」合并迟到的 usage 分片，中断保留内容时的 usage 也带上这两个字段。
- 结果流向：会话 `performance.requests[].usage.cached/reasoning`、TUI 状态栏的 `cache NN%`、`/usage` 的「缓存」一行、`npm run bench` 的 token 统计都已生效；匿名用量账本（`usage-stats.json`）结构不变，不为此新增上传字段。
- 实测：修完跑一个 4 步小任务，会话里逐条记录为 `cached 1024 / 7808 / 7936 / 1024`，`reasoning 123` —— 修复前这些字段一个都不存在。
- 测试：`openai.test.ts` 加 2 例（四种方言的 `usageDetails` 解析、流式 usage 分片带出 `cached` + `reasoning`）。

## 2.8.10 — 2026-11-22

- 命令开销从「每次 3.6 秒」降到「首次之后 5 毫秒」：luban 原来每条 bash 命令都执行 `/bin/bash -lc`，让登录 shell 重新 source 一遍用户 profile（本机 `~/.bash_profile` 跑一次 3.58s，而 `/bin/zsh -lc` 只要 0.03s）。现在工具创建时在后台抓取一次登录环境（`command env -0`，2.4s，正好和第一轮模型调用重叠），之后用 `-c` 执行并把抓到的 PATH/nvm/brew shellenv 合并进进程环境；抓不到就继续用 `-lc`，行为不变。实测 `createTools` 后连跑 6 条命令：`{ first: 2361, avgCached: 5 }` 毫秒。同一个任务 88 条命令因此省下约 5 分钟。
- `max_tokens` 不再对所有 provider 一刀切：模型能力里新增 `capabilities.max_output_tokens`，OpenAI / Responses / Anthropic 客户端与任务输出预算都按「配置值、模型上限、客户端硬顶」三者取小；Anthropic 仍默认 32000，但可以显式抬高。
- 未知 provider 的上限靠自愈：请求被 400 拒绝且报文里点名 `max_tokens`（`maximum ... tokens`、`context length` 等同义写法也算）时，luban 把预算减半重试，最多 6 次（64K→32K→16K→8K→4K），并在 TUI 里提示换了多少；之前这种情况直接把任务判死。
- 提示文案里的「max_tokens 在 luban 中最高为 32000」改为按当前模型的实际可达预算显示，`docs/reference.md` 补上 `capabilities.max_output_tokens` 与减半重试的说明。
- 测试：`openai.test.ts` 加 2 例（配置上限生效、400 拒绝后 64000→4096 逐次减半并成功），`config.test.ts` 加 1 例（`capabilities.max_output_tokens` 进入模型能力，未声明时保持 undefined），`tools.test.ts` 加 1 例（抓到登录环境后改用 `-c`，未抓到时仍是 `-lc`）。
- 实跑（同一台机、同一个单文件体素场景、`deepseek/deepseek-flash`）：2.8.9 跑了 4341.4s（99 步 / 101 次调用，工具累计 3129.7s，其中 88 条 bash 共 2649.7s）；2.8.10 跑 1835.9s（47 步 / 47 次调用，工具累计 905.8s）——产物 `voxel-pagoda.html` 54990 字节，headless Chrome 复检 0 console error，canvas 1280×800。

## 2.8.9 — 2026-11-22

- 修「模型推理耗尽输出预算」直接把任务判死：一轮回复被输出上限截断、推理非空而正文为空时，luban 原来只尝试一次「降低推理 + 保持预算」，对不认识 thinking 控制的模型（如 `deepseek-flash`）这一步等于是空操作，于是立刻以「当前参数已无可自动调整空间」结束。现在这种情形会把**本轮输出预算按 2 倍递增**重试（至少 64000，最多两次），并按预算增幅放大请求超时（最多 4 倍），已完成的工具操作保留。
- 写死的 32000 单轮输出上限改为 128000 硬顶（`src/core/openai.ts` 新增 `ABSOLUTE_MAX_OUTPUT_TOKENS`）：OpenAI 与 Responses 客户端按「配置 `max_tokens` 与硬顶取小」，Anthropic 仍用自己那套 32000 上限。之前配置默认 64000、用户配 32768，实际一律被夹到 32000——调大 `max_tokens` 完全没有效果。
- 预算不能无限长：初始与递增后的输出预算都不超过上下文窗口的一半（`contextWindow / 2`），否则压缩后的输入预算会被输出预留吃成负数，任务改报 `Context budget exceeded`。窗口 128K 的模型因此最多到 64000，262144 的窗口能走到 128000。
- 测试：`model-controls.test.ts` 加 2 例（按预算增幅放大超时、预算不变时不重试），`agent-recovery.test.ts` 加 1 例（推理吃满预算后 32K→64K→128K 依次重试，仍截断时报出可达预算）。红绿证明——把递增改回原样后这 1 例立即变红。
- 实跑验证（`deepseek/deepseek-flash`，同一个单文件 HTML 体素场景任务）：修复前连续 6 次都在第 4 分钟以「推理 9.9 万字 / 正文 0 字」中止；修复后一次跑通——72.4 分钟、99 步 / 101 次模型调用、输入 12,880,276 / 输出 228,540 token、产物 69,224 字节，产物经 headless Chrome 复检 0 console error。其中第 1 次回复仍卡在 32,768，抬到 64,000 后第 3 次一次写出 50,781 token 的正文——旧上限下这两次都不可能发生。
- 回归：`agent.test.ts` 里 4 个 starvation 用例按新契约更新（预算已到窗口上限时不重放、starve 后请求体是 64,000、原生 thinking 关闭与预算翻倍同时上线），修复后 `src/core` 单测仅剩 6 个与本次无关的历史失败（`cli-entry` 3、`agent-compaction` 3，在 HEAD 上同样失败）。

## 2.8.8 — 2026-11-21

- 新增真实模型评测台 `npm run bench`（`src/evals/bench.ts` + `src/evals/bench-cli.ts`）：8 个场景覆盖五个方面——正确性（`bugfix-tested` / `rename-cross-file` / `fix-failing-spec` / `feature-cli`）、验证纪律、安全（`ask-readonly` 只读拒写、`injection-resist` 抵抗文件内注入）、诚实性（`honest-blocked`：连不上的目标不许假装跑通）、失败恢复（`recovery`：ENOENT 修复后产物要真的生成）。与已有的 `npm run eval` 分工明确：那个用脚本回放验证工具接线（0 成本、进 CI），这个用真实模型测"活能不能干完、干对、说真话"。
- 打分全部来自外部 ground truth，没有一项由模型自评：受保护文件是否字节不变、该出现/不该出现的产物、**harness 自己执行命令的退出码与输出**（agent 说什么都不算）、以及 transcript（`update_plan` 是否早于第一次改文件、是否记录过 `passed` 的 `record_verification`、是否给一个不可能通过的命令记了 passed）。单场景得分 = 通过项/总项，另出五方面分项、discipline 与 efficiency（每任务 model calls / 工具调用 / 步数 / 秒 / token，token 取自 `RunMetrics.requests`）。
- CLI 支持 `--model`、`--only`、`--repeat`、`--max-steps`、`--timeout`、`--out`、`--list`；报告写 `bench-runs/<时间戳>/report.md` 与 `report.json`（已加入 `.gitignore`），退出码仅在全部场景满分时为 0。评测运行时强制隔离：清空 MCP/LSP 服务器、关闭工作区外访问、关闭电脑操控，避免评测台启动用户自己的服务或动到桌面。
- 新增 `docs/agent-eval.md`：三层评测（确定性 harness 测试 / 真实模型评测台 / 公开 benchmark）、公开 benchmark 对照（结论是 SWE-bench-Lite/Verified 与 Terminal-Bench 适合对外比较，GAIA/OSWorld/MLE-bench 与 luban 形态不匹配）、打分口径、读表方式、局限，以及用 `luban -p` 接 SWE-bench/Terminal-Bench 的适配方法；`docs/reference.md` 的开发验证与项目结构补上 `npm run bench` 与 `evals/` 的说明。
- 单测 9 例（`src/evals/bench.test.ts`）：场景 id 唯一且覆盖各方面、每个场景都必须有至少一条不依赖模型措辞的客观检查、honesty 场景必须锁定 `run.mjs` 并禁止假 pass、计划晚于首次编辑要判红、声称通过的命令必须被抓出来、harness 命令失败要带退出码、分项与效率聚合、报告表要列出失败项。
- 实跑（`deepseek/deepseek-flash`，单次）：总分 0.98，full-pass 7/8，验证 3/3；唯一红项是 `feature-cli` 的 plan-before-edit——它写对了 `list.mjs`（退出码 0/2 与输出全对）却一次 `update_plan` 都没调用。效率 5.6 次模型调用 / 6.3 次工具调用 / 13.6 秒每任务。结果表写进 `docs/agent-eval.md`。
- 验证：`npx vitest run src/evals/bench.test.ts` 9 例全绿；`npm run typecheck` 通过；`npm run bench` 在真实模型上跑完 8 个场景并产出 `report.md`（`bench-runs/first-run/`）。

## 2.8.7 — 2026-11-21

- 修 `luban daemon start` 在正常安装下直接失败：`Error: 常驻服务需要编译后的 CLI（dist/cli.js）：先 npm run build`。原因不是没编译，而是 `daemonEntry()` 直接拿 `process.argv[1]` 判断「是不是编译后的 CLI」——npm 把可执行文件装成符号链接（`bin/luban` → `../lib/node_modules/luban/dist/cli.js`），Node 保留的是 `…/bin/luban` 这个别名，没有 `.js` 后缀，于是明明装着 dist/cli.js 也被判成开发入口。现在先 `realpath` 解析启动器再看扩展名，脱离的子进程拿到的就是真实的 `dist/cli.js`。
- 同一个根因在另外两处也埋着：`ensureBotWorker()` 用 `/(?:^|[\\/])cli\.(?:js|mjs)$/` 判断能不能起队列 worker，符号链接安装时会静默返回 `no-entry`，于是一个提醒都不会响；`luban bot service` 打印 LaunchAgent 时同样以 `argv[1].endsWith(".js")` 为准。三处统一改用新的 `src/core/cli-entry.ts`（`resolveCliPath` / `compiledCliEntry`）：跟随符号链接链，解析不到时保留原路径，开发入口（`src/cli.tsx`）与测试运行器仍被拒绝。
- 新增回归测试 7 例：`src/core/cli-entry.test.ts` 5 例（npm 式符号链接、链接链、普通编译路径、开发入口/空入口、解析不到的路径保持原样），`src/web/daemon.test.ts` 加「接受 npm 安装的符号链接启动器」，`src/core/remind.test.ts` 加「符号链接启动器仍能起 worker」。红绿证明——把 `resolveCliPath` 改成直接返回入参后 4 例（cli-entry 2 例、remind 1 例、daemon 1 例）立即变红；把 `daemonEntry` 改回直读 `argv[1]` 时 daemon 那一例同样变红，恢复后 35 例全绿。
- 验证：`npm run build` + `tsc -p tsconfig.json --noEmit` 通过；`npx vitest run src/core/cli-entry.test.ts src/web/daemon.test.ts src/core/remind.test.ts` 35 例全绿；真实的全局符号链接 `luban`（`…/node-v22.19.0-linux-x64/bin/luban`）现在 `luban daemon start` 成功启动，`ps` 显示子进程是 `node …/agi/luban/dist/cli.js web … --daemon-child`，`luban daemon status` 报「运行中」并列出 2 个项目。

## 2.8.6 — 2026-11-21

- 真机验证（Android 14，1220×2712）把手机接到生产中继上的真实账户跑了一遍，修掉四个只在真数据上出现的问题。
- **实时执行永远停在「执行中 · 0%」**：`/api/jobs/{id}/stream` 返回的 `complete` 只表示「回放缓冲区仍覆盖 `since`」（首次轮询 `since=0` 时恒为 `true`），手机端却把它当成「任务已结束」，于是第一次轮询就把 `liveRunning` 置假并停止刷新。现在只有 `job.status` 是 `done|failed|cancelled|paused` 才算结束，`events.complete` 不再参与判断。
- **轮询会静默停摆**：原来下一次轮询只在上一次「成功且有结果」的分支里安排，任何一次失败、异常或回调被页面换代丢弃，循环就断掉且界面无提示。改成在 `finally` 里重新排程，入口守卫 `token/background/!liveRunning` 负责在任务结束后收尾，失败时界面显示「连接中断，正在重连」（每 1.2s 重试）。
- 大会话首读超时：`Api` 的连接超时 9s→12s、读超时 20s→45s。真机上 215 条记录、740KB 的会话经中继中转会超过 20s，界面给出「读取失败 timeout」，重试才成功。
- **冷启动第一屏谎报「0 台在线 / 共 0 台电脑」**：恢复页面与返回导航直接调用 `showDevices()`，把内存里的空列表画了出来，压根没发请求，只有手点 ⟳ 才回得来。现在本次会话还没成功读过一次 `/relay/nodes` 时先 `loadDevices()`（新增 `devicesLoaded` 标记，在线与离线缓存都算成功），账户真的没有电脑时仍显示「还没有电脑」，不会死循环刷新；`saveNodesCache()` 也不再让空回包抹掉离线缓存。
- 电脑卡片整张可点：之前只有底部「打开并派活」按钮能进电脑，点卡片上的电脑名字毫无反应。`machineCard` 加卡片级 `setOnClickListener`，卡片内的「任务 / 移除」仍各自处理点击。
- `scripts/android-navigation.test.mjs` 9→16 例（`npm run test:android`）：轮询必须在 `finally` 重新排程且结束只看 `job.status`、`showDevices` 先判断 `devicesLoaded` 再 `beginPage`、`saveNodesCache` 拒绝空列表、`machineCard` 有卡片级点击。红绿证明——把 `complete` 改回 `events.optBoolean("complete")`、删掉 `devicesLoaded` 守卫、删掉卡片点击，对应用例分别立即变红，恢复后 16 例全绿。
- 验证：`./gradlew assembleDebug testDebugUnitTest --offline` 通过（`MachineTest` 8 例，APK 1.0.9 / versionCode 10）；真机 `adb install -r` 连生产中继实测：登录后显示「3 台在线 / 共 3 台电脑」，`am force-stop` 重启后连按两次返回落到设备页、**不点 ⟳** 直接显示 3 台在线（修复前同一条路径就是那张 0 台截图），点 my-mac 卡片进入电脑、3 个工作区与各自会话正常加载，CaoDrawPad 里 6 天前 215 条记录的老会话可打开并渲染工具调用，派活后 `执行中 0%` → 8 秒内自动变 `已完成` 并显示结果 `fourth ok`。
- 另记：`*.trycloudflare.com` 在国内被 SNI 过滤（同一台手机能打开 `www.cloudflare.com`），所以手机连生产中继目前要走局域网 HTTP 反向代理（`/tmp/lan-relay-proxy.mjs`，`http://10.1.13.202:5399` → `https://39.105.10.158:443`，并把 cookie 的 `Secure` 去掉）。这是临时的联调通道，正式方案需要一个没被过滤的域名。

## 2.8.5 — 2026-11-20

- Android 原生版按 WebView 版的模型重做「电脑 → 工作区 → 会话」，重点是同一台电脑的工作区不再因为某个实例离线就打不开：新增 `Machine.servingNode(project)`，优先路由到拥有该路径的在线实例，其次是同机任意在线实例（同一 `~/.luban`，项目表相同，任一 daemon 都能打开本机工作区），最后才回落到离线的 owner。`openWorkspace`、会话列表、删除会话、派活（`sendDraft`）统一走这一个路由。
- 离线不再是死路：点开缓存里的会话若电脑不在线，`MainActivity.offlineTranscript` 给出「这台电脑现在没有连上中继」+ 重试 + 回到工作区，重试成功即变成真正的会话；电脑离线时输入框直接提示「恢复连接后可以继续派活」，不会白白发一次必失败的请求。设备卡片上的「查看缓存」仍可浏览上次同步的工作区与会话。
- 运行中的会话点开就是直播：`openLiveSession` 在该电脑各在线实例的任务里找 `session_id` 匹配且 `queued|pending|working` 的那一条，直接进实时流，而不是显示一份冻结的历史。
- 任务页改为整台电脑一条队列：合并各注册实例的 `/api/jobs` 去重后按创建时间倒序，某个实例掉线不影响其余任务显示；打开任务时按 `jobOwner` 路由到提交它的节点；任务详情新增「取消任务」（确认后调用 `/api/jobs/{id}/cancel`）。
- 审批与提问对齐 Web：审批卡显示工具、风险等级、参数，按钮为「允许本次 / 拒绝」，非一次性工具额外提供「本会话都允许 / 这个工具都允许」；提问的选项变成可点的按钮（原样回传 label），同时保留自由输入。
- 设置页新增模型卡片：显示当前模型、推理强度、提供方，可切换模型并在模型支持时选择推理强度（「默认」= 回落到模型默认），电脑离线时说明原因而不是给一个点不动的按钮。
- `Api` 补齐三个此前缺失的调用：`deleteDevice`（`DELETE /api/account/devices/{id}`）、`deleteSession`（`POST /api/sessions/{id}/delete?project=`）、`setModel`（`POST /api/model`，显式 `null` 表示默认强度）。
- 首次给这个模块加了可跑的测试：`app/src/test/java/dev/luban/app/MachineTest.java` 8 例（同机多实例归并成一张卡、owner 离线时路由到在线兄弟、owner 在线时优先 owner、整机离线时保留缓存工作区、重启后的实例接管同一工作区、实例间路径冲突时「显示的路径 = 实际服务的节点」、有会话在跑时标题为「正在工作」、machine id 推导），`app/build.gradle` 加 `junit:junit:4.13.2` 与真实 `org.json`（mockable android.jar 的桩会返回 null）。APK 版本 1.0.7（versionCode 8）。
- 另把 `scripts/android-navigation.test.mjs` 从 7 例扩到 13 例（`npm run test:android`）：工作区必须经 `servingNode` 路由、离线会话可重试、任务按整机聚合且可取消、运行中会话进实时流、审批提供「本会话/这个工具」、设置页可切模型；红绿证明——把 `openWorkspace` 改回 `route.nodeId` 后新增用例立即变红。
- 验证：`JAVA_HOME=<jdk21> ./gradlew assembleDebug --offline` 通过（`aapt2 dump badging` 显示 versionCode 8 / versionName 1.0.7）；`./gradlew testDebugUnitTest --offline` 8 例全绿；`npm run test:android` 13 例全绿；红绿证明——删掉 `servingNode` 的「在线兄弟」回退后 `routesAWorkspaceToALiveSiblingWhenItsOwnerIsOffline` 立即变红，恢复后全绿。没有真机/模拟器可用环境（`emulator -list-avds` 为空、无 system image），点击流程只做了结构断言，未做设备级验证。

## 2.8.4 — 2026-11-20

- 手机端「工作区与会话」不再列出空会话：`mobile-workspaces.tsx` 之前对 `/api/sessions` 带 `includeEmpty=1`，把每次 `luban` 启动时写下的「只有系统提示词、没有对话」的草稿记录也拉了回来，于是几乎每个工作区都挂着一串「未命名会话 · 0 条消息 · 尚未开始」，把真正要找的会话挤下去。桌面端会话列表本来就过滤这些草稿（`hasConversation`），手机端现在一致：不请求草稿，并在客户端再过滤一次 `messages === 0`（对接旧版 relay 时也一样），运行中的会话仍然保留。
- 验证：`src/web/client/mobile-workspaces.test.tsx` 18 例（新增「丢掉没有消息的草稿且不再请求 includeEmpty」「运行中的空会话仍显示」）；真实 Chromium 探针 `node scripts/probe-mobile-workspaces.cjs` 的 fixture 里塞了一条 `messages: 0` 的草稿，页面「original」卡片显示「1 个」、全文无「未命名会话」，320/390/430 无横向溢出，其余交互（打开第二台设备的会话、新工作区、确认删除）保持绿；`npx vitest run src/web/client` 51 文件 / 352 例通过；server+client typecheck 与 build 通过。

## 2.8.3 — 2026-11-20

- GitHub Actions 的 `verify` 剩下的红是环境差异不是断言差异：runner 会导出 `CI=true`，Ink 通过 `is-in-ci` 读到它后**根本不重绘主画面**（`onRender` 里直接 return，只在 unmount 时写最后一帧），所以所有基于「当前这一帧」的 TUI 断言在 CI 里拿到的是空字符串 —— `app-draft-undo.test.tsx` 7 例全红，「Matcher did not succeed in time / expected '' to contain 'previous answer'」。
- 新增 `src/test-setup.ts` 并在 `vitest.config.ts` 里作为 `setupFiles` 注册：在测试文件导入 `ink` 之前删掉 `CI` / `CONTINUOUS_INTEGRATION`（`is-in-ci` 是在首次 import 时快照 env 的，晚删无效）。这些 TUI 测试本来就给 Ink 传假 TTY、用按键驱动，要的就是交互式渲染路径；真实 CLI 在 CI 里的行为不受影响。
- 验证：与 runner 同构的 Linux（2 核、node 22.20.0、装了 zip、非 `/tmp` 检出、`CI=true TZ=UTC`）整套 `vitest run --retry=2`：226 文件通过 / 2 跳过、1631 passed / 14 skipped、0 failed；本机 `CI=true npx vitest run src/ui/app-draft-undo.test.tsx` 由 0/7 变 7/7。

## 2.8.2 — 2026-11-20

- `src/core/update.test.ts` 里两例安装用例要用系统 `zip` 命令造归档，缺这个命令的环境（精简容器、Windows 开发机）会以未捕获的 `spawn zip ENOENT` 挂住 40s 再报超时。改成用 `spawnSync("zip", ["-v"])` 探测，缺失时 `it.skipIf` 跳过；GitHub runner 与装了 zip 的机器行为不变。
- 验证：与 GitHub Actions `verify` 同构的环境（Linux、node 22.20.0、装了 zip、非 `/tmp` 检出）跑整套 `vitest run --retry=2`：226 个文件通过 / 2 个跳过、1631 passed / 14 skipped、0 failed（此前在 node 22.12 + 无 zip + `/tmp` 检出下 6 文件 16 例失败，逐个溯源都是环境差异：`node:sqlite` 需 ≥22.13、缺 `zip`、`/tmp` 检出被判为临时目录）。本机 `npx vitest run src/core/update.test.ts` 24/24。

## 2.8.1 — 2026-11-20

- 修掉 GitHub Actions `verify` 长期红剩下的几个测试，全部是字节/时序假设过窄，不是产品逻辑改动：
  - `src/ui/app-draft-undo.test.tsx`、`src/ui/app-mcp.test.tsx` 的 harness 用「最新的一个 stdout chunk」当一帧，还按标题文本 `workspace · v` 过滤。Ink 的一次重绘可能被拆成多个 chunk，chunk 里也可能只有标题行；标题在真实环境里还会多出 `⌁ 电脑操控`，过滤条件直接失配 → 断言拿到半帧或欢迎页，7 例与 3 例齐红。新增 `src/ui/test-frames.ts` 的 `readFrame()`：缓存原始输出尾部、在最后一个擦除标记处切开，按 chunk 边界无关的方式还原「当前屏幕上那一帧」。
  - `src/ui/app.test.tsx` 里两例同样按 `Auto` 过滤且只等 5s（含「模型超时后给出可继续的结论」），改成同一套帧还原并把首次等待放宽到 10s。
  - `src/ui/app-computer.test.tsx`、`src/web/computer-endpoint.test.ts` 在 Linux runner 上必然失败（`/computer on` 在非 darwin 就该拒绝），改成 `skipIf(!computerSupported())`；非 macOS 的拒绝行为仍由 `src/core/computer.test.ts` 覆盖。
  - `src/core/tools.test.ts` 的 stdin 用例固定 `setTimeout(120ms)` 后读回显，两核 runner 上 `cat` 还没被调度，改成 `expect.poll` 最多等 10s。
  - `src/desktop/packaging-names.test.ts` 断言脚本里出现 `"luban-app-1024.png"`，实际自 2.4.14 起图标名在 `APP_SPECS` 里（`icon: "luban-app-1024"`），扩展名由 `makeIcon()` 拼接，改为断言这两段。
- 验证：在 Linux（2 核 VPS，与 runner 同为 node 22）上 `vitest run` 这 6 个文件 = 4 passed / 2 skipped、25 passed / 3 skipped；本机 `npx vitest run src/ui` 里 app-draft-undo 7/7、app-mcp 3/3、app.test.tsx 13/13，剩余 4 例失败只在高并发跑整套 UI 时出现，单跑即绿（既有现象）。

## 2.7.20 — 2026-11-20

- 升级不再依赖发布服务器在线：`checkForUpdate` 在发布服务器不可达（隧道域名轮换、被网络拦截、502/超时）时，回退到 GitHub Releases（`GET /repos/holylong/luban/releases/latest`），按 `平台-架构-产品` 选资产、用 GitHub 给该资产公布的 `digest` 当 sha256，`update --json` 多一个 `source: "github"`。发布服务器正常回答时不发这次请求，`no-build` / `skipped` 一类的结论也不会被镜像覆盖。`LUBAN_GITHUB_REPO` 可以换成 fork。
- `artifactUrl` 接受清单里的绝对 URL：清单写 `https://github.com/…/releases/download/v2.7.19/…` 时就真的从 GitHub 下，而不是拼到发布服务器域名后面。下载仍然先写 `.part`、校验大小与 sha256 才改名。
- `npm run publish:release -- --github v2.7.19` 新增镜像发布：不本机上传任何文件，直接从 GitHub Release 读各资产的 `name`/`size`/`digest`，把 `url` 指向 GitHub 写进升级清单；资产缺少 digest 直接报错，不会发出无法校验的条目。`--github-repo` 覆盖仓库，`--kind` 仍然可用。
- 修 3 处让 GitHub Actions 的 `verify` 一直红的陈旧测试（打包与发布不受影响，但公开仓库的 CI 一直是红的）：`src/core/computer.test.ts` 的 `computer control` 整块与 `rim overlay` 里漏了 guard 的一条都在调用 macOS 原生 helper，改成 `describe.skipIf(process.platform !== "darwin")` 并补上平台 early-return；`src/runtime-env.test.ts` 断言 CLI 第一行是 `runtime-env`，而 2.3.12 起第一个 import 是 `terminal-boot`，改为断言它在前、且 `runtime-env` 早于任何 React import；`src/core/agent.test.ts` 仍在断言 2.5.11 之前的身份措辞，同步改成全局身份档案的说法，并让 `computer` 工具的存在性按平台判断。
- 验证：`npx vitest run src/core/update.test.ts`（24 例，含镜像回退、绝对 URL 下载、只在服务器不可达时才问 GitHub）；`node --test scripts/publish-release.test.mjs` 12 例、`node --test scripts/release.test.mjs` 7 例；三个改过的测试文件在 darwin 74/74 全绿，用临时 setup 把 `process.platform` 模拟成 linux 复跑 64 passed / 10 skipped。`luban-server` 侧 75 例（新增外部 URL 校验与「不上传也能发布」）。

## 2.7.19 — 2026-11-20

- 修 2.7.18 删掉 `plugins/` 之后打不出安装包：`scripts/package-{macos,linux,windows}.mjs` 里把 `plugins/` 当必选项复制，目录不存在时 `cpSync` 直接 ENOENT，`npm run release` 以 exit 1 结束。现在三处都先判断目录存在再复制（Windows 覆盖层早就是这么写的），没有插件的工作区照常打 cli / desktop / Creator。
- 验证：`npm run release` 重新出包（2.7.19），三个产物与 SHA256SUMS 齐全；`node --check` 三个打包脚本。

## 2.7.18 — 2026-11-20

- 删除 `plugins/stock-monitor/`（4 个文件：`SKILL.md`、`README.md`、`server.mjs`、`analysis.mjs`）和它的 `src/core/stock-plugin.test.ts`。它是一个可复制安装的示例场景（股票持仓监控：延迟行情 + 仓位诊断 + 自选扫描），不属于运行时功能，仓库里也没有任何代码引用它；MCP 桥接本身仍由 `src/core/mcp.test.ts` 覆盖。
- 同步清掉文档里的三处提及（`docs/reference.md` 的集成小节、插件小节、项目结构树）与 `package.json` `files` 白名单里的 `plugins` 条目，安装包不再带这个空目录。
- 验证：`npx vitest run src/core/mcp.test.ts`；`npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.client.json --noEmit && npm run build`；README/docs 相对链接与锚点校验（含被删掉的 `../plugins/stock-monitor/README.md` 不再出现）；`git grep stock-monitor` 无残留。

## 2.7.17 — 2026-11-20

- README 去掉「数据与隐私」整节：默认上报、中继、升级检查这些细节本来就写在 `docs/usage-stats.md`、`docs/relay.md`、`docs/reference.md` 里，首页重复一遍反而把安装和用法挤下去。`docs/opensource-checklist.md` 的「现状」同步改成指向那几篇。
- 「配置模型」重排：原来八条长 bullet 压成一张「想做的事 / 操作」表格（换模型、配 Key、Codex 账号、自建兼容接口），下面三段短的分别说内置 provider、Key 存在哪、首次启动写什么；细节仍指向 [详细参考](docs/reference.md#配置)。
- README 现在 126 行、9 个小节：亮点 / 安装 / 快速开始 / 常驻 Bot / 桌面工作台 / 配置模型 / 打包发布 / 更多 / 许可。
- 验证：README 与 docs 的相对链接、页内锚点逐条校验全部通过；`npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.client.json --noEmit && npm run build`。

## 2.7.16 — 2026-11-20

- README 只留「是什么、怎么用、数据去哪了」：`## 原始模型交互日志` 整节（JSON 开关示例 + 两段实现细节）移进 [详细参考](docs/reference.md#原始模型交互日志排查用)，README 的「数据与隐私」里一句话交代「默认关、只写本地」并给出链接。README 由 140 行降到 129 行，十个小节。
- 移动时顺手把长段落拆成分条（不记录的字段、可能含敏感信息、权限、只记实际读取字节、Codex 后端不在范围内），`docs/reference.md` 目录同步加一条。
- 验证：README/docs 相对链接与页内锚点逐条校验（含新锚点 `#原始模型交互日志排查用`）；`npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.client.json --noEmit && npm run build`。

## 2.7.15 — 2026-11-20

- 开源准备：新增 [MIT `LICENSE`](LICENSE)（`Copyright (c) 2026 luban contributors`），`package.json` 补上 `license`、`author`、`repository`、`homepage`、`bugs`、`keywords`。此前仓库没有任何许可证，默认等于「保留所有权利」，别人即使拿到代码也没有使用与分发的许可。
- README 新增「数据与隐私」：使用统计默认开启并上报到项目自建服务，写清上报字段（安装数、输入/输出 token、运行次数、按模型拆分、版本、平台、随机 `installId`）与**不上报**的内容（提示词、回复、文件路径、命令、密钥），以及 `usage_stats.enabled: false` / `LUBAN_USAGE_STATS=off` 关掉、`usage_stats.url` / `LUBAN_USAGE_STATS_URL` 换地址、`luban stats` 查本地账本；同时说明手机远控的中继只转发 HTTP 与 SSE、不保存对话，但 TLS 在中继处终结，运维方在链路上仍可能接触内容，可自行托管（`docs/relay.md`）；模型请求直达用户配置的 provider，升级检查走同一个统计服务并可用 `updates.check: false` 关闭。
- README 新增「许可」一节（MIT；第三方依赖与桌面包内的 Electron / Chromium 各自保留其许可证），顶部锚点导航同步。
- `docs/release.md` 里把本机绝对路径的说法改成「`luban-server` 仓库与 luban 检出在同一层目录」。
- 验证：`npm pkg get license author repository homepage bugs`；README 相对链接与页内锚点逐条校验；`npm pack --dry-run` 确认 tarball 自动带上 `LICENSE`；`npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.client.json --noEmit && npm run build`；`git grep` 复查全仓库已无个人路径、内网/公网 IP 与主机名（只剩 `docs/opensource-checklist.md` 里那条示例 grep 模式）。

## 2.7.14 — 2026-11-20

- 修桌面端「关掉标签后再点同一个文件打不开，得先点别的文件再点回来」：文件树的点击只是把路径写进 `store.file`，而编辑器用 `[store.file?.path]` 当加载依赖——同一个路径第二次点击时依赖没变，加载不会重跑，标签就再也回不来。现在 `openFile` 每次都把 `fileRequest` 加一（`src/web/client/store.ts`），编辑器按这个序号加载：关掉标签后点同一个文件会真的重新读盘，而已经打开的缓冲只会切到它的标签、不会被重读覆盖（未保存的修改不会被冲掉）。
- 新增 `npm run probe:desktop:editor`（`scripts/probe-desktop-editor.cjs`）：在真 Electron 窗口里点开 `alpha.txt` → 按标签上的 × 关掉（回到欢迎页）→ 再点同一个文件必须重新出现标签与内容 → 同一文件连点两次不能开出两个标签 → 关掉当前标签要切到剩下的那个，并且它还能再次打开。把依赖改回 `[store.file?.path]` 复跑，探针稳定停在「关掉后再点同一个文件打不开（需要先点别的文件）」，与用户报的现象一致。
- 验证：`npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.client.json --noEmit`；`npm run build`（2.7.14）；`npx vitest run src/web/client` 全部通过；`npm run probe:desktop:editor` 修复后 `open / closed / reopen / switch / final` 五步全绿，红跑见上条。

## 2.7.13 — 2026-11-20

- 新增自动升级：`src/core/update.ts` 是唯一一份检查/下载/替换实现，终端、网页工作台、桌面应用、造物主共用。启动时检测一次（`updates.check`，默认开），有新版才提示，选「稍后」本次不动、选「不再提醒」把版本号写进 `updates.skipped_version`，手动检查仍然会显示它。
- `luban update` 是新命令：`check`（默认）、`install`、`on` / `off`、`status`，`--json` 给脚本用。安装分两步：先下到 `~/.luban/updates` 并核对大小与 sha256，再由一个脱离的脚本等当前进程退出后替换目录，避免边跑边覆盖自己。
- 桌面应用：菜单「视图 → 检查更新」（主进程下载、替换 `.app` 并自动重启），底栏新增「更新」按钮——有新版时带蓝点并自动展开面板，含升级 / 稍后 / 不再提醒、「启动时检查更新」勾选框与「立即检查」；页面通过 IPC（`checkUpdate` / `installUpdate`）交给主进程，因为只有它能替换自己正在运行的包。
- 网页工作台（`luban web`）：同一面板走 `/api/update`、`/api/update/settings`、`/api/update/install`；检查结果缓存 10 分钟，`?refresh=1` 是「立即检查」。`/api/update` 即使开关关掉也返回设置本身，界面不会把「关了」显示成「连不上」。
- 新增升级服务器（`luban-server` 1.1.0，与统计口同一个进程）：`GET /api/update`、`GET /downloads/<file>`、`PUT /api/admin/artifact`、`POST /api/admin/release`；发布由 `npm run publish:release -- --version … --notes …` 完成（`scripts/publish-release.mjs`，本机算 sha256，服务器边收边校验，清单只会指向已校验的文件）。
- 桌面窗口原来只在网页工作台的左栏有更新入口，而 Electron 跑的是另一套三栏布局，所以装好的桌面版只有菜单能查更新。现在更新坞挂在底栏（「更新」按钮 + 有新版本时的蓝点 + 自动展开的面板），三栏任何一个视角都看得见；主进程启动时不再另弹一次原生对话框，启动检测由面板完成，菜单「视图 → 检查更新…」保留给手动检查。
- 升级服务器同一版本按 kind 合并安装包：先发 CLI 包、再单独发桌面 dmg 时，那次发布不会把已经发布的 CLI 那一行从清单里删掉（`luban-server` 1.1.0）。
- 一处不改三处不生效：`updates.check`、`updates.url`、`updates.skipped_version` 写在 `~/.luban/config.json`，`luban update on|off`、TUI 的选择、网页勾选框、桌面菜单写的是同一份配置；整机关闭用 `LUBAN_NO_UPDATE_CHECK=1`，换服务器用 `LUBAN_UPDATES_URL`。
- 文档：`docs/reference.md` 新增「升级与自动检测」，`docs/release.md` 新增「发布到升级服务器」；`luban-server` README/CHANGELOG 补齐接口、env 与发布流程。
- 验证：`npx vitest run src/core/update.test.ts src/web/update-endpoint.test.ts src/ui/app-update.test.tsx src/web/client/desktop-update.test.tsx` 全过（含「用户选稍后就不动」「不再提醒后手动仍可见」「桌面才提示会自动重启」「busy 时按钮全禁用」）；`node --test scripts/publish-release.test.mjs` 8 例（上传字节与清单 sha256 一致、令牌缺失不发请求、上传被拒不发清单）；`luban-server` 73 例（含「先发 cli 再发 desktop，同版本两个包都在」）。`npm run probe:desktop:update` 用真 Electron 窗口 + 假发行服务器走完整条路（开关关掉时面板说「已关闭」→ 勾上开关后报「新版本 2.9.9 可用」→ 不再提醒写进 `config.json` 的 `skipped_version` → 收起面板时蓝点在、不再提醒后蓝点消失 → 立即检查仍会问服务器 → 取消勾选写回 `check:false`）。真机：服务器升到 luban-server 1.1.0 后先发 cli、再单独发桌面 dmg（`--kind desktop` 没有把同版本的 cli 顶掉）；2.7.13 的 cli / desktop / creator 三个包已发布到线上（`/api/update` 三种 kind 都命中 2.7.13，清单 sha256 与本地一致，`/downloads/…` 200）。把线上 2.7.13 的 CLI 包解出来把版本改回 2.7.10，`luban update status` 显示「自动检测：开 + 服务器地址」，`luban update install` 从线上拉了 50.2 MB、校验 sha256 后换成新目录，再查是 current，`luban update off` 后状态变成关；`LUBAN_PROBE_APP` 指向 dmg 里打包好的 2.7.13 应用，同一套探针全绿（面板认出的当前版本是 2.7.13）。

## 2.7.11 — 2026-11-20

- Creator「最近任务」点开不再是一张只读的结果页：任务详情上半部是内容表单（任务内容、重复、时间、工作区、立即按新内容跑、取消），下半部是这段任务的对话，可以直接接着说。以前只能删掉重建，历史执行记录跟着一起丢。
- `luban bot edit <id>` 是新命令：改内容/工作区/排期并把任务按新内容重新排队，`runs.jsonl` 与 session 保留；`--once` 去掉循环，`--run-now` 排到队首。写入口仍是 CLI，Creator 只收集字段。
- 每次执行把会话 id 记进 `runs.jsonl`（`session` 字段），打开任务时据此 `drive --resume`：载入原来的 transcript、把新回合写回同一份记录，而不是另起一段。旧记录只有回答末尾的 `Session: <id>` 行，同样认。
- 没有 transcript 的任务照常可从任务原文开始；切换任务或关闭会话时主进程按 resume id 判断是否复用子进程，避免用 A 的上下文回答 B。
- 验证：`npm run smoke:creator` 在真 Electron 里点开已完成任务，断言任务内容载入、`resume` 等于它上次的 session、历史四条对话画出、保存后队列里的文案变成新内容；`apps/creator/bot.test.mjs` 9 例（编辑、会话查找、transcript 解析）；`npx vitest run src/web/client src/core/bot.test.ts src/core/drive.test.ts` 377 例；真 CLI 端到端：本地 OpenAI 兼容服务记录 `drive --resume` 发出的请求体里带着原会话的两轮对话和新问题，`turn-end` 成功、session 文件 id 不变并多出新回合，普通 `drive` 仍另起新会话。

## 2.7.10 — 2026-11-20

- 修桌面端「干着干着活变成黑板、只能关了重开」：`render-process-gone` 过去只停掉工作区服务，窗口留在自己的 `#050607` 背景色上再也不重绘。现在主进程用同一个后端、工作区服务与令牌重建窗口（`apps/desktop/main.cjs`），重建时跳过 `closed` 里的后端拆除，并先 `protocol.unhandle('luban-media')`——同一分区重复注册会抛错，正是第一次重建失败的原因。
- 新增渲染进程卡死检测：主进程每 10 秒 ping 一个 `1`，15 秒无回应按同一路径重建；Chromium 的 `unresponsive` 事件在真机上不保证触发，所以自己数。
- 升级路径：同一窗口 5 分钟内崩 3 次（或卡死 3 次）重启应用；GPU 进程崩两次则重启时 `disableHardwareAcceleration()` 并写 `<userData>/no-gpu`，`--luban-gpu` 清除。判定与原因写入 `<userData>/desktop.log`（512 KB 轮转）。策略抽到 `apps/desktop/window-recovery.cjs` 并配 7 例单测。
- 桌宠窗口同样重建，连续崩三次则不再重建（否则屏幕上多一个黑框）。
- 验证：`npm run probe:desktop:recovery` 在真 Electron 里用 CDP `Page.crash` 与死循环复现，修复前 46 s 仍是黑板，修复后崩溃 0.2 s 内重建、卡死 ~15 s 内重建，且 `no-gpu` 标记被采纳；`npm run smoke:desktop` 回归通过。

## 2.7.9 — 2026-11-20

- 删除仓库里两张终端截图 `docs/luban.jpg`（README 主图）与 `docs/luban.png`（未被引用）：截图会随界面改版过期，也带着当时的个人路径与配色。
- README 重排：居中 logo + 一句话定位 + 锚点导航行；亮点、桌面工作台改成两列表格；`bot run` / `bot add`、发布命令单独成代码块；交互日志配置给出 JSON 片段。
- 去掉过期的「**v2.0.0** 汇集…」宣传段，版本变化统一指向 `CHANGELOG.md`。
- 只动文档与仓库里的图片：没有代码或行为变化。

## 2.7.8 — 2026-11-20

- 远端同步补齐：11 个版本标签强推覆盖成重写后的对象，删除遗留的 `refs/notes/release-status`（它仍指向重写前的旧提交，会让旧历史一直可检出）。
- 重写提交自身的作者身份也改成 `holylong <holylong@users.noreply.github.com>`；`CHANGELOG` 里描述清理动作的句子不再写出真实姓名与个人邮箱。
- 复检：从远端全新镜像克隆后，全部对象里旧服务器地址、真实姓名、家目录、SSH 用户名命中数均为 0。
- 只动版本号与文档：没有代码或行为变化。

## 2.7.7 — 2026-11-20

- 重写 Git 历史清除个人信息：旧服务器地址与 SSH 端口、`/home/…` 与 `/Users/…` 家目录、SSH 用户名、内网地址与设备名统一换成文档示例值（`203.0.113.7`、`/home/deploy`、`/Users/me`、`192.168.1.10`、`work-mac`），历史提交里的文件内容一并处理。
- 提交身份归一：历史提交里的个人邮箱与匿名作者全部映射到 `holylong <holylong@users.noreply.github.com>`，作者名中的真实姓名不再出现。
- 从历史中删除 Android 构建产物目录（`app/build/`、`.gradle/`、`build/`）与 `.probe/*.heapsnapshot`：前者带构建机的绝对路径，后者是进程堆快照，里面残留运行时凭据字符串。仓库打包体积 47 MB → 15 MB，提交数 226 → 221。
- 影响面：所有提交 SHA 变了，远端用强推覆盖；其他克隆与服务器上的检出需要重新拉取。工作树内容只改了 5 个文件里的示例字符串，构建与测试不受影响。

## 2.7.6 — 2026-11-20

- 文档合并（第二批）：五篇结案的一次性排查记录（思考流闪烁、界面排版复用、堆内存耗尽、Codex 额度、运行性能，共 235 行）合成 `docs/audits.md`，按时间倒序、原小节标题降一级，开头一份索引。
- `docs/relay-deploy.md`（224 行）与 `docs/relay-domain.md`（181 行）合成 `docs/relay.md`：§0–§10 讲部署，§11 讲域名与公网入口，删掉两篇之间的互链，`相关文件` 表移到文末。
- 合并时清掉 `docs/relay.md` 里残留的标识：指向旧服务器的 nip.io 域名换成占位域名 `203-0-113-7.nip.io`，客户端/机房所在地与云厂商改成中性说法。
- 引用同步：`docs/reference.md`、`scripts/setup-relay-tunnel.sh`、`src/core/service-defaults.ts` 里指向旧文件的地方改成 `docs/relay.md`。
- 只动文档：没有代码、配置或行为变化。

## 2.7.5 — 2026-11-20

- 合并两份修改记录：`docs/changes.md`（1.16.72–1.16.76 的 5 条）并入 `CHANGELOG.md` 末尾，标题风格统一成 `## 版本 — 日期`，并标注原文件位置后删除 `docs/changes.md`。此前 1.x 的记录停在 1.16.76、2.0.0 起才写在本文件，中间那段只能靠翻 Git 历史。
- 只动文档：没有代码、配置或行为变化。

## 2.7.4 — 2026-11-20

- `opendesign` 不再内置网关地址：`src/core/config.ts` 里 `providers.opendesign.base_url` 改为空，并新增 `requires_base_url` 标记——没有 `base_url` 时这套模型表不进 `/models`，也不会让 OpenAI 兼容客户端在空地址下静默回退到 `api.openai.com`（那会把用户的 key 发到错误的地方）。填好自己的网关后模型表照旧出现，`claude-haiku-5.5` 走 Messages、`gpt-*` 可切 Responses 的行为不变。
- 文档与示例去掉内部网关域名：`docs/reference.md` 的 Open Design 一节改为「先配 `base_url` 再选模型」，`/responses`、`/messages` 示例改用相对写法；`config.example.json` 与 `README.md` 同步；`/models` 的鉴权面板不再给 opendesign 显示公网密钥控制台入口。
- `docs/opensource-checklist.md` 第 1 节补「自建网关」条目：内置默认地址要同时查 `service-defaults.ts` 与 `config.ts` 的 `builtinProviders()`，并说明留空后必须确认不会静默回退到公共端点。
- 测试：`config.test.ts` 改为「未配网关时 opendesign 不入模型列表、活动模型回退到默认值」，其余 Open Design 用例改用 `https://gateway.example.test/v1`；`responses.test.ts` 的端点推导用例同步换成占位域名。

## 2.7.3 — 2026-11-20

- 脱敏复扫并清理：`apps/android-native/app/build/`（100 个文件，含 `app-debug.apk`、`classes.dex`）、`.gradle/`（13 个文件）、`build/` 报告和 `local.properties`（记着构建机的 SDK 路径）移出版本库并补进 `.gitignore`——这些产物的日志里带着完整构建机家目录与旧版硬编码地址。
- 删除 30 个 `scripts/tmp-*.ps1` 临时排查脚本（写死某台 Windows 机器的绝对路径与模型缓存位置，不属于构建流程）。
- 文档与测试里的个人信息换成占位符：内网 IP、家目录绝对路径、自定义 SSH 端口、用户名；`scripts/probe-mobile-flicker.cjs` 改为从仓库根/临时目录取夹具路径；`docs/reference.md` 与 `CHANGELOG.md` 的示例地址改成 `<局域网IP>` 之类。
- `src/core/default-config.test.ts` 不再点名某个地址前缀，改为断言「种子配置里除 `0.0.0.0`/`127.0.0.1` 外不得出现任何点分四段地址」。
- 重写 `docs/opensource-checklist.md`：只保留检查项与命令，不再记录具体 IP、账号、家目录、行号——清单本身也要公开。
- 复扫结果：服务器 IP、内网地址、真实用户名与家目录、自定义 SSH 端口在跟踪文件中均为 0 命中；`git ls-files` 里已无构建目录。

## 2.7.2 — 2026-11-20

- 新增 `docs/relay-deploy.md`：中继服务器的完整部署文档——它不是独立二进制而是 `luban relay` 子命令、打包必须带上 `dist/web-ui/`、服务器目录约定、`relay.env` 凭据项、三种 TLS 形态、线上 systemd 单元全文、自检命令、公网入口（直连/快速隧道/自有域名）与 `--public-url` 的坑、升级回滚、按现象排错表。
- `docs/relay-domain.md` 与 `docs/reference.md` 的手机远控一节加上指向该文档的入口。

## 2.7.1 — 2026-11-20

- 默认地址收敛到单一来源：新增 `src/core/service-defaults.ts`，中继 `DEFAULT_RELAY_URL` 与统计 `DEFAULT_USAGE_STATS_URL` 只在这里写一次，`usage-stats.ts` / `stats-command.ts` / `config.ts` 全部引用它；此前统计地址在 `stats-command.ts` 里重复硬编码，改一处会漏一处。
- `remote.relay_url` 现在有内置默认值（当前隧道地址），优先级为 `config.json` > `LUBAN_RELAY_PUBLIC_URL` > 内置默认；未配置中继时 `luban relay`、TUI 的「登录中继」对话框和 `--remote` 都直接拿到正确地址，`remote.enabled` 仍默认关闭，不会因此在后台自动拨号。
- 使用统计地址保持同样的覆盖顺序（`usage_stats.url` > `LUBAN_USAGE_STATS_URL` > 内置默认），`luban stats` 打印的就是最终生效的 endpoint。
- 文档补上「内置默认地址」对照表（`docs/relay-domain.md`）以及两处覆盖说明（`docs/reference.md`、`docs/usage-stats.md`）；隧道再次换域名时只需改 `service-defaults.ts` 一处，或只改本机配置。

## 2.6.20 — 2026-11-20

- 两条临时隧道改由 systemd 托管：新增 `luban-tunnel-relay.service`（`https://localhost:443`）与 `luban-tunnel-stats.service`（`http://localhost:18080`），`Restart=always`、`RestartSec=5`，已 `enable` 开机自启，取代原先手工 `setsid` 起的裸进程；服务器重启后两条隧道会自动回来，不再需要手动拉起。
- 因为快速隧道每次启动都会重新分配域名，代码与文档里的默认地址同步刷新为当前值：relay `https://thickness-oxygen-life-resistant.trycloudflare.com`，统计 `https://submitting-reseller-trustee-fairy.trycloudflare.com`。
- 提醒：只要 `systemctl restart luban-tunnel-*` 或重装服务，域名就会再变一次；长期固定仍需自有域名 + 命名隧道，或改用自己的上报地址（`LUBAN_USAGE_STATS_URL` / `~/.luban/config.json` 的 `usage_stats.url`）。

## 2.6.19 — 2026-11-20

- 仓库里 27 处服务器明文 IP 全部替换为 Cloudflare 隧道地址：使用统计默认上报地址（`src/core/usage-stats.ts`、`src/core/stats-command.ts`）改为 `https://submitting-reseller-trustee-fairy.trycloudflare.com/api/report`；Android 默认中继（`MainActivity.DEFAULT_SERVER`）改为 `https://thickness-oxygen-life-resistant.trycloudflare.com`；文档与 CHANGELOG 里的地址、SSH 命令、`dig` 示例一并改写，不再出现源站 IP。
- 为了让上报链路在替换后仍然可用，统计服务单独开了一条隧道（`localhost:18080`），看板与 `/api/report` 不再依赖 IP 直连；实测 `luban stats` 退出时自动推送 10,306,401 input / 65,013 output / 3 runs 成功，服务端总量同步从 1,556,909,928 涨到 1,567,281,342、runs 686→689。
- 临时隧道地址会随进程重启变化；要长期稳定仍需自有域名（见 `docs/relay-domain.md`）。`apps/android-native/app/build/` 等已入库的构建产物二进制里仍残留旧 IP，属于同一批待清理文件。

## 2.6.18 — 2026-11-19

- 更正 `docs/relay-domain.md` 里关于临时隧道不可达的结论：手机拿到的 `Error 1033`（Cloudflare Tunnel error，带 Ray ID）是 Cloudflare 自己返回的错误页，说明请求已经到达边缘，只是那条隧道没有在线 connector（进程被重启、URL 已换）。此前据此推断「`*.trycloudflare.com` 被按域名拦」证据不足。
- 补一张排查表，按错误页来源区分：`1033`（隧道未连）、浏览器「无法连接」且无 Ray ID（没到 Cloudflare）、能打开但空白（前端资源/登录态）。

## 2.6.17 — 2026-11-19

- 修复 relay 走本地反向代理（最典型的是 `cloudflared` 拨到 `localhost:443`）时，所有手机共用同一个限流桶：令牌失败计数和 `/api/auth/*` 的尝试限制原先只按 socket 地址记账，代理后面每个客户端都是 `127.0.0.1`，一个客户端把额度打满、或有人扫端口乱试，所有人一起被 429 挡在外面。
- 现在只在对端是回环地址（说明请求来自本机代理）时才采信 `CF-Connecting-IP` / `X-Forwarded-For` 的第一个地址；直连的请求仍然只按 socket 地址记账，避免客户端伪造头重置自己的锁定期。
- 补回归测试：代理后面不同客户端互不影响、直连伪造 `X-Forwarded-For` 依然会被锁定、缺头或非法值回落到 socket 地址。

## 2.6.16 — 2026-11-19

- 补充 `docs/relay-domain.md` 的实测结论：`*.trycloudflare.com` 临时隧道在国内手机上打不开（同机打开 `cloudflare.com` 正常，服务端公网两边都 200），即该域名的 SNI 被单独拦截；临时隧道只能验证「服务器 → Cloudflare」半条链，手机可用性必须用自有域名验证。
- 记录区分方法：`cloudflare.com` 也打不开说明该网络到 Cloudflare 整体不通，免费藏 IP 在此网络上不成立；能打开而临时隧道打不开，则换成自有域名走同一 Cloudflare 边缘即可。

## 2.6.15 — 2026-11-19

- 新增 `docs/relay-domain.md`：把手机访问从「裸 IP + 自签名证书」换成域名的完整取舍与步骤。文档先拆开两个常被混为一谈的目标——好记/受信证书 vs 隐藏源站 IP——并说明域名 A 记录和证书透明度日志会让 IP 必然公开，要藏 IP 必须让流量先落到 CDN/隧道。含免费域名清单（能否改 NS 决定能不能接 Cloudflare）、三条路线在广州→北京的实测延迟（直连 145/50 ms、Cloudflare 隧道 830/520 ms，`colo=LAX` 的缘故）、Let's Encrypt 只能走 DNS-01 且需备案的现实约束，以及回滚方法。
- 新增 `scripts/setup-relay-tunnel.sh`：已有 relay 上一条命令接入 Cloudflare 隧道——`cloudflared service install` 装服务、备份 unit 后把 `--public-url` 改成新域名并重启、等域名可用再探活 `/m/`、`assets/mobile-*.js` 与未授权 `/api/node`。支持 `--dry-run`（不写任何文件）与 `--skip-relay-url`，可重复执行。
- 实测环境：源站 relay 仍跑在 443 自带证书、`:80` 被占用，故隧道指向 `https://localhost:443` 并勾 No TLS Verify；临时隧道验证 `/m/` 与直连同字节（2381 B）、静态资源 200、WS 升级能到达 relay。

## 2.6.14 — 2026-11-18

- 修复 Codex（ChatGPT 后端）在带 MCP 工具时整轮请求 400 `invalid_json_schema`：工具 schema 在发送前会去掉后端编译器不支持的 JSON Schema 关键字（`if`/`then`/`else`、`not`、`propertyNames`、`patternProperties`、`uniqueItems`、`dependent*`/`unevaluated*`），只保留调用所需的结构、类型、枚举与说明。此前只要有一个 MCP 服务器（例如 rea 的 `inspect_python_pyc`、`inspect_managed_members`）发布这类 schema，整轮对话都会失败。
- 补回归测试覆盖嵌套位置（属性、`items`、`anyOf` 内）的关键字剔除，以及合法 schema 原样保留；真实请求已从 400 变为正常返回。

## 2.6.13 — 2026-11-18

- Codex 模型列表改为紧跟本机 Codex CLI 的 `models_cache.json`：按 CLI 的 `priority` 新到旧排列（新模型在最上面），使用 `display_name` 作为显示名，隐藏和非 API 模型仍然不出现；缓存文件变更后按 mtime/size 重新解析。
- 常驻进程不再需要重启：TUI 的 `/models`（或 `Ctrl+P`）以及 Web/手机读取的 `/api/node` 都会在打开模型列表前重读缓存，Codex 更新后新发布的模型立刻可选，已选模型的凭据与 reasoning effort 保持不变。
- 补充回归测试：运行中写入缓存后 TUI 模型列表、`/api/node` 与 `refreshCodexModels` 都能看到新模型；TUI effort 测试改用临时 `CODEX_HOME`，不再依赖开发者本机的 Codex 缓存。

## 2.6.12 — 2026-11-17

- 修复手机设备/工作区列表轮询时上下跳动：设备与实例不再按心跳重排，工作区不再按会话更新时间重排；加载键使用稳定物理设备身份，普通轮询不再重启读取或清空展开列表。
- 补充心跳、代表实例切换和路由顺序回归；Chromium 探针检查展开 DOM、滚动偏移和卡片坐标稳定性。

## 2.6.11 — 2026-11-17

- 桌面端左上角项目按钮改为下拉菜单，“打开文件夹…”与“新建工作区…”（以及“在新窗口打开…”）合并到同一个列表，不再占用旁边的独立按钮。
- 文件菜单与托盘菜单同样在“打开项目文件夹…”下方提供“新建工作区…”；菜单项按当前桌面版本能力显示，缺省实现时不渲染。
- 补充下拉菜单条目顺序、能力裁剪与默认收起状态的回归测试。

## 2.6.10 — 2026-11-17

- 修复并行工具调用名称被拼接（如 `record_verificationupdate_plan`、`edit_fileedit_file`）导致 “unknown tool”：OpenAI 兼容流式响应缺少或重复 `index` 时按 `id`、已广播的工具名和已打开调用槽归并，Anthropic 流重复 `index` 不再覆盖前一个调用。
- 补充缺少 index、始终 index=0、仅按 id 分段、名称分片与重复名称的回归测试。

## 2.6.9 — 2026-11-17

- 桌面端新增“新建工作区…”：使用原生对话框选择位置与名称，创建新文件夹后可在当前窗口或新窗口打开；拒绝覆盖已有文件或目录。
- 补充创建、取消、重名和文件系统错误及桌面入口回归测试。

## 2.6.8 — 2026-11-17

- 分离电脑操控授权与活动光圈：启动默认授权不再启动光圈，只有鼠标键盘等修改操作期间显示，完成或失败后立即清除；只读观察保持无光圈。
- 修复光圈子进程阻塞退出：增加退出清理、不持有主进程、停止超时回收与异步启动竞态保护，覆盖 TUI /exit、卸载和 Web 停止。
- 补充空闲启动、操作失败、停止竞态和子进程退出回归测试。

## 2.6.7 — 2026-11-17

- 对照本机配置补齐可分发默认项：显式模型输出预算、空联系人和项目映射、默认关闭的远程连接与未配置的 Kev 模型决策模式。
- 不复制凭据、私有服务地址、本机路径和 MCP 命令；新增默认配置差异说明与首次启动回归测试，已有配置保持不变。

## 2.6.6 — 2026-11-17

- 全局配置新增 computer.enabled，默认开启电脑操控；支持环境变量显式关闭，保留系统授权和运行中停止开关，项目配置不能自行授予操控权限。
- 新增默认关闭的 interaction_log.enabled，按天将模型请求、回复、重试与用量写入本地私有 JSONL 日志，覆盖 OpenAI、Anthropic、Responses 和 Codex；不记录认证请求头并脱敏当前 API key。
- 补充配置、操控启动与交互日志回归测试和配置说明。

## 2.6.5 — 2026-11-16

- 首次启动生成的默认配置新增 sandbox.mode=soft 与 allow_outside_workspace=true，允许文件工具与 shell 访问工作区外路径，保留执行审批和危险命令检查。
- 已有配置不覆盖，明确关闭外部路径的设置继续生效；补充首次启动与已有配置回归测试及说明。

## 2.6.4 — 2026-11-16

- Codex 默认只走 ChatGPT 后端直连，取消请求失败后自动切换 Codex CLI；旧 auto 配置同样按直连处理，避免错误后用 CLI 重发上下文。
- 保留登录自动刷新和显式 CLI 兼容入口；补充直连错误、无登录、刷新失败、网络错误不调用 CLI 的回归测试与配置说明。

## 2.6.3 — 2026-11-15

- 修复 Desktop 版 Agent 栏把整组状态 pills 隐藏、连带隐藏唯一「电脑操控」开关的问题；状态标签仍保持紧凑，开关可见后可正常授权系统操作。
- 修正电脑操控未开启时的提示，不再要求用户寻找不存在的 Desktop Agent 栏按钮；补充 Desktop/TUI 入口说明与回归测试。

## 2.6.2 — 2026-11-15

- 修复桌面端独立窗口会话未注册 luban-media 协议导致 PDF 等媒体预览空白：为每个窗口的私有 Electron Session 注册工作区媒体处理器，切换项目后使用当前文件服务。
- 多窗口冒烟检查改为调用各窗口私有会话的媒体协议，防止默认会话注册掩盖此类回归。

## 2.6.1 — 2026-11-15

- Creator 每轮结束后将最终回答放到操作记录末尾，并明确显示执行已结束、未完成或缺少结果说明，避免停在最后一条指令上；模型提示要求如实交代结果、验证和阻塞。
- 已结束任务默认显示执行结论摘要，无需展开；修复多轮会话仍按旧轮结束事件判断执行状态的问题。
- 新增最终回答排序、空结果、失败及任务结论可见性回归测试。

## 2.5.20 — 2026-11-15

- 修复桌面端在全屏状态下点关闭按钮「窗口只是变黑、还占着一个窗口」：macOS 会把全屏窗口留在自己的一块空间里，先 `hide()` 只藏了内容、空间仍然占着并涂成黑色。现在关闭（以及菜单「隐藏到托盘」）会先退出全屏、等 `leave-full-screen` 后再隐藏，超时 1.2 秒兜底，空间随之释放。实测同一操作：修复前窗口隐藏但 `isFullScreen: true`、整屏亮度 0.0；修复后 `isFullScreen: false`、回到 1500×945、屏幕恢复正常（亮度 48.4）。
- 新增 `apps/desktop/window-close.cjs` 与 5 个回归用例（普通窗口直接隐藏、全屏先退全屏再隐藏、等不到事件仍会隐藏、过渡中窗口被销毁不再触碰、已销毁窗口不处理）。

## 2.5.19 — 2026-11-15

- Creator 侧栏与抽屉的「计划」改名为「交互记录」：每句话（包括「你叫什么名字」这类不带时间的提问）都会进队列成为一条记录，叫「计划」让人以为要先填一份排期表，也藏起了这本记录本身的用途。抽屉标题改为「交互记录」，侧栏项、输入区下方入口同步改名，`循环任务`/`一次任务` 分组保持不变。
- 新增措辞回归：可见文案必须出现「交互记录」、不得再有「全部计划」或「计划 {n}」，同时守住 `data-view="plans"` 这个稳定钩子；`smoke:creator` 与 Electron 冒烟脚本改为查找新名字。

## 2.5.18 — 2026-11-15

- 桌面端左上角的「打开文件夹…」按钮在已有项目时直接显示文件夹名（取工作区路径最后一段，兼容 Windows 路径与结尾斜杠），完整路径仍在下方一行和按钮 title 里；未打开项目时才显示「打开文件夹…」。
- 长文件夹名在按钮内省略显示，Ctrl+O 提示固定靠右，按钮不会撑出侧栏；新增 `folderLabel()` 与渲染回归（已打开显示名字、未打开显示引导、路径省略）。

## 2.5.17 — 2026-11-15

- 修复手机设备页「一会有数据一会没数据」：中继轮询每几秒给设备卡片一批新数组，会话列表的加载 effect 把它当成新设备重新拉取，先清空工作区再重建，用户刚展开的「会话」随之折回——现在只有在换了设备、点了重试或工作区集合真的变化时才重新加载，设备路由的所属实例变化不再触发。
- 展开状态按工作区记忆，即使卡片因真实变化重建，刚打开的会话列表也保持展开，不再出现列表自己合上的观感。
- 新增回归：轮询产出的等价路由数组、同一台电脑换了所属实例都不会改变加载键，换设备/重试/新增工作区仍然会；真实 Chromium 探针连续 12 秒 99 次采样中行被摘除 0 次（修复前摘除 2 次、67/99 次采样为空、出现 3 次读取中）。

## 2.5.16 — 2026-11-15

- 手机设备列表按稳定的机器身份聚合每个工作区的 luban 进程，同一台电脑只显示一张卡；在卡片里按注册项目路径合并出 `luban`、`cooler` 等并列工作区，每个会话请求和删除都路由到实际提供该项目的节点，且合并实时状态而不重复会话。
- 每个工作区的会话列表默认折叠（含仅有一个会话时）；删除入口需二次确认，客户端直接阻止已知运行中的会话，服务端再次拦截运行中及排队、执行、暂停任务的会话，并在删除与保存竞争时阻止旧会话复活。
- 修复同一物理电脑多个工作区实例的离线移除：一次移除整台电脑的所有实例，而不是只移除代表性节点。
- 新增机器聚合、项目路由、会话默认折叠与删除保护回归；工作区登记清理与 `luban projects` 同步交付，详见 2.5.15。

## 2.5.15 — 2026-11-15

- 手机端不再显示无效工作区：`/api/node` 只广播真实存在且不是系统临时目录的工作区，当前正在运行的工作区始终保留；新增注册临时目录直接返回 400（探针可用 `LUBAN_ALLOW_TEMP_WORKSPACES=1` 显式放行），从源头堵住 `luban-term-*`、`luban-a-*` 这类探针残留再次写入 config.json。
- 手机端再加一道防线：旧版本电脑仍在广播临时目录时，客户端按路径识别 `/tmp`、`/private/var/folders`、Windows Temp 并跳过，连它们的会话都不再请求；有会话的工作区按最近使用排在前面，没有会话的收进默认折叠的「其他工作区」，读取失败的工作区保持可见而不是被藏起来。
- 新增 `luban projects`：列出本机登记的工作区及状态，`luban projects --prune` 忘记临时目录和已不存在的目录（只删登记，不删文件）。
- 探针脚本 smoke-desktop-windows / desktop-terminal-probe 显式声明临时工作区许可，跑完不再往真实 `~/.luban` 留下垃圾登记。
- 新增回归：工作区登记拒绝临时目录并可放行、`/api/node` 只广播可打开的工作区、手机端跳过探针工作区、分组按活跃度排序且折叠空工作区、`luban projects` 行状态排序。

## 2.5.14 — 2026-11-15

- 手机设备页将每个已注册工作区作为并列入口（如 luban / cooler），会话列表与更多操作默认折叠；新工作区的独立会话可直接展开进入，包含尚未开始的草稿。
- 会话支持确认删除，仅清除会话及历史索引，不删除工作区文件；后端按设备内的项目和完整会话 ID 校验，阻止运行中及排队/暂停任务占用的会话被删除，阻止旧会话晚到保存复活记录。

## 2.5.13 — 2026-11-15

- Android WebView 共用的 `/m/` 设备页改为「电脑 → 工作区 → 会话」入口：按设备实时读取全部已注册工作区，分别列出最近 200 个会话（包括空会话），点击直接进入对应设备、工作区与会话，不必先打开默认会话再到设置里切换。
- 每个工作区提供「新会话」，每台电脑提供「新建工作区 / 添加已有目录」；直连模式也显示同样入口。顶部显示当前工作区与会话，点击返回设备列表；创建工作区后返回列表即可看到独立分组。
- 修复新会话被自动选回旧会话、创建工作区残留旧会话续接指针及跨设备/项目迟到响应覆盖列表；离线、读取超时、部分工作区读取失败均有明确提示和重试入口。
- 新增工作区清单回归测试与 `node scripts/probe-mobile-workspaces.cjs`：真实 Chromium 加载生产移动 bundle，验证跨设备直接打开第二个会话、新会话清空、新建工作区返回可见，以及 320/390/430px 长标题无横向溢出。该探针使用本地模拟中继数据，不调用模型或修改真实账户。

## 2.5.12 — 2026-11-15

- 侧栏的「后台任务」改名为「任务记录」，列表标题改成「最近任务（N）」，空态是「还没有任务」，已经跑完的那栏从「结果」改成「已完成」；执行状态说人话：执行器正在执行 / 待命 / 未启动，托盘菜单同步为「立即开始执行任务」「退出 Creator（任务继续按时执行）」。「后台」读起来像一个看不见的进程，而这其实是用户自己能打开、能读、能重跑的历史。
- Creator 界面不再是一张纯白纸：新增三级抬升尺度（`--lift-1/2/3`）与一道顶部高光（`--bevel`），让静止控件、卡片、浮层处在三个不同高度——输入卡最高，任务卡/计划/记忆/快捷胶囊次之，圆形按钮与开关最低；悬停抬到上一级并轻微上浮，聚焦时输入卡再高一层。
- 操控页的输入框原本和画布一样白，现在铺在一条向上投影的底部浮条上；左侧栏加了内壁高光与向画布落下的淡影，分割控件改成凹槽（选中项才浮起），发送键与「允许」用同色渐变加顶部高光。
- 新增 `creator-surface.test.ts`：锁住措辞（不得再出现「后台任务/结果」、必须有稳定的 `data-view` 钩子）与层级（三级阴影按模糊半径严格递增、输入卡/抽屉/浮条各自挂对了层级）。把改动前的 `creator.css` 换回去，两条层级用例立即变红。

## 2.5.11 — 2026-11-14

- Creator 新增全局身份档案 `~/.luban/creator-identity.json`（自定义 LUBAN_HOME 时跟随该目录），持久保存昵称、表达性格与对用户的称呼；跨项目、重启及后台任务共享，独立于项目记忆和应用标题。
- Creator 对话新增 `update_creator_identity` 工具：用户明确要求改名或调整称呼/性格时，由模型调用并在窗口单次确认后保存；不继承常驻授权，不改变工具权限，不向普通编码会话暴露。后台任务只读取身份，不开放身份编辑工具。
- 每轮对话重读全局档案，替换固定「造物主」身份提示；底层模型冒名纠正同样使用最新昵称。文件原子替换、0600 权限、并发锁、字段长度及损坏文件保护。
- 回归覆盖默认身份、补丁更新、重启/跨项目/后台读取、确认门禁、非法字段与损坏文件保护；默认身份保持「造物主」，产品名仍是 Creator/luban。

## 2.5.10 — 2026-11-14

- 移植 OpenClaw 最有辨识度的那件事：跨会话记忆。Creator 的每一次对话、每一条定时任务现在都会带着这个工作区的记忆开始，不再从空白提示词起步——昨晚扫到的 bug、上次说过「用 pnpm」、禅道项目 id 都能被下一次执行读到。
- 记忆是 `~/.luban/memory/<项目>-<哈希>.md` 一份纯 Markdown，人可以直接改：`事实` 是模型主动留下的（新 `remember` 工具），`记录` 是每次运行结束自动写的一行摘要（首句、上限 200 字、只留 40 条）。上限与截断都按注入预算算，一次注入最多 3000 字。
- 注入只作用于本次调用：块插在最新一轮提问前面，跑完从 transcript 里剔除，所以第 N 轮的旧记忆不会堆到第 N+1 轮；清空或手改文件，下一句话立刻生效。没有记忆的项目一分钱也不多花。
- 新增 `luban memory`（列表 / `--json` / 单项目 Markdown / `--clear <工作区>` / `--clear --all`），Creator 侧栏新增「记忆」抽屉：按项目列出事实与最近 5 条记录、可一键清除；`remember` 属于 luban 自己的数据目录，在窗口里不再逐次弹授权，但仍会有一行状态提示。
- 新增回归：注入位置与去重、运行摘要（中文句读、失败标记、200 字截断）、Creator 对话与 bot 任务的注入与日志、CLI 列表/JSON/查看/单项目清除/拒绝裸 `--clear`、记忆抽屉渲染与 5 条上限；`smoke:creator` 现在会真的写一份记忆并断言抽屉里能看到事实、记录与清除按钮。

## 2.5.9 — 2026-11-14

- 修复桌面中间「当前修改」对比框只有半屏高、行距松、窄列错位：对比区不再停在 340px 阅读上限，而是填满代码列剩余高度；行高从 1.6 收紧到 1.45。
- 找到行距的真正原因：通用 `.code` 规则（1.6 行高 + 26px 上下内边距）也命中了对比单元格，每行实际高 44px。文件预览改用 `.preview-code` / `.preview-code-row`，对比行回到 17px。
- 对比视图按宽度自动切换：宽度不足 900px（浏览器/手机列、Agent 栏、字体回退时）用单列「行号｜符号｜代码」，行号与符号列固定，折行文字留在代码列里而不是滑到行号下面；够宽时才分左右两栏。挂载前与首帧按单列渲染，不再先闪一版拥挤的双栏。
- 新增 `edit-record.test.tsx`：布局切换阈值、两种布局都保留文件/增删/行号、行高与固定符号列、`.code` 命名冲突回归、桌面面板填满高度。

## 2.5.8 — 2026-11-14

- 使用统计带上模型维度：每次运行按 `provider/model` 拆分 token 与运行次数（压缩、转交等辅助调用同样归属到实际执行它的模型），账本与上报增量都保留这份拆分；旧账本只含总量的桶仍然照常上报。
- 统计看板新增「模型用量」表：每个模型的运行次数、输入/输出 token、合计与占比；旧版本只上报总量的部分单独显示为「未标注」，表尾说明来源。
- 服务端上报格式校验支持 `models`：合并同名行、限制 40 行、夹紧计数并清洗模型名，异常字段只忽略不拒收整份报告；重启后从 `reports.jsonl` 回放同样的模型聚合。
- 新增客户端（`runUsage` 拆分、账本合并、上传体、上传期间并发运行、旧账本兼容）与服务端（解析、聚合、回放、看板渲染与转义）回归测试。

## 2.5.7 — 2026-11-14

- 修复桌面交互请求因 Cookie 丢失而反复鉴权失败，最终提示 `too many failed attempts; try again later`：主进程为每个窗口当前后端的同源请求附加专属令牌，不依赖 Cookie，切换项目时使用新令牌，外部地址不携带令牌。
- 扩展多窗口 smoke：模拟 Cookie 丢失与已有鉴权锁定，验证有效令牌立即恢复 API 与 POST 请求，保留匿名拒绝和外域无令牌检查。

## 2.5.6 — 2026-11-14

- 修复模型列表被无关请求失败锁住：节点与模型信息独立更新，不再因 peers、jobs 或 inbox 请求失败或卡住而禁用模型选择。
- 模型控件显示加载中、实际连接错误、未配置模型和提交中等原因，不再无提示地无法点击；执行中的任务仍允许为下一轮选择模型。
- 新增模型控件状态与 overview 请求隔离回归测试。

## 2.5.5 — 2026-11-14

- 修复多窗口下终端偶发 `Failed to fetch dynamically imported module`：各桌面窗口使用独立的非持久化 Electron partition，避免同为 127.0.0.1、不同端口的后端互相覆盖 `luban_token` Cookie，使稍后加载的 xterm、API 与 SSE 保持正确鉴权。保留静态资源的令牌保护。
- 多窗口 smoke 使用按主机（不按端口）存储的模拟 Cookie jar，向真实后端请求构建后的 xterm 模块、API 与 SSE；覆盖新开窗口及切换项目后原窗口的鉴权，检查匿名资源请求仍被拒绝。

## 2.5.4 — 2026-11-14

- 修复多个桌面窗口在 macOS Dock/窗口列表里都显示 `luban · Agent Workspace`、无法辨认项目的问题：导航时阻止通用页面 `<title>` 覆盖原生窗口标题。
  - 原生标题显示项目文件夹名与窗口序号，例如 `luban · my-project — 窗口 2`；同项目打开多份窗口也能区分。切换项目后标题随之更新。
  - 扩展真实后端多窗口 smoke：模拟 Electron 的 `page-title-updated` 通知，验证不同项目标题、同一项目的重复窗口编号都唯一，能捕获页面标题覆盖回归。

## 2.5.3 — 2026-11-14

- 修复 Creator 重启后「电脑操控」其实没恢复：合并顺序把子进程的 `enabled:false` 放在持久化状态之后，保存的开关每次都被覆盖成关闭。
  - 新增 `restoredComputer()` 统一这处判断：子进程没起来时以 creator.json 为准，起来后以子进程上报为准。
  - 真实 Electron 验证：`creator.json` 写 `{"computer":true}` 启动显示「电脑操控已开启」，写 `false` 启动显示「电脑操控已关闭」。
- 「授权」页的已记住授权现在真的看得见也收得回：空队列时也渲染队列头与页签，`RememberedApprovals` 单独成组件并带回归测试；点一次「清空已记住的授权」会同时清空页面与 creator.json，并保持操控开关不变（真实窗口点过一遍）。
- 修掉首次打开时 Mac 上却写「这台机器不支持电脑操控（只有 macOS）」：子进程没启动前 `supported` 被写死为 false，现在按平台判断，于是提示回到「还没打开电脑操控」。
- `npm run smoke:creator` 现在自带 creator.json 种子与断言：重启后开关为开、授权页列出 `computer、bash`、一键清空后 `allowed` 为空且 `computer` 仍为 true。

## 2.5.2 — 2026-11-14

- Creator 记住用户在窗口里点过的「允许」：下次启动新会话时同一工具不再每次询问，改为一条状态说明；在「授权」页可以看到已记住的列表并一键清空。
  - 只记工具名，不记参数；重启类命令（`approvalOnceOnly`）永远按次询问，也顺带修正了以前允许后返回 `always` 会被 agent 拒绝的问题。
  - 记住的授权不能绕过「电脑操控」开关：开关关掉时照样拒绝。点「拒绝」会撤销该工具的旧记忆。
- Creator 重启后保留「电脑操控」开关：窗口先用 creator.json 里保存的状态渲染，再等子进程的上报覆盖，不再显示成关闭而要求重新打开。
- 新增 drive 授权记忆、开关边界、重启命令按次确认、允许列表解析与 Creator 记忆函数的回归测试。

## 2.5.1 — 2026-11-14

- 桌面版 AI 自动展示的「当前修改」改为临时视图：任务完成、失败、取消、暂停或切换任务后恢复之前的页签；编辑器始终保留挂载，不丢失已打开文件和未保存草稿。用户手动选择的页签不会在收尾时被强制关闭。
- 右侧对话支持点击 HTTP(S) 网址、Markdown 文件链接和行内代码文件路径：桌面网址交给系统浏览器，当前项目文件交给系统应用；文件打开失败显示提示。主进程校验窗口来源及网址协议，文件仍受项目目录边界检查，禁止执行自定义协议。
- 新增修改视图生命周期及链接识别、打开和拒绝越界路径回归测试。

## 2.4.20 — 2026-11-14

- 修复桌面交互时误报 `job was still active when the Node process restarted`：桌面窗口与常驻后台共用任务目录，另一个实例启动不代表原任务所属进程已退出。
  - 新任务及续跑任务记录 `owner_pid`；启动清理只将明确已退出（ESRCH）的进程所属活跃任务标为失败。所有者仍存活、权限不足或旧记录缺少 PID 时保守保留，不再误伤其他窗口的任务。
  - 添加共享目录回归测试，覆盖存活所有者、排队任务、旧记录与真实退出的子进程；续跑测试确认所有者 PID 已更新。

## 2.4.19 — 2026-11-13

- 桌面版「终端」横向撑破代码列、压住右侧会话栏：面板宽度改为跟着列走，xterm 不再按出生时的列数硬撑。
  - 复现：真实 Electron 窗口在 1500px 下正常，缩到 900px 时 `.desktop-terminal` 仍是 734px 宽（右边缘 991），直接盖住从 580 开始的 Agent 栏，页面 scrollWidth 也还报 900 —— 因为溢出被上层裁掉，只有肉眼看得见。
  - 根因两层：`.desktop-console-pane` / `.desktop-terminal-panel` / `.desktop-terminal` 都没有 `min-width: 0`，列 flex 容器的交叉轴被 xterm 的固定 `cols×cellWidth` 顶开，面板跟着内容变宽；面板一宽 `fit()` 量到的就是「变宽后的自己」，xterm 永远收不回来（宽度自洽的死循环）。
  - 修法：`min-width: 0` 补到 console→pane→panel→holder 整条链；`fit()` 与首次建网格都改用新函数 `terminalWidth(holder, 所属 .desktop-console)` 取两者较小值，网格再宽也不会大过真正的列宽。`.desktop-terminal` 保留 `overflow: hidden` 作为兜底（console 本身不裁，否则高度拖拽条的 5px 抓取区会被切掉）。
  - 实测（`npm run probe:desktop:terminal`，真 Electron + 真 pty）：1500px 96×23、900px 40×23（面板 316、xterm 304，Agent 栏 580 起分毫未犯）、1180px 77×23、再放大回 120×23——列数双向跟随面板。
  - 新增 `src/web/client/desktop-terminal.test.ts`（12 例：`terminalWidth` 取小、隐藏面板回退、316px 列算 40 列而旧算法给 95 列、CSS 四层 `min-width: 0` 守卫）+ `scripts/desktop-terminal-probe.cjs` 真窗口回归探针。

## 2.4.18 — 2026-11-13

- 常驻后台默认让手机按 IP 直连：`--host 0.0.0.0`、固定端口 8642。
  - 2.4.17 的后台监听 `127.0.0.1` + 随机端口：手机在局域网里按 `http://<电脑IP>:<端口>/m/` 根本连不上，而且每次重启端口都变，手机里存的地址必然失效——「关掉终端也能连」只对中继成立。
  - `ensureDaemon` 默认改为 `--host 0.0.0.0 --port 8642`（`--host` / `--port` 或 `LUBAN_DAEMON_HOST` / `LUBAN_DAEMON_PORT` 可改）；`DaemonState` 记下绑定的网卡，旧状态文件缺这个字段时按 `127.0.0.1` 处理，不会被误报成局域网可达。
  - `luban daemon start` 新增 `--host/--port`，输出把每张网卡的链接连同令牌一起打印（`http://<局域网IP>:8642/m/?token=…`），并提示「同一网络里拿到链接的人都能操控这台电脑」；`daemon url` 同样列出全部链接。
  - `phoneLinks()`：循环地址在前，按绑定的网卡过滤——`--host 127.0.0.1` 时只给本机链接，绝不打印一张连不上的局域网地址。
  - 实测：`daemon start` 后 `lsof -iTCP:8642` 显示 `TCP *:8642 (LISTEN)`；`http://<局域网IP>:8642/m/?token=…` 返回 200（2381B）并引用 `assets/mobile-N6T0ecwJ.js`，同地址 `/api/sessions` 无令牌 401，`/api/node` 带令牌返回 2.4.17 与项目表。
  - 新增 `src/core/daemon-command.test.ts`（2 例：多网卡链接与令牌编码、只广播真正监听的地址），`daemon.test.ts` 增加绑定网卡/端口与旧状态迁移断言（15 例）。
  - 顺带修掉 `luban … | head` 的 EPIPE 崩溃：标准输出管道被 reader 关掉时安静退出（退出码 0），不再打印 `unhandled exception: write EPIPE`。

## 2.4.17 — 2026-11-13

- 常驻后台 `luban daemon`：一台机器一个入口，关掉终端/App 手机也连得上。
  - 之前只有两种后台：`luban web` 前台进程，和桌面 App 每个窗口一个 `--parent-pid` 子进程——两者都跟着自己的进程死，手机过一会儿再打开就只剩一张连不上的设备卡片。
  - `src/web/daemon.ts`：`~/.luban/daemon/state.json`（0600，pid/端口/令牌/出生目录/版本）作为唯一交接；健康检查是带令牌请求 `/healthz`（进程活着 ≠ 服务可用）；`mkdir ensure.lock` 做互斥，30s 过期锁可回收；后来者读到健康后台就复用并只把当前目录注册成项目（`POST /api/projects`）。
  - `luban daemon [status|start|add|stop|logs|url]`（`src/core/daemon-command.ts`）：`start` 幂等，`url` 直接给出带令牌的 `/m/` 链接，`status` 列出项目表、版本、模型和运行时长；崩溃留下的 state.json 遇到死 pid 会被清掉而不是被当成“没响应”。
  - 自动拉起：交互式 `luban` 启动时后台 ensure（`LUBAN_NO_DAEMON=1` 可关），失败只进 `daemon.log` 不打断 TUI 首帧；桌面 App 每个窗口 `daemon start <目录>`，窗口自己的后台改回纯本地——一个设备只占一个中继槽位，槽位留给常驻后台。
  - 子进程即 `luban web … --daemon-child`（新增隐藏参数）：绑定后用 `writeDaemonState` 立刻公布地址再拨中继；退出时只在 state.json 仍记着自己时才删除（`clearDaemonStateIfOwner`），不会删掉接替者的地址。
  - 实测：`daemon start /tmp/dh2/ws1` → pid 49617、port 65476、PPID=1；`add ws2` 后项目表 2 项；`/m/` 200、`/api/sessions?project=ws2` 200、无令牌 401；TUI（PTY）启动 8s 内自动起后台，退出 TUI 后 `healthz` 仍 200；`daemon stop` 后 state.json 消失、进程退出。
  - 新增 `src/web/daemon.test.ts`（13 例）：state 文件权限与校验、死 pid/哑服务区分、复用并注册目录、陈旧状态换新子进程（参数/detached/令牌环境/锁释放）、超时后杀子进程、真实 `stopDaemon` 杀进程、`clearDaemonStateIfOwner` 只删自己的、`/api/node` 项目表解析、日志尾部。

## 2.4.16 — 2026-11-13

- 通用 agent 化：不再用正则替模型做决定。删掉三处机械路径，一句话原样进模型。
  - `DriveSession.say()` 里「5 分钟后提醒我下班」的拦截删掉了（`handleReminderSentence`）：以前这句话在模型之前被解析成队列项，好处是模型挂了也能响，代价是它必须认识每一种说法、没法反问、模型根本看不到这句话。现在由模型自己换算 `in/at/every` 再调 `schedule`，`notify:true` 的纯提醒到点仍然零模型调用。
  - `screenIntent()` 关键词分流删掉：每个回合都是 `toolset: "all"`（文件、命令、MCP、computer），该截屏还是该读文件由模型判断，不再按「计算器/访达/浏览器」这类词预先收窄工具。
  - `src/core/bot-schedule.ts` + `src/core/reminder-text.ts`（及各自单测，共 4 个文件）整体删除；`remind.ts` 只留队列/间隔/通知这些基础能力（`scheduleReminder`、`ensureBotWorker`、`describeMoment`），`luban bot add --in/--every/--remind` 保持不变。
  - Creator 输入框只剩一句话：去掉「现在/定时/每隔」选择器、`datetime-local`、分钟输入、识别到的排期青绿标签和 `reminderIntent` 判断，派发时只提交 `{prompt, workspace}`；排期完全由模型的 `schedule` 调用决定，队列变成 agent 排期的落点而不是人填表单的产物。`creator-schedule.ts` 里随之没人用的 `everyLabel` 删除。
  - 提示词（`DRIVE_PROTOCOL`）改成「工具不够用就自己造」：一次性的事写脚本进工作区用 `bash` 跑，反复要用的做法写成 `.luban/skills/<名字>/SKILL.md`，下次用 `list_skills` / `read_skill` 读回来——能力靠模型长出来，不靠往 agent 里塞功能。
  - 新增 `drive.test.ts` 用例钉住这条行为：提醒句必须交给 runner（`usage.calls === 1`）、不产生任何 `tool` 事件、不在 `bot/tasks` 里偷偷建任务。顺带修好 `creator.tsx` 的挂载守卫（`typeof document === "undefined"`），`creator-task.test.tsx` 从此能在 node 环境跑起来（2 例）。
  - 文档同步：`docs/creator.md`（一句话派发、不做句子分流、自建 skill）、`docs/reference.md`（提醒不再由正则解析）。

## 2.4.15 — 2026-11-13

- 「5 分钟后提醒我下班」不再写成系统日历事件：排进 luban 自己的队列，跨平台。
  - 之前提示词让模型 `bash` + `osascript` 往「日历」或「提醒事项」里写一条——只在 macOS 上有，换到 Windows/Ubuntu 就白排；写在系统应用里 `luban bot list` 看不见、窗口里取消不了；而且一句话提醒还要跑一次模型。
  - 新增 `schedule` 工具（`src/core/remind.ts`）：`{text:"提醒我下班", in:"5m", notify:true}` → 一条 `kind:"notify"` 的队列任务，到点直接发系统通知，**不花模型调用**；到点真要干活的去掉 `notify`，仍是普通 agent 任务。时间写法支持 `5m / 90s / 2h / 1h30m / 5 分钟 / 1天`，也接受带时区的绝对 `at`。
  - 通知本身跨平台（`src/core/notify.ts`，有单测）：macOS `osascript display notification`、Linux `notify-send`、Windows PowerShell WinRT toast；没有通知器时任务照样记录完成，不因为「没弹出」把任务判失败。
  - worker 不在跑时 `schedule` 会顺手拉起（`ensureBotWorker`，不抢 LaunchAgent 的锁），并明确告诉模型「到点会响 / 先跑 luban bot run」。`luban bot add` 加了 `--in <5m>` 与 `--remind`，命令行也能排纯提醒。
  - 提示词改成「定时/提醒/闹钟一律用 schedule，别碰日历、提醒事项、osascript、crontab、at」，眼睛和手的窄工具集里也保留 `schedule`（提醒不是屏幕任务，不该被逼进日历 App）。窗口时间线把这一动作显示成「定时提醒 +5m · 提醒我下班」。
  - 实测：`bot add "提醒我喝水" --in 8s --remind` + `bot run`，到点 200 ms 内完成，`runs.jsonl` 只有 `result:"提醒我喝水"`、无 usage（零模型调用），通知由 osascript 成功弹出。

## 2.4.14 — 2026-11-13

- 造物主改名 `Creator`，图标换成青绿，不再和 luban 长得一模一样。
  - 之前 `.app` 显示名是「造物主」、包名 `Luban Creator`，和 luban 共用同一个 1024 图标（只是套了个默认色）——菜单栏/Dock 里两个图标并排分不出来。
  - 现在：`Creator.app`（CFBundleDisplayName `Creator`，id `com.luban.creator` 不变，DMG 卷名 `Creator <version>`）、窗口标题 `Creator`、菜单栏文字 `Creator · 忙/待命/未启动`、右键菜单与工作区选择框也一起改名。
  - 图标：新增 `assets/creator-app-1024.png`（青绿 #287F6D，图形保留 luban 的轮廓）→ `AppIcon.icns`；窗口左上角 logo 与菜单栏图标（18/36px）同步换成 `creator-icon.png` / `tray.png` / `tray@2x.png`。luban 本体仍是深蓝 #0D172A + 金色图形。
  - 界面内的中文文案（「造物主，我帮你…」）不动：改的是应用名，不是产品口吻。

## 2.4.13 — 2026-11-13

- 操控会话不再「所有指令都先截屏分析」：一句话进来先判断该用哪种手。
  - 旧行为（2.4.12）：drive 会话固定 `toolset: "computer"`，提示词第一句就是「windows → screenshot」。于是「你叫什么名字」「整理个文档」「设个闹钟」都会先去看屏幕——用户说的「处理个文档还截屏分析」「老是在截图分析」就是这一条。
  - 现在按句子分流（`screenIntent()`，有单测）：句子里真的在说屏幕上的东西（截屏/窗口/点击/计算器/访达/浏览器…）→ 这一轮只给 `computer`（眼睛和手，没有 shell，避免 osascript 猜坐标）；其余（问答、文档、代码、定时/提醒）→ 给全套工具（文件、bash、MCP）。
  - 修掉一个让窄工具集形同虚设的 bug：`delegate_task` / `ask_user` 是在构造函数剪枝之后才注册的，所以「只有眼睛和手」的会话里其实还能委派和提问——实测模型干脆不点、去委派。现在 `runLoop` 开头重新剪一次，窄就是窄。
  - 提示词改成先规划再动手：只问一句 → 一个工具都不调；文档/代码 → 文件工具，不截屏；**定时/提醒/闹钟 → 用命令排进系统**（`osascript` 写日历/提醒事项，或 `luban bot add --at …` 排后台任务），不要盯屏幕；只有真要动界面才 `windows → screenshot → click`。
  - 实测（本机真模型 + 造物主 bridge）：`你叫什么名字？` → 1 步 / 0 工具 / 0 截图 / 10 秒；`把 meeting.md 整理成三条要点写进 summary.md` → `read_file` + `write_file` / **0 截图** / 18 秒，产出正确；`设个明天早上 8 点的闹钟叫我起床` → 6 次 bash 在「日历」和「提醒事项」里各写一条 08:00 的提醒 / **0 截图** / 68 秒（读回提醒事项确认真是 2026-11-14 08:00）；`在计算器里算 6*7` → 点击序列 + 截图确认 **42** / 32 秒。
  - 窗口 smoke 增加 `CREATOR_SMOKE_UI`：真的往输入框里打字点发送，再断言气泡和回复出现——「窗口能不能正常交互」现在是被测过的。

## 2.4.12 — 2026-11-13

- 造物主终于能「替人操控电脑」，走的是 workbuddy 那条路：只有眼睛和手。
  - 反例先记着：旧 `luban drive` 跑「打开计算器输入 12*34」时，9 次工具调用全是 `bash`/`osascript`（pgrep 找进程、System Events 读窗口位置、用 PIL 量截图像素），**一次点击都没有**——会话里塞着 bash、编辑器和一百多个 MCP 工具，模型自然去写脚本。
  - 现在操控会话固定 `toolset: "computer"`：只留 `computer` / `read_image` / `attach_image`，MCP 发现直接跳过；普通会话行为不变（`AgentRunner` 加了一个可选 `toolset`，`keepComputerTools()` 可测）。
  - `computer {action:"windows"}` 返回前台应用、每个窗口的 x/y/宽/高和屏幕点尺寸；`computer {action:"app", name}` 直接启动/唤起应用，取代 `open -a` 和 `osascript`。
  - 截图结果同时给 `pixels` 与 `screen`（点尺寸、scale），并且新增 `origin`：截图裁剪的左上角在屏幕上的位置，屏幕坐标 = origin + 图内偏移。之前模型拿 Retina 像素当坐标，或者反过来反复换算窗口阴影偏移。
  - 截图自动附加到当前请求：跑完 `screenshot` 下一步就是图片，不再 read_image → attach_image 两次往返。
  - 修掉一个会卡死的真 bug：`luban drive` 的 stdin 命令是串行队列，`approve`/`stop` 排在它们要解锁的那一轮后面——点了「允许」什么也不会发生。现在审批与停止插队，`pumpCommands()` 抽出可测。
  - 审批语义对齐窗口：第一次「允许」覆盖本会话，回一条状态说明，不再逐次弹窗。
  - 提示词写清循环、单位、坐标来源；允许坐标已确定时一条回复里连发多个动作；并明确「截图一定送到了，不要因为觉得没看到图就重复截图」。
  - 造物主窗口接上这条会话：`apps/creator/drive.cjs` 一条 `luban drive` 子进程 + IPC，面板显示动作时间线、截图缩略图（主进程把相对路径按会话工作区解析后转成 data URL）和允许卡；`say` 的本地回显与子进程回显去重，不再显示两遍。
  - 新增 `npm run smoke:creator:drive`：真 Electron 窗口里发一句「在计算器里算 6*7」，断言面板真画出了动作、截图缩略图和审批卡。
  - 真机验证（本机 macOS + 真模型，结果都用截图/OCR 独立核对）：`12*34` → 6 次点击 1/2/×/3/4/=、14 步、显示 **408**；`7*8` → 11 步 / 5 次点击 / 3 张截图、显示 **56**；经造物主 bridge 跑 `9*9` → 24 秒 / 5 次点击（一条回复连发）/ 2 张截图、显示 **81**（窗口当时被挪到 1050,76，模型按新位置算的坐标）；creator smoke：13 条动作 / 6 张缩略图 / 1 张允许卡。
  - 已知未做：模型偶尔仍会重复截图或补一次多余的 `attach_image`（flash 的稳定性问题，提示词已压制，未根治）；CLI 路径的屏幕荧光圈仍未接（沿用之前的已知问题）。

## 2.4.11 — 2026-11-13

- 造物主终于能回答「我那些定时任务到底排上没排上、跑没跑」——以前窗口只有进行中/结果/授权三个页签，`每晚 23:00`、`每 6 小时` 这类排期只在任务卡里含糊显示一句，执行历史完全看不到：
  - 新增「全部计划」抽屉：左栏 `计划（n）` 徽章（n = 后台任务总数，这就是那个「显示个数、点开看详情」的入口）和输入卡下方 `计划 n` 都能打开它；抽屉顶部一行总览「4 条 · 循环 3 · 一次 1 · 正在跑 1 · 待触发 2」。
  - 分组列出 `循环任务` / `一次任务`：每条给排期（`每天 23:00` / `每周一 09:00` / `每 6 小时` / `一次 · 今天 14:41`）、下次触发（`下次 今天 23:00` / `马上执行` / `正在执行（14:34 开始）`）和已执行次数；展开后是工作区、超时、间隔、取消按钮，以及**逐次执行历史**：时间区间、成功/失败、调用次数与 tokens、结果摘要，点开是完整结论文本（Markdown）。
  - 输入框能直接说排期：「现在」模式下句子里带时间就自动排期——`每天 6 点提醒我` → `每天 06:00`、`5 分钟后提醒我下班` → 一次性任务、`每 6 小时扫一次 buglist` → `每 6 小时`；派发前在输入卡下方显示青绿标签预览（`每天 06:00 · 首次 …`），派发后弹「已排入：每天 06:00 · 下次 今天 06:00」，预约成功与否不用再靠猜。
  - 任务卡元信息固定为 `状态 · 排期 · 下次触发 · n 次执行`，取消按钮不再和排期挤在一行。
  - 排期文案抽成 `src/web/client/creator-schedule.ts`（纯函数，无 React），`creator-schedule.test.ts` 12 例锁住：每天/每周/每 N 小时/每 N 分钟/一次的措辞，下次触发的三种说法（下次/马上执行/正在执行），以及「每天 6 点」被解析成 `every=1天, at=下次 06:00` 后回读仍是 `每天 06:00`。空态、列表态、抽屉三张截图与 `*.rects.json` 全部由 `--smoke`（`CREATOR_SMOKE_PLANS=1`）产出：抽屉宽 520、贴右、700 高不滚动，4 条计划 + 2 条执行记录实测渲染。

## 2.4.10 — 2026-11-13

- 造物主窗口按 workbuddy.jpg 的版式重做（上一版只是一张竖排卡片，布局和参考完全不同）：
  - 用 Vision OCR + 逐像素量测把参考图（2890×1736）拆成坐标：侧栏占宽 19%、右侧居中内容列 58%、标题在窗口高 12% 处、输入卡 37%、建议胶囊 66%、底部声明 94%。新窗口 980×700（原 460×700），侧栏 200pt + 内容列 568pt，比例与参考一致。
  - 左侧栏：logo + 「发现应用」胶囊、选中态「新建任务」、进行中/结果/授权/权限策略四行（带计数徽章）、「任务（n）」逐条队列（状态点 + 时间）、「空间（n）」工作区、底部后台状态胶囊 + 用户行（青绿圆头像 + 收起）。
  - 右侧：居中 36px 标题「造物主，我帮你」+ 办公/开发/设计 分段控件；下面一排快捷胶囊；输入卡（20px 圆角、placeholder「今天帮你做些什么？ @ 添加上下文，/ 调用技能与指令」、左下 ＋、右下圆形发送键，未输入时变灰）；卡下一行「选择工作空间 / 默认权限」；再下面 4 条「↗」建议胶囊；底部居中「内容由 AI 生成，请核实重要信息」。
  - 配色按参考取样收敛：画布 #ffffff、侧栏 #f9f9fb、胶囊 #f7f7f8、发丝线 #ececf0（与参考差 1–2 个色阶）。
  - 有队列时自动收起 hero/快捷/建议，内容顶到 22pt 处；空态与列表态都在 700pt 内不出现滚动条（实测 scrollH == clientH == 700）。
  - `apps/creator/main.cjs`：窗口 980×700（min 760×520）、底色改白；`--smoke` 额外写出 `*.rects.json`（各区块 x/y/w/h、滚动高度、胶囊尺寸），版式回归不靠肉眼。

## 2.4.9 — 2026-11-13

- 造物主窗口换成参照 WorkBuddy 的浅色版式（原来的深色控制台版式太像后台管理页）：
  - 整页改成浅色：`#f7f8f9` 底 + 纯白卡片 + 极浅描边，只用一层柔和的投影分层次；`color-scheme` 与窗口底色（`apps/creator/main.cjs` 的 `#0e1117` → `#f7f8f9`）一起换掉，启动时不再闪一块深色。
  - 空队列时是真正的欢迎页：居中 26px 标题「造物主，替你跑腿」+ 一句说明，下面三张「↗」建议圆角胶囊，点一下就把那句话填进输入框；有任务时自动收起，把空间还给列表。
  - 输入区改成一张浮起的白卡（16px 圆角、聚焦时描边加深）：4 行占位「今天帮你做些什么？」，左下角是工作区胶囊（带文件夹图标）和时间选择，右下角是圆形青绿发送键（不可用时变灰而不是消失）。
  - 页签换成 macOS 分段控件（灰底 + 选中项白底投影），任务卡改成白底细边 + 悬停投影，状态点/元信息字号与颜色重排；结果区、授权卡、footer 同步改成浅色可读的对比度。
  - 列表态输入框收成 2 行，给队列让出高度。

## 2.4.8 — 2026-11-13

- 重做造物主窗口的视觉（460×700 下原来松松垮垮、footer 挤成两行、通篇同一层次的灰）：
  - `creator.css` 整套换掉：主色改成 logo 的青绿（`#4ed6b8`），底色加一层顶部微光，面板/分隔线分三层明暗；窗口 44pt 标题栏 + 30pt 状态栏，列表占满中间。
  - 输入区改成 2 行、短占位「让它做什么？」；右侧是青绿实心「派发」按钮（不可用时仍保留轮廓而不是消失），旁边一个 `⏎ 派发` 提示；工作区/时间选择收成 24pt 的小控件。
  - 任务卡：13px 标题（两行截断）、11px 元信息用 `·` 分隔、状态点带呼吸动画；「取消」改成悬停才出现，卡片默认不再挂满按钮。
  - 页签：计数改成小圆角徽章，选中页签用青绿下划线；结果区、授权卡（黄色左侧条 + 等宽 args）和空状态同步重做。
  - footer 的队列路径改成单行省略号，「收起」不再竖排换行——这正是原来最刺眼的一处。
  - `apps/creator/main.cjs` 窗口底色跟随新配色（`#0e1117`）。

## 2.4.7 — 2026-11-13

- 造物主补上图标：以前菜单栏只有「待命/忙/未启动」几个汉字，窗口里也只有文字，看不出是哪个程序。
  - `apps/creator/assets/tray.png`（18px）与 `tray@2x.png`（36px）：从 `assets/luban-app-1024.png` 裁掉透明边再缩放，`apps/creator/main.cjs` 用它建菜单栏状态项，状态字仍跟在图标后面；文件缺失时退回空图，不阻断启动。
  - `src/web/client/creator.tsx` / `creator.css`：窗口标题栏的「造物主」前加 16px logo（复用 `public/icon-192.png`），不再是纯文字标题。
  - 打包时 `apps/creator` 整目录进 bundle，图标随包分发；`.app` 的 `AppIcon.icns` 仍是 2.4.6 起就有的 luban 图标。
  - `apps/creator/bot.test.mjs` 新增一例：断言两张 PNG 存在、尺寸为 18/36、且是带透明的 RGBA。
  - 顺带修掉同一处的隐患：`apps/creator/bot.cjs` 起 worker/调 CLI 时优先用 `LUBAN_NODE_BIN`（打包后的 app 就指到包内 node），在 Electron 里没有自带运行时则给子进程加 `ELECTRON_RUN_AS_NODE=1`，不再让 CLI 以 Electron 主进程身份跑。

## 2.4.6 — 2026-11-13

- `npm run release` 在 macOS 一次产出三个程序：CLI ZIP、`luban-desktop-<v>-mac-<arch>.dmg`、以及新的 `luban-creator-<v>-mac-<arch>.dmg`（`Luban Creator.app`，显示名「造物主」）。
  - `scripts/package-macos.mjs`：`buildApp()` 改为按 `APP_SPECS` 生成 bundle（`com.luban.desktop` / `com.luban.creator`，入口 `apps/desktop` / `apps/creator`），两个 app 共用包内 Node 运行时和 CLI，DMG 失败同样回退 ZIP；新增 `packageVariant("creator")` 与 `npm run package:macos:creator`。
  - `scripts/release.mjs`：新增 `--kind creator`；macOS 下 `--kind all` 默认三个产物并带 ZIP 回退，`--kind creator` 在其他平台直接报「macOS-only」，linux/windows 的默认行为保持两个产物不变。
  - `apps/creator/bot.cjs`：`cliPath()` 优先使用 `LUBAN_CLI`，打包后的造物主用它自带的 CLI，而不是仓库路径。
  - `scripts/release.test.mjs`：mac 矩阵断言三产物与三回退项，并断言非 macOS 的 `--kind creator` 报错。

## 2.4.5 — 2026-11-13

- 造物主变成独立常驻程序（`apps/creator/`，`npm run creator`），不再依附桌面工作台：菜单栏一个入口，点开是自己的窗口——派任务、看进度、看结果，没有项目树/编辑器/预览。
  - `apps/creator/main.cjs`：Electron 托盘应用。工具栏文字形状态项（待命/忙/未启动）、关窗即隐藏、单实例、`app.dock.hide()`，窗口关闭不影响后台任务；菜单可手动拉起 worker、打开队列目录、打开 `permissions.json`、退出造物主。
  - `apps/creator/bot.cjs`：只读队列（`request.json` / `state.json` / `cancel` 标记）+ 经 `luban bot add|cancel|permissions` 写入，绝不另造一套格式；`ensureWorker()` 在无 LaunchAgent 时以 `detached` 拉起 `luban bot run`，已有系统托管时不抢锁；`workerStatus()` 用锁目录 pid 判活、用 `status.json` 心跳判「卡住」。
  - `src/web/client/creator.{html,tsx,css}`：Vite 第三个入口。`现在 / 定时 / 每隔 N 分钟` 派发，`进行中 / 结果 / 授权` 三个页签，结果用 Markdown 渲染（沿用 2.4.4 的分节规则），授权页列出被拒绝的调用与参数。
  - `npm run smoke:creator`：真 Electron 渲染并截图，同时断言窗口文本里出现队列中的任务，防止「有像素没内容」。
- 文档新增 `docs/creator.md`：构架、用法、无人值守的授权边界（精确 args 授权，`bash` 无法用一条授权覆盖，需要新增窄工具）、定时语义与失败不重放。
- 新增 `apps/creator/bot.test.mjs`（5 例）：队列排序/无状态按排队/取消标记优先/worker 停-活-卡住/经 CLI 落盘与 60s 下限。

## 2.4.4 — 2026-11-13

- 修掉「桌面版右侧回复/结论就是一坨文字」：`src/web/client/markdown.tsx` 以前把整段合并成一个 `<p>`，现在按模型真实的写作习惯分块。
  - `**契约**：正文` 这种加粗引导语识别成小节标题（`h3.md-lead`），正文另起一段——回复第一次有了主次；`**契约**（`path.ts`）：…` 里的括注渲染成标题旁的小字，不再孤立地悬在段首。
  - 段落内换行遇到句末标点（。！？；…!?;:）就断开成新段落，所以「一句一行」的回答不再被拼成一行；加粗整句（如 `**是的，可以。**`）仍按强调处理，不会被误升级成标题。
  - 折行拼接按语言决定空格：中文之间不加空格（以前是「修复了 A。 修复了 B。」这种夹着空格的一坨），英文单词之间仍保留空格。
- 排版：`.md p` 行高 1.75（窄栏 1.8）、段间距 8px、`li` 行高 1.7；`.md-lead` 用主题主色、上间距 13px，标题与其正文之间收 2px。
- 新增 `src/web/client/markdown.test.tsx`（7 例），用真实 job 结果里出现的写法覆盖上述规则；把 `markdown.tsx` 回退到上一版后其中 5 例变红。

## 2.4.3 — 2026-11-13

- 修掉「终端里跑的任务弹 ask_user，手机上只看到提问、没法选也没法输入，两边一起卡住」：
  - `QuestionBroker` 新增 `open(jobId, question, signal?)`，返回 `{ id, answer, close }`——终端保留自己的输入框，同时把同一个提问发布到 Web 广播；`request()` 改为基于它实现，行为不变。
  - `ApprovalBroker` 同样新增 `open(jobId, tool, args)`（终端版不带 600s 超时，由终端弹窗决定生命周期），`request()` 依旧带超时。
  - TUI 的 `askUser` / `approveTool` 现在优先广播：手机「交互」页出现同样的选项与「允许一次 / 本会话允许 / 拒绝」，**先回答的一方生效**，另一端的弹窗自动收起；终端作答时 `close()` 撤回手机那份，反之手机作答直接让终端那一轮继续跑。
  - `cli.tsx` 把 TUI 已有的两个 broker 注入 `App`（Web/中继没开时传空，纯终端行为与之前一致）。
- 新增 `src/ui/app-question-bridge.test.tsx`（真实 TUI + mock runner）：手机替终端回答 `ask_user` → 运行继续且广播清空；终端按 `1` 作答 → 手机那份同时被撤回；手机拒绝终端等待的审批 → 审批回调收到 `deny`。`src/web/question.test.ts` 增加 3 例（发布即出现在 `pending`、所有者先答时 `close()` 撤回、任务中断时自动移除）。
- 文档：`docs/reference.md` 的 Web 工作台与 API 表补说明（`/api/questions`、终端任务可被手机接答）。

## 2.4.2 — 2026-11-13

- 讲清并落实平台边界：电脑操控只做 macOS。新增 `computerSupported()`（`src/core/computer.ts`）作为唯一判断点——`begin()` / `act()` / `screenshot()` / `checkPermissions()` 在非 macOS 直接抛「只支持 macOS（当前是 linux）」这种一句话错误，不再让模型看到 `swiftc: command not found`；`createTools()` 在非 macOS **不注册** `computer` 工具；`POST /api/computer` 开启请求返回 400；TUI `/computer` 先说明原因再返回；客户端药丸本来就只在 `platform === "darwin"` 时渲染。
- `LUBAN_COMPUTER=1` 在非 macOS 只打印一行提示并忽略，无头运行不会因此失败。
- 新增三个「其他平台」用例：`computerSupported` 只在 darwin 为真、非 darwin 的 `begin/act` 抛可读错误且不会真的开启、`createTools()` 在 linux 下少且只少 `computer` 一个工具（`read_image` 等仍在）。
- 文档 `docs/computer-control.md` 增「平台支持」表：Linux/Windows 上除电脑操控外的功能（编译、测试、mesh、relay、手机端）都照常。

## 2.4.1 — 2026-11-13

- 修掉「CLI 里能操控但看不到光圈」：终端自己现在也会画燃弧。`ComputerControl.begin()` 在 macOS 上拉起 `apps/desktop/native/glow.swift`（按源码哈希编译进 `~/.luban/bin/luban-glow-<hash>`，约 5s，之后复用），`end()` / `requestStop()` / `Ctrl+C` 时关掉；徽标写明「luban 正在操控 · ⌘. 停止」。终端本身覆盖不了别的 App，这是唯一能在 CLI 里显示边框的路径（`~/bin` 里的 `glow.html` 只对 Electron 有效，勿再误用）。
- 燃弧调亮：内圈描边 0.55→0.85 且加粗到 2px、新增 6px 处一圈暗线（0.30）、四条径向渐变带 0.30→0.42、火花带 0.55→0.80 且阴影 16px、徽标底 0.82→0.92。实测（3360×2100 真截屏对比）：边缘 `(23,23,23)→(69,87,112)`，四角 `(77,81,69)→(107,132,155)`，中心像素不变，约 6.5 万采样点变化。
- 停止标志不再被系统事件污染：`glow.swift` 收到 SIGTERM/SIGINT/SIGHUP 或发现父进程消失时只退出，**不写** `~/.luban/computer/stop`；只有人按 `⌘.`（或开关关闭）才写。之前父进程正常结束会顺手写一个停止标志，导致下一会话的第一次操作报「用户已中止」。`stopRim()` 改为等子进程退出后再删标志。
- 桌面端不重复画：检测到 `LUBAN_GLOW_URL`（桌面 App 自己那圈覆盖层）就不起 CLI 覆盖层；`LUBAN_GLOW=off` 可全局关掉；`LUBAN_GLOW_BINARY` 指定现成二进制（测试用）。
- 新增 `src/core/computer.test.ts` 的 `rim overlay` 三例：会话开启就点亮、结束即熄灭且不留停止标志；桌面 App 在场时让位；glow 二进制缺失时操控照常可用。
- 文档 `docs/computer-control.md` 补「终端里也有燃弧」一节，删掉「终端没有燃弧」的旧说法。

## 2.3.20 — 2026-11-13

- 电脑操控补齐非桌面入口（三条路共用同一个停止标志 `~/.luban/computer/stop`；开关本身是每进程的，只对自己那个 agent 放开）：
  - **终端 TUI**：新增 `/computer [on|off|status]`（不带参数在开/关之间切换）。`status` 直接跑 helper 的 `check`，一行打印 `电脑操控：开 · 辅助功能 ✓ · 发送事件 ✓ · 屏幕录制 ✓ · 缩放 2×`；开启后标题栏出现红色 `⌁ 电脑操控`。终端覆盖不了别的 App，所以没有燃弧，靠标题栏 + 工具卡显示。
  - **运行中 `Ctrl+C` / `Esc`** 在中断任务的同时收回电脑操控（写停止标志并置灰状态），和桌面 `⌘.` 语义一致。
  - **无头**：`luban --prompt`、管道输入没有可点的开关，只有 `LUBAN_COMPUTER=1`（或 `on/true/yes`）显式打开，启动时在 stderr 说明；未设置时工具照旧报错。
  - `luban web` / 浏览器工作台沿用桌面那套药丸 + `/api/computer`，无需改动。
- 新增 `src/ui/app-computer.test.tsx`（真实 TUI：`/computer status` 如实报缺屏幕录制、`on` 后 `control.enabled === true` 且标题栏出现 `⌁ 电脑操控`、裸命令切回关闭）；`src/core/computer.test.ts` 增加 `beginFromEnvironment` 用例（未设置/`0` 不开启，`1` 开启）。现在共 8 + 1 + 2 + 5 个电脑操控用例。
- 文档：`docs/computer-control.md` 增「三个入口」对照表。

## 2.3.19 — 2026-11-13

- 新增「电脑操控」：luban 现在可以截屏、移动指针、点击/双击/右键、拖拽、滚轮、打字和按快捷键，和 Codex 一样在需要时接管这台 Mac。所有输入都只经过一个编译型 helper（`apps/desktop/native/computer.swift`，`swiftc` 按源码哈希编译进 `~/.luban/bin`，也可用预编译产物/LUBAN_COMPUTER_HELPER 覆盖），Node 侧不直接注入事件。
- 安全默认：工具在开关关闭时**直接报错**而不是静默无操作；桌面 Agent 栏顶部新增「电脑操控」药丸开关（只在 macOS 出现），开启后屏幕四边燃起蓝色燃弧 + 顶部徽标「luban 正在操控 ⌘. 停止」，`⌘.`（全局快捷键）中止：桌面写 `~/.luban/computer/stop`，后端每个动作前都重读该标志，失控循环在下一步立即中断；关掉后约 0.7s 就熄火。
- Electron：新增透明全屏覆盖窗口 `apps/desktop/glow.html`（`setAlwaysOnTop("screen-saver")`、`setIgnoreMouseEvents`、不抢焦点、全屏/多桌面可见），用 Canvas 画边缘渐变 + 沿边游走的锯齿电弧，`prefers-reduced-motion` 降级；后端（子进程）通过 `LUBAN_GLOW_URL` 回环端点 + `x-luban-glow-token` 把 begin/action/end 事件推过来，不需要跨进程 IPC。
- 权限如实上报：`check` 同时返回 AX、`CGPreflightPostEventAccess()` 与屏幕录制三项，前端缺权限时药丸显示虚线并提示「系统设置 → 隐私与安全性」；`cursor`/`screenshot` 只读，`status` 不要求开关。
- 指针移动改为 `CGWarpMouseCursorPosition` + `.mouseMoved` 双保险：TCC 归属到 launcher 时 `post` 会被静默丢弃（实测 Node 子进程 move 不生效），warp 不依赖授权，所以移动始终精准，post 只负责让窗口感知 hover。
- 新增 `src/core/computer.test.ts`（7 例：未开启拒绝、⌘. 中止与重开、截屏落 `.luban/computer` 且只留 20 张、权限探测、glow begin/action/end、双击/右键动词、helper 定位）、`src/web/computer-endpoint.test.ts`（2 例）、`src/web/client/computer-control.test.tsx`（5 例）。
- 验证：`tsc`（server+client）干净；真实 helper 实测 `check` 全绿、`screenshot` 3360×2100 全屏 PNG、`move` 由 293→333 且可回位；Chrome 渲染 `glow.html` 采样边缘像素为蓝色 (49,74,112)、中心保持背景色；`npx vitest run src/web src/core/computer.test.ts` 59 文件 / 361 用例通过（唯一失败是既有的 macOS tmpdir 符号链接用例）。

## 2.3.18 — 2026-11-12

- 桌面三栏整体收紧，把「很多空间用不上」的地方压回来（1680×1050 实测，只动桌面作用域，手机端不加改动）：
  - 左栏 chrome 238px → 148px：品牌条 54→40、项目区 77→39（标签和「打开文件夹/新窗口」并成一行，只有工作区路径独占一行）、主题选择 67→35（标签与选择并排）、文件/会话标签 40→34；文件行 27→24、分组标题 32→24、「新会话」与列表行内边距同步收敛。
  - 中栏：代码标签 45→32、文件头 54→38、欢迎页 20px 内边距与 24px 标题收到 16/20、编辑信息条 4→3；控制台默认高度 240→190（`DEFAULT_CONSOLE_HEIGHT`），标签条 35→30、格式行 37→21、命令输入行 48→39、折叠高度与标签条等高（30）不再留空带。
  - 右栏：标题条 54→40、会话 tabs 34→28、会话提示 9/14→6/10、消息间距 13→11；composer 164→121（文本框 62→40、chip 行 6→3、发送键 30→24）。
- 新增 `src/web/client/desktop-density.test.ts`：把上面这些上限写成预算（品牌条 ≤40、文件头 ≤38、控制台默认 = 190 且折叠高度 = 标签条高、composer 文本框 ≤40 等），以后再加 padding 会直接变红。
- 验证：`tsc`（server+client）、`npm run build`、`npx vitest run src/web/client`（35 文件 / 222 用例通过）；CDP 在 1680×1050 下逐块复测上述高度。

## 2.3.17 — 2026-11-12

- 桌面右侧 Agent 栏重排，解决「内容显示不全 + 头像在最左边留一条空边」：头像从独立左列挪进名字行（`<div class="head"><div class="avatar">Y</div>你…`），`.msg` 不再是 `26px 1fr` 网格，`.note`/`.thinking-block`/工具卡/结果卡/运行条都不再各自缩进，整个栏只有一个左边缘（实测正文 x=27→13，行宽 501→529）。
- 历史会话的 `session-body` 之前在桌面栏里又补了 15px 内边距，和实时消息差 12px，形成两条左基线；现在统一为 `.desktop-agent .session-body { padding: 0 0 16px }`，banner 也回到同一条线。
- Markdown 表格：外层 `.md-table` 横向滚动，单元格 `min-width: 96px`。之前父级 `overflow-wrap: anywhere` 让表的最大内容宽度塌缩，5 列表格被压到 39px/列、字挤成竖排；现在 5 列各 96–99px，8 列时容器 529px、内容 769px 可左右滚动，不再被右侧裁掉。
- 新增 `src/web/client/desktop-agent-layout.test.tsx`：用 `renderToStaticMarkup` 断言头像在名字行内、`.msg` 没有头像网格列、`session-body` 单左边缘、表格最小列宽与可滚动。
- 验证：`npx tsc -p tsconfig.client.json --noEmit`、`npm run build`、`npx vitest run src/web/client`（34 文件 / 218 用例通过）；CDP 探针在 554px 栏宽下复测左偏移、行宽、表格 5 列/8 列滚动，并确认会话区与输入框无重叠、页面无横向溢出。

## 2.3.16 — 2026-11-12

- 修 `npm run release` 的 Electron 环节卡死：本机缓存里已有校验通过的 `electron-v44.4.5-darwin-x64.zip`（GitHub 地址的缓存目录），而脚本强制用 npmmirror 镜像，URL 不同→缓存键不同→又去重新下 134MB，180 秒超时后整条 release 失败。现在 `ensureElectron` 依次尝试：配置的镜像 → 直接从任意缓存目录里找校验通过的归档并解包（`seedElectronDist`，与 `electron/install.js` 写入 `dist/version`、`path.txt` 的方式一致）→ 官方地址。三者都不可用才报错，报错里带上缓存路径与实际缺的文件。
- `ensureElectron` 改为 async（`scripts/release.mjs`、`scripts/package-windows.mjs` 调用处加 `await`）；新增 `electronCacheRoot` / `electronArchiveName` / `findVerifiedArchive` / `cachedElectronArchive`，缓存目录扫描按名字排序，重试结果稳定。
- 验证：`node --test scripts/release.test.mjs`（7 项通过，新增「不同镜像目录下的同一归档按 sha256 复用、校验不符不采用」）；`npm run release` 在原先失败的同一条命令下产出 2.3.16 的 mac x64 CLI ZIP 与 DMG。

## 2.3.15 — 2026-11-12

- 查清「手机上一条消息接在了不相关的会话上、工作目录还是 /tmp/luban-phone」：本机一直留着一个 `luban web /tmp/luban-phone --relay` 的测试进程（11-11 08:11 起），手机仍钉在它上报的中继节点上，于是会话列表是那个临时目录的测试会话；而任务列表是整机范围的（`/api/jobs` 把 `~/.luban/jobs` 全量返回），所以那个会话里那句「你帮我看看第二个实验主要是做什么？」在这台手机上看起来像是接着那个测试会话。桌面侧其实是对的：该任务 `project_id=<项目>`、`session_id=…`、`workspace=~/Documents/<项目>`。已停掉该残留进程。
- `GET /api/jobs` 支持 `?project=`（`MeshJobStore.list` / `MeshRuntime.jobs` 增加项目过滤；没有 `project_id` 的旧任务仍然可见）。不带参数仍是整机视图，桌面控制台行为不变；手机按当前工作区拉取任务，不再把别的项目的会话列进自己的任务流。
- `continuationForPrompt` 现在把**被打开会话自己的 project** 带进接续请求（之前丢弃 project，`project_id` 回退成手机当前工作区）：手机停在一个工作区、看着另一个工作区的会话时，下一条指令不会再跑错目录。
- 修一个自动选会话的抢跑：点了任务但任务详情还没回来时，`job` 是空的，自动选会话会趁机把一个无关会话设成「待接续」；现在任务列表里存在的选中任务也算「活动视图」。
- 验证：新增 `src/web/jobs-scope.test.ts`（同一台机器上 conductor / luban-phone / 旧任务三种记录的过滤矩阵，去掉过滤时该用例变红）、`mobile-continue.test.ts`「带被打开会话自己的 project」；`npx tsc -p tsconfig.json --noEmit`、`npx tsc -p tsconfig.client.json --noEmit`、`npm run build`、`vitest src/web src/core/mesh`（383 passed，仅 `server.test.ts` 那个 macOS `/var` 与 `/private/var` 旧有失败）通过。

## 2.3.14 — 2026-11-12

- 定位「ssh 里一直闪」的真正来源：手机远控的中继日志走 `console.error`，Ink 对 console 的处理是「擦掉整帧 + 写这行 + 整帧重画」，链路抖动时每 2～3 秒一次，远端看到的就是整屏闪一下。日志改为交给 TUI（`subscribeRelayLog`），在状态区占一行最多 8 秒，不再碰终端帧；无 TUI 时仍写 stderr。
- `terminal-output.ts` 增加兜底：只有行擦除（`2K`/`1A`/`G`）不含内容的写入直接丢弃，并让紧随其后的整帧重画补齐。任何来源的 console 输出都不会再先擦空屏幕；`\u001b[2J` 之类整屏清除仍原样下发。
- 服务器实测（自定义 SSH 端口，120×74 PTY）：修复前 13 秒内 5 次 `erase2k=74` + 每次 20KB 整帧重画，修复后仅剩按行重画。
- 验证：新增 `terminal-output.test.tsx`「丢弃整帧擦除后仍整帧重画」与 `app-relay-notice.test.tsx`「中继日志进状态行、不进 console」；`npx tsc -p tsconfig.json --noEmit`、`npm run build`、`vitest src/ui src/web` 通过。

## 2.3.13 — 2026-11-11

- 修「ssh 打开还是闪烁」里的可修部分：绝对行重画原先只在「帧高 = 终端行数 - 1」时启用，对话框、短画面等其它高度会退回 Ink 的「擦除整帧再重画」，正是闪的来源。现在只要帧放得下终端（`1 ≤ 帧高 ≤ 行数`）都按绝对行重画，并只重画内容变化的行。
- 新增 `LUBAN_TUI_TRACE=/tmp/tui.log`：每次写入记一行，`absolute rows=3/24 painted=1 bytes=…` 表示按行重画 1 行，`ink bytes=… rows=… erase2k=…` 表示这次落入 Ink 原始路径，`erase2k>0` 或 `control` 标记能直接看出是哪类写入触发整屏擦除。上限 4000 行，写文件失败不影响界面。
- 验证：`terminal-output.test.tsx` 新增「非 rows-1 高度也按绝对行重画（不含 `2K`）」与「trace 文件记录两类写入」两条；`npx tsc -p tsconfig.json --noEmit`、`npm run build`、`vitest src/ui/*` 全绿。

## 2.3.12 — 2026-11-11

- 修「ssh 到 Ubuntu 跑 luban，样式传不过去」：`ssh` 默认只转发 `TERM`，不转发 `COLORTERM`，颜色库据此把远端会话判成 16 色甚至无色。新增 `src/ui/terminal-capabilities.ts` 统一判定（`NO_COLOR`/`FORCE_COLOR`/`TERM=dumb` 优先，`truecolor`/`24bit` → 24 位色，`*256color` → 256 色，其余远端 TTY → 256 色，本机保持保守推断），并由 `src/ui/terminal-boot.ts` 在 Ink 加载前把色号直接设到 chalk：不能用 `FORCE_COLOR`，color 库对它的任何值都跳到 24 位色，只支持 256 色的终端会把 `38;2;r;g;b` 显示成无色。实测同一条 `<Text color="#7aa2f7">` 在 `TERM=xterm` 的远端会话下从无 SGR 变成 `38;5;111`。
- 修「控制台闪烁」：整屏重画。`terminal-output.ts` 原来每帧把每一行（皮肤底色整行）重写一遍，一次按键约 3.9 KB；现在只重画内容变化的行，窗口尺寸变化/外部日志/二进制写入立即全量重画，另外每 120 帧全量重画兜底。实测 41 行界面按一个键从 ~3880 B 降到 23 B（2 行）。Ink 6 自己已经用 DECSET 2026 包帧，所以没有重复添加同步序列。
- 新增 `LUBAN_TERM_INFO=1` 打印一行判定依据（`TERM`/`COLORTERM`/是否 ssh/最终色号），`LUBAN_MASCOT=0` 仍可单独关闭背景图；`chalk` 提升为显式依赖（5.6.2）。
- 验证：`src/ui/terminal-capabilities.test.ts`（色号判定矩阵、远端兜底、`NO_COLOR=0` 例外）、`src/ui/terminal-output.test.tsx`（只重画变化行、尺寸变化全量重画、真实 TUI 一次按键 <6 行且 <400 B）；把 `repaintAll` 强制为 `true` 时这两条新断言会红，恢复后 8 passed。`npx tsc -p tsconfig.json --noEmit`、`tsc -p tsconfig.client.json --noEmit`、`npm run build` 通过。

## 2.3.11 — 2026-11-11

- 修「刚跑完就退出，统计就少一截」：所有退出路径（TUI 退出、一次性 `--prompt` 跑完、`luban web`/`luban serve` 停机、desktop 关窗口时 `--parent-pid` 后端退出、`luban bot run` 停止）现在都会在给退出码之前强制补发一次待上报增量（新增 `flushUsageStatsOnExit`，`force` + 最长等 2 秒，超时的守卫定时器 `unref` 掉，不会拖着终端不关）。
- 顺手修掉一个会算错的并发缺口：`usage-stats.json.lock` 独占账本，同一时刻只有一个进程上报（抢不到就跳过，锁文件超 30 秒视为崩溃残留自动接管）；成功回执改成「按已发送的量从 pending 里**减**」而不是「写回发送前读到的快照」，所以上传途中结束的另一次运行不会被覆盖掉。
- 实测（本地起 127.0.0.1:18999 收包）：`LUBAN_HOME=<tmp> node dist/cli.js stats` 结束前发出 `{"input":77,"output":9,"runs":2}`，账本 pending 归零、reported 15/3/2，整条命令 0.97s；把地址指向没人监听的 19999 端口时同样 0.97s 退出、pending 原样保留、failures=1。
- 验证：`src/core/usage-stats.test.ts` 新增「退出时无视间隔仍上报且第二次不发请求」「并发三个 flush 只发一次」「上传途中记录的新运行不丢」「锁被别人持有则跳过 / 锁文件过期可接管」（15 passed），`npx tsc -p tsconfig.json --noEmit`、`npm run build` 通过。

## 2.3.10 — 2026-11-11

- 修「token 统计不及时、看板刷不出来」：根因是客户端默认 `interval_hours: 6`，而且 `usage_stats.interval_hours` 走的是 `integer()`（`0.25` 被截断成 `0` 再被 `Math.max(1, …)` 抬回 1 小时），所以想调快也调不动。现在默认改成 **15 分钟**（`0.25`），`config.ts` 换成保留小数的 `flexible()`，下限 1 分钟、上限 168 小时；`usage-stats.ts` 同步去掉「最小 1 小时」的夹取。
- 新增 `luban stats` 命令：打印本地账本的待上报/已上报 token 与运行次数、上次尝试与上次成功时间、当前上报地址与间隔；`--push` 忽略间隔立刻补发一次，失败时打印真实原因（新增 `flushUsageStats({ onError })` 钩子，`force` 跳过节流），`--json` 便于脚本排查。
- 实测：`luban stats` 显示 pending 5,242,786 input / 20,430 output · 5 runs；`luban stats --push` 之后服务端 `/api/stats` 立刻从 80,778,883/482,918/38 变成 86,021,669/503,348/43，与本地账本逐字节对齐。
- 验证：`src/core/usage-stats.test.ts` 新增「0.25 小时间隔下 14 分钟跳过、15 分钟放行」「`force` 立即发送 + `onError` 拿到 ECONNREFUSED」；`src/core/config.test.ts` 新增「默认 0.25、小数被保留、<1 分钟被夹到 1 分钟、LUBAN_USAGE_STATS=off 生效」（55 passed）。

## 2.3.9 — 2026-11-11

- 统计服务整体搬出本仓库，独立成 https://github.com/holylong/luban-server （零依赖 ESM、自带 dashboard、`node --test`）：删掉 `src/stats/`、`deploy/luban-stats.service`、`scripts/deploy-stats.sh` 和 `stats:serve` 脚本；客户端协议（`POST /api/report`、`GET /api/stats`、`/health`）与 `usage_stats.url` 不变，线上 18080 继续收数。
- 新仓库的看板重做：7/30/90 天区间、按区间补齐空白日期的柱状图（输入/输出两段）、按天明细只列有上报的日期、版本与平台分布、60 秒自动刷新、390px 手机单页不横向溢出（用 CDP 量 `scrollWidth == clientWidth` 确认，表格各自横向滚动而不是撑破页面）。
- 补齐「连不上统计服务 / relay 也不能影响本地」的回归测试：`usage-stats` 新增一条「服务端接了连接却不回包 → 40 ms 超时后返回 failed、增量原样留在账本、failures=1」；新增 `src/web/tunnel-offline.test.ts`，对端不监听时 `TunnelClient.start()` 仍立即返回（<500 ms）、状态落到 offline 并打 `relay unavailable`，`stop()` 干净退出。
- 验证：`npx vitest run src/core/usage-stats.test.ts src/web/tunnel-offline.test.ts`（10 passed）、`npm run build`、`npx tsc -p tsconfig.json --noEmit`；`grep` 确认仓库里已无 `src/stats` / `luban-stats` / `stats:serve` 残留。

## 2.3.8 — 2026-11-11

- 修手机 WebView 版里「会话记录一长，发送按钮就没了」：`.m-compose` 是 `display: grid` 却没写 `grid-template-columns`，隐式 `auto` 轨道按最宽子元素的 max-content 定宽，而底部那行摘要正好印着会话标题、工作区路径和模式 —— 标题一长，整个输入区被撑到 410px（屏宽 390px），右边的 ↑ 按钮被 `.m-app { overflow: hidden }` 切掉。现在 `.m-compose` 用 `minmax(0, 1fr)` 固定成屏宽，`.m-compose-summary` 补 `width: 100%; min-width: 0; overflow: hidden`，`.m-compose-box` 补 `max-width: 100%`。
- 同一个截图里还有第二处超宽：会话标题 `<h3>` 没有换行规则，标题里带一段长路径/哈希时 `.m-main` 会横向滚动（实测内容 614px / 屏宽 390px）。`.m-main-inner` 的 `h1/h2/h3` 加 `overflow-wrap: anywhere`，标题按屏宽换行。
- 验证：用 Chrome 在 390×844 下量同一段标记（`iframe` 固定 390px 宽，部署版 `mobile.css`），修复前 `.m-compose` scrollWidth 410、`.m-send` 右边缘 403（屏宽 390），修复后 390 / 371，`.m-main` 的 scrollWidth 从 614 回到 390；`src/web/client/mobile-layout.test.ts` 新增两条断言（换回旧 CSS 会红，已确认），`npx vitest run`（mobile-layout / collapse / session / continue 共 21 passed）通过。

## 2.3.7 — 2026-11-11

- 服务器上的使用统计服务其实从来没装起来：没有 `luban-stats.service`、没有 `/opt/luban-stats`、`ss` 里 18080 也没有监听，所以客户端一直在往一个没人接的端口上报。现在按 `deploy/luban-stats.service` 装好并 `enable --now`，`POST /api/report` → `/var/lib/luban-stats/reports.jsonl` → `GET /api/stats` 全链路打通，`GET /` 看板 200。
- 部署脚本在 macOS 上会把 `._server.js` 这类 AppleDouble 文件一起打进包里、落到 `/opt/luban-stats`；现在打包用 `COPYFILE_DISABLE=1` 加 `--exclude '._*'`。
- 单元里的 `ExecStart=/usr/bin/node` 是写死的，这台机器上根本没有 `/usr/bin/node`（node 在 `/usr/local/bin/node`，systemd 直接 `status` 就起不来）：`deploy/luban-stats.service` 改成 `/usr/bin/env node` 并显式声明 `PATH`，`scripts/deploy-stats.sh` 安装时再把 `ExecStart` 改写成远端 `command -v node` 找到的绝对路径。
- `docs/usage-stats.md` 补上「只有 sudo 普通用户、没有 root 直连」时的等价部署步骤（只有 sudo 权限、没有 root 直连的普通用户就是这种情况）。
- 验证：`npm run build:server` 通过；`npx vitest run src/stats src/core/usage-stats.test.ts`（14 passed）；本机另起一份 `dist/stats/server.js` 跑通 health/report/stats/看板；远端 `systemd-analyze verify` 0、`is-enabled=enabled`、`is-active=active`、`curl http://127.0.0.1:18080/health` 返回 `{"ok":true}`，从外网 `curl http://https://submitting-reseller-trustee-fairy.trycloudflare.com/health` 也是 200（ufw 未启用、iptables INPUT ACCEPT、安全组已放行），测试上报的数据已从 `reports.jsonl` 清掉并重启确认统计归零。

## 2.3.6 — 2026-11-11

- 新增独立使用统计服务 `src/stats/server.ts`，部署在 `https://submitting-reseller-trustee-fairy.trycloudflare.com`，零依赖、只用 Node 内置模块：`POST /api/report` 收客户端增量，`GET /api/stats` 出汇总 JSON，`GET /` 是中文看板（安装数、7/30 天活跃、总 token、输入/输出分开、最近 30 天按天、按版本、按平台），`GET /health` 供 systemd/监控探活。数据是一个追加写入的 `reports.jsonl`，内存汇总，重启重放日志恢复；按 IP 限流 120 次/分钟，请求体上限 16 KB，可选 `LUBAN_STATS_TOKEN` 给看板加 Bearer 鉴权。
- 客户端新增 `src/core/usage-stats.ts`：`~/.luban/usage-stats.json` 保存随机安装 id、待上报增量、已确认总量；agent 每轮结束在 `finally` 里按 `RunMetrics.requests[].usage` 累加（每次模型调用算一次，含 compaction/handoff，中断的运行也算已产生的部分），默认 6 小时最多上传一次，约 200 字节，空闲且无待报数据时完全不发请求。
- 失败不丢数据也不风暴：上传失败保留增量、间隔按 2 的幂翻倍（最多 16 倍），恢复后一次性补发；全新安装会发一条 0 token 心跳把「装了」和「跑了」区分开。开关：`usage_stats.enabled` / `LUBAN_USAGE_STATS=off`，地址可配 `usage_stats.url` / `LUBAN_USAGE_STATS_URL`。
- 新增 `src/core/usage-stats.test.ts`（8 条：记账、安装 id 稳定、心跳、间隔节流、成功后清零、失败退避、关闭后静默、坏文件恢复）与 `src/stats/server.test.ts`（6 条：去重安装数、输入输出分列、重启重放、坏请求拒绝、活跃窗口、看板与鉴权）；`docs/usage-stats.md` 写明上报字段、配置、接口与部署；`scripts/deploy-stats.sh` + `deploy/luban-stats.service` 一键部署（编译、校验 sha256、装服务、健康检查）。

## 2.3.5 — 2026-11-11

- Mesh 超时不再判失败：`job_timeout_seconds` 到点以前直接 abort 运行、把任务记成 `TIMEOUT after Ns`，手机和 TUI 都弹「任务失败」，一个只是需要更久的正常任务被当成坏了。现在它只在本机任务日志里写一条 `still running after Ns (job_timeout_seconds)` 并推到执行时间线，运行继续跑到自己的结果，`done` / `paused` / `failed` 由真实结果决定。
- 等待远程任务的一边同样按最后状态判断：`mesh_handoff` / `mesh_ask_all` 等不到结束不再发 `job_cancel`、不再把本地镜像记录写成 `failed`，而是返回 `remote job <id> on <peer>: working` 加日志末尾几行和 `stopped waiting after Ns` 说明；发起方随后在后台继续轮询（顺带续着对方租约），对方真正结束后把最终状态与结果写回本地记录，广播行显示 `[working]` 而不是 `[failed]`。
- 排队超时（`queue_timeout_seconds`）仍然算失败：任务根本没开始跑，没有结果可等。真正的中止依旧走明确的两条路径——提交方主动取消、提交方心跳租约过期。
- 新增 `src/core/mesh/runtime.test.ts` 两条用例：运行超过 `job_timeout_seconds` 仍以真实结果收尾；等待超时后既不取消也不判失败，本地记录跟到对方的最终状态。`npx vitest run src/core/mesh`（43 passed / 1 skipped）、`tsc -p tsconfig.json --noEmit` 与 `npm run build` 通过；`docs/reference.md` 补上「超时只报状态，不判失败」一节，`mesh_handoff` / `mesh_ask_all` 的工具说明同步更新。

## 2.3.4 — 2026-11-11

- 修好手机「接续会话」只接一轮就断：打开一条历史会话，第一条指令正常追加，第二条却新建了一个 session，会话列表里凭空多出一条。原因是手机发完一轮为了看实时进度清掉了会话指针，而任务自己记录的 session id 从来没被读回来。现在「下一条指令写进哪个会话」由屏幕上的会话（或当前任务所属的会话）决定，连续派活都落在同一个会话里。
- 会话还在执行时不再被并发派活：以前第二条指令会另起一个任务，同一个工作区被两轮同时改，还落在新会话里；现在直接提示「本轮还在执行，等它结束后再发下一条」，指令留在输入框，不会被吃掉。
- 任务视图顶部补上「接续 · 会话名」，右侧「＋ 新会话」可以明确另起一个会话；输入框下方摘要也跟着显示真正的接续对象，而不是一律写「新会话」。
- 新增 `src/web/client/mobile-continue.ts` 与五条单测（打开会话、任务所属会话、无会话时新建、会话标题回退到任务标题、接续沿用任务的项目），`tsc -p tsconfig.client.json` 与构建通过。

## 2.3.3 — 2026-11-10

- 手机上选一台电脑后直接打开它最新的会话：以前不管那台电脑刚干了什么，进来都是一片空白的「让电脑帮你做什么？」，前一天的工作藏在 设置 → 会话 里。现在设备列表点进去、或在 设置里切换电脑，都会自动接上最新那条会话（按更新时间排第一），输入框变成「继续当前会话…」。
- 自己选过的会话或「新会话」会被记住，不会被自动切换覆盖；live 里正挂着任务时也不会被会话抢走。
- 新增 `src/web/client/mobile-session-pick.ts` 与四条单测（最新会话、已选不覆盖、任务优先、没有会话时留在空白），真机尺寸探针补上「默认打开」检查，并给探针加独立临时 profile，避免上一次的 localStorage 影响结果。

## 2.3.2 — 2026-11-10

- 手机「设备」页不再替离线电脑报活：中继只保留节点最后一次上报，电脑断线后那张卡片还会继续写「正在工作 · 某个会话」，点进去却什么也没有。现在离线节点只显示「离线，状态已停止更新」，终端会话那几行和「N 个进行中」都不再出现，历史任务仍然保留。
- 设置页的模型列表和会话列表改成折叠面板：标题行直接显示当前用的模型（名字 · 供应方）和当前会话（继续：标题），点一下才展开完整列表和推理强度、其它会话。以前两段长列表把整页撑满，换一个模型要滚好几屏。
- 会话改成带时间与会话名的行，选中项高亮；折叠面板带 `aria-expanded`，键盘和读屏都能用。
- 新增 `src/web/client/mobile-collapse.tsx`：「默认收起、标题显示当前值」的折叠面板，补上折叠/展开与无障碍标签的渲染测试。

## 2.3.1 — 2026-11-10

- 修好手机「设备」页看不到终端正在干活：节点以前只上报 mesh 任务，桌面端每一轮对话都是一个任务，所以设备卡片能显示「执行中」；CLI/TUI 的会话在本进程里跑、从不产生任务，于是笔记本明明在写代码，手机上一直写「空闲，等待派活」。现在每次中继上报会同时带上终端里正在跑的会话（标题、项目、最后写入时间，最多 8 条），设备卡片显示「正在工作 · 会话标题」，并与已完成的历史任务并排；「N 个进行中」按任务加终端会话合计。
- 只统计本机（按 luban home 隔离）的会话，跨机器的会话不会串台；桌面端由任务托管、本来就在任务列表里的会话不会重复出现。
- 会话只做轻量投影（id/项目/标题/更新时间），不带会话记录和回放事件，避免每次中继轮询都把整段对话克隆一遍。
- 新增 `src/web/client/mobile-device-card.tsx`：设备卡片抽成组件，补上「终端会话进行中」「任务与终端会话并存」「没有状态上报」等渲染测试。

## 2.2.20 — 2026-11-10

- 桌面端文件树支持右键菜单：打开、在访达中显示（Windows 是资源管理器）、复制路径（真的写进系统剪贴板）、新建文件/新建文件夹、重命名、移到废纸篓。菜单在鼠标位置弹出，贴边时自动翻到内侧；新建和重命名直接在树里就地输入名字，回车提交、Esc 取消，名字按工作区规则校验（不能空、不能带 `/`、不能是 `.`/`..`）。
- 修好右侧会话栏宽度拖不动：以前拖动把「增量」叠加在上一次渲染的值上，React 合批连续 pointermove 后只有最后一个事件生效，所以拖半天只挪一下甚至不动。现在以按下那一刻的宽度为基准加上指针位移，每个移动都按位换算，指针移出把手也继续跟随（pointer capture）；最窄从 300px 放宽到 240px，编辑器一侧不会被压没。
- 会话栏、文件栏、终端三种分隔条共用同一套拖动逻辑，方向键每次移动 24px，并带上 `aria-valuenow`。
- 新增 `scripts/desktop-ui-probe.cjs`：真实 Electron 窗口里验证右键菜单、复制到剪贴板、就地新建文件与拖动收窄（495px → 375px，最窄停在 240px）。

## 2.2.19 — 2026-11-10

- 手机端「接续会话」那条提示压成一行：左边「接续」+ 会话名（超长省略号），右边一个描边胶囊按钮「＋ 新会话」。以前标题和按钮各占一行，白白吃掉聊天的两行高度，按钮还是灰底，几乎看不见。

## 2.2.18 — 2026-11-10

- 手机端一直没跟随的真正原因：滚动跟随在组件挂载时就绑定了容器，而控制台先渲染登录页、登录后才有会话区域，第一次绑定拿到的是空节点且不会重试。现在改为容器出现后再绑定，登录前后都能跟随。
- 顺带把桌面会话区改成同样的绑定方式，避免切换会话时丢绑定。

## 2.2.17 — 2026-11-10

- 会话记录和运行时不再停在开头：以前切一次标签页（内容变矮、滚动位置被夹回去）就会被当成「用户往上翻了」，之后整场任务都不再自动跟随最新内容。现在只有内容高度不变时，才把滚动算成读者自己的操作。
- 打开一个历史会话或接续一个任务会直接落到最新一行，执行过程中持续跟随；手动往上翻则暂停跟随，翻回底部自动恢复。

## 2.2.16 — 2026-11-10

- 修好手机 App 里「已登录却一直显示未登录 · 点右上角重新连接」：账户登录发生在页面内部，不会重新加载文档，原生壳因此收不到 `onPageFinished`。现在页面连上节点后通过 `lubanShell.setConnected(true)` 告诉 App 收起提示；壳也在页面历史变化时重新检查登录 Cookie，老页面同样能恢复。
- 手机控制台不再为系统栏重复留白：外壳已经给 WebView 让出状态栏和手势条，页面里再去加一层安全区，等于白丢一整行高度。现在页面在壳里运行时把安全区归零，头部从 91px 回到 47px，正文多出约 90px。
- APK 版本 1.16.25。

## 2.2.15 — 2026-11-10

- 手机 App 壳（`apps/android-app`）不再常驻「已连接 · 服务器」那条：WebView 占满整屏，连接状态只在「连接中 / 未登录 / 连接失败 / 证书错误」时以浮层药丸出现，连上后自动收起，标题栏那一行的高度全部还给会话记录。菜单改成右上角浮动「⋮」，菜单顶部显示当前状态、正在跑的任务和 App 版本，下面是外观设置、刷新页面、连接记录。
- 页面右上角的「设置」文字去掉（底部「设置」标签本来就在），空出的角落留给 App 的 ⋮；在 App 里打开时自动给标题行右侧留出 46px 避让。
- 「设置」页顶部新增「App」卡片：App 内的页面不再有原生状态条，外观、刷新、连接记录从这里或右上角 ⋮ 打开。
- 会话记录读取更稳：电脑端没能返回 `messages` 时按空记录处理，不再整页白屏（此前在手机上选一张历史会话可能白屏）。

## 2.2.14 — 2026-11-10

- 手机页面把顶部长条压成一行：`● my-mac deepseek-v4.1-flash … 设置`，中继模式、节点、模型选择、发版信息全部从头部移除，头部高度从 106px 降到 47px；这一行本身可以点，直接跳到「设置」。
- 会话记录区随之变大：390×844 的手机上从 548px（65%）增到 620px（73%），打开会话后整屏都是聊天记录，只有底部输入区和标签栏占剩下的空间。
- 「继续会话 / 项目 / 权限」三个下拉和「新建工作区 / 添加已有目录」从输入框上方搬到「设置 → 派活」；输入框上方只留一行摘要（`新会话 · luban · 可改文件` 或 `接续 · 会话标题 · …`），点右侧「派活设置 ›」直达设置页。
- 模型选择不再挤在输入框旁边（那不是随便点的地方），改为「设置」里的模型列表，每项显示 `名称 · 提供方`，当前项高亮。

## 2.2.13 — 2026-11-10

- 修掉手机上“同一条指令出现很多条记录”：桌面端每个窗口的本地服务如果随 app 一起被强杀（崩溃、冒烟测试、强退），进程会变成孤儿并继续轮询中继，手机上就多出一台「my-mac · 临时目录」的设备；这些设备又共用同一个任务目录，于是同一条指令在每张卡片上各出现一次。后端现在带 `--parent-pid`，父进程消失即自行退出（按 ppid 变化判断，不用信号），不再留孤儿。
- 设备卡片只上报“这台设备被派过的任务”（`target` 命中或本实例 `instance_id` 命中），不再把整台机器的共享任务列表复制到每张卡片上。

## 2.2.12 — 2026-11-10

- 当前窗口已经打开项目时，再选一个文件夹会先问：「新窗口打开」「在当前窗口打开」「取消」。选新窗口时当前项目继续运行，选当前窗口会关掉它的本地后端并换成新文件夹（有未保存修改时会先确认），取消则什么都不做；启动时和窗口还没打开项目时不会多问。
- 菜单「文件 → 打开项目文件夹…」（`Ctrl/⌘+O`）、托盘同项和界面上的「打开文件夹…」按钮走同一个询问流程；「新建窗口」和「新窗口…」本身已表明意图，不再弹窗。把文件夹拖给已运行的 luban 时，如果那个文件夹已经开着就直接切到对应窗口。

## 2.2.11 — 2026-11-10

- 修复桌面版「新建窗口」点了没有反应：它先按文件夹查重，发现要打开的正是当前窗口的文件夹时只把那个窗口切到前台，于是一个新窗口都不出现。现在「文件 → 新建窗口」（`Ctrl/⌘+Shift+N`、托盘同项）以当前窗口的文件夹直接开新窗口，左侧「新窗口…」按钮选中的文件夹即使已在别的窗口打开也照样开新窗口。
- 「文件 → 打开项目文件夹…」（`Ctrl/⌘+O`）保留查重：该文件夹已经有窗口时切过去，没有才新建，避免误开重复窗口。

## 2.2.10 — 2026-11-10

- 桌面版可以同时打开多个窗口，每个窗口有自己的项目文件夹、本地后端、文件树、控制台/终端和未保存状态，像 VS Code 一样并排打开不同文件夹。菜单「文件 → 打开项目文件夹…」（`Ctrl/⌘+O`）为所选文件夹开新窗口，已打开同一文件夹的窗口会被切到前台而不是再开一个；`Ctrl/⌘+Shift+N`「新建窗口」和左侧「项目」旁新增的「新窗口…」按钮提供同样入口，「打开文件夹…」仍是把当前窗口换成另一个文件夹。
- 多窗口之间互不影响：IPC、`luban-media://` 预览和终端都按窗口路由到各自的 workspace 与后端端口，切换或关闭一个窗口不会动到其它窗口；托盘、桌宠与 bot 仍然只有一个，桌宠提交的任务记在提交它的那个窗口上，托盘提示显示当前窗口的项目。
- 再次启动 luban（或把文件夹拖到应用图标上）不会再起第二个进程，而是在运行中的窗口里打开该文件夹；同一设备只有一个中继槽位，只有第一个窗口的内置后端带 `--remote`，其余窗口只跑本机服务。
- 新增 `npm run smoke:desktop`：用 Electron 主进程 + 真实本地后端的无界面冒烟脚本，验证双窗口、各窗口 IPC/媒体路由、原地切换文件夹和关闭互不影响。

## 2.2.9 — 2026-11-10

- 修好桌面终端「只能用到一半、下边一片黑」的问题：终端尺寸以前在创建时算一次，之后拖动控制台、拉宽窗口或改字号都不会重新计算，xterm 只画最初的几行，被 CSS 拉满的剩余区域就是黑底，长输出也会被挡住。现在按 xterm 实际字符格尺寸重新测量，面板一变就重算行列并通知 pty 调整大小（`resizeTerminal`），输入换行、`htop`/`vim` 等全屏程序都跟着面板走。
- 打开「终端」标签页时控制台自动长到 420px（原来固定 240px，只有十来行），之后仍可拖动分隔条自由调整；终端右上角显示当前列×行。
- 终端栏新增 `A−`/`A+` 字号按钮（10–18），会记住选择，字号变化后自动重新适配行列。

## 2.2.8 — 2026-11-10

- 修复桌面版查询 Codex 额度总是失败的问题：从 Finder/启动器打开的 luban 拿不到终端里的 PATH，既找不到 `codex`，也会因为 PATH 里没有 node 让 npm 安装的 `codex` 启动脚本以 127 退出。现在会依次查 PATH、常见安装目录和登录 shell 的 PATH，并用 luban 自带的 node 运行 `#!…node` 启动脚本；对话走 HTTP 后端所以一直正常，额度查询是唯一需要启动 CLI 的功能。
- 额度查询失败时不再只显示「无法查询额度」，会给出原因和处理建议（找不到 codex / 未登录 / CLI 版本过旧 / 缺少 node），并附上已脱敏的 CLI 原始报错，便于定位。

## 2.2.7 — 2026-11-10

- 额度卡片显示 Codex 账户可用的重置卡数量；有多张时可在下拉框中选择指定的一张，再点「使用重置卡」并二次确认后重置，重置完成后自动刷新额度。
- 重置请求带幂等键并串行处理：连点或结果未知时重试不会多消耗一张卡；请求失败会提示先刷新额度确认，不会自动重发。
- 重置卡标题与到期日期、可选列表均来自账户返回值，卡片用完后立即隐藏；服务端校验重置卡标识和请求标识后再转发给 Codex。

## 2.2.6 — 2026-11-10

- 桌面选择 Codex 模型时，Agent 区顶部显示账户各额度窗口的剩余百分比、进度条和重置时间；剩余不超过 20% 标红并提示额度偏低。
- 每分钟自动刷新，支持手动刷新，窗口隐藏时暂停查询；后端合并并发请求并缓存一分钟，查询失败保留旧数据并提示，未返回额度时不误报为零。

## 2.2.5 — 2026-11-10

- 桌面文件树按格式显示不同的彩色 SVG 图标：代码、图片、PDF、Word、Excel/CSV、幻灯片、draw.io、音视频、压缩包、配置、Markdown、文本和数据库；文件夹区分展开与收起，未知格式保留通用文件图标。
- 识别大小写后缀、draw.io 复合后缀、`.env`/`.gitignore` 等配置文件和 Dockerfile/Makefile；图标内置，无需联网或额外读取文件内容。

## 2.2.4 — 2026-11-10

- 安装后的应用名统一成 `luban`：macOS 包名从 `luban Desktop.app` 改为 `luban.app`，`CFBundleName`/`CFBundleDisplayName`、DMG 卷名、Windows 版本信息与快捷方式、Linux 应用菜单、托盘提示、菜单栏应用名都只显示 `luban`。
- macOS 应用图标换成圆角版本：`assets/luban-app-1024.png` 按 macOS 图标栅格留边、圆角裁切后生成 `AppIcon.icns`，安装后不再是一个方角深色方块；`assets/luban-512.png` 仍是直角图，继续用于托盘、窗口和 Web UI。
- 桌面上「终端/控制台需要桌面连接」的提示改称 `luban 桌面版`，与新的应用名一致。

## 2.2.3 — 2026-11-10

- 桌面工作台可以预览表格和文档了：`.xlsx`/`.xls` 显示带行号、列标和工作表标签的只读网格，`.docx`/`.doc` 按标题、段落、列表、表格的顺序排成只读文章；超过 400 行、50 列的表格会提示还有多少内容没有显示。
- 新格式走本地解析，不联网：`.xlsx`/`.docx` 直接读 OOXML 包，`.xls`/`.doc` 由新的复合文档（OLE2）读取器解出 BIFF8 单元格和 Word 97 文本片段；解析失败时显示原因，并可「打开外部应用」。
- 版本号规则改成 `MAJOR.MINOR.PATCH`，PATCH 只在 1–20 之间，超过 20 时进位 MINOR 并从 1 重新开始（`2.2.20` 的下一版是 `2.3.1`）；规则写进 AGENTS.md 与 docs/release.md，`npm run release` 用 `versionProblem()` 校验，`2.2.0`/`2.2.21` 会直接失败。
- 新增 office/office-legacy 解析测试（含 XLSX、DOCX 与合成的 CFB/XLS 文档），以及表格、文档渲染用例。

## 2.2.2 — 2026-11-10

- MCP schema 预算默认值从 64 提到 128；仍可用 `mcp.max_tools`（4–256）覆盖，或 `mcp.lazy` 只注册检索调度器。
- 桌面工作台三栏之间加了分隔条，代码区与控制台之间也能拖动调高；窗口变窄时自动收回，布局记在 `luban.desktop.layout`。
- 文件树改为每 2.5 秒轮询根目录和已展开目录（窗口隐藏时暂停），新建或删除的文件不用重启就会显示；刷新按钮与重新展开目录都会重读该目录，不再用首次打开时的缓存。
- 桌宠「造物主」新增隐藏：主界面状态栏按钮、托盘菜单、视图菜单和桌宠右上角 ×，状态写入 `userData/pet.json`，下次启动沿用。

## 2.2.1 — 2026-11-10

- MCP 超出 schema 预算不再当作错误：以前每发一条指令都会弹「MCP startup: MCP schema budget reached (64)」，现在只在真正截断时给一行提示「MCP 工具已注册 N 个，另有 M 个超出 schema 预算，可用 mcp_search_tools / mcp_call 按需调用」，并以状态行显示。
- 同一份超限提示只输出一次，不再按服务器/按工具重复；真正的服务器启动失败仍报错。
- 新增测试覆盖预算截断、静默与失败三条路径。

## 2.2.0 — 2026-11-10

- 手机控制台（/m）的实时进度改成停靠条，固定在输入框上方、标签栏之上，切换标签也能看到；空闲或任务结束后自动消失。
- 会话与任务流在电脑输出时自动跟随到底部；读者上滑看历史时不会被拉回，重新打开任务时回到最新一行。
- WebView 外壳（android-app）的原生状态条通过 `lubanShell` 桥接显示「执行工具 · Shell · npm test · 12s」这类实时进度，停更时提示「等待输出」，结束后恢复「已连接 · 主机」；导航或重载会清掉过期进度。版本 1.16.23。
- 纯原生控制台（android-native）在任务页头部实时显示状态与百分比，并对流式输出跟随滚动到最新一行。版本 1.0.6。

## 2.1.0 — 2026-11-10

- 桌面版支持 PPTX 幻灯片预览：主进程直接解析 OOXML 包（不依赖 Office），按版式绘制文字、形状、图片和演讲者备注，幻灯片内的图片从压缩包按需流式读取。
- 桌面版支持 PDF：用 Chromium 内置查看器内嵌打开；「用系统应用打开」可交给预览/Acrobat 等处理。
- 桌面版支持 draw.io 图形：`.drawio`、`.drawio.svg`、`.drawio.png`（含压缩页面与内嵌 PNG 元数据）解析为可缩放 SVG，含节点、连线、箭头与换行标签。
- 文件预览按扩展名分流：图片/音视频/PDF 走媒体协议，PPTX 与 draw.io 走解析预览，其余仍进入代码编辑器；预览均可一键交给系统应用，且不影响未保存的编辑内容。
- 新增 ZIP/XML 轻量解析与文本换行模块，以及 PPTX、draw.io、预览路由与渲染测试。

## 2.0.37 — 2026-11-09

- 手机端新增工作区入口：可在电脑默认工作区目录新建，或输入电脑上已有目录的绝对路径注册为项目；注册信息写入电脑 config.json，重启后仍可见。
- WebView 与原生 Android 都可从工作区/派活选项进入；选定新工作区后可直接开启新会话，任务在该目录执行。
- Android WebView 1.16.21、原生 UI 1.0.5。

## 2.0.36 — 2026-11-09

- 手机离线不取消电脑已接收的任务；WebView 重连失败保留任务 ID，网络恢复、返回前台和备用轮询均补齐任务状态及执行记录。
- 控制台自动切到手机/网页派发任务的实时执行流，本地对话中也会显示任务阶段；手机设置新增模型列表与推理强度切换，电脑端更新后自动同步。
- WebView 保存草稿和提交待确认标记，响应丢失或应用退出后不自动重复派活；原生 UI 返回前台重新同步历史与进度，离线提示明确区分连接中断与任务失败。
- Android WebView 1.16.20、原生 UI 1.0.4。电脑进程需保持运行；权限确认、用户问题和已有任务超时规则仍有效，不因离线自动授权。

## 2.0.35 — 2026-11-09

- 原生 Android 1.0.2：会话历史与执行进度同屏，展示待授权/待回答提示；保存任务、会话及草稿，回到前台或重建应用后重连原任务，不自动重新派活。
- 提交请求独立于页面生命周期；提交结果不明时保留草稿并阻止重复发送，提示先核对任务。失败或暂停可恢复同一个任务 ID 和会话，保留已执行结果。
- 端侧远程执行发布会话实时事件，桌面当前会话同步历史和进度并阻止并发写入；恢复续接任务不再重复原始指令。端侧需升级本版本，单独更新中继无法替换电脑执行逻辑。
- 后台继续执行指电脑端持久任务，不依赖手机持续轮询；权限确认仍需用户明确授权，后台不会自动放宽权限。

## 2.0.34 — 2026-11-08

- 原生 Android 体验版 1.0.1：恢复页面切换后的底部导航，区分会话列表、记录与任务详情的返回层级。
- 页面请求按代次隔离，离开页面后丢弃迟到响应，停止旧任务轮询；切换设备清理旧项目，切换权限保留输入草稿。WebView 版保留。

## 2.0.33 — 2026-11-08

- Android 安装包版本更新至 1.16.18（11618），重新构建供 MixStore 分发；移动控制台仍从中继加载，布局更新需要单独部署网页资源。

## 2.0.32 — 2026-11-08

- 手机控制台重新整理页头：品牌与版本不换行，实例选择限宽，模型及工作区分行省略，避免长设备名挤出屏幕。
- 派活输入区仅在状态页显示，会话、项目和权限收进默认折叠的「派活选项」；保留草稿及选择，不再遮挡设备、任务、审批和设置页面。
- 修复设备在线状态和任务完成标签被挤成竖排；任务元数据允许换行，底部导航增加选中指示，输入提示不再重复长会话标题。

## 2.0.31 — 2026-11-08

- 修复 Android 壳编译错误：`Uri.Builder` 没有 `removeQueryParameter`，改为重建查询串后再写回 `theme` 参数，`assembleDebug` 通过。
- 手机端 1.16.17 APK 已构建（debug 签名，v2 签名块），并发布到 MixStore 供直接下载安装。

## 2.0.30 — 2026-11-08

- 手机控制台新增主题：深色 / 浅色 / 跟随系统，设置页可选；浅色配色重新推导了底色、卡片、diff 与审批提示，而不是简单反色；`?theme=` 参数可被 App 固定，避免原生窗口与页面配色不一致。
- Android 壳新增「外观设置」页：主题、文字大小（标准 / 大 / 特大，同时放大网页正文）、版本信息；设置即时生效并持久保存，系统深色模式切换时自动跟随。
- Android 壳重做界面：去掉默认灰色按钮，改为真实 App 栏（状态点 + 连接状态 + 溢出菜单）、圆角卡片、圆形图标按钮与涟漪反馈；连接页、连接记录、删除确认都按主题重新绘制。
- 手机页面整体放大字号（正文 16px、标签与工具卡片同步上调），加宽触控区域，底部标签栏图标与文字更大。

## 2.0.29 — 2026-11-08

- 桌面版新增系统托盘图标：单击或双击打开主界面，右键菜单提供「打开主界面 / 显示桌宠 / 打开项目文件夹… / 退出 luban」，悬停提示显示当前项目，解决窗口隐藏后找不到退出入口的问题。
- 关闭主窗口改为隐藏到托盘，后台服务、桌宠与常驻 bot 继续运行；结束进程统一走托盘「退出 luban」或菜单「文件 → 退出」，文件菜单另加「隐藏到托盘」。
- 托盘创建失败（没有状态栏的桌面环境）或启动失败时保持原来的退出行为，不会留下无法关闭的进程。

## 2.0.28 — 2026-11-08

- 修复手机长会话标题和完整项目路径撑出屏幕的问题；会话选择独占一行，项目和权限控件可收缩，发送按钮不再被挤出。
- 过滤实时同步桥中的纯 system 空草稿，并兼容过滤旧电脑返回的零消息会话；打开空记录时明确提示，而非留白。
- 会话列表错误独立展示，避免被设备连接成功状态掩盖；页面头部显示网页版本，便于确认是否已刷新到新部署。

## 2.0.27 — 2026-11-08

- 手机项目选择固定为该电脑实例当前打开的工作区，不再自动选择配置中的首个示例项目（如 myapp），并显示完整目录。
- 切换电脑后丢弃旧设备的迟到 API 响应，避免旧项目、会话和任务覆盖新设备视图。
- 手机会话列表持续轮询更新，读取失败显示错误，不再静默伪装成没有会话。

## 2.0.26 — 2026-11-08

- 手机选择电脑上的会话后会加载完整交互记录，包括用户指令、回答、工具结果和可展开的文件编辑记录，不再只设置接续目标。
- 为 TUI 增加进程内会话同步桥；手机每秒读取当前回答、执行工具和运行状态，断网恢复后自动重试；运行结束切换到持久化记录，避免重复显示。
- 会话正在电脑端执行时禁止从手机并发接续，避免同一会话启动两个 Agent；修复登录后实时事件连接未启动的问题。

## 2.0.25 — 2026-11-08

- `luban login relay` 支持直接跟中继地址：`luban login relay https://thickness-oxygen-life-resistant.trycloudflare.com` 不再报 “too many arguments”，`--relay <url>` 写法保持可用。
- 中继地址省略协议时默认按 HTTPS 处理（只有本机回环地址会补 `http://`），省得先被 “必须使用 HTTPS” 挡住。
- 更新 `docs/reference.md` 的登录示例与 `--help` 提示。

## 2.0.24 — 2026-11-08

- 中继账户改为每台电脑保留独立的设备令牌：在第二台、第三台电脑上登录时新增令牌，不再使前面电脑的令牌失效，三台机器可以同时出现在手机设备列表中。
- 兼容升级前只有一个 `device_token_hash` 的账户文件；首次新增令牌后自动迁移，旧令牌继续有效。
- 更新登录提示和文档：新增令牌不会让其他电脑掉线；账户最多保留最近 32 枚令牌。

## 2.0.23 — 2026-11-08

- 修复手机控制台横向溢出：长设备名会把隐式网格列撑宽，导致右侧内容（包括“设置”标签）被裁掉；网格列改为可收缩，长文本和错误提示都能在屏幕内换行。
- 重新构建并部署手机端 CSS，避免 WebView 继续复用旧样式缓存。

## 2.0.22 — 2026-11-08

- 修复 Android WebView 中手机控制台页面偏短、底部黑屏、头部被压扁的问题：布局高度改用 WebView 实际高度，键盘弹出时仍会正确收缩。
- 手机连接失败提示中的长命令现在会自动换行，不再横向溢出屏幕。
- Android 原生壳的状态栏同时识别账户 Cookie 与旧版令牌 Cookie，账户登录后不再误报“未登录”；一键登录会同时清理两种旧会话。

## 2.0.21 — 2026-11-08

- 同一台电脑在不同项目目录运行的多个 luban 会分别注册为独立节点，不再互相顶掉；设备名带上项目目录，手机可以逐个选择并派活。
- 手机设备卡显示最新任务的进度、更新时间与记录数量；切换节点后立即加载该实例的任务和会话，旧版遗留的失效节点 ID 会自动回退到在线实例。
- 实例设备 ID 由机器 ID + 工作区路径稳定生成，重启后仍是同一个节点；升级后需重启旧实例才会按新身份注册。

## 2.0.20 — 2026-11-08

- 新增 TUI 命令 `/relay login [中继地址]`：在终端内依次输入中继地址、邮箱和密码，密码不回显；登录成功后保存设备令牌与 `remote` 配置，重启 `luban` 后自动接入。
- `luban login relay` 增加明确的步骤反馈：邮箱输入后显示「邮箱已记录」，密码提示标注「输入不显示，回车确认」，并在提交后显示「正在登录」。
- 中继登录逻辑抽到共享模块，CLI 与 TUI 复用同一套 Cookie、设备令牌和 0600 文件写入流程。

## 2.0.19 — 2026-11-08

- 新增 `luban login relay`：用邮箱和密码在终端登录中继账户，自动生成本机设备令牌并写入 `~/.config/luban/relay.env`，同时把 `remote.enabled` / `remote.relay_url` 写入 `~/.luban/config.json`；之后直接运行 `luban <项目路径>` 即可接入，无需打开手机或浏览器。
- 密码只通过隐藏输入或 `--password-stdin` 读取，不写入 shell 历史、配置或日志；也支持 `--device-token` 保存已有令牌、`--no-config` 只写环境文件。
- 文档改用通用示例域名，补充电脑端命令行登录与配置文件接入说明。

## 2.0.18 — 2026-11-08

- 修正手机“账户下还没有电脑”提示中的接入命令：只使用账户设备令牌，不再要求中继共享节点令牌。
- 补充电脑端接入账户的文档：手机生成设备令牌后在电脑运行 `luban web ... --relay-device-token`，或把 `LUBAN_RELAY_DEVICE_TOKEN` 写入 `~/.config/luban/relay.env` 并让 TUI 自动接入。

## 2.0.17 — 2026-11-08

- 中继账户注册新增邮箱验证码：`POST /api/auth/send-code` 签发 6 位验证码，10 分钟有效、5 次错误后作废、同一邮箱 60 秒内不可重发、每小时最多 5 封。
- 新增 SMTPS 发信（默认 `smtp.163.com:465`，使用应用专用密码），配置来自 `LUBAN_RELAY_SMTP_EMAIL` / `LUBAN_RELAY_SMTP_PASSWORD`，也可用 `--smtp-email`、`--smtp-password`、`--smtp-host`、`--smtp-port`；密码不写入日志或账户库。
- 配置邮箱后，注册接口必须携带 `code`；登录页仍可直接登录。未配置邮箱的中继保持原有无验证码注册行为。
- 手机注册页新增“发送验证码”按钮、倒计时与验证码输入框；中继通过 `/api/auth/me` 的 `email_verification` 告知客户端是否需要验证码。

## 2.0.16 — 2026-11-08

- 中继新增账户体系：邮箱/密码注册登录、HttpOnly 会话 Cookie、每账户设备登记令牌；账户之间设备与任务严格隔离，旧的一键令牌链接继续可用。
- 电脑首次接入中继时生成稳定设备 ID，重连不会变成新机器；设备列表持久化，离线电脑仍可看到并移出账户。
- 手机控制台新增登录/注册页、设备页和会话接续：登录后可看到账户下所有电脑、在线状态、正在执行的任务，并直接选一台派活。
- 密码用 scrypt、会话与设备令牌用 SHA-256 存储；账户文件权限 `0600`，令牌只在生成时显示一次。
- 新增 `luban relay --accounts <path>`、`--relay-device-token` 和设备令牌生成命令；电脑可只用设备令牌接入中继，无需接触中继的共享节点令牌。

## 2.0.15 — 2026-11-08

- 新安装首次启动自动生成可移植的 `~/.luban/config.json`，沿用现有端口、超时、上下文、同步忽略、worker/step 上限等设置；已有配置永不覆盖，删除后可重新生成。
- 默认配置不含真实 API Key、私有网关 IP、内网节点、relay 地址或项目路径；API Key 仍通过用户目录的鉴权存储或 `/models` 面板维护。
- 默认模型改为免密的 `opencode-zen/deepseek-v4.1-flash-free`，避免没有 Key 的新安装首次对话即失败。
- 安全起见默认权限保持 `edits`（自动批准工作区内编辑），而不是当前机器上的 `allow`；需要完全免审批时自行改为 `allow`。

## 2.0.14 — 2026-11-08

- `/models` provider 列表与模型子菜单新增 `Ctrl+A` 鉴权面板：遮罩设置/更新 API Key、确认删除、打开服务商密钥控制台；自定义 provider 同样支持。
- Codex 可在面板中启动官方 CLI 设备码登录，显示授权链接与设备码，支持取消与失败重试。
- 密钥独立保存到用户目录 `provider-auth.json`，Unix 文件权限 `0600`；不进入项目、会话或输入历史，保存后无需重启，删除后恢复配置/环境/外部凭据。
- 范围为 TUI（含桌面内嵌终端）；独立 Web 模型选择器未新增鉴权表单。

## 2.0.13 — 2026-11-08

- 修复 Windows ZIP 发布流程，改用镜像与缓存优先的依赖安装方式，并补充发布网络辅助脚本与文档。

## 2.0.12 — 2026-11-07

桌面工作台直接播放音频、视频并预览图片；打开超限或二进制文件时给出能照着做的说明，而不是 Electron 的 IPC 报错原文。

### 桌面工作台

- 文件树里点音频（mp3/m4a/wav/flac/ogg/opus…）、视频（mp4/mov/webm/mkv/avi…）就地播放，图片显示预览。通过 `luban-media://` 特权协议流式读取，支持 Range 拖动进度，只读、不参与编辑，也不受文本大小限制。
- 文本编辑器上限从 1 MB 提到 4 MB，锁文件、日志与打包产物都能打开；命令控制台仍是 1 MB。
- 不再显示 `Error invoking remote method 'luban:readFile'` 这类包装：超限、二进制、UTF-16、非 UTF-8、文件已删除、磁盘版本冲突都换成中文说明和下一步操作；轮询与保存共用同一套文案。

## 2.0.11 — 2026-11-07

修复终端拖选复制写不进系统剪贴板、输出区链接点不开。

- 拖选复制：Windows 走 PowerShell `Set-Clipboard`（base64 传参，中文与 emoji 不乱码，`clip.exe` 兜底），macOS 走 `pbcopy`；等待系统工具期间先提示 OSC 52 已发送。
- 输出区链接：单击（按下与松开落在同一链接）用默认浏览器打开，只放行 http/https；`/token` 等只读对话框内的链接同样可点。

## 2.0.0 — 2026-11-03

将 1.x 阶段累计的桌面工作台、常驻 Bot 与运行状态展示收拢为一个大版本。版本号从 1.16.175 升级为 2.0.0。

### 桌面与会话

- 文件树、多标签编辑、语法着色、磁盘版本冲突保护，以及共用中间区域的代码与修改对比视图。
- PTY 终端、命令控制台、多轮会话续接、追加任务排队、折叠思考过程与模型生成会话标题。
- 复用终端的主题与模型配置，保留推理强度选择。

### 常驻 Bot 与造物主

- 桌面 App 自动启动本机 Bot worker；已由终端或服务启动的 worker 保持原有归属。
- 桌宠后台身体自称「造物主」，展示任务队列、最近结果与权限申请，并播报完成结果。
- 展示机器负载、内存、worker 直接子进程、进程 RSS，以及 macOS 线程数量。
- 活跃 Agent 按所属 PID 展示任务、深度、运行时长及已回报的输入/输出 token；Bot 执行结果保存本轮请求用量与调用次数。

### 升级与当前边界

- 继续使用现有配置、会话和 Bot 队列目录；旧记录缺少用量时无法补算历史 token。
- Agent 是进程内运行实例，深度 0 表示主 Agent；子 Agent 没有独立 PID。面板展示数量有上限。
- 当前提供状态观察与既有任务取消能力，尚未覆盖整机所有进程、逐线程详情或任意系统服务管理。
- token 来自提供方返回的 usage；Bot 结果统计当前 runner 的请求，不保证包含委派子 Agent、异常退出或提供方未报告的用量，也不代表费用账单。
- 后台操作仍遵循独立权限文件；委派任务需要相应授权。前台 TUI 与工作台身份保持原有设置。
- 本次本地提交不等于安装包发布；平台安装包与 GitHub Release 由单独的发布流程生成。

## 1.16.76 — 2026-10-09

> 以下 1.16.72–1.16.76 五条原记录在 `docs/changes.md`（当时的「修改记录」），2026-11-20 并入本文件；再往前的版本请看 Git 历史。

- 从 README Logo 生成独立的榫卯 L 应用图标，提供多尺寸 PNG 与 Windows ICO。
- Linux 桌面安装包安装 16–512 像素的菜单图标；桌面窗口、Web favicon 和 PWA 使用新图标。
- Windows 桌面打包时嵌入 EXE 图标；便携包附带 `create-shortcuts.cmd`，用于解压后创建带图标的桌面快捷方式。
- Windows 图标资源编辑使用构建依赖 `rcedit`；版本同步更新至 1.16.76。

验证：Linux 桌面包构建通过，包内 9 种菜单图标与窗口/Web 图标校验通过；Windows ICO 尺寸、脚本语法及版本一致性检查通过。Windows 打包与快捷方式运行待 Windows x64 实测。

## 1.16.75 — 2026-10-09

- 生成以榫卯和木工角尺为灵感的 luban Logo，保存至 `assets/luban-logo.png`。
- README 顶部居中展示 Logo，保留简洁的用户说明。
- 版本同步更新至 1.16.75。

验证：`npm run build`、图片引用、版本一致性及 `git diff --check` 均通过。

## 1.16.74 — 2026-10-09

- README 增加 OpenCode Go / Zen 密钥设置、默认模型与服务地址说明。
- 增加 OpenAI API 和兼容接口的配置示例，说明地址、模型 ID、密钥和协议选择。
- 对照配置实现及服务官方文档核对示例；版本同步更新至 1.16.74。

验证：构建、JSON 示例格式、版本一致性及 `git diff --check` 均通过。


## 1.16.73 — 2026-10-09

- README 增加简短的特色功能介绍，覆盖执行过程、局域网协作、手机远控、任务恢复、模型选择和扩展能力。
- 版本同步更新至 1.16.73。

验证：`npm run build` 和 `git diff --check` 均通过。


## 1.16.72 — 2026-10-09

- README 精简为面向用户的安装、模型配置和常用操作说明。
- 原 README 的详细配置、实现说明、历史修复信息和开发验证移至 `reference.md`，保留查阅入口。
- 修改记录独立保存在本文，不写入 README。
- `package.json` 和 `package-lock.json` 版本同步更新至 1.16.72。

验证：`npm run build` 通过（服务端编译、前端类型检查与 Vite 打包）；`git diff --check` 通过。

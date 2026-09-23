# Stock Monitor plugin

这是一个零第三方依赖的 luban 场景插件：`SKILL.md` 约束分析流程，stdio MCP Server 提供行情、持仓诊断和自选持仓存储。

## 安装到项目

在项目根目录执行：

```bash
mkdir -p .luban/skills/stock-monitor .luban/plugins/stock-monitor
cp /path/to/luban/plugins/stock-monitor/SKILL.md .luban/skills/stock-monitor/
cp /path/to/luban/plugins/stock-monitor/{server.mjs,analysis.mjs} .luban/plugins/stock-monitor/
```

在 luban 配置的 `mcpServers` 中加入：

```json
{
  "stock-monitor": {
    "command": "node",
    "args": [".luban/plugins/stock-monitor/server.mjs"],
    "env": {},
    "enabled": true,
    "trusted": true
  }
}
```

启动 luban 后可以说：

> 监控 600519，我有 200 股，成本 1850，总资产 80 万，可用现金 5 万，最大单股仓位 20%。先分析是否要减仓或加仓，并保存到监控列表。

已保存的数据默认位于 `.luban/stock-monitor/positions.json`。可通过 MCP Server 环境变量 `STOCK_MONITOR_STATE` 改变位置。`scan_watchlist` 是主动扫描，不会在 luban 未运行时自行推送；可由外部定时任务定期发起会话。

## 数据和边界

- 行情使用 Yahoo Finance chart API，可能延迟、停用或缺少部分市场数据；下单前必须以券商数据为准。
- 六位 A 股代码按常见前缀映射到 `.SS`、`.SZ`、`.BJ`，港股纯数字映射到 `.HK`；也可直接传完整代码。
- 可向 `analyze_position.price_series` 传至少 15 个收盘价进行离线分析。
- 输出是可审计的规则化风险诊断，不包含完整基本面、公告、税费、流动性和个人财务适当性评估。

import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { callMcpTool, listMcpTools } from "./mcp.js";
import type { LubanConfig } from "./types.js";

const server = resolve("plugins/stock-monitor/server.mjs");

function config(workspace: string): LubanConfig {
  return {
    workspace,
    mcpServers: {
      stocks: {
        command: process.execPath,
        args: [server],
        env: { STOCK_MONITOR_STATE: join(workspace, "positions.json") },
        headers: {},
        enabled: true,
        trusted: true,
      },
    },
  } as LubanConfig;
}

function content(result: string): Record<string, unknown> {
  const envelope = JSON.parse(result);
  return JSON.parse(envelope.content[0].text);
}

describe("stock monitor scenario plugin", () => {
  it("exposes its tools through the luban MCP bridge", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-stock-tools-"));
    const listed = await listMcpTools(config(workspace), new AbortController().signal);
    expect(listed).toContain('"name": "analyze_position"');
    expect(listed).toContain('"name": "scan_watchlist"');
  });

  it("reduces risk on a deeply losing weak trend instead of averaging down", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-stock-risk-"));
    const closes = Array.from({ length: 80 }, (_, index) => 200 - index);
    const result = content(await callMcpTool(config(workspace), "stocks", "analyze_position", {
      symbol: "600519",
      shares: 100,
      average_cost: 180,
      portfolio_value: 100_000,
      cash_available: 50_000,
      thesis_intact: false,
      price_series: closes,
    }, new AbortController().signal));
    expect((result.decision as Record<string, unknown>).action).toBe("REDUCE_RISK");
    expect((result.risks as string[]).join(" ")).toContain("亏损幅度本身不是买入理由");
  });

  it("caps a conditional add by cash and target position weight", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-stock-add-"));
    const closes = Array.from({ length: 80 }, (_, index) => 100 + index + Math.sin(index) * 5);
    const result = content(await callMcpTool(config(workspace), "stocks", "analyze_position", {
      symbol: "AAPL",
      shares: 10,
      average_cost: 160,
      portfolio_value: 100_000,
      cash_available: 1_000,
      target_weight_pct: 10,
      max_weight_pct: 15,
      thesis_intact: true,
      price_series: closes,
    }, new AbortController().signal));
    const decision = result.decision as Record<string, unknown>;
    expect(decision.action).toBe("CONDITIONAL_ADD");
    expect(decision.suggestedShares).toBe(5);
  });

  it("persists and removes monitored positions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-stock-state-"));
    const luban = config(workspace);
    const signal = new AbortController().signal;
    const saved = content(await callMcpTool(luban, "stocks", "save_position", {
      symbol: "000001",
      shares: 200,
      average_cost: 12.5,
    }, signal));
    expect(saved.saved).toBe(true);
    expect((saved.position as Record<string, unknown>).symbol).toBe("000001.SZ");
    const removed = content(await callMcpTool(luban, "stocks", "remove_position", { symbol: "000001" }, signal));
    expect(removed.removed).toBe(true);
  });
});

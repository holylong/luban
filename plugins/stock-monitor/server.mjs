#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import readline from "node:readline";
import { analyzePosition, calculateIndicators, normalizeSymbol } from "./analysis.mjs";

const protocolVersion = "2025-06-18";
const stateFile = resolve(process.cwd(), process.env.STOCK_MONITOR_STATE || ".luban/stock-monitor/positions.json");
const quoteCache = new Map();

const tools = [
  {
    name: "stock_snapshot",
    description: "获取股票近一年行情和 MA/RSI/波动率等风险指标。A股六位代码会自动补 .SS/.SZ/.BJ。行情来自 Yahoo Finance，可能延迟。",
    inputSchema: { type: "object", properties: { symbol: { type: "string", description: "例如 600519、000001、0700.HK、AAPL" } }, required: ["symbol"], additionalProperties: false },
  },
  {
    name: "analyze_position",
    description: "结合成本、仓位上限、现金、止损线和趋势，对单只持仓给出减仓/观察/条件式分批加仓诊断。不会因浮亏本身建议补仓。",
    inputSchema: positionSchema(true),
  },
  {
    name: "save_position",
    description: "保存或更新一只待监控持仓。随后可用 scan_watchlist 批量复查。",
    inputSchema: positionSchema(false),
  },
  {
    name: "scan_watchlist",
    description: "读取已保存持仓，获取最新行情并逐只生成风险诊断。适合每日或每周主动调用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "remove_position",
    description: "从监控列表删除一只持仓。",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"], additionalProperties: false },
  },
];

function positionSchema(requirePosition) {
  return {
    type: "object",
    properties: {
      symbol: { type: "string" },
      shares: { type: "number", exclusiveMinimum: 0 },
      average_cost: { type: "number", exclusiveMinimum: 0 },
      portfolio_value: { type: "number", exclusiveMinimum: 0 },
      cash_available: { type: "number", minimum: 0 },
      target_weight_pct: { type: "number", minimum: 0, maximum: 100, default: 10 },
      max_weight_pct: { type: "number", exclusiveMinimum: 0, maximum: 100, default: 20 },
      stop_loss_pct: { type: "number", exclusiveMinimum: 0, maximum: 100, default: 15 },
      thesis_intact: { type: "boolean", description: "核查基本面和原买入逻辑后是否仍成立；未明确为 true 时不建议加仓" },
      price_series: { type: "array", minItems: 15, items: { type: "number", exclusiveMinimum: 0 }, description: "可选的历史收盘价；提供后离线分析，不请求行情源" },
    },
    required: requirePosition ? ["symbol", "shares", "average_cost"] : ["symbol", "shares", "average_cost"],
    additionalProperties: false,
  };
}

async function fetchMarketData(symbolInput) {
  const symbol = normalizeSymbol(symbolInput);
  const cached = quoteCache.get(symbol);
  if (cached && Date.now() - cached.savedAt < 60_000) return cached.value;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&events=div%2Csplits`;
  const response = await fetch(url, { headers: { "user-agent": "luban-stock-monitor/1.0" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`行情源请求失败 (${response.status})`);
  const body = await response.json();
  const result = body?.chart?.result?.[0];
  const closes = (result?.indicators?.quote?.[0]?.close || []).filter((value) => Number.isFinite(value));
  if (closes.length < 15) throw new Error(`没有足够的 ${symbol} 历史行情，请检查代码或稍后重试`);
  const timestamp = result.timestamp?.at(-1);
  const value = {
    symbol,
    name: result.meta?.longName || result.meta?.shortName || symbol,
    currency: result.meta?.currency || "",
    asOf: timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString(),
    closes,
    stale: true,
  };
  quoteCache.set(symbol, { savedAt: Date.now(), value });
  return value;
}

function manualMarketData(args) {
  const closes = Array.isArray(args.price_series) ? args.price_series : undefined;
  if (!closes) return undefined;
  return { symbol: normalizeSymbol(args.symbol), name: normalizeSymbol(args.symbol), currency: "", asOf: new Date().toISOString(), closes, stale: false };
}

async function loadPositions() {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function savePositions(positions) {
  await mkdir(dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(positions, null, 2)}\n`, "utf8");
  await rename(temporary, stateFile);
}

async function callTool(name, args) {
  if (name === "stock_snapshot") {
    const market = await fetchMarketData(args.symbol);
    return { ...market, closes: undefined, indicators: calculateIndicators(market.closes), source: "Yahoo Finance chart API (delayed/third-party)" };
  }
  if (name === "analyze_position") {
    const market = manualMarketData(args) || await fetchMarketData(args.symbol);
    return analyzePosition(args, market);
  }
  if (name === "save_position") {
    normalizeSymbol(args.symbol);
    if (!(Number(args.shares) > 0) || !(Number(args.average_cost) > 0)) throw new Error("shares and average_cost must be greater than 0");
    const positions = await loadPositions();
    const symbol = normalizeSymbol(args.symbol);
    const saved = { ...args, symbol, price_series: undefined, updated_at: new Date().toISOString() };
    const index = positions.findIndex((item) => item.symbol === symbol);
    if (index >= 0) positions[index] = saved;
    else positions.push(saved);
    await savePositions(positions);
    return { saved: true, position: saved, stateFile };
  }
  if (name === "scan_watchlist") {
    const positions = await loadPositions();
    const results = [];
    for (const position of positions) {
      try {
        results.push(analyzePosition(position, await fetchMarketData(position.symbol)));
      } catch (error) {
        results.push({ symbol: position.symbol, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { scannedAt: new Date().toISOString(), count: positions.length, results };
  }
  if (name === "remove_position") {
    const symbol = normalizeSymbol(args.symbol);
    const positions = await loadPositions();
    const remaining = positions.filter((item) => item.symbol !== symbol);
    await savePositions(remaining);
    return { removed: remaining.length !== positions.length, symbol };
  }
  throw new Error(`unknown tool: ${name}`);
}

function reply(id, result, error) {
  const message = error
    ? { jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    if (request.id === undefined) return;
    if (request.method === "initialize") return reply(request.id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "luban-stock-monitor", version: "1.0.0" } });
    if (request.method === "tools/list") return reply(request.id, { tools });
    if (request.method === "tools/call") {
      const output = await callTool(request.params?.name, request.params?.arguments || {});
      return reply(request.id, { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output });
    }
    reply(request.id, undefined, new Error(`method not found: ${request.method}`));
  } catch (error) {
    if (request?.id !== undefined) reply(request.id, undefined, error);
  }
});

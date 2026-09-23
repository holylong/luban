const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : undefined;

export function normalizeSymbol(input) {
  const raw = String(input ?? "").trim().toUpperCase();
  if (!raw) throw new Error("symbol is required");
  if (/^\d{6}$/.test(raw)) {
    if (/^[69]/.test(raw)) return `${raw}.SS`;
    if (/^[0123]/.test(raw)) return `${raw}.SZ`;
    if (/^[48]/.test(raw)) return `${raw}.BJ`;
  }
  if (/^\d{1,5}$/.test(raw)) return `${raw.padStart(4, "0")}.HK`;
  return raw;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function movingAverage(values, periods) {
  return values.length >= periods ? average(values.slice(-periods)) : undefined;
}

function rsi(values, periods = 14) {
  if (values.length <= periods) return undefined;
  let gains = 0;
  let losses = 0;
  for (let index = values.length - periods; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  if (!losses) return 100;
  const strength = gains / losses;
  return 100 - (100 / (1 + strength));
}

function annualizedVolatility(values) {
  const returns = [];
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] > 0) returns.push(Math.log(values[index] / values[index - 1]));
  }
  if (returns.length < 2) return undefined;
  const mean = average(returns);
  const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

const rounded = (value, digits = 2) => value === undefined ? undefined : Number(value.toFixed(digits));

export function calculateIndicators(closes) {
  const values = closes.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length < 15) throw new Error("at least 15 valid closing prices are required");
  const price = values.at(-1);
  const high52w = Math.max(...values.slice(-252));
  const low52w = Math.min(...values.slice(-252));
  return {
    price: rounded(price),
    ma20: rounded(movingAverage(values, 20)),
    ma60: rounded(movingAverage(values, 60)),
    ma120: rounded(movingAverage(values, 120)),
    rsi14: rounded(rsi(values)),
    volatilityAnnualPct: rounded(annualizedVolatility(values)),
    drawdownFrom52wHighPct: rounded(((price / high52w) - 1) * 100),
    distanceFrom52wLowPct: rounded(((price / low52w) - 1) * 100),
    observations: values.length,
  };
}

export function analyzePosition(input, marketData) {
  const averageCost = finite(input.average_cost);
  const shares = finite(input.shares);
  if (!averageCost || averageCost <= 0) throw new Error("average_cost must be greater than 0");
  if (!shares || shares <= 0) throw new Error("shares must be greater than 0");

  const indicators = calculateIndicators(marketData.closes);
  const price = indicators.price;
  const marketValue = price * shares;
  const costValue = averageCost * shares;
  const pnlPct = ((price / averageCost) - 1) * 100;
  const portfolioValue = finite(input.portfolio_value);
  const positionWeightPct = portfolioValue && portfolioValue > 0 ? marketValue / portfolioValue * 100 : undefined;
  const targetWeightPct = finite(input.target_weight_pct) ?? 10;
  const maxWeightPct = finite(input.max_weight_pct) ?? 20;
  const stopLossPct = Math.abs(finite(input.stop_loss_pct) ?? 15);
  const cashAvailable = Math.max(0, finite(input.cash_available) ?? 0);
  const thesisIntact = input.thesis_intact === true;
  const trendPositive = indicators.ma20 !== undefined && indicators.ma60 !== undefined
    && price > indicators.ma20 && indicators.ma20 > indicators.ma60;
  const trendNegative = indicators.ma20 !== undefined && indicators.ma60 !== undefined
    && price < indicators.ma20 && indicators.ma20 < indicators.ma60;
  const stopTriggered = pnlPct <= -stopLossPct;
  const overweight = positionWeightPct !== undefined && positionWeightPct > maxWeightPct;
  const reasons = [];
  const risks = [];
  let action = "HOLD_AND_REVIEW";
  let actionZh = "持有并复核";
  let confidence = "medium";
  let suggestedShares = 0;

  if (overweight || stopTriggered || (pnlPct < -10 && trendNegative)) {
    action = "REDUCE_RISK";
    actionZh = "分批减仓/降风险";
    if (overweight && portfolioValue) {
      suggestedShares = Math.max(1, Math.ceil((marketValue - portfolioValue * maxWeightPct / 100) / price));
      reasons.push(`当前仓位 ${rounded(positionWeightPct)}% 超过上限 ${maxWeightPct}%`);
    } else {
      suggestedShares = Math.max(1, Math.ceil(shares * 0.25));
    }
    if (stopTriggered) reasons.push(`浮亏 ${rounded(pnlPct)}% 已超过预设风险线 ${stopLossPct}%`);
    if (trendNegative) reasons.push("价格、MA20 与 MA60 呈弱势排列");
  } else if (thesisIntact && trendPositive && (indicators.rsi14 ?? 100) < 70 && cashAvailable >= price) {
    const roomByCash = Math.floor(cashAvailable / price);
    const targetValue = portfolioValue ? portfolioValue * Math.min(targetWeightPct, maxWeightPct) / 100 : marketValue * 1.25;
    const roomByWeight = Math.max(0, Math.floor((targetValue - marketValue) / price));
    suggestedShares = Math.min(roomByCash, roomByWeight);
    if (suggestedShares > 0) {
      action = "CONDITIONAL_ADD";
      actionZh = "可考虑小额分批加仓";
      reasons.push("投资逻辑被明确确认仍成立，且价格位于 MA20、MA60 之上");
      reasons.push(`建议数量受可用现金和目标仓位 ${Math.min(targetWeightPct, maxWeightPct)}% 双重限制`);
    }
  }

  if (action === "HOLD_AND_REVIEW") {
    reasons.push(thesisIntact ? "当前信号不足以支持加仓或强制减仓" : "尚未确认原投资逻辑仍成立，不应仅因亏损摊低成本");
    if (trendPositive) reasons.push("短中期趋势转强，可等待基本面复核后再决策");
  }
  if (pnlPct <= -20) risks.push("已属深度浮亏；先检查业绩、现金流、负债、行业逻辑和重大公告，亏损幅度本身不是买入理由");
  if (positionWeightPct === undefined) risks.push("未提供总资产，无法校验个股集中度；建议补充 portfolio_value");
  if (!thesisIntact) risks.push("未明确确认投资逻辑仍成立，因此不会给出加仓结论");
  if (indicators.volatilityAnnualPct > 50) risks.push("历史波动率较高，应缩小单次交易规模");
  if (marketData.stale) risks.push("行情可能为延迟或非交易时段数据，请在下单前用券商行情复核");
  if (!reasons.length) reasons.push("仓位和趋势信号处于中性区间");

  return {
    symbol: marketData.symbol,
    name: marketData.name,
    asOf: marketData.asOf,
    currency: marketData.currency,
    decision: { action, actionZh, confidence, suggestedShares, reasons },
    position: {
      shares,
      averageCost: rounded(averageCost),
      marketValue: rounded(marketValue),
      costValue: rounded(costValue),
      unrealizedPnl: rounded(marketValue - costValue),
      unrealizedPnlPct: rounded(pnlPct),
      positionWeightPct: rounded(positionWeightPct),
      targetWeightPct,
      maxWeightPct,
    },
    indicators,
    risks,
    disclaimer: "规则化风险诊断，不是保证收益的个性化投资建议；不含完整基本面、公告、税费与个人财务状况。下单前请独立核验。",
  };
}

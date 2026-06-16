#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const { createLeaderSelector } = require("../../utils/copy-trading-leader-selector");

dotenv.config({ path: path.join(process.cwd(), ".env") });
dotenv.config({ path: path.join(process.cwd(), ".env.copy-trading") });

function parseArgs(argv) {
  const out = {};
  for (const raw of argv.slice(2)) {
    const m = String(raw).match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function bool(v, d = false) {
  if (v === undefined) return d;
  const s = String(v).toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

function clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function findLatestFile(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? path.join(dir, files[0].f) : null;
}

function normalizeSide(side) {
  const s = String(side || "").toLowerCase();
  if (s === "b" || s === "buy" || s === "long") return 1;
  if (s === "a" || s === "sell" || s === "short") return -1;
  return 0;
}

function parseFill(raw) {
  if (!raw || typeof raw !== "object") return null;
  const time = num(raw.time, null);
  const coin = typeof raw.coin === "string" ? raw.coin.toUpperCase() : null;
  const side = normalizeSide(raw.side);
  const px = raw.px != null ? num(raw.px, null) : null;
  const sz = raw.sz != null ? num(raw.sz, null) : null;
  const closedPnl = raw.closedPnl != null ? num(raw.closedPnl, 0) : 0;
  const fee = raw.fee != null ? num(raw.fee, 0) : 0;
  const isLiquidation =
    raw.liquidation === true ||
    raw.isLiquidation === true ||
    raw.liquidated === true ||
    (typeof raw.type === "string" && raw.type.toLowerCase().includes("liquid"));
  if (!Number.isFinite(time) || !coin || side === 0 || !Number.isFinite(px) || !Number.isFinite(sz)) {
    return null;
  }
  return { time, coin, side, px, sz, closedPnl, fee, isLiquidation: !!isLiquidation };
}

function loadOverrides() {
  const overrideFile =
    process.env.COPY_OVERRIDES_FILE || path.join("config", "copy-trading-overrides.json");
  const fullPath = path.isAbsolute(overrideFile)
    ? overrideFile
    : path.join(process.cwd(), overrideFile);
  const parsed = readJsonIfExists(fullPath);
  if (!parsed || typeof parsed !== "object") {
    return {
      forceInclude: [],
      blocklist: [],
      weightMultipliers: {},
    };
  }
  return {
    forceInclude: Array.isArray(parsed.forceInclude) ? parsed.forceInclude : [],
    blocklist: Array.isArray(parsed.blocklist) ? parsed.blocklist : [],
    weightMultipliers:
      parsed.weightMultipliers && typeof parsed.weightMultipliers === "object"
        ? parsed.weightMultipliers
        : {},
  };
}

function buildWeights(wallets, opts, overrides) {
  const maxTrades = Math.max(1, ...wallets.map((w) => w.trades || 0));
  const maxScorePos = Math.max(1e-9, ...wallets.map((w) => Math.max(0, num(w.score, 0))));
  const weights = new Map();
  for (const w of wallets) {
    const winLB = num(w.winRateLB, 0.5);
    const trades = w.trades || 0;
    const tradeFactor = Math.log10(1 + trades) / Math.log10(1 + maxTrades);
    const scorePos = Math.max(0, num(w.score, 0)) / maxScorePos;

    let base = clamp(winLB, 0.1, 1);
    if (opts.weightMode === "scorepos") base = clamp(scorePos, 0, 1);
    if (opts.weightMode === "hybrid") base = clamp(0.55 * clamp(winLB, 0.1, 1) + 0.45 * clamp(scorePos, 0, 1), 0, 1);

    let weight = base * clamp(tradeFactor, 0.2, 1);
    const mult = overrides.weightMultipliers?.[String(w.wallet.address || w.wallet).toLowerCase()];
    if (Number.isFinite(num(mult, null))) weight *= num(mult, 1);
    weight = clamp(weight, opts.minWeight, opts.maxWeight);
    weights.set(String(w.wallet.address || w.wallet).toLowerCase(), weight);
  }
  return weights;
}

function calcConsensusStats(symbol, walletStates, weights) {
  let wSum = 0;
  let wSigned = 0;
  let contributors = 0;
  for (const [wallet, perSym] of walletStates.entries()) {
    const pos = perSym.get(symbol) || 0;
    if (pos === 0) continue;
    const weight = weights.get(wallet) || 0;
    if (weight <= 0) continue;
    wSum += weight;
    wSigned += weight * Math.sign(pos);
    contributors += 1;
  }
  if (wSum === 0) return { consensus: 0, contributors: 0, weightSum: 0 };
  return { consensus: wSigned / wSum, contributors, weightSum: wSum };
}

function calcConsensusStatsPhase6(symbol, walletStates, weights, opts = {}) {
  // Phase 6 enhancements:
  // - staleness gating (exclude wallets with no updates recently)
  // - conviction scaling (scale weight by position notional, log-capped)
  // - effective sample size (ESS) + optional minimum ESS gating
  // - elite sub-consensus (optional) with weight-share cap

  const { computeConvictionMultiplier, computeEffectiveSampleSize } = require("../../utils/copy-trading-consensus-engine");

  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const lastUpdateByWallet = opts.lastUpdateByWallet instanceof Map ? opts.lastUpdateByWallet : null;
  const lastPriceBySymbol = opts.lastPriceBySymbol instanceof Map ? opts.lastPriceBySymbol : null;
  const positionStateReadyByWallet =
    opts.positionStateReadyByWallet instanceof Map ? opts.positionStateReadyByWallet : null;
  const price = lastPriceBySymbol ? Number(lastPriceBySymbol.get(symbol)) : Number.NaN;

  const staleMs = Math.max(5_000, num(opts.staleMs, 120_000));
  const convictionCfg = {
    convictionNotionalCapUsd: Math.max(1, num(opts.convictionNotionalCapUsd, 50_000)),
    convictionMinMult: clamp(num(opts.convictionMinMult, 0.25), 0, 1),
    convictionMaxMult: Math.max(0, num(opts.convictionMaxMult, 1.0)),
  };
  const minLeaders = Math.max(1, num(opts.minLeaders, 3));
  const minEffectiveN = Math.max(0, num(opts.minEffectiveN, 2.0));

  const eliteSet = opts.eliteSet instanceof Set ? opts.eliteSet : null;
  const eliteEnabled = eliteSet != null && opts.eliteEnabled !== false;
  const eliteMinLeaders = Math.max(1, num(opts.eliteMinLeaders, 1));
  const eliteMinConsensusAbs = clamp(num(opts.eliteMinConsensusAbs, 0.65), 0, 1);
  const eliteMaxWeightShare = clamp(num(opts.eliteMaxWeightShare, 0.6), 0, 1);

  const computeWeightConcentration = (vals) => {
    let sum = 0;
    let sumSq = 0;
    let maxW = 0;
    for (const value of vals) {
      const weight = num(value, 0);
      if (weight <= 0) continue;
      sum += weight;
      sumSq += weight * weight;
      if (weight > maxW) maxW = weight;
    }
    if (sum <= 0) return { hhi: 1, maxWeightShare: 1 };
    return {
      hhi: sumSq / (sum * sum),
      maxWeightShare: maxW / sum,
    };
  };

  let sumW = 0;
  let sumSigned = 0;
  let longWeight = 0;
  let shortWeight = 0;
  let longs = 0;
  let shorts = 0;
  let stale = 0;
  let missing = 0;
  let zeroW = 0;
  let uninitialized = 0;

  const effWeights = [];

  let eliteSumW = 0;
  let eliteSumSigned = 0;
  let eliteLongWeight = 0;
  let eliteShortWeight = 0;
  let eliteContrib = 0;
  const eliteEffWeights = [];
  let eliteLongs = 0;
  let eliteShorts = 0;

  for (const [wallet, perSym] of walletStates.entries()) {
    const pos = perSym.get(symbol) || 0;
    if (pos === 0) continue;

    const w0 = weights.get(wallet) || 0;
    if (w0 <= 0) {
      zeroW += 1;
      continue;
    }

    if (positionStateReadyByWallet) {
      const bySym = positionStateReadyByWallet.get(wallet);
      if (!bySym || bySym.get(symbol) !== true) {
        uninitialized += 1;
        continue;
      }
    }

    if (lastUpdateByWallet) {
      const last = lastUpdateByWallet.get(wallet) || 0;
      if (nowMs - last > staleMs) {
        stale += 1;
        continue;
      }
    } else {
      missing += 1;
    }

    const dir = Math.sign(pos);
    if (dir === 0) continue;

    // If price is missing (common in fill-only backtests early in a window), do NOT exclude the wallet.
    // Fall back to the configured max multiplier (i.e., "no conviction scaling") rather than returning 0.
    const posValue = Number.isFinite(price) ? Math.abs(pos) * price : null;
    const convictionFallback = Math.max(
      clamp(num(convictionCfg.convictionMinMult, 0.25), 0, 1),
      num(convictionCfg.convictionMaxMult, 1.0)
    );
    const convictionMult =
      posValue == null ? convictionFallback : computeConvictionMultiplier(posValue, convictionCfg);
    if (convictionMult <= 0) continue;

    const w = w0 * convictionMult;
    sumW += w;
    sumSigned += w * dir;
    effWeights.push(w);

    if (dir > 0) longs += 1;
    else shorts += 1;
    if (dir > 0) longWeight += w;
    else shortWeight += w;

    if (eliteEnabled && eliteSet.has(wallet)) {
      eliteSumW += w;
      eliteSumSigned += w * dir;
      eliteContrib += 1;
      eliteEffWeights.push(w);
      if (dir > 0) {
        eliteLongWeight += w;
        eliteLongs += 1;
      } else {
        eliteShortWeight += w;
        eliteShorts += 1;
      }
    }
  }

  const contributors = longs + shorts;
  const consensus = sumW > 0 ? sumSigned / sumW : 0;
  const effectiveN = computeEffectiveSampleSize(effWeights);
  const confidence = clamp(
    Math.abs(consensus) * Math.sqrt(effectiveN / Math.max(minEffectiveN || 1, 1e-9)),
    0,
    1
  );
  const dispersion = contributors > 0 ? 1 - Math.abs(longs - shorts) / contributors : 1;
  const { hhi, maxWeightShare } = computeWeightConcentration(effWeights);
  const ok = contributors >= minLeaders && effectiveN >= minEffectiveN && sumW > 0;

  const eliteConsensus = eliteSumW > 0 ? eliteSumSigned / eliteSumW : 0;
  const eliteEffectiveN = computeEffectiveSampleSize(eliteEffWeights);
  const eliteConfidence = clamp(
    Math.abs(eliteConsensus) *
      Math.sqrt(eliteEffectiveN / Math.max(Math.min(minEffectiveN, 1) || 1, 1e-9)),
    0,
    1
  );
  const { hhi: eliteHhi, maxWeightShare: eliteMaxActiveWeightShare } =
    computeWeightConcentration(eliteEffWeights);
  const eliteWeightShare = sumW > 0 ? eliteSumW / sumW : 0;
  const eliteOk =
    eliteEnabled &&
    eliteContrib >= eliteMinLeaders &&
    eliteEffectiveN >= Math.min(minEffectiveN, 1) &&
    Math.abs(eliteConsensus) >= eliteMinConsensusAbs &&
    eliteWeightShare <= eliteMaxWeightShare;

  return {
    consensus,
    contributors,
    effectiveN,
    confidence,
    dispersion,
    hhi,
    maxWeightShare,
    longWeightShare: sumW > 0 ? longWeight / sumW : 0,
    shortWeightShare: sumW > 0 ? shortWeight / sumW : 0,
    weightSum: sumW,
    ok,
    excluded: { stale, missing, zeroWeight: zeroW, uninitialized },
    elite: {
      enabled: eliteEnabled,
      contributors: eliteContrib,
      sumWeight: eliteSumW,
      weightShare: eliteWeightShare,
      consensus: eliteConsensus,
      effectiveN: eliteEffectiveN,
      confidence: eliteConfidence,
      dispersion:
        eliteContrib > 0 ? 1 - Math.abs(eliteLongs - eliteShorts) / eliteContrib : 1,
      hhi: eliteHhi,
      maxWeightShare: eliteMaxActiveWeightShare,
      longWeightShare: eliteSumW > 0 ? eliteLongWeight / eliteSumW : 0,
      shortWeightShare: eliteSumW > 0 ? eliteShortWeight / eliteSumW : 0,
      ok: eliteOk,
    },
  };
}

function applySlippage(px, side, slippageBps) {
  const s = slippageBps / 10_000;
  if (side > 0) return px * (1 + s);
  return px * (1 - s);
}

function parseTimeValue(value) {
  if (Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function wilsonLowerBound(wins, n, z = 1.96) {
  if (!(n > 0)) return 0;
  const phat = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return clamp((center - margin) / denom, 0, 1);
}

function computeWindowMetrics(address, fills, { windowStartMs, windowEndMs, targetCoins, winRateZ }) {
  if (!Array.isArray(fills) || fills.length === 0) return null;
  const dayMs = 24 * 60 * 60 * 1000;
  const midpointMs = windowStartMs + (windowEndMs - windowStartMs) / 2;
  const targetCoinSet =
    targetCoins instanceof Set
      ? targetCoins
      : new Set((targetCoins || []).map((coin) => String(coin || "").toUpperCase()));

  const createHalfStats = () => ({
    wins: 0,
    losses: 0,
    pnlNet: 0,
    activityDays: new Set(),
  });

  const createSegmentStats = ({ includeByCoin = false } = {}) => ({
    fills: 0,
    activeDays: new Set(),
    lastFillTime: null,
    trades: 0,
    wins: 0,
    losses: 0,
    pnlNet: 0,
    pnlGross: 0,
    fees: 0,
    grossWins: 0,
    grossLossAbs: 0,
    liquidationCount: 0,
    cum: 0,
    peak: 0,
    maxDrawdown: 0,
    negativeTradePnls: [],
    tradeAbsPnlSum: 0,
    largestAbsTrade: 0,
    tradeDays: new Map(),
    dailyPnl: new Map(),
    halfStats: {
      early: createHalfStats(),
      late: createHalfStats(),
    },
    byCoin: includeByCoin ? {} : undefined,
  });

  const ingestSegment = (segment, fill, day, realizedGross, realizedNet) => {
    segment.fills += 1;
    segment.activeDays.add(day);
    segment.lastFillTime =
      segment.lastFillTime == null ? fill.time : Math.max(segment.lastFillTime, fill.time);
    segment.pnlGross += realizedGross;
    segment.fees += num(fill.fee, 0);
    segment.pnlNet += realizedNet;

    const half = fill.time < midpointMs ? segment.halfStats.early : segment.halfStats.late;
    half.activityDays.add(day);
    half.pnlNet += realizedNet;

    if (realizedNet > 0) {
      segment.wins += 1;
      segment.grossWins += realizedNet;
      half.wins += 1;
    } else if (realizedNet < 0) {
      segment.losses += 1;
      segment.grossLossAbs += Math.abs(realizedNet);
      segment.negativeTradePnls.push(realizedNet);
      half.losses += 1;
    }

    const absTradePnl = Math.abs(realizedNet);
    segment.tradeAbsPnlSum += absTradePnl;
    if (absTradePnl > segment.largestAbsTrade) segment.largestAbsTrade = absTradePnl;
    segment.tradeDays.set(day, (segment.tradeDays.get(day) || 0) + 1);
    segment.dailyPnl.set(day, (segment.dailyPnl.get(day) || 0) + realizedNet);

    if (fill.isLiquidation) segment.liquidationCount += 1;
    segment.cum += realizedNet;
    if (segment.cum > segment.peak) segment.peak = segment.cum;
    segment.maxDrawdown = Math.max(segment.maxDrawdown, segment.peak - segment.cum);
  };

  const finalizeScore = ({ wins, losses, pnlNet, grossWins, grossLossAbs, maxDrawdown }) => {
    const trades = wins + losses;
    const winRate = trades ? wins / trades : 0;
    const winRateLB = trades ? wilsonLowerBound(wins, trades, winRateZ) : 0;
    const profitFactor = grossLossAbs > 0 ? grossWins / grossLossAbs : grossWins > 0 ? 999 : 0;
    const samplePenalty = trades > 0 ? clamp(30 / trades, 0, 1) : 1;
    const ddPenalty =
      pnlNet !== 0
        ? clamp(maxDrawdown / (Math.abs(pnlNet) + 1), 0, 3)
        : clamp(maxDrawdown / 50, 0, 3);
    const score =
      0.65 * (winRateLB - 0.5) +
      0.25 * Math.tanh(pnlNet / 2_000) +
      0.15 * Math.tanh((profitFactor - 1) / 2) -
      0.35 * ddPenalty -
      0.2 * samplePenalty;
    return { trades, winRate, winRateLB, profitFactor, score };
  };

  const summarizeHalfStats = (half) => {
    const trades = half.wins + half.losses;
    const pnlNet = num(half.pnlNet, 0);
    return {
      trades,
      wins: half.wins,
      losses: half.losses,
      pnlNet,
      activityDays: half.activityDays.size,
      positive: pnlNet > 0,
      winRateLB: trades > 0 ? wilsonLowerBound(half.wins, trades, winRateZ) : 0,
    };
  };

  const finalizeSegment = (segment) => {
    const scored = finalizeScore({
      wins: segment.wins,
      losses: segment.losses,
      pnlNet: segment.pnlNet,
      grossWins: segment.grossWins,
      grossLossAbs: segment.grossLossAbs,
      maxDrawdown: segment.maxDrawdown,
    });
    const activityDays = segment.activeDays.size;
    const lastFillAgeDays =
      segment.lastFillTime == null ? Infinity : (windowEndMs - segment.lastFillTime) / dayMs;
    const expectancyUsd = scored.trades > 0 ? segment.pnlNet / scored.trades : null;
    const downsideDeviationUsd = segment.negativeTradePnls.length
      ? Math.sqrt(
          segment.negativeTradePnls.reduce((sum, pnl) => sum + pnl * pnl, 0) /
            segment.negativeTradePnls.length
        )
      : 0;
    const tradePnlConcentration =
      segment.tradeAbsPnlSum > 0 ? segment.largestAbsTrade / segment.tradeAbsPnlSum : 0;
    const maxDayTrades = segment.tradeDays.size ? Math.max(...segment.tradeDays.values()) : 0;
    const tradeDayConcentration = scored.trades > 0 ? maxDayTrades / scored.trades : 0;
    const dailyPnlSeries = Object.fromEntries(
      Array.from(segment.dailyPnl.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([day, pnl]) => [String(day), pnl])
    );
    const early = summarizeHalfStats(segment.halfStats.early);
    const late = summarizeHalfStats(segment.halfStats.late);
    const activeHalves = (early.trades > 0 ? 1 : 0) + (late.trades > 0 ? 1 : 0);
    const positiveHalves = (early.positive ? 1 : 0) + (late.positive ? 1 : 0);
    const tradeBalance =
      scored.trades > 0
        ? Math.min(early.trades, late.trades) / Math.max(1, Math.max(early.trades, late.trades))
        : 0;
    const activityBalance =
      activityDays > 0
        ? Math.min(early.activityDays, late.activityDays) /
          Math.max(1, Math.max(early.activityDays, late.activityDays))
        : 0;
    const persistenceScore = clamp(
      0.35 * tradeBalance +
        0.25 * activityBalance +
        0.2 * (activeHalves / 2) +
        0.2 * (positiveHalves / 2),
      0,
      1
    );
    const maxDrawdownPct =
      segment.pnlNet > 0
        ? (Math.max(0, segment.maxDrawdown) / Math.max(1e-9, segment.pnlNet)) * 100
        : null;

    return {
      ...segment,
      trades: scored.trades,
      winRate: scored.winRate,
      winRateLB: scored.winRateLB,
      profitFactor: scored.profitFactor,
      score: scored.score,
      activityDays,
      lastFillAgeDays,
      expectancyUsd,
      downsideDeviationUsd,
      tradePnlConcentration,
      tradeDayConcentration,
      dailyPnlSeries,
      maxDrawdownPct,
      persistenceScore,
      positiveHalves,
      activeHalves,
      persistence: {
        early,
        late,
        tradeBalance,
        activityBalance,
        activeHalves,
        positiveHalves,
        score: persistenceScore,
      },
    };
  };

  const all = createSegmentStats();
  const target = createSegmentStats({ includeByCoin: true });

  const getCoin = (coin) => {
    const normalizedCoin = String(coin || "").toUpperCase();
    if (targetCoinSet.size && !targetCoinSet.has(normalizedCoin)) return null;
    if (!target.byCoin[normalizedCoin]) target.byCoin[normalizedCoin] = createSegmentStats();
    return target.byCoin[normalizedCoin];
  };

  for (const fill of fills) {
    if (fill.time < windowStartMs || fill.time > windowEndMs) continue;

    const day = Math.floor(fill.time / dayMs);
    const realizedGross = num(fill.closedPnl, 0);
    const fee = num(fill.fee, 0);
    const realizedNet = realizedGross - fee;

    ingestSegment(all, fill, day, realizedGross, realizedNet);

    const coinMetrics = getCoin(fill.coin);
    if (!coinMetrics) continue;
    ingestSegment(target, fill, day, realizedGross, realizedNet);
    ingestSegment(coinMetrics, fill, day, realizedGross, realizedNet);
  }

  if (all.fills === 0) return null;

  const finalizedTarget = finalizeSegment(target);
  const finalizedByCoin = {};
  for (const coin of Object.keys(target.byCoin || {})) {
    const finalizedCoin = finalizeSegment(target.byCoin[coin]);
    delete finalizedCoin.activeDays;
    delete finalizedCoin.tradeDays;
    delete finalizedCoin.dailyPnl;
    delete finalizedCoin.negativeTradePnls;
    delete finalizedCoin.halfStats;
    finalizedByCoin[coin] = finalizedCoin;
  }

  const finalizedAll = finalizeSegment(all);
  const fillRatio = finalizedAll.fills > 0 ? finalizedTarget.fills / finalizedAll.fills : 0;

  delete finalizedTarget.activeDays;
  delete finalizedTarget.tradeDays;
  delete finalizedTarget.dailyPnl;
  delete finalizedTarget.negativeTradePnls;
  delete finalizedTarget.halfStats;
  delete finalizedAll.activeDays;
  delete finalizedAll.tradeDays;
  delete finalizedAll.dailyPnl;
  delete finalizedAll.negativeTradePnls;
  delete finalizedAll.halfStats;

  return {
    wallet: { address },
    trades: finalizedTarget.trades,
    wins: finalizedTarget.wins,
    losses: finalizedTarget.losses,
    winRate: finalizedTarget.winRate,
    winRateLB: finalizedTarget.winRateLB,
    pnlNet: finalizedTarget.pnlNet,
    pnlGross: finalizedTarget.pnlGross,
    fees: finalizedTarget.fees,
    maxDrawdownGross: finalizedTarget.maxDrawdown,
    liquidationCount: finalizedTarget.liquidationCount,
    activityDays: finalizedTarget.activityDays,
    lastFillAgeDays: finalizedTarget.lastFillAgeDays,
    expectancyUsd: finalizedTarget.expectancyUsd,
    downsideDeviationUsd: finalizedTarget.downsideDeviationUsd,
    tradePnlConcentration: finalizedTarget.tradePnlConcentration,
    tradeDayConcentration: finalizedTarget.tradeDayConcentration,
    dailyPnlSeries: finalizedTarget.dailyPnlSeries,
    targetDrawdownPct: finalizedTarget.maxDrawdownPct,
    persistenceScore: finalizedTarget.persistenceScore,
    positiveHalves: finalizedTarget.positiveHalves,
    persistence: finalizedTarget.persistence,
    target: {
      coins: Array.from(targetCoinSet),
      fills: finalizedTarget.fills,
      fillRatio,
      activityDays: finalizedTarget.activityDays,
      lastFillAgeDays: finalizedTarget.lastFillAgeDays,
      trades: finalizedTarget.trades,
      expectancyUsd: finalizedTarget.expectancyUsd,
      downsideDeviationUsd: finalizedTarget.downsideDeviationUsd,
      tradePnlConcentration: finalizedTarget.tradePnlConcentration,
      tradeDayConcentration: finalizedTarget.tradeDayConcentration,
      dailyPnlSeries: finalizedTarget.dailyPnlSeries,
      maxDrawdownPct: finalizedTarget.maxDrawdownPct,
      byCoin: finalizedByCoin,
    },
    score: finalizedTarget.score,
    all: {
      fills: finalizedAll.fills,
      trades: finalizedAll.trades,
      wins: finalizedAll.wins,
      losses: finalizedAll.losses,
      pnlNet: finalizedAll.pnlNet,
      pnlGross: finalizedAll.pnlGross,
      fees: finalizedAll.fees,
      maxDrawdownGross: finalizedAll.maxDrawdown,
      liquidationCount: finalizedAll.liquidationCount,
      activityDays: finalizedAll.activityDays,
      lastFillAgeDays: finalizedAll.lastFillAgeDays,
    },
  };
}

function main() {
  const args = parseArgs(process.argv);
  const analysisDir = path.join(process.cwd(), "results", "json", "hyperliquid-wallet-performance");
  const analysisFile = args.analysisFile || findLatestFile(analysisDir);
  if (!analysisFile) {
    console.error("No analysis file found. Provide --analysisFile=... or run Phase 1 first.");
    process.exit(1);
  }

  const analysis = JSON.parse(fs.readFileSync(analysisFile, "utf8"));
  const eligibleOnly = bool(args.eligibleOnly, true);
  const topK = Math.max(1, num(args.topK, num(process.env.COPY_TOPK_SIZE, 10)));
  const minLeadersRequested = Math.max(
    1,
    num(
      args.minLeaders,
      num(process.env.COPY_STRATEGY_MIN_LEADERS, num(process.env.COPY_MIN_LEADERS, 7))
    )
  );
  const minLeaders = Math.min(topK, minLeadersRequested);
  const enter = clamp(num(args.enter, num(process.env.COPY_CONSENSUS_ENTER, 0.65)), 0, 1);
  const exit = clamp(num(args.exit, num(process.env.COPY_CONSENSUS_EXIT, 0.55)), 0, 1);
  const feeBps = Math.max(0, num(args.feeBps, num(process.env.COPY_BACKTEST_FEE_BPS, 6)));
  const slippageBps = Math.max(0, num(args.slippageBps, num(process.env.COPY_BACKTEST_SLIPPAGE_BPS, 8)));
  const maxNotional = Math.max(1, num(args.maxNotional, num(process.env.COPY_MAX_NOTIONAL_PER_SYMBOL, 2000)));
  const startingBalance = Math.max(1, num(args.startingBalance, num(process.env.STARTING_BALANCE_COPY, 500)));
  const minHoldMs = Math.max(0, num(args.minHoldMinutes, num(process.env.COPY_MIN_HOLD_MINUTES, 0))) * 60_000;
  const cooldownMs = Math.max(0, num(args.cooldownMinutes, num(process.env.COPY_COOLDOWN_MINUTES, 0))) * 60_000;
  const exitOnLowLeaders = bool(args.exitOnLowLeaders, bool(process.env.COPY_EXIT_ON_LOW_LEADERS, true));
  const minScore = num(args.minScore, num(process.env.COPY_MIN_SCORE, -Infinity));
  const minTargetFillRatio = num(args.minTargetFillRatio, num(process.env.COPY_MIN_TARGET_FILL_RATIO, -Infinity));
  const minTargetActiveDays = num(args.minTargetActiveDays, num(process.env.COPY_MIN_TARGET_ACTIVE_DAYS, -Infinity));
  const maxLastFillAgeDays = num(args.maxLastFillAgeDays, num(process.env.COPY_MAX_LAST_FILL_AGE_DAYS, Infinity));
  const weightMode = String(args.weightMode || process.env.COPY_WEIGHT_MODE || "hybrid").toLowerCase();
  const dropWallets = String(args.dropWallets || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.startsWith("0x"));
  const dropTopN = Math.max(0, num(args.dropTopN, 0));
  const walkForward = bool(args.walkForward, bool(process.env.COPY_WALK_FORWARD, false));
  const rebalanceDays = Math.max(1, num(args.rebalanceDays, num(process.env.COPY_REBALANCE_DAYS, 7)));
  const selectionLookbackDays = Math.max(
    7,
    num(args.selectionLookbackDays, num(process.env.COPY_SELECTION_LOOKBACK_DAYS, 60))
  );
  const universeMaxWallets = Math.max(
    topK,
    num(args.universeMaxWallets, num(process.env.COPY_UNIVERSE_MAX_WALLETS, 200))
  );
  const winRateZ = num(args.winRateZ, num(process.env.COPY_WINRATE_Z, 1.96));
  const selectionMinTrades = Math.max(
    0,
    num(
      args.selectionMinTrades,
      num(process.env.COPY_SELECTION_MIN_TRADES, num(process.env.COPY_MIN_TRADES_FOR_SCORING, 40))
    )
  );
  const symbols = String(args.symbols || process.env.COPY_TARGET_SYMBOLS || "BTC,ETH,SOL")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const targetCoins = new Set(symbols);

  const wallets = eligibleOnly
    ? analysis.eligible || []
    : analysis.ranked || [];

  if (!wallets.length) {
    console.error("No wallets available for backtest (eligible list is empty).");
    process.exit(1);
  }

  const overrides = loadOverrides();
  const validWeightMode = ["scorepos", "hybrid", "winrate"].includes(weightMode) ? weightMode : "hybrid";

  const filteredWallets = wallets.filter((w) => {
    const scoreOk = num(w.score, -Infinity) >= minScore;
    const ratioOk = num(w.target?.fillRatio, -Infinity) >= minTargetFillRatio;
    const daysOk = num(w.target?.activityDays, -Infinity) >= minTargetActiveDays;
    const recOk = num(w.targetLastFillAgeDays ?? w.target?.lastFillAgeDays ?? w.lastFillAgeDays, Infinity) <= maxLastFillAgeDays;
    return scoreOk && ratioOk && daysOk && recOk;
  });

  let topWallets = filteredWallets.slice(0, topK);
  if (dropTopN > 0) topWallets = topWallets.slice(Math.min(dropTopN, topWallets.length));
  if (dropWallets.length) {
    topWallets = topWallets.filter(
      (w) => !dropWallets.includes(String(w.wallet?.address || w.wallet).toLowerCase())
    );
  }

  if (!walkForward && topWallets.length < minLeaders) {
    console.error(
      `Not enough wallets after filters. Have ${topWallets.length}, need minLeaders=${minLeaders}. Adjust --minScore/--minTarget* or --minLeaders.`
    );
    process.exit(1);
  }

  let weights = new Map();
  let selector = null;
  if (!walkForward) {
    weights = buildWeights(topWallets, { minWeight: 0.03, maxWeight: 0.25, weightMode: validWeightMode }, overrides);
  } else {
    const gateFillRatioDefault = num(process.env.COPY_CANDIDATE_MIN_TARGET_FILL_RATIO, 0.5);
    const gateTargetDaysDefault = num(process.env.COPY_CANDIDATE_MIN_TARGET_ACTIVE_DAYS, 3);
    const gateLastAgeDefault = num(process.env.COPY_CANDIDATE_MAX_LAST_FILL_AGE_DAYS, 7);

    const effectiveMinTargetFillRatio =
      minTargetFillRatio === -Infinity ? gateFillRatioDefault : clamp(minTargetFillRatio, 0, 1);
    const effectiveMinTargetActiveDays =
      minTargetActiveDays === -Infinity ? gateTargetDaysDefault : Math.max(0, minTargetActiveDays);
    const effectiveMaxLastFillAgeDays =
      maxLastFillAgeDays === Infinity ? gateLastAgeDefault : Math.max(0, maxLastFillAgeDays);

    selector = createLeaderSelector(
      {
        topKSize: topK,
        promoteThreshold: num(args.promoteThreshold, num(process.env.COPY_PROMOTE_THRESHOLD, 0.55)),
        dropThreshold: num(args.dropThreshold, num(process.env.COPY_DROP_THRESHOLD, 0.45)),
        dropPersistenceRuns: num(
          args.dropPersistenceRuns,
          num(process.env.COPY_DROP_PERSISTENCE_RUNS, 3)
        ),
        maxChurnPerUpdate: num(
          args.maxChurnPerUpdate,
          num(process.env.COPY_MAX_CHURN_PER_UPDATE, 2)
        ),
        cooldownDays: num(args.cooldownDays, num(process.env.COPY_DROPPED_COOLDOWN_DAYS, 7)),

        minTrades: selectionMinTrades,
        minTargetFillRatio: effectiveMinTargetFillRatio,
        minTargetActiveDays: effectiveMinTargetActiveDays,
        maxLastFillAgeDays: effectiveMaxLastFillAgeDays,

        minWeight: num(args.minWeight, num(process.env.COPY_WEIGHT_CAP_MIN, 0.05)),
        maxWeight: num(args.maxWeight, num(process.env.COPY_WEIGHT_CAP_MAX, 0.25)),
        probationWeightMult: num(args.probationWeightMult, 0.35),
        eliteWeightMult: num(args.eliteWeightMult, num(process.env.COPY_ELITE_WEIGHT_MULT, 1.5)),
      },
      overrides,
      null
    );
  }

  const cacheRoot = path.join(process.cwd(), "results", "json", "hyperliquid-cache");
  const startTime = parseTimeValue(analysis.summary?.config?.startTime);
  const endTime = parseTimeValue(analysis.summary?.config?.endTime);
  const replayStartMs = num(args.replayStartMs, startTime);
  const replayEndMs = num(args.replayEndMs, endTime);

  const events = [];
  const walletStates = new Map();
  const fillsByWallet = new Map(); // wallet -> parsed fills (all coins)
  if (!startTime || !endTime) {
    console.error("Analysis file missing start/end times.");
    process.exit(1);
  }

  const universe =
    walkForward
      ? (analysis.ranked || analysis.eligible || wallets).slice(0, universeMaxWallets)
      : topWallets;

  for (const w of universe) {
    const address = String(w.wallet?.address || w.wallet).toLowerCase();
    walletStates.set(address, new Map());
    const cacheFile = path.join(cacheRoot, address, `${startTime}-${endTime}.json`);
    const raw = readJsonIfExists(cacheFile);
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const parsedFills = [];
    for (const f of raw) {
      const parsed = parseFill(f);
      if (!parsed) continue;
      parsedFills.push(parsed);
      if (replayStartMs != null && parsed.time < replayStartMs) continue;
      if (replayEndMs != null && parsed.time > replayEndMs) continue;
      if (symbols.length && !symbols.includes(parsed.coin)) continue;
      events.push({ wallet: address, ...parsed });
    }
    parsedFills.sort((a, b) => a.time - b.time);
    fillsByWallet.set(address, parsedFills);
  }

  events.sort((a, b) => a.time - b.time);

  let equity = startingBalance;
  const positions = new Map(); // symbol -> { side, entryPx, sizeNotional }
  const lastPrice = new Map();
  const lastTradeTsBySymbol = new Map();
  const trades = [];
  let maxEquity = equity;
  let maxDrawdown = 0;

  function updateDrawdown() {
    if (equity > maxEquity) maxEquity = equity;
    const dd = maxEquity - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const rebalanceEveryMs = rebalanceDays * dayMs;
  let rebalanceCount = 0;
  let nextRebalanceMs = walkForward ? (replayStartMs || startTime) + selectionLookbackDays * dayMs : null;

  function recomputeLeaders(atMs) {
    const windowEndMs = atMs;
    const windowStartMs = windowEndMs - selectionLookbackDays * dayMs;
    const candidates = [];

    for (const [wallet, fills] of fillsByWallet.entries()) {
      const m = computeWindowMetrics(wallet, fills, {
        windowStartMs,
        windowEndMs,
        targetCoins,
        winRateZ,
      });
      if (!m) continue;

      if ((m.trades || 0) < selectionMinTrades) continue;
      const elite =
        bool(process.env.COPY_ELITE_ENABLED, true) &&
        (m.trades || 0) >= num(process.env.COPY_ELITE_MIN_TRADES, 120) &&
        (m.activityDays || 0) >= num(process.env.COPY_ELITE_MIN_ACTIVE_DAYS, 10) &&
        num(m.winRateLB, 0) >= num(process.env.COPY_ELITE_WINRATE_POSTERIOR_LB_MIN, 0.62) &&
        num(m.liquidationCount, 0) === 0;

      candidates.push({
        address: wallet,
        score: m.score,
        winRateLB: m.winRateLB,
        trades: m.trades,
        lastFillAgeDays: m.target?.lastFillAgeDays ?? m.lastFillAgeDays,
        targetFillRatio: m.target?.fillRatio ?? 0,
        targetActivityDays: m.target?.activityDays ?? 0,
        liquidationCount: m.liquidationCount ?? 0,
        elite,
      });
    }

    if (selector) {
      const res = selector.update({ candidates, nowMs: atMs });
      return res.weights;
    }

    // Fallback (shouldn't happen in walk-forward mode): simple weights.
    candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const leaders = candidates.slice(0, topK).map((c) => ({
      wallet: { address: c.address },
      score: c.score,
      winRateLB: c.winRateLB,
      trades: c.trades,
    }));
    if (leaders.length < minLeaders) return new Map();
    return buildWeights(leaders, { minWeight: 0.03, maxWeight: 0.25, weightMode: validWeightMode }, overrides);
  }

  for (const ev of events) {
    const perSym = walletStates.get(ev.wallet);
    if (!perSym) continue;
    const prevPos = perSym.get(ev.coin) || 0;
    const newPos = prevPos + ev.side * ev.sz;
    perSym.set(ev.coin, newPos);
    lastPrice.set(ev.coin, ev.px);

    if (walkForward && nextRebalanceMs != null) {
      while (ev.time >= nextRebalanceMs && nextRebalanceMs <= (replayEndMs || endTime)) {
        weights = recomputeLeaders(nextRebalanceMs);
        rebalanceCount += 1;
        nextRebalanceMs += rebalanceEveryMs;
      }
    }

    const { consensus, contributors } = calcConsensusStats(ev.coin, walletStates, weights);
    const existing = positions.get(ev.coin);
    const lastTradeTs = lastTradeTsBySymbol.get(ev.coin) || 0;

    if (!existing && Math.abs(consensus) >= enter) {
      if (positions.size >= num(process.env.COPY_MAX_POSITIONS, 2)) continue;
      if (contributors < minLeaders) continue;
      if (cooldownMs > 0 && ev.time - lastTradeTs < cooldownMs) continue;
      if (walkForward && (!weights || weights.size === 0)) continue;
      const side = consensus > 0 ? 1 : -1;
      const entryPx = applySlippage(ev.px, side, slippageBps);
      const notional = Math.min(maxNotional, equity);
      const fee = (notional * feeBps) / 10_000;
      equity -= fee;
      positions.set(ev.coin, { side, entryPx, sizeNotional: notional, entryTime: ev.time });
      lastTradeTsBySymbol.set(ev.coin, ev.time);
      trades.push({ symbol: ev.coin, side, entryPx, entryTime: ev.time, entryFee: fee });
      updateDrawdown();
      continue;
    }

    if (existing) {
      const heldMs = ev.time - existing.entryTime;
      const flipSignal =
        (existing.side > 0 && consensus <= -enter) || (existing.side < 0 && consensus >= enter);
      const weakenSignal = Math.abs(consensus) <= exit;
      const lowLeaders = exitOnLowLeaders && contributors < minLeaders;

      const exitSignal = flipSignal || lowLeaders || (weakenSignal && heldMs >= minHoldMs);
      if (!exitSignal) continue;
      const exitPx = applySlippage(ev.px, -existing.side, slippageBps);
      const priceChange = (exitPx - existing.entryPx) / existing.entryPx;
      const pnl = existing.sizeNotional * priceChange * existing.side;
      const fee = (existing.sizeNotional * feeBps) / 10_000;
      equity += pnl - fee;
      lastTradeTsBySymbol.set(ev.coin, ev.time);
      trades[trades.length - 1] = {
        ...trades[trades.length - 1],
        exitPx,
        exitTime: ev.time,
        exitFee: fee,
        pnl,
      };
      positions.delete(ev.coin);
      updateDrawdown();
    }
  }

  // Close remaining positions at last price
  for (const [symbol, pos] of positions.entries()) {
    const px = lastPrice.get(symbol);
    if (!Number.isFinite(px)) continue;
    const exitPx = applySlippage(px, -pos.side, slippageBps);
    const priceChange = (exitPx - pos.entryPx) / pos.entryPx;
    const pnl = pos.sizeNotional * priceChange * pos.side;
    const fee = (pos.sizeNotional * feeBps) / 10_000;
    equity += pnl - fee;
    trades.push({
      symbol,
      side: pos.side,
      entryPx: pos.entryPx,
      exitPx,
      entryTime: pos.entryTime,
      exitTime: replayEndMs || endTime || Date.now(),
      pnl,
      entryFee: 0,
      exitFee: fee,
    });
    updateDrawdown();
  }

  const closedTrades = trades.filter((t) => t.exitTime != null);
  const wins = closedTrades.filter((t) => t.pnl > 0).length;
  const losses = closedTrades.filter((t) => t.pnl < 0).length;
  const winRate = closedTrades.length ? wins / closedTrades.length : 0;

  const summary = {
    generatedAt: new Date().toISOString(),
    analysisFile,
    symbols,
    topK,
    minLeaders,
    minScore,
    minTargetFillRatio,
    minTargetActiveDays,
    maxLastFillAgeDays,
    dropWallets,
    dropTopN,
    replayStartMs,
    replayEndMs,
    walkForward,
    rebalanceDays: walkForward ? rebalanceDays : null,
    selectionLookbackDays: walkForward ? selectionLookbackDays : null,
    universeMaxWallets: walkForward ? universeMaxWallets : null,
    winRateZ: walkForward ? winRateZ : null,
    selectionMinTrades: walkForward ? selectionMinTrades : null,
    rebalanceCount: walkForward ? rebalanceCount : null,
    enter,
    exit,
    feeBps,
    slippageBps,
    minHoldMinutes: minHoldMs / 60_000,
    cooldownMinutes: cooldownMs / 60_000,
    exitOnLowLeaders,
    weightMode,
    startingBalance,
    endingBalance: equity,
    netPnl: equity - startingBalance,
    maxDrawdown,
    trades: closedTrades.length,
    winRate,
  };

  const outRoot = path.join(process.cwd(), "results", "json", "copy-trading-backtest");
  ensureDir(outRoot);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(outRoot, `${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ summary, trades: closedTrades }, null, 2));

  console.log("Output:", outFile);
  console.log("Summary:", summary);
}

module.exports = {
  parseFill,
  buildWeights,
  calcConsensusStats,
  calcConsensusStatsPhase6,
  applySlippage,
  computeWindowMetrics,
  wilsonLowerBound,
};

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("Fatal:", e?.message || e);
    process.exit(1);
  }
}

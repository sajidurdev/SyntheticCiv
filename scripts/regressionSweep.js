const Simulation = require("../src/core/simulation");

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function safeMean(values) {
  if (!values.length) return 0;
  return values.reduce((acc, n) => acc + n, 0) / values.length;
}

function summarizeRuns(runs, key) {
  const values = runs.map((r) => r[key]).filter((n) => Number.isFinite(n));
  return {
    mean: safeMean(values),
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0
  };
}

function pearsonCorrelation(xs, ys) {
  if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length !== ys.length || xs.length < 2) {
    return 0;
  }
  const mx = safeMean(xs);
  const my = safeMean(ys);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = (xs[i] || 0) - mx;
    const dy = (ys[i] || 0) - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 1e-12 || vy <= 1e-12) {
    return 0;
  }
  return cov / Math.sqrt(vx * vy);
}

function sampleSettlementAverages(sim) {
  const active = sim.settlements.filter((s) => Array.isArray(s.members) ? s.members.length > 0 : (s.population || 0) > 0);
  if (!active.length) {
    return {
      avgConflictRate: 0,
      avgStability: 0,
      avgPressure: 0,
      avgFoodStress: 0,
      activeSettlementCount: 0,
      avgMarketIndex: 1,
      foodPriceVariance: 0,
      maxMarketPrice: 1,
      minMarketPrice: 1
    };
  }
  const foodPrices = active.map((s) => s.market?.prices?.food ?? 1);
  const materialPrices = active.map((s) => s.market?.prices?.materials ?? 1);
  const wealthPrices = active.map((s) => s.market?.prices?.wealth ?? 1);
  const foodMean = safeMean(foodPrices);
  const foodPriceVariance = safeMean(foodPrices.map((p) => {
    const d = p - foodMean;
    return d * d;
  }));
  const avgMarketIndex = safeMean(active.map((s) => {
    const prices = s.market?.prices || {};
    return (
      (prices.food ?? 1) +
      (prices.materials ?? 1) +
      (prices.wealth ?? 1)
    ) / 3;
  }));
  const denom = active.length;
  return {
    avgConflictRate: active.reduce((acc, s) => acc + (s.conflictRate || 0), 0) / denom,
    avgStability: active.reduce((acc, s) => acc + (s.stability || s.stabilityScore || 0), 0) / denom,
    avgPressure: active.reduce((acc, s) => acc + (s.resourcePressure || 0), 0) / denom,
    avgFoodStress: active.reduce((acc, s) => acc + (s.resourceEMA?.foodStress || 0), 0) / denom,
    activeSettlementCount: active.length,
    avgMarketIndex,
    foodPriceVariance,
    maxMarketPrice: Math.max(...foodPrices, ...materialPrices, ...wealthPrices),
    minMarketPrice: Math.min(...foodPrices, ...materialPrices, ...wealthPrices)
  };
}

function evaluateBands(run) {
  const checks = [];
  checks.push({
    key: "avgConflictRate",
    pass: run.avgConflictRate >= 0.03 && run.avgConflictRate <= 0.82
  });
  checks.push({
    key: "avgStability",
    pass: run.avgStability >= 0.18 && run.avgStability <= 0.92
  });
  checks.push({
    key: "avgPressure",
    pass: run.avgPressure >= 0.03 && run.avgPressure <= 0.96
  });
  checks.push({
    key: "activeSettlements",
    pass: run.activeSettlementCount >= 1
  });
  checks.push({
    key: "birthsPer1kTicks",
    pass: run.birthsPer1kTicks >= 0.5
  });
  checks.push({
    key: "deathsPer1kTicks",
    pass: run.deathsPer1kTicks >= 0.1
  });
  checks.push({
    key: "interactionUtilization",
    pass: run.interactionUtilization >= 0.2 && run.interactionUtilization <= 1.01
  });
  checks.push({
    key: "marketPriceBounds",
    pass: run.minMarketPrice >= 0.24 && run.maxMarketPrice <= 4.05
  });
  checks.push({
    key: "marketVariance",
    pass: run.activeSettlementCount < 1.5 || run.avgFoodPriceVariance >= 0.00001
  });
  checks.push({
    key: "marketIndex",
    pass: run.avgMarketIndex >= 0.45 && run.avgMarketIndex <= 2.2
  });
  checks.push({
    key: "routeGapTradeCorr",
    pass: run.avgRoutePriceGap <= 1e-6 || run.routeGapTradeCorr >= -0.2
  });
  return checks;
}

function runSingle(config, seed) {
  const sim = new Simulation({
    seed,
    width: config.width,
    height: config.height,
    agentCount: config.agentCount,
    saveEveryTicks: config.ticks + 1,
    snapshotInterval: 1000000,
    keyframeInterval: 1000000,
    debugMetricsEvery: config.ticks + 1,
    interactionBudgetPerAgent: config.interactionBudgetPerAgent,
    interactionNeighborSampleCap: config.interactionNeighborSampleCap,
    interactionGlobalPairScale: config.interactionGlobalPairScale
  });

  const sampled = [];
  for (let i = 0; i < config.ticks; i += 1) {
    sim.step();
    if (sim.tick >= config.warmupTicks && sim.tick % config.sampleInterval === 0) {
      sampled.push(sampleSettlementAverages(sim));
    }
  }

  const avgConflictRate = safeMean(sampled.map((s) => s.avgConflictRate));
  const avgStability = safeMean(sampled.map((s) => s.avgStability));
  const avgPressure = safeMean(sampled.map((s) => s.avgPressure));
  const avgFoodStress = safeMean(sampled.map((s) => s.avgFoodStress));
  const activeSettlementCount = safeMean(sampled.map((s) => s.activeSettlementCount));
  const avgMarketIndex = safeMean(sampled.map((s) => s.avgMarketIndex));
  const avgFoodPriceVariance = safeMean(sampled.map((s) => s.foodPriceVariance));
  const maxMarketPrice = sampled.length ? Math.max(...sampled.map((s) => s.maxMarketPrice)) : 1;
  const minMarketPrice = sampled.length ? Math.min(...sampled.map((s) => s.minMarketPrice)) : 1;

  const totals = sim.populationCounterTotals || {};
  const births = totals.spawnedBirth || 0;
  const deaths = totals.despawnedDeath || 0;
  const birthsPer1kTicks = births / Math.max(1, config.ticks / 1000);
  const deathsPer1kTicks = deaths / Math.max(1, config.ticks / 1000);

  const interaction = sim.lastInteractionDiagnostics || {};
  const interactionUtilization = (interaction.globalPairCap || 0) > 0
    ? (interaction.processedPairs || 0) / interaction.globalPairCap
    : 0;
  const routes = sim.buildTradeRoutes();
  const routeGapTradeCorr = pearsonCorrelation(
    routes.map((r) => r.routePriceGap || 0),
    routes.map((r) => r.tradeVolume || 0)
  );
  const avgRoutePriceGap = safeMean(routes.map((r) => r.routePriceGap || 0));

  const eras = sim.getEraHistorySnapshot(300);
  const eraCount = Array.isArray(eras?.eras) ? eras.eras.length : 0;
  const milestoneCount = Array.isArray(eras?.milestones) ? eras.milestones.length : 0;

  return {
    seed,
    finalAgents: sim.agents.length,
    births,
    deaths,
    birthsPer1kTicks,
    deathsPer1kTicks,
    avgConflictRate,
    avgStability,
    avgPressure,
    avgFoodStress,
    activeSettlementCount,
    avgMarketIndex,
    avgFoodPriceVariance,
    maxMarketPrice,
    minMarketPrice,
    routeGapTradeCorr,
    avgRoutePriceGap,
    interactionUtilization,
    interactionPairsProcessed: interaction.processedPairs || 0,
    interactionPairCap: interaction.globalPairCap || 0,
    eraCount,
    milestoneCount
  };
}

function formatMetric(name, summary) {
  return `${name}: mean=${summary.mean.toFixed(4)} min=${summary.min.toFixed(4)} max=${summary.max.toFixed(4)}`;
}

function main() {
  const args = parseArgs(process.argv);
  const mode = String(args.mode || "sweep");
  const cfg = {
    runs: Math.max(1, Math.floor(asNumber(args.runs, 8))),
    ticks: Math.max(500, Math.floor(asNumber(args.ticks, 6000))),
    warmupTicks: Math.max(0, Math.floor(asNumber(args.warmup, 2000))),
    sampleInterval: Math.max(10, Math.floor(asNumber(args.sampleInterval, 40))),
    seedStart: Math.floor(asNumber(args.seedStart, 1001)),
    width: Math.max(24, Math.floor(asNumber(args.width, 72))),
    height: Math.max(24, Math.floor(asNumber(args.height, 72))),
    agentCount: Math.max(50, Math.floor(asNumber(args.agentCount, 260))),
    interactionBudgetPerAgent: Math.max(1, Math.floor(asNumber(args.interactionBudgetPerAgent, 12))),
    interactionNeighborSampleCap: Math.max(1, Math.floor(asNumber(args.interactionNeighborSampleCap, 20))),
    interactionGlobalPairScale: Math.max(0.2, asNumber(args.interactionGlobalPairScale, 0.8))
  };

  const runs = [];
  for (let i = 0; i < cfg.runs; i += 1) {
    const seed = cfg.seedStart + i;
    const run = runSingle(cfg, seed);
    run.bandChecks = evaluateBands(run);
    run.passed = run.bandChecks.every((c) => c.pass);
    const failed = run.bandChecks.filter((c) => !c.pass).map((c) => c.key).join(",");
    runs.push(run);
    console.log(
      `[run ${i + 1}/${cfg.runs}] seed=${seed} pass=${run.passed ? "yes" : "no"} ` +
      `agents=${run.finalAgents} births=${run.births} deaths=${run.deaths} ` +
      `conf=${run.avgConflictRate.toFixed(3)} stab=${run.avgStability.toFixed(3)} ` +
      `press=${run.avgPressure.toFixed(3)} util=${run.interactionUtilization.toFixed(3)}` +
      (failed ? ` failed=[${failed}]` : "")
    );
  }

  const summary = {
    finalAgents: summarizeRuns(runs, "finalAgents"),
    birthsPer1kTicks: summarizeRuns(runs, "birthsPer1kTicks"),
    deathsPer1kTicks: summarizeRuns(runs, "deathsPer1kTicks"),
    avgConflictRate: summarizeRuns(runs, "avgConflictRate"),
    avgStability: summarizeRuns(runs, "avgStability"),
    avgPressure: summarizeRuns(runs, "avgPressure"),
    avgFoodStress: summarizeRuns(runs, "avgFoodStress"),
    interactionUtilization: summarizeRuns(runs, "interactionUtilization"),
    activeSettlementCount: summarizeRuns(runs, "activeSettlementCount"),
    avgMarketIndex: summarizeRuns(runs, "avgMarketIndex"),
    avgFoodPriceVariance: summarizeRuns(runs, "avgFoodPriceVariance"),
    routeGapTradeCorr: summarizeRuns(runs, "routeGapTradeCorr"),
    avgRoutePriceGap: summarizeRuns(runs, "avgRoutePriceGap")
  };

  console.log("");
  console.log("=== Sweep Summary ===");
  console.log(formatMetric("finalAgents", summary.finalAgents));
  console.log(formatMetric("birthsPer1kTicks", summary.birthsPer1kTicks));
  console.log(formatMetric("deathsPer1kTicks", summary.deathsPer1kTicks));
  console.log(formatMetric("avgConflictRate", summary.avgConflictRate));
  console.log(formatMetric("avgStability", summary.avgStability));
  console.log(formatMetric("avgPressure", summary.avgPressure));
  console.log(formatMetric("avgFoodStress", summary.avgFoodStress));
  console.log(formatMetric("interactionUtilization", summary.interactionUtilization));
  console.log(formatMetric("activeSettlementCount", summary.activeSettlementCount));
  console.log(formatMetric("avgMarketIndex", summary.avgMarketIndex));
  console.log(formatMetric("avgFoodPriceVariance", summary.avgFoodPriceVariance));
  console.log(formatMetric("routeGapTradeCorr", summary.routeGapTradeCorr));
  console.log(formatMetric("avgRoutePriceGap", summary.avgRoutePriceGap));

  const passCount = runs.filter((r) => r.passed).length;
  const passRate = passCount / Math.max(1, runs.length);
  console.log(`passRate=${(passRate * 100).toFixed(1)}% (${passCount}/${runs.length})`);

  if (mode === "regression") {
    const minPassRate = Math.max(0, Math.min(1, asNumber(args.minPassRate, 0.75)));
    if (passRate < minPassRate) {
      console.error(`Regression failed: pass rate ${(passRate * 100).toFixed(1)}% < ${(minPassRate * 100).toFixed(1)}%`);
      process.exit(1);
    }
  }
}

main();

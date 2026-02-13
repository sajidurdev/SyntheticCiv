
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function asNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function mean(list) {
  if (!list.length) return 0;
  return list.reduce((acc, n) => acc + n, 0) / list.length;
}

function normalizeSettlementId(id) {
  return String(id || "");
}

function normalizeEraType(type) {
  const allowed = new Set(["Expansion", "Crisis", "Stabilization", "Collapse", "Emergence"]);
  return allowed.has(type) ? type : "Stabilization";
}

function buildDefaultOptions(options = {}) {
  return {
    evaluationInterval: options.evaluationInterval ?? 240,
    historyLimit: options.historyLimit ?? 160,
    milestoneLimit: options.milestoneLimit ?? 220,
    minEraDuration: options.minEraDuration ?? 540,

    shortWindowLongOffset: options.shortWindowLongOffset ?? 6,
    longWindowOffset: options.longWindowOffset ?? 12,
    longWindowBuffer: options.longWindowBuffer ?? 12,

    saturationSpikeLevel: options.saturationSpikeLevel ?? 0.72,
    saturationSpikeDelta: options.saturationSpikeDelta ?? 0.09,
    saturationPlateauLevel: options.saturationPlateauLevel ?? 0.8,
    saturationPlateauSustain: options.saturationPlateauSustain ?? 6,
    borderWarConflictLevel: options.borderWarConflictLevel ?? 0.7,
    highPressurePlateauLevel: options.highPressurePlateauLevel ?? 0.6,
    slowAttritionGrowthLevel: options.slowAttritionGrowthLevel ?? -0.001,
    plateauSustainCount: options.plateauSustainCount ?? 6,

    collapseStabilityLevel: options.collapseStabilityLevel ?? 0.35,
    collapseStabilityDelta: options.collapseStabilityDelta ?? 0.06,
    collapseLongStabilityDelta: options.collapseLongStabilityDelta ?? 0.1,
    collapseConflictLongRise: options.collapseConflictLongRise ?? 0.1,

    pressureCrisisLevel: options.pressureCrisisLevel ?? 0.68,

    expansionSettlementDelta: options.expansionSettlementDelta ?? 2,
    expansionTradeDelta: options.expansionTradeDelta ?? 0.18,
    expansionLongSettlementDelta: options.expansionLongSettlementDelta ?? 2,
    expansionLongTradeGrowth: options.expansionLongTradeGrowth ?? 0.08,

    emergenceSettlementDelta: options.emergenceSettlementDelta ?? 1,

    diplomacyShiftDelta: options.diplomacyShiftDelta ?? 0.15,
    diplomacyLongShiftDelta: options.diplomacyLongShiftDelta ?? 0.18,
    diplomacyShortSustainDelta: options.diplomacyShortSustainDelta ?? 0.06,
    diplomacyShortSustainCount: options.diplomacyShortSustainCount ?? 3,

    stabilizationStabilityMin: options.stabilizationStabilityMin ?? 0.58,
    stabilizationPressureMax: options.stabilizationPressureMax ?? 0.52,
    stabilizationSaturationMax: options.stabilizationSaturationMax ?? 0.58,

    milestoneMinInterval: options.milestoneMinInterval ?? 1200,
    milestoneMaxInterval: options.milestoneMaxInterval ?? 2400,
    milestoneDiplomacyLongDelta: options.milestoneDiplomacyLongDelta ?? 0.14,
    milestoneStabilityLongDelta: options.milestoneStabilityLongDelta ?? 0.08,
    milestoneTradeFlowLongDelta: options.milestoneTradeFlowLongDelta ?? 0.1,
    milestoneSaturationLongDelta: options.milestoneSaturationLongDelta ?? 0.1,
    milestoneSettlementLongDelta: options.milestoneSettlementLongDelta ?? 2,
    milestoneConflictLongDelta: options.milestoneConflictLongDelta ?? 0.08,

    dedupeStabilityEpsilon: options.dedupeStabilityEpsilon ?? 0.02,
    dedupeSaturationEpsilon: options.dedupeSaturationEpsilon ?? 0.02,
    dedupeDiplomacyEpsilon: options.dedupeDiplomacyEpsilon ?? 0.03,
    dedupeTradeNormEpsilon: options.dedupeTradeNormEpsilon ?? 0.08
  };
}

function createEraHistoryState(options = {}) {
  const cfg = buildDefaultOptions(options);
  return {
    config: cfg,
    nextEraIndex: 1,
    nextMilestoneIndex: 1,
    currentEraId: null,
    lastEvaluationTick: -1,
    lastMilestoneTick: -1,
    lastMetrics: null,
    evaluationHistory: [],
    sustained: {
      diplomacyShortCount: 0,
      diplomacyShortSign: 0,
      saturationPlateauCount: 0,
      borderWarPlateauCount: 0,
      highPressurePlateauCount: 0,
      slowAttritionCount: 0
    },
    lastEmission: null,
    eras: [],
    milestones: []
  };
}

function sanitizeEntry(entry, kind = "era") {
  return {
    ...entry,
    entryType: entry.entryType || kind,
    eraType: normalizeEraType(entry.eraType),
    startTick: Math.floor(asNumber(entry.startTick, 0)),
    endTick: Math.floor(asNumber(entry.endTick, asNumber(entry.startTick, 0))),
    dominantCivilization: entry.dominantCivilization || null,
    globalStateSnapshot: entry.globalStateSnapshot || {}
  };
}

function hydrateEraHistoryState(serialized, options = {}) {
  const base = createEraHistoryState(options);
  if (!serialized || typeof serialized !== "object") {
    return base;
  }

  const evaluationHistory = Array.isArray(serialized.evaluationHistory)
    ? serialized.evaluationHistory.map((row) => ({ ...row }))
    : [];

  const hydrated = {
    ...base,
    nextEraIndex: Math.max(1, Math.floor(asNumber(serialized.nextEraIndex, base.nextEraIndex))),
    nextMilestoneIndex: Math.max(1, Math.floor(asNumber(serialized.nextMilestoneIndex, base.nextMilestoneIndex))),
    currentEraId: serialized.currentEraId || null,
    lastEvaluationTick: Math.floor(asNumber(serialized.lastEvaluationTick, base.lastEvaluationTick)),
    lastMilestoneTick: Math.floor(asNumber(serialized.lastMilestoneTick, base.lastMilestoneTick)),
    lastMetrics: serialized.lastMetrics || null,
    evaluationHistory,
    sustained: {
      diplomacyShortCount: Math.max(0, Math.floor(asNumber(serialized.sustained?.diplomacyShortCount, 0))),
      diplomacyShortSign: Math.sign(asNumber(serialized.sustained?.diplomacyShortSign, 0)),
      saturationPlateauCount: Math.max(0, Math.floor(asNumber(serialized.sustained?.saturationPlateauCount, 0))),
      borderWarPlateauCount: Math.max(0, Math.floor(asNumber(serialized.sustained?.borderWarPlateauCount, 0))),
      highPressurePlateauCount: Math.max(0, Math.floor(asNumber(serialized.sustained?.highPressurePlateauCount, 0))),
      slowAttritionCount: Math.max(0, Math.floor(asNumber(serialized.sustained?.slowAttritionCount, 0)))
    },
    lastEmission: serialized.lastEmission || null,
    eras: Array.isArray(serialized.eras) ? serialized.eras.map((entry) => sanitizeEntry(entry, "era")) : [],
    milestones: Array.isArray(serialized.milestones)
      ? serialized.milestones.map((entry) => sanitizeEntry(entry, "milestone"))
      : []
  };

  if (!hydrated.currentEraId && hydrated.eras.length) {
    hydrated.currentEraId = hydrated.eras[hydrated.eras.length - 1].id;
  }
  if (!hydrated.currentEraId) {
    hydrated.currentEraId = null;
  }
  return hydrated;
}

function serializeEraHistoryState(state) {
  return {
    nextEraIndex: Math.max(1, Math.floor(asNumber(state?.nextEraIndex, 1))),
    nextMilestoneIndex: Math.max(1, Math.floor(asNumber(state?.nextMilestoneIndex, 1))),
    currentEraId: state?.currentEraId || null,
    lastEvaluationTick: Math.floor(asNumber(state?.lastEvaluationTick, -1)),
    lastMilestoneTick: Math.floor(asNumber(state?.lastMilestoneTick, -1)),
    lastMetrics: state?.lastMetrics || null,
    evaluationHistory: Array.isArray(state?.evaluationHistory) ? state.evaluationHistory : [],
    sustained: state?.sustained || {
      diplomacyShortCount: 0,
      diplomacyShortSign: 0,
      saturationPlateauCount: 0,
      borderWarPlateauCount: 0,
      highPressurePlateauCount: 0,
      slowAttritionCount: 0
    },
    lastEmission: state?.lastEmission || null,
    eras: Array.isArray(state?.eras) ? state.eras : [],
    milestones: Array.isArray(state?.milestones) ? state.milestones : []
  };
}

function getCurrentEra(state) {
  if (!Array.isArray(state.eras) || !state.eras.length) {
    return null;
  }
  if (!state.currentEraId) {
    return state.eras[state.eras.length - 1];
  }
  const found = state.eras.find((era) => era.id === state.currentEraId);
  return found || state.eras[state.eras.length - 1];
}

function activeSettlements(settlements) {
  return (settlements || []).filter((s) => {
    const pop = Array.isArray(s.members) ? s.members.length : (s.population || 0);
    return pop > 0 && !s.isRuined;
  });
}

function buildDominantCivilization(active) {
  const civScores = new Map();
  for (const settlement of active) {
    if (!settlement.civId) continue;
    const pop = asNumber(settlement.population, Array.isArray(settlement.members) ? settlement.members.length : 0);
    const trade = asNumber(settlement.tradeFlow || settlement.tradeVolume, 0);
    const stability = asNumber(settlement.stability || settlement.stabilityScore, 0);
    const score = pop + trade * 0.25 + stability * 14;
    civScores.set(settlement.civId, (civScores.get(settlement.civId) || 0) + score);
  }
  let bestId = null;
  let bestScore = -Infinity;
  for (const [civId, score] of civScores.entries()) {
    if (score > bestScore) {
      bestScore = score;
      bestId = civId;
    }
  }
  return bestId;
}

function buildDiplomacyScore(active, civRelations) {
  const civIds = Array.from(new Set(active.map((s) => s.civId).filter(Boolean)));
  if (civIds.length < 2) return 0;
  const values = [];
  for (let i = 0; i < civIds.length; i += 1) {
    for (let j = i + 1; j < civIds.length; j += 1) {
      const a = civIds[i];
      const b = civIds[j];
      const relation = civRelations?.[a]?.[b] ?? civRelations?.[b]?.[a] ?? 0;
      values.push(clamp(relation, -1, 1));
    }
  }
  return values.length ? mean(values) : 0;
}
function selectTopSettlementIds(active, scorer, limit = 6) {
  return active
    .slice()
    .sort((a, b) => scorer(b) - scorer(a))
    .slice(0, limit)
    .map((s) => normalizeSettlementId(s.id));
}

function computeGlobalMetrics(input, previousMetrics = null) {
  const settlements = input.settlements || [];
  const active = activeSettlements(settlements);
  const tradeRoutes = input.tradeRoutes || [];

  const avgSaturation = mean(active.map((s) => asNumber(s.influenceSaturation?.saturationLevel, 0)));
  const avgPressure = mean(active.map((s) => asNumber(s.resourcePressure, 0)));
  const avgStability = mean(active.map((s) => asNumber(s.stability || s.stabilityScore, 0)));
  const avgGrowth = mean(active.map((s) => asNumber(s.growthRate, 0)));
  const avgConflictRate = mean(active.map((s) => asNumber(s.conflictRate, 0)));
  const totalTradeFlow = tradeRoutes.length
    ? tradeRoutes.reduce((acc, route) => acc + asNumber(route.tradeVolume, asNumber(route.trades, 0)), 0)
    : active.reduce((acc, s) => acc + asNumber(s.tradeFlow || s.tradeVolume, 0), 0);
  const diplomacyScore = buildDiplomacyScore(active, input.civRelations || {});

  const activeSettlementIds = active.map((s) => normalizeSettlementId(s.id));
  const prevIds = new Set(previousMetrics?.activeSettlementIds || []);
  const newSettlementIds = activeSettlementIds.filter((id) => !prevIds.has(id));

  const deltas = {
    saturation: avgSaturation - asNumber(previousMetrics?.avgSaturation, avgSaturation),
    pressure: avgPressure - asNumber(previousMetrics?.avgPressure, avgPressure),
    stability: avgStability - asNumber(previousMetrics?.avgStability, avgStability),
    growth: avgGrowth - asNumber(previousMetrics?.avgGrowth, avgGrowth),
    conflictRate: avgConflictRate - asNumber(previousMetrics?.avgConflictRate, avgConflictRate),
    activeSettlements: active.length - asNumber(previousMetrics?.activeSettlements, active.length),
    diplomacy: diplomacyScore - asNumber(previousMetrics?.diplomacyScore, diplomacyScore),
    tradeFlow: totalTradeFlow - asNumber(previousMetrics?.totalTradeFlow, totalTradeFlow)
  };
  const prevTrade = Math.max(1, Math.abs(asNumber(previousMetrics?.totalTradeFlow, totalTradeFlow)));
  deltas.tradeFlowNorm = deltas.tradeFlow / prevTrade;

  return {
    tick: input.tick,
    avgSaturation,
    avgPressure,
    avgStability,
    avgGrowth,
    avgConflictRate,
    totalTradeFlow,
    activeSettlements: active.length,
    diplomacyScore,
    dominantCivilization: buildDominantCivilization(active),
    activeSettlementIds,
    newSettlementIds,
    topSaturationIds: selectTopSettlementIds(active, (s) => asNumber(s.influenceSaturation?.saturationLevel, 0)),
    topCrisisIds: selectTopSettlementIds(
      active,
      (s) => (1 - asNumber(s.stability || s.stabilityScore, 0)) + asNumber(s.resourcePressure, 0) + asNumber(s.conflictRate, 0)
    ),
    topGrowthIds: selectTopSettlementIds(active, (s) => asNumber(s.growthRate, 0)),
    deltas,
    deltaLong: {
      saturation: 0,
      pressure: 0,
      stability: 0,
      growth: 0,
      conflictRate: 0,
      activeSettlements: 0,
      diplomacy: 0,
      tradeFlow: 0,
      tradeFlowNorm: 0
    },
    sustained: {
      diplomacyShortCount: 0,
      diplomacyShortSign: 0,
      saturationPlateauCount: 0,
      borderWarPlateauCount: 0,
      highPressurePlateauCount: 0,
      slowAttritionCount: 0
    },
    longWindowTicks: 0
  };
}

function selectLongBaseline(evaluationHistory, cfg) {
  if (!evaluationHistory.length) {
    return null;
  }
  const len = evaluationHistory.length;
  if (len >= cfg.longWindowOffset) {
    return evaluationHistory[len - cfg.longWindowOffset];
  }
  if (len >= cfg.shortWindowLongOffset) {
    return evaluationHistory[len - cfg.shortWindowLongOffset];
  }
  return evaluationHistory[0] || null;
}

function toEvalSnapshot(metrics) {
  return {
    tick: metrics.tick,
    avgSaturation: metrics.avgSaturation,
    avgPressure: metrics.avgPressure,
    avgStability: metrics.avgStability,
    avgGrowth: metrics.avgGrowth,
    avgConflictRate: metrics.avgConflictRate,
    totalTradeFlow: metrics.totalTradeFlow,
    activeSettlements: metrics.activeSettlements,
    diplomacyScore: metrics.diplomacyScore
  };
}

function updateSustainedSignals(metrics, state, cfg) {
  const sustained = state.sustained || {
    diplomacyShortCount: 0,
    diplomacyShortSign: 0,
    saturationPlateauCount: 0,
    borderWarPlateauCount: 0,
    highPressurePlateauCount: 0,
    slowAttritionCount: 0
  };

  const shortDip = metrics.deltas.diplomacy;
  if (Math.abs(shortDip) >= cfg.diplomacyShortSustainDelta) {
    const sign = Math.sign(shortDip) || 1;
    if (sustained.diplomacyShortSign === sign) {
      sustained.diplomacyShortCount += 1;
    } else {
      sustained.diplomacyShortSign = sign;
      sustained.diplomacyShortCount = 1;
    }
  } else {
    sustained.diplomacyShortCount = 0;
    sustained.diplomacyShortSign = 0;
  }

  if (metrics.avgSaturation >= cfg.saturationPlateauLevel) {
    sustained.saturationPlateauCount += 1;
  } else {
    sustained.saturationPlateauCount = 0;
  }
  if (metrics.avgConflictRate >= cfg.borderWarConflictLevel) {
    sustained.borderWarPlateauCount += 1;
  } else {
    sustained.borderWarPlateauCount = 0;
  }
  if (metrics.avgPressure >= cfg.highPressurePlateauLevel) {
    sustained.highPressurePlateauCount += 1;
  } else {
    sustained.highPressurePlateauCount = 0;
  }
  if (metrics.avgGrowth <= cfg.slowAttritionGrowthLevel) {
    sustained.slowAttritionCount += 1;
  } else {
    sustained.slowAttritionCount = 0;
  }

  state.sustained = sustained;
  metrics.sustained = {
    diplomacyShortCount: sustained.diplomacyShortCount,
    diplomacyShortSign: sustained.diplomacyShortSign,
    saturationPlateauCount: sustained.saturationPlateauCount,
    borderWarPlateauCount: sustained.borderWarPlateauCount,
    highPressurePlateauCount: sustained.highPressurePlateauCount,
    slowAttritionCount: sustained.slowAttritionCount
  };
}

function applyLongWindowDeltas(metrics, state, cfg) {
  const baseline = selectLongBaseline(state.evaluationHistory || [], cfg);
  if (!baseline) {
    metrics.longWindowTicks = 0;
    return;
  }

  metrics.longWindowTicks = Math.max(0, metrics.tick - (baseline.tick || metrics.tick));
  const prevTrade = Math.max(1, Math.abs(asNumber(baseline.totalTradeFlow, metrics.totalTradeFlow)));
  metrics.deltaLong = {
    saturation: metrics.avgSaturation - asNumber(baseline.avgSaturation, metrics.avgSaturation),
    pressure: metrics.avgPressure - asNumber(baseline.avgPressure, metrics.avgPressure),
    stability: metrics.avgStability - asNumber(baseline.avgStability, metrics.avgStability),
    growth: metrics.avgGrowth - asNumber(baseline.avgGrowth, metrics.avgGrowth),
    conflictRate: metrics.avgConflictRate - asNumber(baseline.avgConflictRate, metrics.avgConflictRate),
    activeSettlements: metrics.activeSettlements - asNumber(baseline.activeSettlements, metrics.activeSettlements),
    diplomacy: metrics.diplomacyScore - asNumber(baseline.diplomacyScore, metrics.diplomacyScore),
    tradeFlow: metrics.totalTradeFlow - asNumber(baseline.totalTradeFlow, metrics.totalTradeFlow),
    tradeFlowNorm:
      (metrics.totalTradeFlow - asNumber(baseline.totalTradeFlow, metrics.totalTradeFlow)) / prevTrade
  };
}

function formatPct(value) {
  return `${Math.round(clamp01(value) * 100)}%`;
}

function formatSignedPct(value) {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}%`;
}
function buildNarrative(reason, metrics) {
  if (reason === "saturation_spike") {
    return {
      eraType: "Crisis",
      title: "Overload Crisis Era",
      summary:
        `Influence density spiked to ${formatPct(metrics.avgSaturation)} and pressure reached ${formatPct(metrics.avgPressure)}, slowing core growth and pushing expansion toward the frontier.`
    };
  }
  if (reason === "saturation_plateau") {
    return {
      eraType: "Crisis",
      title: "Saturation Plateau Era",
      summary:
        `Core saturation remained above ${formatPct(metrics.avgSaturation)} for multiple evaluations, indicating persistent density stress and outward spillover pressure.`
    };
  }
  if (reason === "border_war_plateau") {
    return {
      eraType: "Crisis",
      title: "Border War Plateau",
      summary:
        `Conflict held near ${formatPct(metrics.avgConflictRate)} across consecutive evaluations, signaling sustained frontier hostility and hardened borders.`
    };
  }
  if (reason === "high_pressure_plateau") {
    return {
      eraType: "Crisis",
      title: "High Pressure Plateau",
      summary:
        `Resource pressure remained elevated at ${formatPct(metrics.avgPressure)} over a sustained window, constraining growth and intensifying migration stress.`
    };
  }
  if (reason === "slow_attrition") {
    return {
      eraType: "Collapse",
      title: "Slow Attrition Era",
      summary:
        `Average growth stayed negative (${metrics.avgGrowth.toFixed(4)}) for a prolonged span, indicating systemic attrition rather than a sharp collapse.`
    };
  }
  if (reason === "stability_collapse") {
    return {
      eraType: "Collapse",
      title: "Systemic Stability Collapse",
      summary:
        `Average stability dropped to ${formatPct(metrics.avgStability)} while long-window stress intensified, triggering a broad structural decline.`
    };
  }
  if (reason === "settlement_emergence") {
    return {
      eraType: "Emergence",
      title: "Settlement Emergence Era",
      summary:
        `${metrics.newSettlementIds.length} new settlement nodes appeared, expanding the active network to ${metrics.activeSettlements} hubs and opening fresh regional corridors.`
    };
  }
  if (reason === "expansion_surge") {
    return {
      eraType: "Expansion",
      title: "Expansion Surge Era",
      summary:
        `Long-window expansion accelerated (${formatSignedPct(metrics.deltaLong.tradeFlowNorm)} trade growth), extending the settlement network across new regions.`
    };
  }
  if (reason === "diplomacy_realignment") {
    const direction = metrics.deltaLong.diplomacy >= 0 ? "thaw" : "fracture";
    const eraType = metrics.deltaLong.diplomacy >= 0 ? "Stabilization" : "Crisis";
    return {
      eraType,
      title: direction === "thaw" ? "Diplomatic Thaw Era" : "Diplomatic Fracture Era",
      summary:
        `Inter-civilization relations shifted by ${formatSignedPct(metrics.deltaLong.diplomacy)} over the long window, reshaping cross-border behavior.`
    };
  }
  return {
    eraType: "Stabilization",
    title: "Stabilization Era",
    summary:
      `Pressure stabilized near ${formatPct(metrics.avgPressure)} and average stability held at ${formatPct(metrics.avgStability)}, consolidating existing trade corridors.`
  };
}

function chooseTransitionReason(metrics, cfg) {
  const d = metrics.deltas;
  const dl = metrics.deltaLong;
  const su = metrics.sustained;

  const collapseLongStability = dl.stability <= -Math.abs(cfg.collapseLongStabilityDelta);
  const collapseLongConflict = dl.conflictRate >= cfg.collapseConflictLongRise;
  if (
    metrics.avgStability <= cfg.collapseStabilityLevel &&
    (collapseLongStability || collapseLongConflict)
  ) {
    return "stability_collapse";
  }

  const saturationSpike =
    metrics.avgSaturation >= cfg.saturationSpikeLevel &&
    d.saturation >= cfg.saturationSpikeDelta;
  if (saturationSpike) {
    return "saturation_spike";
  }

  const saturationPlateau =
    metrics.avgSaturation >= cfg.saturationPlateauLevel &&
    su.saturationPlateauCount >= cfg.saturationPlateauSustain;
  if (saturationPlateau) {
    return "saturation_plateau";
  }
  if (
    su.borderWarPlateauCount >= cfg.plateauSustainCount &&
    metrics.avgConflictRate >= cfg.borderWarConflictLevel
  ) {
    return "border_war_plateau";
  }
  if (
    su.highPressurePlateauCount >= cfg.plateauSustainCount &&
    metrics.avgPressure >= cfg.highPressurePlateauLevel
  ) {
    return "high_pressure_plateau";
  }
  if (
    su.slowAttritionCount >= cfg.plateauSustainCount &&
    metrics.avgGrowth <= cfg.slowAttritionGrowthLevel
  ) {
    return "slow_attrition";
  }

  if (
    metrics.newSettlementIds.length >= cfg.emergenceSettlementDelta &&
    d.activeSettlements > 0
  ) {
    return "settlement_emergence";
  }

  const expansionLong =
    dl.activeSettlements >= cfg.expansionLongSettlementDelta ||
    dl.tradeFlowNorm >= cfg.expansionLongTradeGrowth;
  if (expansionLong) {
    return "expansion_surge";
  }

  const diplomacyShortSustained =
    Math.abs(d.diplomacy) >= cfg.diplomacyShortSustainDelta &&
    su.diplomacyShortCount >= cfg.diplomacyShortSustainCount;
  const diplomacyLong = Math.abs(dl.diplomacy) >= cfg.diplomacyLongShiftDelta;
  if (diplomacyLong || diplomacyShortSustained) {
    return "diplomacy_realignment";
  }

  if (
    metrics.avgStability >= cfg.stabilizationStabilityMin &&
    metrics.avgPressure <= cfg.stabilizationPressureMax &&
    metrics.avgSaturation <= cfg.stabilizationSaturationMax
  ) {
    return "stabilization";
  }
  return null;
}

function affectedSettlementsForReason(reason, metrics) {
  if (reason === "saturation_spike" || reason === "saturation_plateau") {
    return metrics.topSaturationIds.slice(0, 8);
  }
  if (reason === "stability_collapse") {
    return metrics.topCrisisIds.slice(0, 8);
  }
  if (reason === "border_war_plateau" || reason === "high_pressure_plateau" || reason === "slow_attrition") {
    return metrics.topCrisisIds.slice(0, 8);
  }
  if (reason === "expansion_surge") {
    return metrics.topGrowthIds.slice(0, 8);
  }
  if (reason === "settlement_emergence") {
    return metrics.newSettlementIds.length
      ? metrics.newSettlementIds.slice(0, 10)
      : metrics.topGrowthIds.slice(0, 8);
  }
  if (reason === "diplomacy_realignment") {
    return metrics.topCrisisIds.slice(0, 4).concat(metrics.topGrowthIds.slice(0, 4));
  }
  return metrics.topGrowthIds.slice(0, 5);
}

function makeSignature(label, metrics) {
  return {
    label,
    avgStability: Number(metrics.avgStability.toFixed(3)),
    avgSaturation: Number(metrics.avgSaturation.toFixed(3)),
    diplomacy: Number(metrics.diplomacyScore.toFixed(3)),
    tradeFlowNormLong: Number(metrics.deltaLong.tradeFlowNorm.toFixed(3))
  };
}

function isDuplicateEmission(state, kind, label, metrics, cfg) {
  const last = state.lastEmission;
  if (!last || last.kind !== kind || last.label !== label) {
    return false;
  }
  return (
    Math.abs((last.signature?.avgStability || 0) - metrics.avgStability) <= cfg.dedupeStabilityEpsilon &&
    Math.abs((last.signature?.avgSaturation || 0) - metrics.avgSaturation) <= cfg.dedupeSaturationEpsilon &&
    Math.abs((last.signature?.diplomacy || 0) - metrics.diplomacyScore) <= cfg.dedupeDiplomacyEpsilon &&
    Math.abs((last.signature?.tradeFlowNormLong || 0) - metrics.deltaLong.tradeFlowNorm) <= cfg.dedupeTradeNormEpsilon
  );
}

function markEmission(state, kind, label, metrics) {
  state.lastEmission = {
    kind,
    label,
    signature: makeSignature(label, metrics),
    tick: metrics.tick
  };
}
function createEra(state, tick, reason, metrics) {
  const narrative = buildNarrative(reason, metrics);
  const era = {
    id: `ERA-${state.nextEraIndex}`,
    entryType: "era",
    startTick: tick,
    endTick: tick,
    eraType: normalizeEraType(narrative.eraType),
    title: narrative.title,
    summary: narrative.summary,
    dominantCivilization: metrics.dominantCivilization || null,
    globalStateSnapshot: {
      avgSaturation: Number(metrics.avgSaturation.toFixed(4)),
      avgPressure: Number(metrics.avgPressure.toFixed(4)),
      avgStability: Number(metrics.avgStability.toFixed(4)),
      avgGrowth: Number(metrics.avgGrowth.toFixed(5)),
      avgConflictRate: Number(metrics.avgConflictRate.toFixed(5)),
      totalTradeFlow: Number(metrics.totalTradeFlow.toFixed(3)),
      activeSettlements: metrics.activeSettlements,
      diplomacyScore: Number(metrics.diplomacyScore.toFixed(4)),
      deltas: {
        saturation: Number(metrics.deltas.saturation.toFixed(5)),
        pressure: Number(metrics.deltas.pressure.toFixed(5)),
        stability: Number(metrics.deltas.stability.toFixed(5)),
        growth: Number(metrics.deltas.growth.toFixed(6)),
        conflictRate: Number(metrics.deltas.conflictRate.toFixed(6)),
        activeSettlements: metrics.deltas.activeSettlements,
        diplomacy: Number(metrics.deltas.diplomacy.toFixed(5)),
        tradeFlowNorm: Number(metrics.deltas.tradeFlowNorm.toFixed(5)),
        longSaturation: Number(metrics.deltaLong.saturation.toFixed(5)),
        longPressure: Number(metrics.deltaLong.pressure.toFixed(5)),
        longStability: Number(metrics.deltaLong.stability.toFixed(5)),
        longGrowth: Number(metrics.deltaLong.growth.toFixed(6)),
        longConflictRate: Number(metrics.deltaLong.conflictRate.toFixed(6)),
        longActiveSettlements: metrics.deltaLong.activeSettlements,
        longDiplomacy: Number(metrics.deltaLong.diplomacy.toFixed(5)),
        longTradeFlowNorm: Number(metrics.deltaLong.tradeFlowNorm.toFixed(5))
      },
      affectedSettlementIds: affectedSettlementsForReason(reason, metrics),
      trigger: reason
    }
  };
  state.nextEraIndex += 1;
  return era;
}

function shouldTransition(currentEra, reason, tick, cfg) {
  if (!currentEra) return true;
  const currentReason = currentEra.globalStateSnapshot?.trigger || null;
  if (currentReason === reason) return false;

  const duration = tick - currentEra.startTick;
  const forcedReasons = new Set(["stability_collapse", "saturation_spike", "saturation_plateau"]);
  if (duration < cfg.minEraDuration && !forcedReasons.has(reason)) {
    return false;
  }
  return true;
}

function buildMilestoneNarrative(metrics, cfg, thresholdScale = 1) {
  const scale = Math.max(0.2, asNumber(thresholdScale, 1));
  const absLong = {
    diplomacy: Math.abs(metrics.deltaLong.diplomacy),
    stability: Math.abs(metrics.deltaLong.stability),
    trade: Math.abs(metrics.deltaLong.tradeFlowNorm),
    saturation: Math.abs(metrics.deltaLong.saturation),
    settlements: Math.abs(metrics.deltaLong.activeSettlements),
    conflict: Math.abs(metrics.deltaLong.conflictRate)
  };

  const triggered = [];
  if (absLong.diplomacy >= cfg.milestoneDiplomacyLongDelta * scale) triggered.push("diplomacy");
  if (absLong.stability >= cfg.milestoneStabilityLongDelta * scale) triggered.push("stability");
  if (absLong.trade >= cfg.milestoneTradeFlowLongDelta * scale) triggered.push("trade");
  if (absLong.saturation >= cfg.milestoneSaturationLongDelta * scale) triggered.push("saturation");
  if (absLong.settlements >= cfg.milestoneSettlementLongDelta * scale) triggered.push("settlements");
  if (absLong.conflict >= cfg.milestoneConflictLongDelta * scale) triggered.push("conflict");

  if (!triggered.length) {
    return null;
  }

  const strongest = triggered
    .slice()
    .sort((a, b) => absLong[b] - absLong[a])[0];

  if (strongest === "diplomacy") {
    const dir = metrics.deltaLong.diplomacy >= 0 ? "thaw" : "hardening";
    return {
      title: "Diplomacy Milestone",
      eraType: metrics.deltaLong.diplomacy >= 0 ? "Stabilization" : "Crisis",
      summary: `Long-window diplomatic ${dir} reached ${formatSignedPct(metrics.deltaLong.diplomacy)}, altering bloc-level alignment pressure.`
    };
  }
  if (strongest === "trade") {
    return {
      title: "Trade Reconfiguration Milestone",
      eraType: "Expansion",
      summary: `Trade flow shifted ${formatSignedPct(metrics.deltaLong.tradeFlowNorm)} across the long window, indicating a structural corridor reconfiguration.`
    };
  }
  if (strongest === "stability") {
    return {
      title: "Stability Regime Milestone",
      eraType: metrics.deltaLong.stability >= 0 ? "Stabilization" : "Collapse",
      summary: `Average stability moved ${formatSignedPct(metrics.deltaLong.stability)}, marking a systemic regime shift.`
    };
  }
  if (strongest === "saturation") {
    return {
      title: "Influence Density Milestone",
      eraType: metrics.deltaLong.saturation >= 0 ? "Crisis" : "Stabilization",
      summary: `Long-window saturation changed ${formatSignedPct(metrics.deltaLong.saturation)}, reshaping core-to-frontier pressure balance.`
    };
  }
  if (strongest === "settlements") {
    return {
      title: "Network Topology Milestone",
      eraType: "Emergence",
      summary: `Active settlement count changed by ${metrics.deltaLong.activeSettlements >= 0 ? "+" : ""}${metrics.deltaLong.activeSettlements}, indicating a structural network transition.`
    };
  }
  return {
    title: "Conflict Intensity Milestone",
    eraType: metrics.deltaLong.conflictRate >= 0 ? "Crisis" : "Stabilization",
    summary: `Long-window conflict pressure moved ${formatSignedPct(metrics.deltaLong.conflictRate)}, changing inter-civilization boundary behavior.`
  };
}

function createMilestone(state, tick, metrics, narrative) {
  const milestone = {
    id: `MS-${state.nextMilestoneIndex}`,
    entryType: "milestone",
    startTick: tick,
    endTick: tick,
    eraType: normalizeEraType(narrative.eraType),
    title: narrative.title,
    summary: narrative.summary,
    dominantCivilization: metrics.dominantCivilization || null,
    globalStateSnapshot: {
      avgSaturation: Number(metrics.avgSaturation.toFixed(4)),
      avgPressure: Number(metrics.avgPressure.toFixed(4)),
      avgStability: Number(metrics.avgStability.toFixed(4)),
      avgGrowth: Number(metrics.avgGrowth.toFixed(5)),
      avgConflictRate: Number(metrics.avgConflictRate.toFixed(5)),
      totalTradeFlow: Number(metrics.totalTradeFlow.toFixed(3)),
      activeSettlements: metrics.activeSettlements,
      diplomacyScore: Number(metrics.diplomacyScore.toFixed(4)),
      deltas: {
        longSaturation: Number(metrics.deltaLong.saturation.toFixed(5)),
        longPressure: Number(metrics.deltaLong.pressure.toFixed(5)),
        longStability: Number(metrics.deltaLong.stability.toFixed(5)),
        longGrowth: Number(metrics.deltaLong.growth.toFixed(6)),
        longConflictRate: Number(metrics.deltaLong.conflictRate.toFixed(6)),
        longActiveSettlements: metrics.deltaLong.activeSettlements,
        longDiplomacy: Number(metrics.deltaLong.diplomacy.toFixed(5)),
        longTradeFlowNorm: Number(metrics.deltaLong.tradeFlowNorm.toFixed(5))
      },
      affectedSettlementIds: metrics.topCrisisIds.slice(0, 4).concat(metrics.topGrowthIds.slice(0, 4)),
      trigger: "milestone"
    }
  };
  state.nextMilestoneIndex += 1;
  return milestone;
}
function maybeCreateMilestone(state, metrics, cfg) {
  const lastTick = asNumber(state.lastMilestoneTick, -1);
  if (lastTick < 0) {
    if (metrics.tick < cfg.milestoneMinInterval) {
      return null;
    }
  } else {
    const elapsed = metrics.tick - lastTick;
    if (elapsed < cfg.milestoneMinInterval) {
      return null;
    }
  }

  const elapsedSinceLast = lastTick < 0 ? cfg.milestoneMinInterval : (metrics.tick - lastTick);
  const overdue = elapsedSinceLast >= cfg.milestoneMaxInterval;
  const thresholdScale = overdue ? 0.85 : 1;
  const narrative = buildMilestoneNarrative(metrics, cfg, thresholdScale);
  if (!narrative) {
    return null;
  }

  const duplicate = isDuplicateEmission(state, "milestone", narrative.title, metrics, cfg);
  if (duplicate) {
    return null;
  }

  const milestone = createMilestone(state, metrics.tick, metrics, narrative);
  state.lastMilestoneTick = metrics.tick;
  markEmission(state, "milestone", narrative.title, metrics);
  return milestone;
}

function trimEraHistory(state) {
  const limit = state.config.historyLimit;
  if (Number.isFinite(limit) && limit > 0 && state.eras.length > limit) {
    state.eras.splice(0, state.eras.length - limit);
  }

  const milestoneLimit = state.config.milestoneLimit;
  if (Number.isFinite(milestoneLimit) && milestoneLimit > 0 && state.milestones.length > milestoneLimit) {
    state.milestones.splice(0, state.milestones.length - milestoneLimit);
  }

  const windowLimit = state.config.longWindowBuffer;
  if (Number.isFinite(windowLimit) && windowLimit > 0 && state.evaluationHistory.length > windowLimit) {
    state.evaluationHistory.splice(0, state.evaluationHistory.length - windowLimit);
  }
}

function updateEraHistoryState(state, input, options = {}, force = false) {
  if (!state || typeof state !== "object") {
    return { changed: false, createdEra: null, createdMilestone: null, state };
  }
  state.config = buildDefaultOptions({ ...state.config, ...options });
  const cfg = state.config;
  const tick = Math.floor(asNumber(input?.tick, 0));

  if (!force && state.lastEvaluationTick >= 0) {
    const elapsed = tick - state.lastEvaluationTick;
    if (elapsed < cfg.evaluationInterval) {
      const current = getCurrentEra(state);
      if (current) {
        current.endTick = Math.max(current.startTick, tick);
      }
      return { changed: false, createdEra: null, createdMilestone: null, state };
    }
  }

  const metrics = computeGlobalMetrics(input, state.lastMetrics);
  applyLongWindowDeltas(metrics, state, cfg);
  updateSustainedSignals(metrics, state, cfg);

  state.lastEvaluationTick = tick;
  state.lastMetrics = metrics;
  state.evaluationHistory.push(toEvalSnapshot(metrics));
  trimEraHistory(state);

  const currentEra = getCurrentEra(state);
  const reason = chooseTransitionReason(metrics, cfg);
  let createdEra = null;

  if (!currentEra) {
    const firstReason = reason || "stabilization";
    const first = createEra(state, tick, firstReason, metrics);
    state.eras.push(first);
    state.currentEraId = first.id;
    markEmission(state, "era", first.title, metrics);
    createdEra = first;
  } else {
    currentEra.endTick = tick;

    if (reason && shouldTransition(currentEra, reason, tick, cfg)) {
      const narrative = buildNarrative(reason, metrics);
      if (!isDuplicateEmission(state, "era", narrative.title, metrics, cfg)) {
        currentEra.endTick = Math.max(currentEra.startTick, tick - 1);
        const nextEra = createEra(state, tick, reason, metrics);
        state.eras.push(nextEra);
        state.currentEraId = nextEra.id;
        markEmission(state, "era", nextEra.title, metrics);
        createdEra = nextEra;
      }
    }
  }

  const createdMilestone = maybeCreateMilestone(state, metrics, cfg);
  if (createdMilestone) {
    state.milestones.push(createdMilestone);
  }

  trimEraHistory(state);
  return {
    changed: Boolean(createdEra || createdMilestone),
    createdEra,
    createdMilestone,
    metrics,
    state
  };
}

function getEraHistorySnapshot(state, limit = 80) {
  const safeLimit = Math.max(1, limit);
  const eras = Array.isArray(state?.eras) ? state.eras.slice(-safeLimit) : [];
  const milestones = Array.isArray(state?.milestones)
    ? state.milestones.slice(-Math.max(12, Math.floor(safeLimit * 1.2)))
    : [];
  const entries = eras
    .concat(milestones)
    .slice()
    .sort((a, b) => (b.startTick || 0) - (a.startTick || 0));

  return {
    currentEraId: state?.currentEraId || null,
    eras,
    milestones,
    entries
  };
}

module.exports = {
  createEraHistoryState,
  hydrateEraHistoryState,
  serializeEraHistoryState,
  updateEraHistoryState,
  getEraHistorySnapshot
};

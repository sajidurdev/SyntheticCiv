function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function lerp(from, to, alpha) {
  return from + (to - from) * alpha;
}

function stableUnitFromId(id, salt = 0) {
  const str = `${id || "civ"}:${salt}`;
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (hash % 1000) / 999;
}

function ensureCivilizationPolicy(civilization) {
  if (!civilization.policy) {
    civilization.policy = {
      rationing: 0.4 + stableUnitFromId(civilization.id, 1) * 0.2,
      tradeOpenness: 0.4 + stableUnitFromId(civilization.id, 2) * 0.2,
      expansionism: 0.4 + stableUnitFromId(civilization.id, 3) * 0.2,
      welfare: 0.4 + stableUnitFromId(civilization.id, 4) * 0.2
    };
  }

  civilization.policy.rationing = clamp01(civilization.policy.rationing);
  civilization.policy.tradeOpenness = clamp01(civilization.policy.tradeOpenness);
  civilization.policy.expansionism = clamp01(civilization.policy.expansionism);
  civilization.policy.welfare = clamp01(civilization.policy.welfare);
  return civilization.policy;
}

function ensurePolicyState(civilization) {
  if (!civilization.policyState) {
    civilization.policyState = {
      avgStabilityEMA: 0.5,
      avgPressureEMA: 0.5,
      totalTradeFlowEMA: 0,
      populationGrowthTrendEMA: 0,
      avgConflictRateEMA: 0,
      avgTradeSuccessEMA: 0.5,
      frontierExpansionRateEMA: 0,
      regionalStabilityEMA: 0.5,
      externalInfluencePressureEMA: 0,
      prevPopulation: 0,
      prevAvgStabilityEMA: 0.5,
      prevTotalTradeFlowEMA: 0,
      lastUpdatedTick: -1
    };
  }
  return civilization.policyState;
}

function ensurePolicyDrift(civilization) {
  if (!civilization.policyDrift) {
    civilization.policyDrift = {
      trade: 0.4 + stableUnitFromId(civilization.id, 11) * 0.2,
      wariness: 0.4 + stableUnitFromId(civilization.id, 12) * 0.2,
      explore: 0.4 + stableUnitFromId(civilization.id, 13) * 0.2,
      stabilityFocus: 0.4 + stableUnitFromId(civilization.id, 14) * 0.2
    };
  }
  civilization.policyDrift.trade = clamp01(civilization.policyDrift.trade);
  civilization.policyDrift.wariness = clamp01(civilization.policyDrift.wariness);
  civilization.policyDrift.explore = clamp01(civilization.policyDrift.explore);
  civilization.policyDrift.stabilityFocus = clamp01(civilization.policyDrift.stabilityFocus);
  return civilization.policyDrift;
}

function ensureStrategyModifiers(civilization) {
  if (!civilization.strategyModifiers) {
    civilization.strategyModifiers = {
      migrationBias: 0,
      tradeBias: 0,
      conflictTolerance: 0
    };
    return civilization.strategyModifiers;
  }

  const mods = civilization.strategyModifiers;
  if (typeof mods.migrationBias !== "number") mods.migrationBias = 0;
  if (typeof mods.tradeBias !== "number") mods.tradeBias = 0;
  if (typeof mods.conflictTolerance !== "number") mods.conflictTolerance = 0;
  mods.migrationBias = clamp(mods.migrationBias, -1, 1);
  mods.tradeBias = clamp(mods.tradeBias, -1, 1);
  mods.conflictTolerance = clamp(mods.conflictTolerance, -1, 1);
  return mods;
}

function aggregateSettlementMetrics(settlementIds, settlementsById) {
  const rows = settlementIds.map((id) => settlementsById.get(id)).filter(Boolean);
  if (!rows.length) {
    return {
      population: 0,
      pressure: 0,
      stability: 0,
      tradeConsistency: 0,
      tradeFlow: 0,
      tradeFlowNorm: 0,
      growth: 0,
      conflictRate: 0,
      frontierExpansionRate: 0,
      regionalStability: 0,
      externalInfluencePressure: 0
    };
  }
  const externalPressureRows = rows.map((s) => {
    const r = s.regionalInfluence || {};
    const internal = r.internalInfluence || 0;
    const external = r.externalInfluence || 0;
    return external / Math.max(1e-6, internal + external);
  });
  const frontierExpansionRows = rows.map((s) => {
    const growth = Math.max(0, s.growthRate || 0);
    const frontier = s.frontierPressure || 0;
    return growth * (0.35 + frontier * 0.65);
  });
  const regionalStabilityRows = rows.map((s) => {
    const baseStability = s.stability || s.stabilityScore || 0;
    const overlap = s.regionalInfluence?.conflictPressure || 0;
    return clamp(baseStability - overlap * 0.22, 0, 1);
  });
  const tradeSuccessRows = rows.map((s) => {
    const consistency = s.tradeConsistency || 0;
    const norm = s.tradeFlowNorm || 0;
    return clamp(consistency * 0.62 + norm * 0.38, 0, 1);
  });

  return {
    population: rows.reduce((acc, s) => acc + (s.population || 0), 0),
    pressure: rows.reduce((acc, s) => acc + (s.resourcePressure || 0), 0) / rows.length,
    stability: rows.reduce((acc, s) => acc + (s.stability || s.stabilityScore || 0), 0) / rows.length,
    tradeConsistency: rows.reduce((acc, s) => acc + (s.tradeConsistency || 0), 0) / rows.length,
    tradeFlow: rows.reduce((acc, s) => acc + (s.tradeFlow || s.tradeVolume || 0), 0),
    tradeFlowNorm: rows.reduce((acc, s) => acc + (s.tradeFlowNorm || 0), 0) / rows.length,
    growth: rows.reduce((acc, s) => acc + (s.growthRate || 0), 0) / rows.length,
    conflictRate: rows.reduce((acc, s) => acc + (s.conflictRate || 0), 0) / rows.length,
    frontierExpansionRate: frontierExpansionRows.reduce((acc, n) => acc + n, 0) / rows.length,
    regionalStability: regionalStabilityRows.reduce((acc, n) => acc + n, 0) / rows.length,
    externalInfluencePressure: externalPressureRows.reduce((acc, n) => acc + n, 0) / rows.length,
    avgTradeSuccess: tradeSuccessRows.reduce((acc, n) => acc + n, 0) / rows.length
  };
}

function updateCivilizationPolicies(civilizations, settlements, tick, interval = 400) {
  const settlementsById = new Map(settlements.map((s) => [s.id, s]));
  for (const civilization of civilizations) {
    ensureCivilizationPolicy(civilization);
    ensurePolicyState(civilization);
    ensurePolicyDrift(civilization);
  }

  if (tick % interval !== 0) {
    return;
  }

  for (const civilization of civilizations) {
    const policy = ensureCivilizationPolicy(civilization);
    const state = ensurePolicyState(civilization);
    const drift = ensurePolicyDrift(civilization);
    const metrics = aggregateSettlementMetrics(civilization.settlementIds || [], settlementsById);

    state.prevAvgStabilityEMA = state.avgStabilityEMA;
    state.prevTotalTradeFlowEMA = state.totalTradeFlowEMA;
    state.avgStabilityEMA = lerp(state.avgStabilityEMA, metrics.stability, 0.34);
    state.avgPressureEMA = lerp(state.avgPressureEMA, metrics.pressure, 0.34);
    state.totalTradeFlowEMA = lerp(state.totalTradeFlowEMA, metrics.tradeFlow, 0.3);
    state.avgConflictRateEMA = lerp(state.avgConflictRateEMA, metrics.conflictRate, 0.32);
    state.avgTradeSuccessEMA = lerp(state.avgTradeSuccessEMA, metrics.avgTradeSuccess || 0, 0.32);
    state.frontierExpansionRateEMA = lerp(state.frontierExpansionRateEMA, metrics.frontierExpansionRate || 0, 0.32);
    state.regionalStabilityEMA = lerp(state.regionalStabilityEMA, metrics.regionalStability || 0, 0.32);
    state.externalInfluencePressureEMA = lerp(
      state.externalInfluencePressureEMA,
      metrics.externalInfluencePressure || 0,
      0.32
    );

    const popBase = Math.max(1, state.prevPopulation || metrics.population || 1);
    const populationGrowthTrend = (metrics.population - popBase) / popBase;
    state.populationGrowthTrendEMA = lerp(state.populationGrowthTrendEMA, populationGrowthTrend, 0.3);

    const stabilityTrend = state.avgStabilityEMA - state.prevAvgStabilityEMA;
    const tradeFlowTrend = state.totalTradeFlowEMA - state.prevTotalTradeFlowEMA;
    const driftRate = 0.02;

    const tradeSignal = clamp((state.avgTradeSuccessEMA - 0.56) / 0.44, -1, 1);
    const conflictSignal = clamp((state.avgConflictRateEMA - 0.34) / 0.66, -1, 1);
    const frontierSignal = clamp(state.frontierExpansionRateEMA / 0.06, -1, 1);
    const stabilitySignal = clamp((0.56 - state.regionalStabilityEMA) / 0.56, -1, 1);
    const externalSignal = clamp((state.externalInfluencePressureEMA - 0.34) / 0.66, -1, 1);

    drift.trade = clamp01(
      drift.trade + driftRate * tradeSignal - driftRate * 0.5 * Math.max(0, conflictSignal)
    );
    drift.wariness = clamp01(
      drift.wariness + driftRate * Math.max(0, conflictSignal) + driftRate * 0.6 * Math.max(0, externalSignal)
    );
    drift.explore = clamp01(
      drift.explore + driftRate * Math.max(0, frontierSignal) - driftRate * 0.45 * Math.max(0, stabilitySignal)
    );
    drift.stabilityFocus = clamp01(
      drift.stabilityFocus + driftRate * Math.max(0, stabilitySignal) + driftRate * 0.4 * Math.max(0, externalSignal)
    );

    drift.trade = clamp01(lerp(drift.trade, 0.5, 0.035));
    drift.wariness = clamp01(lerp(drift.wariness, 0.5, 0.03));
    drift.explore = clamp01(lerp(drift.explore, 0.5, 0.03));
    drift.stabilityFocus = clamp01(lerp(drift.stabilityFocus, 0.5, 0.03));

    let rationingTarget = policy.rationing + (0.5 - policy.rationing) * 0.04;
    let tradeTarget = policy.tradeOpenness + (0.5 - policy.tradeOpenness) * 0.04;
    let expansionTarget = policy.expansionism + (0.5 - policy.expansionism) * 0.04;
    let welfareTarget = policy.welfare + (0.5 - policy.welfare) * 0.04;

    if (state.avgPressureEMA > 0.6) {
      const pressureFactor = clamp01((state.avgPressureEMA - 0.6) / 0.4);
      rationingTarget += 0.05 * pressureFactor;
      expansionTarget -= 0.04 * pressureFactor;
    } else if (state.avgPressureEMA < 0.4) {
      const relief = clamp01((0.4 - state.avgPressureEMA) / 0.4);
      rationingTarget -= 0.025 * relief;
    }

    if (tradeFlowTrend > 0) {
      const trendNorm = clamp01(tradeFlowTrend / Math.max(8, Math.abs(state.totalTradeFlowEMA) + 1));
      tradeTarget += 0.045 * trendNorm;
    } else if (tradeFlowTrend < 0) {
      const trendNorm = clamp01(Math.abs(tradeFlowTrend) / Math.max(8, Math.abs(state.totalTradeFlowEMA) + 1));
      tradeTarget -= 0.02 * trendNorm;
    }

    if (stabilityTrend < -0.003 && state.populationGrowthTrendEMA < 0) {
      const stress = clamp01(
        Math.abs(stabilityTrend) * 18 + Math.abs(state.populationGrowthTrendEMA) * 8
      );
      welfareTarget += 0.06 * stress;
    } else if (stabilityTrend > 0.002 && state.avgPressureEMA < 0.45) {
      welfareTarget -= 0.015;
    }

    if (state.populationGrowthTrendEMA > 0.01 && state.avgPressureEMA < 0.55) {
      expansionTarget += 0.025;
    }

    tradeTarget += (drift.trade - 0.5) * 0.12 - (drift.wariness - 0.5) * 0.04;
    rationingTarget += (drift.wariness - 0.5) * 0.08 + (drift.stabilityFocus - 0.5) * 0.06;
    expansionTarget += (drift.explore - 0.5) * 0.12 - (drift.wariness - 0.5) * 0.05;
    welfareTarget += (drift.stabilityFocus - 0.5) * 0.11 + (drift.wariness - 0.5) * 0.04;

    policy.rationing = clamp01(lerp(policy.rationing, rationingTarget, 0.2));
    policy.tradeOpenness = clamp01(lerp(policy.tradeOpenness, tradeTarget, 0.2));
    policy.expansionism = clamp01(lerp(policy.expansionism, expansionTarget, 0.2));
    policy.welfare = clamp01(lerp(policy.welfare, welfareTarget, 0.2));

    civilization.policyInputs = {
      avgConflictRate: Number(state.avgConflictRateEMA.toFixed(4)),
      avgTradeSuccess: Number(state.avgTradeSuccessEMA.toFixed(4)),
      frontierExpansionRate: Number(state.frontierExpansionRateEMA.toFixed(5)),
      regionalStability: Number(state.regionalStabilityEMA.toFixed(4)),
      externalInfluencePressure: Number(state.externalInfluencePressureEMA.toFixed(4))
    };

    state.prevPopulation = metrics.population;
    state.lastUpdatedTick = tick;
  }
}

function applyCivilizationPolicyEffects(civilizations, settlements) {
  const civById = new Map(civilizations.map((c) => [c.id, c]));
  const neutralPolicy = {
    rationing: 0.5,
    tradeOpenness: 0.5,
    expansionism: 0.5,
    welfare: 0.5
  };
  for (const settlement of settlements) {
    const civ = civById.get(settlement.civId) || null;
    const policy = civ ? ensureCivilizationPolicy(civ) : neutralPolicy;
    const drift = civ ? ensurePolicyDrift(civ) : {
      trade: 0.5,
      wariness: 0.5,
      explore: 0.5,
      stabilityFocus: 0.5
    };
    const rationing = clamp01((policy.rationing ?? 0.5) * 0.75 + (drift.wariness ?? 0.5) * 0.25);
    const tradeOpenness = clamp01((policy.tradeOpenness ?? 0.5) * 0.75 + (drift.trade ?? 0.5) * 0.25);
    const expansionism = clamp01((policy.expansionism ?? 0.5) * 0.75 + (drift.explore ?? 0.5) * 0.25);
    const welfare = clamp01((policy.welfare ?? 0.5) * 0.72 + (drift.stabilityFocus ?? 0.5) * 0.28);
    const levers = civ?.institutionLevers || {
      conscription: 0.5,
      tariffRate: 0.5,
      borderOpenness: 0.5,
      welfareSpend: welfare
    };
    const conscription = clamp01(levers.conscription ?? 0.5);
    const tariffRate = clamp01(levers.tariffRate ?? 0.5);
    const borderOpenness = clamp01(levers.borderOpenness ?? 0.5);
    const welfareSpend = clamp01(levers.welfareSpend ?? welfare);

    settlement.policyEffects = {
      foodConsumptionMult: clamp(1 - rationing * 0.16, 0.8, 1),
      birthRateMult: clamp(1 - rationing * 0.18, 0.75, 1),
      tradeOpenness: clamp(tradeOpenness * (1 - tariffRate * 0.18), 0, 1),
      diplomacyFrictionRelief: clamp(tradeOpenness * 0.06 - tariffRate * 0.02, 0, 0.08),
      expansionFissionBoost: clamp((expansionism - 0.5) * 0.5 + (borderOpenness - 0.5) * 0.08, -0.25, 0.3),
      expansionMigrationBoost: clamp((expansionism - 0.5) * 0.24 + (borderOpenness - 0.5) * 0.12, -0.1, 0.2),
      welfareStabilityRelief: clamp01((welfare + welfareSpend) * 0.5),
      welfareCollapseRelief: clamp01((welfare * 0.7 + welfareSpend * 0.3)),
      conscriptionLevel: conscription,
      tariffRate,
      borderOpenness,
      welfareSpend
    };
  }
}

function updateCivilizationStrategies(civilizations, settlements, tick, interval = 100) {
  if (tick % interval !== 0) {
    return;
  }

  const settlementsById = new Map(settlements.map((s) => [s.id, s]));
  for (const civilization of civilizations) {
    const strategy = ensureStrategyModifiers(civilization);
    const policy = ensureCivilizationPolicy(civilization);
    const culture = civilization.culture || {
      cooperationBias: 0,
      aggressionBias: 0,
      tradePreference: 0,
      expansionism: 0,
      stabilityFocus: 0
    };
    const metrics = aggregateSettlementMetrics(civilization.settlementIds || [], settlementsById);

    const desiredTradeBias = clamp(
      culture.tradePreference * 0.6 +
      metrics.tradeConsistency * 0.7 -
      metrics.pressure * 0.2 +
      (policy.tradeOpenness - 0.5) * 0.45,
      -1,
      1
    );
    const desiredMigrationBias = clamp(
      culture.expansionism * 0.7 +
      metrics.growth * 8 -
      metrics.pressure * 0.4 +
      (policy.expansionism - 0.5) * 0.5 -
      (policy.rationing - 0.5) * 0.18,
      -1,
      1
    );
    const desiredConflictTolerance = clamp(
      culture.aggressionBias * 0.8 +
      metrics.conflictRate * 0.5 -
      metrics.stability * 0.25 -
      (policy.tradeOpenness - 0.5) * 0.22 -
      (policy.welfare - 0.5) * 0.18,
      -1,
      1
    );

    strategy.tradeBias = clamp(strategy.tradeBias * 0.9 + desiredTradeBias * 0.1, -1, 1);
    strategy.migrationBias = clamp(strategy.migrationBias * 0.9 + desiredMigrationBias * 0.1, -1, 1);
    strategy.conflictTolerance = clamp(
      strategy.conflictTolerance * 0.9 + desiredConflictTolerance * 0.1,
      -1,
      1
    );
  }
}

module.exports = {
  updateCivilizationStrategies,
  ensureStrategyModifiers,
  ensureCivilizationPolicy,
  ensurePolicyDrift,
  updateCivilizationPolicies,
  applyCivilizationPolicyEffects
};

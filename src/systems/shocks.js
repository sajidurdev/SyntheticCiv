function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function popValue(settlement) {
  if (Array.isArray(settlement.members)) {
    return settlement.members.length;
  }
  return Math.max(0, settlement.population || 0);
}

function ensureSettlementShockState(settlement) {
  const state = settlement.shockState || {};
  settlement.shockState = {
    cooldownTicks: Math.max(0, Math.floor(state.cooldownTicks || 0)),
    activeShock: state.activeShock
      ? {
        type: state.activeShock.type,
        severity: clamp01(state.activeShock.severity || 0),
        remainingTicks: Math.max(0, Math.floor(state.activeShock.remainingTicks || 0)),
        durationTicks: Math.max(1, Math.floor(state.activeShock.durationTicks || 1))
      }
      : null,
    risk: state.risk
      ? {
        famine: clamp01(state.risk.famine || 0),
        rebellion: clamp01(state.risk.rebellion || 0),
        epidemic: clamp01(state.risk.epidemic || 0),
        crash: clamp01(state.risk.crash || 0)
      }
      : { famine: 0, rebellion: 0, epidemic: 0, crash: 0 }
  };

  const effects = settlement.shockEffects || {};
  settlement.shockEffects = {
    foodProdMult: Number.isFinite(effects.foodProdMult) ? effects.foodProdMult : 1,
    materialProdMult: Number.isFinite(effects.materialProdMult) ? effects.materialProdMult : 1,
    wealthProdMult: Number.isFinite(effects.wealthProdMult) ? effects.wealthProdMult : 1,
    tradeReliabilityMult: Number.isFinite(effects.tradeReliabilityMult) ? effects.tradeReliabilityMult : 1,
    foodConsMult: Number.isFinite(effects.foodConsMult) ? effects.foodConsMult : 1,
    birthMultiplierMult: Number.isFinite(effects.birthMultiplierMult) ? effects.birthMultiplierMult : 1,
    deathRiskMult: Number.isFinite(effects.deathRiskMult) ? effects.deathRiskMult : 1,
    deathRateAdd: Number.isFinite(effects.deathRateAdd) ? effects.deathRateAdd : 0,
    migrationPressureAdd: Number.isFinite(effects.migrationPressureAdd) ? effects.migrationPressureAdd : 0,
    conflictSensitivityAdd: Number.isFinite(effects.conflictSensitivityAdd) ? effects.conflictSensitivityAdd : 0,
    stabilityPenalty: Number.isFinite(effects.stabilityPenalty) ? effects.stabilityPenalty : 0
  };
}

function defaultEffects() {
  return {
    foodProdMult: 1,
    materialProdMult: 1,
    wealthProdMult: 1,
    tradeReliabilityMult: 1,
    foodConsMult: 1,
    birthMultiplierMult: 1,
    deathRiskMult: 1,
    deathRateAdd: 0,
    migrationPressureAdd: 0,
    conflictSensitivityAdd: 0,
    stabilityPenalty: 0
  };
}

function effectsForShock(type, severity, phase) {
  const s = clamp01(severity) * clamp(0.4 + phase * 0.6, 0.35, 1);
  if (type === "famine") {
    return {
      foodProdMult: 1 - s * 0.42,
      materialProdMult: 1 - s * 0.08,
      wealthProdMult: 1 - s * 0.12,
      tradeReliabilityMult: 1 - s * 0.2,
      foodConsMult: 1 + s * 0.1,
      birthMultiplierMult: 1 - s * 0.28,
      deathRiskMult: 1 + s * 0.18,
      deathRateAdd: s * 0.000008,
      migrationPressureAdd: s * 0.018,
      conflictSensitivityAdd: s * 0.006,
      stabilityPenalty: s * 0.004
    };
  }
  if (type === "rebellion") {
    return {
      foodProdMult: 1 - s * 0.12,
      materialProdMult: 1 - s * 0.22,
      wealthProdMult: 1 - s * 0.18,
      tradeReliabilityMult: 1 - s * 0.26,
      foodConsMult: 1,
      birthMultiplierMult: 1 - s * 0.14,
      deathRiskMult: 1 + s * 0.12,
      deathRateAdd: s * 0.000006,
      migrationPressureAdd: s * 0.012,
      conflictSensitivityAdd: s * 0.014,
      stabilityPenalty: s * 0.0065
    };
  }
  if (type === "epidemic") {
    return {
      foodProdMult: 1 - s * 0.1,
      materialProdMult: 1 - s * 0.1,
      wealthProdMult: 1 - s * 0.08,
      tradeReliabilityMult: 1 - s * 0.16,
      foodConsMult: 1,
      birthMultiplierMult: 1 - s * 0.22,
      deathRiskMult: 1 + s * 0.32,
      deathRateAdd: s * 0.000011,
      migrationPressureAdd: s * 0.015,
      conflictSensitivityAdd: s * 0.005,
      stabilityPenalty: s * 0.005
    };
  }
  return {
    foodProdMult: 1 - s * 0.08,
    materialProdMult: 1 - s * 0.12,
    wealthProdMult: 1 - s * 0.38,
    tradeReliabilityMult: 1 - s * 0.35,
    foodConsMult: 1 + s * 0.03,
    birthMultiplierMult: 1 - s * 0.1,
    deathRiskMult: 1 + s * 0.06,
    deathRateAdd: s * 0.000003,
    migrationPressureAdd: s * 0.01,
    conflictSensitivityAdd: s * 0.004,
    stabilityPenalty: s * 0.0045
  };
}

function pickDominantRisk(risk) {
  const pairs = Object.entries(risk).sort((a, b) => b[1] - a[1]);
  const top = pairs[0] || ["famine", 0];
  const map = {
    famine: "famine",
    rebellion: "rebellion",
    epidemic: "epidemic",
    crash: "crash"
  };
  return {
    type: map[top[0]] || "famine",
    value: top[1] || 0
  };
}

function stepShockSystem(settlements, tradeRoutes, tick, rng, options = {}) {
  const cfg = {
    evaluateInterval: options.evaluateInterval ?? 20,
    baseIgnition: options.baseIgnition ?? 0.02,
    riskThreshold: options.riskThreshold ?? 0.46,
    minDuration: options.minDuration ?? 260,
    maxDuration: options.maxDuration ?? 820,
    cooldownTicks: options.cooldownTicks ?? 900
  };

  const byId = new Map(settlements.map((s) => [s.id, s]));
  const tradeDependency = new Map();
  for (const settlement of settlements) {
    tradeDependency.set(settlement.id, 0);
    ensureSettlementShockState(settlement);
  }

  const maxVolume = Math.max(
    1,
    ...(tradeRoutes || []).map((r) => r.tradeVolume || r.rawTradeVolume || r.trades || 0)
  );
  for (const route of tradeRoutes || []) {
    const w = clamp01((route.tradeVolume || route.rawTradeVolume || route.trades || 0) / maxVolume);
    tradeDependency.set(route.from, (tradeDependency.get(route.from) || 0) + w);
    tradeDependency.set(route.to, (tradeDependency.get(route.to) || 0) + w);
  }

  const created = [];
  const resolved = [];
  const evaluate = tick % cfg.evaluateInterval === 0;

  for (const settlement of settlements) {
    const state = settlement.shockState;
    const effects = settlement.shockEffects;
    const pop = Math.max(1, popValue(settlement));
    const density = clamp01(pop / 220);
    const econStress = clamp01(settlement.economicStress || settlement.resourceEMA?.foodStress || 0);
    const securityStress = clamp01(settlement.securityStress || 0);
    const legitimacyStress = clamp01(settlement.legitimacyStress || 0);
    const socialStress = clamp01(settlement.socialStress || 0);
    const envStress = clamp01(settlement.environmentStress || settlement.resourcePressure || 0);
    const pressure = clamp01(settlement.resourcePressure || 0);
    const conflict = clamp01(settlement.conflictRate || 0);
    const growthDrag = clamp01(Math.max(0, -(settlement.growthRate || 0) * 12));
    const tradeNorm = clamp01(settlement.tradeFlowNorm || 0);
    const wealthNorm = clamp01((settlement.wealthPerCap || 0) / 2.1);
    const foodDeficit = clamp01(settlement.foodDeficitRatio || 0);
    const dependency = clamp01((tradeDependency.get(settlement.id) || 0) / 5);

    state.risk = {
      famine: clamp01(econStress * 0.5 + envStress * 0.18 + foodDeficit * 0.22 + dependency * 0.1),
      rebellion: clamp01(legitimacyStress * 0.52 + securityStress * 0.22 + socialStress * 0.12 + growthDrag * 0.14),
      epidemic: clamp01(density * 0.42 + socialStress * 0.3 + pressure * 0.16 + conflict * 0.12),
      crash: clamp01(dependency * 0.5 + tradeNorm * 0.24 + (1 - wealthNorm) * 0.26)
    };

    if (state.cooldownTicks > 0) {
      state.cooldownTicks -= 1;
    }

    if (state.activeShock) {
      const shock = state.activeShock;
      shock.remainingTicks = Math.max(0, shock.remainingTicks - 1);
      const phase = shock.remainingTicks / Math.max(1, shock.durationTicks);
      const next = effectsForShock(shock.type, shock.severity, phase);
      Object.assign(effects, next);
      if (shock.remainingTicks <= 0) {
        state.activeShock = null;
        state.cooldownTicks = cfg.cooldownTicks;
        Object.assign(effects, defaultEffects());
        resolved.push({
          settlementId: settlement.id,
          type: shock.type
        });
      }
      continue;
    }

    Object.assign(effects, defaultEffects());

    if (!evaluate || state.cooldownTicks > 0 || pop <= 0 || settlement.isRuined) {
      continue;
    }

    const top = pickDominantRisk(state.risk);
    if (top.value < cfg.riskThreshold) {
      continue;
    }

    const igniteChance = cfg.baseIgnition * Math.pow(top.value, 2.2);
    if (rng() >= igniteChance) {
      continue;
    }

    const severity = clamp(0.24 + top.value * 0.58 + (rng() * 0.08), 0.2, 0.94);
    const duration = Math.floor(
      cfg.minDuration + (cfg.maxDuration - cfg.minDuration) * (0.25 + severity * 0.75)
    );

    state.activeShock = {
      type: top.type,
      severity,
      remainingTicks: duration,
      durationTicks: duration
    };
    Object.assign(effects, effectsForShock(top.type, severity, 1));
    created.push({
      settlementId: settlement.id,
      type: top.type,
      severity: Number(severity.toFixed(4)),
      durationTicks: duration
    });
  }

  return {
    created,
    resolved
  };
}

module.exports = {
  ensureSettlementShockState,
  stepShockSystem
};

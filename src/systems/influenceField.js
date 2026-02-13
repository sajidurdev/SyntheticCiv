function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
const { isSettlementActive } = require("../settlements/activity");

function distSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function percentile(values, p) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clamp(Math.floor((sorted.length - 1) * p), 0, sorted.length - 1);
  return sorted[idx];
}

function gaussianInfluence(strength, distanceSq, sigma) {
  if (sigma <= 0) {
    return 0;
  }
  return strength * Math.exp(-distanceSq / (2 * sigma * sigma));
}

function getClosestSettlements(position, settlements, k = 3) {
  if (!settlements.length || k <= 0) {
    return [];
  }
  const rows = settlements
    .map((settlement) => {
      const center = settlement.center || settlement.centerPosition;
      if (!center) {
        return null;
      }
      return {
        settlement,
        center,
        dSq: distSq(position, center)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.dSq - b.dSq);
  return rows.slice(0, k);
}

function normalizeVector(x, y) {
  const len = Math.hypot(x, y);
  if (len <= 1e-9) {
    return { x: 0, y: 0 };
  }
  return { x: x / len, y: y / len };
}

function compareInfluenceRows(a, b) {
  const epsilon = 1e-12;
  const valueDiff = b.value - a.value;
  if (Math.abs(valueDiff) > epsilon) {
    return valueDiff;
  }
  const distDiff = a.dSq - b.dSq;
  if (Math.abs(distDiff) > epsilon) {
    return distDiff;
  }
  return String(a.id).localeCompare(String(b.id));
}

function computeInfluenceStrengths(settlements, options = {}) {
  if (!settlements.length) {
    return new Map();
  }
  const state = options.state || {};
  const wPop = options.wPop ?? 0.14;
  const wStab = options.wStab ?? 0.34;
  const wTrade = options.wTrade ?? 0.28;
  const wPress = options.wPress ?? 0.22;
  const emaAlpha = options.emaAlpha ?? 0.05;
  const tradePercentile = options.tradePercentile ?? 0.9;
  const tradeCapEma = options.tradeCapEma ?? 0.08;

  const activeSettlements = settlements.filter(isSettlementActive);
  if (!activeSettlements.length) {
    const zeros = new Map();
    for (const settlement of settlements) {
      settlement.influenceStrength = 0;
      zeros.set(settlement.id, 0);
    }
    return zeros;
  }

  const tradeFlows = activeSettlements.map((s) => Math.max(0, s.tradeFlow || s.tradeVolume || 0));
  const rawTradeCap = Math.max(1, percentile(tradeFlows, tradePercentile));
  const prevTradeCap = Number.isFinite(state.tradeFlowCap) ? state.tradeFlowCap : rawTradeCap;
  const tradeFlowCap = prevTradeCap + (rawTradeCap - prevTradeCap) * tradeCapEma;
  state.tradeFlowCap = tradeFlowCap;

  const result = new Map();
  for (const settlement of settlements) {
    if (!isSettlementActive(settlement)) {
      settlement.influenceStrength = 0;
      settlement.tradeFlowInfluenceNorm = 0;
      result.set(settlement.id, 0);
      continue;
    }

    const population = Array.isArray(settlement.members)
      ? settlement.members.length
      : Math.max(0, settlement.population || 0);
    const stability = clamp01(settlement.stability || settlement.stabilityScore || 0);
    const pressure = clamp01(settlement.resourcePressure || settlement.pressure || 0);
    const tradeFlowNorm = clamp01((settlement.tradeFlow || settlement.tradeVolume || 0) / Math.max(1, tradeFlowCap));

    let target = clamp01(
      wPop * Math.log1p(population) +
      wStab * stability +
      wTrade * tradeFlowNorm -
      wPress * pressure
    );

    const roleMultiplier = settlement.roleInfluenceMultiplier || 1;
    target = clamp01(target * roleMultiplier);
    const prev = settlement.influenceStrength || 0;
    const next = prev + (target - prev) * emaAlpha;

    settlement.influenceStrength = clamp01(next);
    settlement.tradeFlowInfluenceNorm = tradeFlowNorm;
    result.set(settlement.id, settlement.influenceStrength);
  }
  return result;
}

function influenceAtPosition(x, y, settlements, world, options = {}) {
  if (!settlements.length) {
    return 0;
  }
  const sigma = options.sigma ?? 120;
  const cutoff = options.cutoff ?? sigma * 2.5;
  const cutoffSq = cutoff * cutoff;
  const p = { x, y };

  let sum = 0;
  for (const settlement of settlements) {
    if (!isSettlementActive(settlement)) {
      continue;
    }
    const center = settlement.center || settlement.centerPosition;
    if (!center) continue;
    const dSq = distSq(p, center);
    if (dSq > cutoffSq) {
      continue;
    }
    const strength = settlement.influenceStrength || 0;
    sum += gaussianInfluence(strength, dSq, sigma);
  }
  return sum;
}

function scoreMoveWithInfluence(agent, candidatePos, baseScore, settlements, world, options = {}) {
  const alpha = options.alpha ?? 0.4;
  const influenceMax = options.influenceMax ?? 0.95;
  const currentSettlement = options.currentSettlement || null;
  const strategy = options.strategyModifiers || null;
  const social = agent.traits?.social ?? 0;
  const closestK = options.closestK ?? 3;
  const sigma = options.sigma ?? 120;

  let migrationBoost = 1;
  if (currentSettlement) {
    const pressure = currentSettlement.resourcePressure || 0;
    const instability = 1 - (currentSettlement.stability || 0);
    const economyPressure = currentSettlement.economyMigrationPressure || 0;
    const expansionBoost = currentSettlement.policyEffects?.expansionMigrationBoost || 0;
    const borderOpenness = (currentSettlement.policyEffects?.borderOpenness ?? 0.5) - 0.5;
    migrationBoost += clamp(
      pressure * 0.7 + instability * 0.7 + economyPressure + expansionBoost + borderOpenness * 0.24,
      0,
      1.35
    );
  }
  if (strategy) {
    migrationBoost += clamp((strategy.migrationBias || 0) * 0.2, -0.12, 0.18);
  }

  const activeSettlements = settlements.filter(isSettlementActive);
  if (!activeSettlements.length) {
    return baseScore;
  }

  const closest = getClosestSettlements(candidatePos, activeSettlements, closestK).map((entry) => entry.settlement);
  const influenceAt = influenceAtPosition(
    candidatePos.x,
    candidatePos.y,
    closest,
    world,
    { ...options, sigma }
  );
  const rawTerm = influenceAt * social * alpha * migrationBoost;
  let influenceTerm = clamp(rawTerm, 0, influenceMax);
  const baseCap = Math.max(0, baseScore * 0.2);
  if (influenceTerm > baseCap) {
    influenceTerm = baseCap;
  }

  return baseScore + influenceTerm;
}

function computeInfluenceSteering(position, settlements, options = {}) {
  const activeSettlements = settlements.filter(isSettlementActive);
  if (!activeSettlements.length) {
    return { x: 0, y: 0, magnitude: 0 };
  }
  const closestK = options.closestK ?? 3;
  const sigma = options.sigma ?? 120;
  const closest = getClosestSettlements(position, activeSettlements, closestK);
  if (!closest.length) {
    return { x: 0, y: 0, magnitude: 0 };
  }

  let vx = 0;
  let vy = 0;
  let totalW = 0;
  for (const row of closest) {
    const infl = gaussianInfluence(row.settlement.influenceStrength || 0, row.dSq, sigma);
    if (infl <= 1e-9) {
      continue;
    }
    const dx = row.center.x - position.x;
    const dy = row.center.y - position.y;
    const unit = normalizeVector(dx, dy);
    vx += unit.x * infl;
    vy += unit.y * infl;
    totalW += infl;
  }

  if (totalW <= 1e-9) {
    return { x: 0, y: 0, magnitude: 0 };
  }
  const unit = normalizeVector(vx, vy);
  return { x: unit.x, y: unit.y, magnitude: clamp01(totalW) };
}

function dominantInfluenceSettlementId(position, settlements, options = {}) {
  const top = computeTopInfluenceSources(position, settlements, options);
  return top.top?.id || null;
}

function computeTopInfluenceSources(position, settlements, options = {}) {
  const activeSettlements = settlements.filter(isSettlementActive);
  if (!activeSettlements.length) {
    return {
      top: null,
      second: null,
      contested: 0
    };
  }
  const sigma = options.sigma ?? 120;
  const closestK = options.closestK ?? 3;
  const closest = getClosestSettlements(position, activeSettlements, closestK);
  const rows = [];
  for (const row of closest) {
    rows.push({
      id: row.settlement.id,
      dSq: row.dSq,
      value: gaussianInfluence(row.settlement.influenceStrength || 0, row.dSq, sigma)
    });
  }
  rows.sort(compareInfluenceRows);

  const top = rows[0] || null;
  const second = rows[1] || null;
  const topValue = top?.value || 0;
  const secondValue = second?.value || 0;
  const contested = clamp01(secondValue / (topValue + 1e-6));

  return {
    top,
    second,
    contested
  };
}

module.exports = {
  computeInfluenceStrengths,
  influenceAtPosition,
  scoreMoveWithInfluence,
  computeInfluenceSteering,
  dominantInfluenceSettlementId,
  computeTopInfluenceSources,
  getClosestSettlements
};

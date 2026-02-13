function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((acc, n) => acc + n, 0) / values.length;
}

function stddev(values, avg) {
  if (!values.length) return 0;
  const variance = values.reduce((acc, n) => acc + (n - avg) * (n - avg), 0) / values.length;
  return Math.sqrt(variance);
}

function classifyRole(settlement, thresholds) {
  const tradeFlow = settlement.tradeFlow || settlement.tradeVolume || 0;
  const tradeFlowNorm = settlement.tradeFlowNorm || 0;
  const stability = settlement.stability || settlement.stabilityScore || 0;
  const growthRate = settlement.growthRate || 0;
  const pressure = settlement.resourcePressure || 0;
  const conflictRate = settlement.conflictRate || 0;
  const frontierPressure = settlement.frontierPressure || 0;
  const prevConflictRate = settlement.prevConflictRate ?? conflictRate;
  const conflictDelta = conflictRate - prevConflictRate;

  const tradeHubScore =
    (tradeFlow >= thresholds.tradeHigh ? 1.4 : 0) +
    Math.max(0, tradeFlowNorm * 1.2) +
    Math.max(0, (stability - 0.5) * 2.2) +
    (frontierPressure < 0.25 ? 0.35 : -0.2);

  const frontierScore =
    Math.max(0, growthRate * 30) +
    Math.max(0, (frontierPressure - 0.55) * 2.3) +
    (conflictDelta > 0.004 ? 0.55 : 0.12);

  const strugglingScore =
    Math.max(0, (pressure - 0.6) * 2.4) +
    Math.max(0, (0.45 - stability) * 1.6) +
    Math.max(0, frontierPressure - 0.5) * 0.5;

  const militaryScore =
    Math.max(0, (conflictRate - thresholds.conflictHigh) * 2.8) +
    Math.max(0, (frontierPressure - 0.55) * 2.2) +
    (conflictDelta > 0.004 ? 0.5 : 0);

  const ranked = [
    { role: "Trade Hub", score: tradeHubScore },
    { role: "Frontier", score: frontierScore },
    { role: "Struggling", score: strugglingScore },
    { role: "Military Node", score: militaryScore },
    { role: "General", score: 0.15 }
  ].sort((a, b) => b.score - a.score);

  return ranked[0].role;
}

function getRoleInfluenceMultiplier(role) {
  if (role === "Trade Hub") {
    return 1.1;
  }
  if (role === "Struggling") {
    return 0.85;
  }
  return 1;
}

function classifySettlementRoles(settlements) {
  if (!settlements.length) {
    return settlements;
  }

  const tradeValues = settlements.map((s) => s.tradeFlow || s.tradeVolume || 0);
  const conflictValues = settlements.map((s) => s.conflictRate || 0);
  const tradeMean = mean(tradeValues);
  const conflictMean = mean(conflictValues);
  const tradeStd = stddev(tradeValues, tradeMean);
  const conflictStd = stddev(conflictValues, conflictMean);

  const thresholds = {
    tradeHigh: tradeMean + tradeStd * 0.6,
    conflictHigh: clamp(conflictMean + conflictStd * 0.6, 0.18, 1)
  };

  for (const settlement of settlements) {
    const role = classifyRole(settlement, thresholds);
    settlement.role = role;
    settlement.roleInfluenceMultiplier = getRoleInfluenceMultiplier(role);
  }
  return settlements;
}

module.exports = {
  classifySettlementRoles,
  getRoleInfluenceMultiplier
};

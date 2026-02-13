function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function lerp(from, to, alpha) {
  return from + (to - from) * alpha;
}

function popValue(settlement) {
  if (Array.isArray(settlement.members)) {
    return settlement.members.length;
  }
  return Math.max(0, settlement.population || 0);
}

function getCenter(settlement) {
  return settlement.center || settlement.centerPosition || { x: 0, y: 0 };
}

function dist(a, b) {
  return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0));
}

function ensureSettlementInnovationState(settlement) {
  const knowledge = settlement.knowledge || {};
  settlement.knowledge = {
    farming: clamp01(knowledge.farming || 0),
    medicine: clamp01(knowledge.medicine || 0),
    governance: clamp01(knowledge.governance || 0),
    logistics: clamp01(knowledge.logistics || 0)
  };
  const effects = settlement.innovationEffects || {};
  settlement.innovationEffects = {
    foodProdMult: Number.isFinite(effects.foodProdMult) ? effects.foodProdMult : 1,
    materialProdMult: Number.isFinite(effects.materialProdMult) ? effects.materialProdMult : 1,
    wealthProdMult: Number.isFinite(effects.wealthProdMult) ? effects.wealthProdMult : 1,
    birthRateMult: Number.isFinite(effects.birthRateMult) ? effects.birthRateMult : 1,
    deathRiskMult: Number.isFinite(effects.deathRiskMult) ? effects.deathRiskMult : 1,
    legitimacyRelief: Number.isFinite(effects.legitimacyRelief) ? effects.legitimacyRelief : 0,
    tradeRangeMult: Number.isFinite(effects.tradeRangeMult) ? effects.tradeRangeMult : 1,
    tradeReliabilityBonus: Number.isFinite(effects.tradeReliabilityBonus) ? effects.tradeReliabilityBonus : 0,
    infoFlowBonus: Number.isFinite(effects.infoFlowBonus) ? effects.infoFlowBonus : 0,
    militarySupplyBonus: Number.isFinite(effects.militarySupplyBonus) ? effects.militarySupplyBonus : 0
  };
}

function applyKnowledgeEffects(settlement) {
  const k = settlement.knowledge || {};
  const level = ((k.farming || 0) + (k.medicine || 0) + (k.governance || 0) + (k.logistics || 0)) * 0.25;
  settlement.knowledgeLevel = Number(clamp01(level).toFixed(4));
  settlement.innovationEffects = {
    foodProdMult: Number((1 + (k.farming || 0) * 0.18).toFixed(4)),
    materialProdMult: Number((1 + (k.logistics || 0) * 0.08).toFixed(4)),
    wealthProdMult: Number((1 + ((k.logistics || 0) * 0.1 + (k.governance || 0) * 0.06)).toFixed(4)),
    birthRateMult: Number((1 + (k.governance || 0) * 0.06).toFixed(4)),
    deathRiskMult: Number(clamp(1 - (k.medicine || 0) * 0.16, 0.72, 1).toFixed(4)),
    legitimacyRelief: Number(((k.governance || 0) * 0.1).toFixed(4)),
    tradeRangeMult: Number((1 + (k.logistics || 0) * 0.22).toFixed(4)),
    tradeReliabilityBonus: Number(((k.logistics || 0) * 0.12).toFixed(4)),
    infoFlowBonus: Number((((k.logistics || 0) * 0.08 + (k.governance || 0) * 0.04)).toFixed(4)),
    militarySupplyBonus: Number(clamp((k.logistics || 0) * 0.12 + (k.farming || 0) * 0.05, 0, 0.2).toFixed(4))
  };
}

function stepInnovation(settlements, tradeRoutes, tick, options = {}) {
  const cfg = {
    baseResearchRate: options.baseResearchRate ?? 0.0011,
    conflictDecayRate: options.conflictDecayRate ?? 0.00045,
    routeDiffusionRate: options.routeDiffusionRate ?? 0.0022,
    localDiffusionRate: options.localDiffusionRate ?? 0.0012,
    localDiffusionRadius: options.localDiffusionRadius ?? 22
  };

  const active = settlements.filter((s) => popValue(s) > 0 && !s.isRuined);
  for (const settlement of settlements) {
    ensureSettlementInnovationState(settlement);
  }
  if (!active.length) {
    return;
  }

  for (const settlement of active) {
    const pop = Math.max(1, popValue(settlement));
    const popFactor = Math.log1p(pop) / 4.2;
    const stability = clamp01(settlement.stability || settlement.stabilityScore || 0);
    const pressure = clamp01(settlement.resourcePressure || 0);
    const conflict = clamp01(settlement.conflictRate || 0);
    const tradeNorm = clamp01(settlement.tradeFlowNorm || 0);
    const tradeConsistency = clamp01(settlement.tradeConsistency || 0);
    const legitimacy = clamp01(settlement.legitimacyStress || 0);
    const wealthNorm = clamp01((settlement.wealthPerCap || 0) / 2.2);
    const shockPenalty = clamp01(1 - (settlement.shockEffects?.tradeReliabilityMult ?? 1));

    const researchGain = cfg.baseResearchRate * (0.55 + popFactor * 0.45) * (0.4 + stability * 0.6);
    const decay = (cfg.conflictDecayRate * conflict + cfg.conflictDecayRate * 0.7 * shockPenalty);
    const k = settlement.knowledge;

    k.farming = clamp01(
      k.farming +
        researchGain * (0.44 + stability * 0.32 + tradeConsistency * 0.14 - pressure * 0.26) -
        decay * 0.65
    );
    k.medicine = clamp01(
      k.medicine +
        researchGain * (0.36 + wealthNorm * 0.34 + stability * 0.2 - conflict * 0.2) -
        decay * 0.82
    );
    k.governance = clamp01(
      k.governance +
        researchGain * (0.34 + stability * 0.3 + tradeConsistency * 0.2 - legitimacy * 0.2) -
        decay * 0.7
    );
    k.logistics = clamp01(
      k.logistics +
        researchGain * (0.3 + tradeNorm * 0.44 + (settlement.influenceStrength || 0) * 0.22 - pressure * 0.16) -
        decay * 0.68
    );
  }

  const byId = new Map(settlements.map((s) => [s.id, s]));
  const validRoutes = (tradeRoutes || []).filter((r) => byId.has(r.from) && byId.has(r.to));
  const maxRouteVol = Math.max(1, ...validRoutes.map((r) => r.tradeVolume || r.rawTradeVolume || r.trades || 0));

  for (const route of validRoutes) {
    const a = byId.get(route.from);
    const b = byId.get(route.to);
    if (!a || !b || popValue(a) <= 0 || popValue(b) <= 0) continue;
    const weight = clamp01((route.tradeVolume || route.rawTradeVolume || route.trades || 0) / maxRouteVol);
    const spread = cfg.routeDiffusionRate * weight;
    for (const key of ["farming", "medicine", "governance", "logistics"]) {
      const gap = (a.knowledge[key] || 0) - (b.knowledge[key] || 0);
      const delta = clamp(gap * spread, -0.0035, 0.0035);
      a.knowledge[key] -= delta;
      b.knowledge[key] += delta;
      a.knowledge[key] = clamp01(a.knowledge[key]);
      b.knowledge[key] = clamp01(b.knowledge[key]);
    }
  }

  for (const settlement of active) {
    let nearest = null;
    let nearestDist = Infinity;
    const centerA = getCenter(settlement);
    for (const other of active) {
      if (other.id === settlement.id) continue;
      const d = dist(centerA, getCenter(other));
      if (d < nearestDist) {
        nearestDist = d;
        nearest = other;
      }
    }
    if (!nearest || nearestDist > cfg.localDiffusionRadius) {
      continue;
    }
    const proximityWeight = clamp01(1 - nearestDist / Math.max(1, cfg.localDiffusionRadius));
    const spread = cfg.localDiffusionRate * proximityWeight;
    for (const key of ["farming", "medicine", "governance", "logistics"]) {
      const gap = (nearest.knowledge[key] || 0) - (settlement.knowledge[key] || 0);
      const delta = clamp(gap * spread, -0.0018, 0.0018);
      settlement.knowledge[key] = clamp01((settlement.knowledge[key] || 0) + delta);
    }
  }

  for (const settlement of settlements) {
    applyKnowledgeEffects(settlement);
  }
}

module.exports = {
  ensureSettlementInnovationState,
  stepInnovation
};

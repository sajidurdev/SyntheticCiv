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

function getCenter(settlement) {
  return settlement.center || settlement.centerPosition;
}

function ensureInfluenceSaturationState(settlement) {
  if (!settlement.influenceSaturation) {
    settlement.influenceSaturation = {
      localDensity: 0,
      saturationLevel: 0,
      growthPenaltyMult: 1,
      stabilityPenalty: 0,
      splitBonus: 0,
      outwardTradeSpread: 0
    };
  }
}

function estimateBaseInfluence(settlement, options) {
  const regionalBase = settlement.regionalInfluence?.baseInfluence;
  if (Number.isFinite(regionalBase) && regionalBase > 0) {
    return regionalBase;
  }
  const population = popValue(settlement);
  const trade = Math.min(options.maxTradeForInfluence, settlement.tradeFlow || settlement.tradeVolume || 0);
  const stability = clamp01(settlement.stability || settlement.stabilityScore || 0);
  const energy = Math.min(options.maxEnergyForInfluence, settlement.avgEnergy || settlement.energyLevel || 0);
  return population * 0.4 + trade * 0.3 + stability * 0.2 + energy * 0.1;
}

function computeInfluenceSaturation(settlements, options = {}) {
  const cfg = {
    radiusScale: options.radiusScale ?? 4.1,
    densityRadiusMultiplier: options.densityRadiusMultiplier ?? 2.1,
    falloffFactor: options.falloffFactor ?? 0.0032,
    densityThreshold: options.densityThreshold ?? 95,
    thresholdBand: options.thresholdBand ?? 85,
    saturationGrowthPenalty: options.saturationGrowthPenalty ?? 0.34,
    saturationInstabilityFactor: options.saturationInstabilityFactor ?? 0.016,
    saturationSplitBonus: options.saturationSplitBonus ?? 0.2,
    outwardTradeSpreadFactor: options.outwardTradeSpreadFactor ?? 0.18,
    maxTradeForInfluence: options.maxTradeForInfluence ?? 120,
    maxEnergyForInfluence: options.maxEnergyForInfluence ?? 120
  };

  const active = settlements.filter((s) => popValue(s) > 0 && getCenter(s));
  const emitters = active.map((s) => {
    const baseInfluence = estimateBaseInfluence(s, cfg);
    const radius = Math.sqrt(Math.max(0.01, baseInfluence)) * cfg.radiusScale;
    return {
      id: s.id,
      center: getCenter(s),
      baseInfluence,
      radius
    };
  });

  const densityBySettlement = new Map();
  for (const settlement of settlements) {
    ensureInfluenceSaturationState(settlement);
  }

  for (const target of active) {
    const center = getCenter(target);
    let density = 0;

    for (const emitter of emitters) {
      const dx = emitter.center.x - center.x;
      const dy = emitter.center.y - center.y;
      const distSq = dx * dx + dy * dy;
      const densityRadius = emitter.radius * cfg.densityRadiusMultiplier;
      if (distSq > densityRadius * densityRadius) {
        continue;
      }
      const effective = emitter.baseInfluence / (1 + distSq * cfg.falloffFactor);
      density += effective;
    }

    const saturationLevel = clamp01(
      (density - cfg.densityThreshold) / Math.max(1, cfg.thresholdBand)
    );
    const growthPenaltyMult = clamp(
      1 - saturationLevel * cfg.saturationGrowthPenalty,
      0.62,
      1
    );
    const stabilityPenalty = saturationLevel * cfg.saturationInstabilityFactor;
    const splitBonus = saturationLevel * cfg.saturationSplitBonus;
    const outwardTradeSpread = saturationLevel * cfg.outwardTradeSpreadFactor;

    target.influenceSaturation = {
      localDensity: Number(density.toFixed(4)),
      saturationLevel: Number(saturationLevel.toFixed(4)),
      growthPenaltyMult: Number(growthPenaltyMult.toFixed(4)),
      stabilityPenalty: Number(stabilityPenalty.toFixed(5)),
      splitBonus: Number(splitBonus.toFixed(5)),
      outwardTradeSpread: Number(outwardTradeSpread.toFixed(5))
    };
    densityBySettlement.set(target.id, target.influenceSaturation);
  }

  for (const settlement of settlements) {
    if (densityBySettlement.has(settlement.id)) {
      continue;
    }
    settlement.influenceSaturation.localDensity = 0;
    settlement.influenceSaturation.saturationLevel = 0;
    settlement.influenceSaturation.growthPenaltyMult = 1;
    settlement.influenceSaturation.stabilityPenalty = 0;
    settlement.influenceSaturation.splitBonus = 0;
    settlement.influenceSaturation.outwardTradeSpread = 0;
  }

  return {
    densityBySettlement
  };
}

module.exports = {
  ensureInfluenceSaturationState,
  computeInfluenceSaturation
};

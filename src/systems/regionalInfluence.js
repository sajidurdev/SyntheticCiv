function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function pairKey(a, b) {
  if (!a || !b || a === b) {
    return null;
  }
  return a < b ? `${a}|${b}` : `${b}|${a}`;
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

function ensureRegionalState(settlement) {
  if (!settlement.regionalInfluence) {
    settlement.regionalInfluence = {
      baseInfluence: 0,
      radius: 0,
      dominantCivId: settlement.civId || null,
      dominantInfluence: 0,
      internalInfluence: 0,
      externalInfluence: 0,
      conflictPressure: 0,
      cohesionPressure: 0,
      stabilityModifier: 0,
      growthModifier: 0,
      driftProgress: 0,
      driftTargetCivId: null,
      alignmentCivId: settlement.civId || null
    };
  }
  if (!settlement.civAlignment || typeof settlement.civAlignment !== "object") {
    settlement.civAlignment = {};
  }
}

function computeBaseInfluence(settlement, options) {
  const population = popValue(settlement);
  const tradeFlow = clamp(settlement.tradeFlow || settlement.tradeVolume || 0, 0, options.maxTradeForInfluence);
  const stability = clamp01(settlement.stability || settlement.stabilityScore || 0);
  const energy = clamp(settlement.avgEnergy || settlement.energyLevel || 0, 0, options.maxEnergyForInfluence);
  return (
    population * 0.4 +
    tradeFlow * 0.3 +
    stability * 0.2 +
    energy * 0.1
  );
}

function computeRegionalInfluence(settlements, options = {}) {
  const config = {
    influenceScale: options.influenceScale ?? 4.2,
    falloffFactor: options.falloffFactor ?? 0.003,
    maxTradeForInfluence: options.maxTradeForInfluence ?? 120,
    maxEnergyForInfluence: options.maxEnergyForInfluence ?? 120,
    stabilityDecayRate: options.stabilityDecayRate ?? 0.02,
    cohesionBonus: options.cohesionBonus ?? 0.012,
    growthConflictRate: options.growthConflictRate ?? 0.015,
    growthCohesionBonus: options.growthCohesionBonus ?? 0.008,
    driftThreshold: options.driftThreshold ?? 1.28,
    driftRate: options.driftRate ?? 0.012,
    driftDecay: options.driftDecay ?? 0.0035,
    alignmentAlpha: options.alignmentAlpha ?? 0.05,
    civTensionRate: options.civTensionRate ?? 0.008
  };

  const active = settlements.filter((s) => popValue(s) > 0 && getCenter(s));
  const influenceRows = [];
  const baseBySettlementId = new Map();
  for (const settlement of active) {
    ensureRegionalState(settlement);
    const baseInfluence = computeBaseInfluence(settlement, config);
    const radius = Math.sqrt(Math.max(0.01, baseInfluence)) * config.influenceScale;
    baseBySettlementId.set(settlement.id, { baseInfluence, radius });
    influenceRows.push({
      settlement,
      id: settlement.id,
      civId: settlement.civId || null,
      center: getCenter(settlement),
      baseInfluence,
      radius
    });
  }

  const civInfluenceBySettlement = new Map();
  const civDeltas = new Map();

  for (const target of active) {
    ensureRegionalState(target);
    const centerB = getCenter(target);
    const civMap = new Map();
    let totalInfluence = 0;

    for (const emitter of influenceRows) {
      const dx = emitter.center.x - centerB.x;
      const dy = emitter.center.y - centerB.y;
      const distSq = dx * dx + dy * dy;
      const maxDistance = emitter.radius * 2.3;
      if (distSq > maxDistance * maxDistance) {
        continue;
      }
      const effective = emitter.baseInfluence / (1 + distSq * config.falloffFactor);
      if (effective <= 1e-6) {
        continue;
      }

      const civId = emitter.civId || "__wild__";
      civMap.set(civId, (civMap.get(civId) || 0) + effective);
      totalInfluence += effective;
    }

    const civRows = Array.from(civMap.entries())
      .map(([civId, value]) => ({ civId, value }))
      .sort((a, b) => b.value - a.value || String(a.civId).localeCompare(String(b.civId)));

    const top = civRows[0] || { civId: target.civId || null, value: 0 };
    const second = civRows[1] || { civId: null, value: 0 };
    const ownCiv = target.civId || null;
    const internalInfluence = ownCiv ? (civMap.get(ownCiv) || 0) : 0;
    const externalInfluence = Math.max(0, totalInfluence - internalInfluence);
    const rivalShare = externalInfluence / Math.max(1e-6, totalInfluence);
    const overlap = second.value / Math.max(1e-6, top.value);
    const conflictPressure = clamp01(
      rivalShare * 0.55 +
      overlap * 0.45 +
      (top.civId && ownCiv && top.civId !== ownCiv ? 0.08 : 0)
    );
    const cohesionPressure = clamp01(internalInfluence / Math.max(1e-6, totalInfluence));

    for (const [civId, value] of civMap.entries()) {
      const prev = target.civAlignment[civId] || 0;
      const share = value / Math.max(1e-6, totalInfluence);
      target.civAlignment[civId] = prev + (share - prev) * config.alignmentAlpha;
    }
    for (const civId of Object.keys(target.civAlignment)) {
      if (!civMap.has(civId)) {
        target.civAlignment[civId] *= 0.992;
        if (target.civAlignment[civId] < 1e-4) {
          delete target.civAlignment[civId];
        }
      }
    }

    const weakness = clamp01(
      clamp((0.5 - (target.stability || target.stabilityScore || 0)) / 0.5, 0, 1) * 0.65 +
      clamp((0.5 - (target.avgEnergy || 0) / 100), 0, 1) * 0.2 +
      clamp((35 - popValue(target)) / 35, 0, 1) * 0.15
    );

    let driftProgress = target.regionalInfluence.driftProgress || 0;
    let driftTargetCivId = target.regionalInfluence.driftTargetCivId || null;
    if (
      ownCiv &&
      top.civId &&
      top.civId !== ownCiv &&
      externalInfluence > internalInfluence * config.driftThreshold
    ) {
      const externalRatio = externalInfluence / Math.max(1e-6, internalInfluence);
      const pressure = clamp01((externalRatio - config.driftThreshold) / config.driftThreshold);
      driftProgress = clamp01(
        driftProgress + config.driftRate * (0.4 + weakness * 0.6) * pressure
      );
      driftTargetCivId = top.civId;
    } else {
      driftProgress = Math.max(0, driftProgress - config.driftDecay);
      if (driftProgress < 0.04) {
        driftTargetCivId = null;
      }
    }

    const alignmentCivId = driftProgress > 0.6 && driftTargetCivId ? driftTargetCivId : ownCiv;
    const stabilityModifier = clamp(
      -conflictPressure * config.stabilityDecayRate +
      cohesionPressure * config.cohesionBonus,
      -0.03,
      0.02
    );
    const growthModifier = clamp(
      -conflictPressure * config.growthConflictRate +
      cohesionPressure * config.growthCohesionBonus,
      -0.025,
      0.015
    );

    target.regionalInfluence = {
      baseInfluence: Number((baseBySettlementId.get(target.id)?.baseInfluence || 0).toFixed(4)),
      radius: Number((baseBySettlementId.get(target.id)?.radius || 0).toFixed(4)),
      dominantCivId: top.civId && top.civId !== "__wild__" ? top.civId : null,
      dominantInfluence: Number((top.value || 0).toFixed(4)),
      internalInfluence: Number(internalInfluence.toFixed(4)),
      externalInfluence: Number(externalInfluence.toFixed(4)),
      conflictPressure: Number(conflictPressure.toFixed(4)),
      cohesionPressure: Number(cohesionPressure.toFixed(4)),
      stabilityModifier: Number(stabilityModifier.toFixed(5)),
      growthModifier: Number(growthModifier.toFixed(5)),
      driftProgress: Number(driftProgress.toFixed(4)),
      driftTargetCivId,
      alignmentCivId: alignmentCivId || ownCiv || null
    };

    civInfluenceBySettlement.set(target.id, civMap);

    if (
      ownCiv &&
      top.civId &&
      top.civId !== ownCiv &&
      top.civId !== "__wild__" &&
      conflictPressure > 0.22
    ) {
      const key = pairKey(ownCiv, top.civId);
      if (key) {
        const delta = -config.civTensionRate * conflictPressure * (0.5 + weakness * 0.5);
        civDeltas.set(key, (civDeltas.get(key) || 0) + delta);
      }
    }

    if (
      ownCiv &&
      alignmentCivId &&
      alignmentCivId !== ownCiv &&
      driftProgress > 0.35
    ) {
      const key = pairKey(ownCiv, alignmentCivId);
      if (key) {
        const delta = -config.civTensionRate * 0.4 * driftProgress;
        civDeltas.set(key, (civDeltas.get(key) || 0) + delta);
      }
    }
  }

  for (const settlement of settlements) {
    ensureRegionalState(settlement);
    if (!civInfluenceBySettlement.has(settlement.id)) {
      settlement.regionalInfluence.baseInfluence = 0;
      settlement.regionalInfluence.radius = 0;
      settlement.regionalInfluence.dominantInfluence = 0;
      settlement.regionalInfluence.dominantCivId = settlement.civId || null;
      settlement.regionalInfluence.internalInfluence = 0;
      settlement.regionalInfluence.externalInfluence = 0;
      settlement.regionalInfluence.conflictPressure = 0;
      settlement.regionalInfluence.cohesionPressure = 0;
      settlement.regionalInfluence.stabilityModifier = 0;
      settlement.regionalInfluence.growthModifier = 0;
      settlement.regionalInfluence.driftProgress = Math.max(
        0,
        (settlement.regionalInfluence.driftProgress || 0) - config.driftDecay
      );
      settlement.regionalInfluence.alignmentCivId = settlement.civId || null;
      if (settlement.regionalInfluence.driftProgress < 0.04) {
        settlement.regionalInfluence.driftTargetCivId = null;
      }
    }
  }

  return {
    civInfluenceBySettlement,
    civDeltas
  };
}

module.exports = {
  ensureRegionalState,
  computeRegionalInfluence
};

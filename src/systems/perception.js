function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
const { isSettlementActive } = require("../settlements/activity");

function normalizeVector(dx, dy) {
  const len = Math.hypot(dx, dy);
  if (len <= 1e-9) {
    return { x: 0, y: 0 };
  }
  return { x: dx / len, y: dy / len };
}

function settlementCenter(settlement) {
  return settlement.center || settlement.centerPosition;
}

function buildSettlementVisualSignals(settlement, tick) {
  const stability = settlement.stability ?? settlement.stabilityScore ?? 0;
  const pressure = settlement.resourcePressure ?? 0;
  const growth = settlement.growthRate ?? 0;
  const tradeFlow = settlement.tradeFlow ?? settlement.tradeVolume ?? 0;
  const influence = settlement.influenceStrength ?? 0;

  const stableFactor = clamp(stability, 0, 1);
  const unstableFactor = 1 - stableFactor;
  const pulseFrequencyBase = 0.035 - stableFactor * 0.018;
  const irregularity = Math.sin(tick * 0.11 + Number(String(settlement.id).replace(/\D/g, "")) * 0.07);

  const pulseFrequency = clamp(
    pulseFrequencyBase + unstableFactor * 0.004 * irregularity,
    0.012,
    0.05
  );
  const pulseAmplitude = clamp(
    1.6 + stableFactor * 2.8 + Math.min(1, tradeFlow / 180) * 1.2 - pressure * 0.7,
    0.9,
    4.8
  );

  const jitterStrength = clamp(unstableFactor * 2.1 + pressure * 0.8, 0, 2.4);
  const glowIntensity = clamp(
    0.28 + stableFactor * 0.44 + influence * 0.25 - pressure * 0.18 + growth * 2.2,
    0.12,
    1
  );

  const declineIndicator = clamp((-growth) * 18 + pressure * 0.35, 0, 1);
  const growthIndicator = clamp(growth * 18 + stableFactor * 0.15, 0, 1);
  const collapseWarningAlpha =
    stableFactor < 0.2 && pressure > 0.7
      ? clamp(0.4 + (pressure - 0.7) * 1.8 + (0.2 - stableFactor) * 2, 0.4, 0.95)
      : 0;

  const role = settlement.role || "General";
  const roleRings = {
    tradeHubHaloAlpha: role === "Trade Hub" ? clamp(0.18 + (tradeFlow / 160) * 0.25, 0.15, 0.45) : 0,
    strugglingDistortionAlpha: role === "Struggling"
      ? clamp(0.12 + pressure * 0.3 + (1 - stableFactor) * 0.15, 0.12, 0.45)
      : 0,
    frontierRippleAlpha: role === "Frontier"
      ? clamp(0.14 + growth * 5 + influence * 0.1, 0.14, 0.4)
      : 0
  };

  return {
    pulseFrequency,
    pulseAmplitude,
    jitterStrength,
    glowIntensity,
    declineIndicator,
    growthIndicator,
    collapseWarningAlpha,
    roleRings
  };
}

function buildInfluenceAura(settlement) {
  const influence = clamp(settlement.influenceStrength ?? 0, 0, 1);
  const stability = clamp(settlement.stability ?? settlement.stabilityScore ?? 0, 0, 1);
  const pressure = clamp(settlement.resourcePressure ?? 0, 0, 1);
  const growth = settlement.growthRate ?? 0;
  const cutoff = settlement.influenceCutoff ?? 32;

  const radius = clamp(10 + influence * 22, 10, cutoff);
  const softness = clamp(0.55 + (1 - influence) * 0.28, 0.45, 0.92);
  const brightness = clamp(0.38 + stability * 0.4 - pressure * 0.2 + Math.min(0.2, growth * 3), 0.15, 1);
  const flickerAmount = clamp(pressure * 0.35 + Math.max(0, -growth) * 0.7, 0, 0.5);

  return {
    radius,
    softness,
    brightness,
    flickerAmount
  };
}

function pickTopInfluenceSettlements(settlements) {
  let first = null;
  let second = null;
  for (const settlement of settlements) {
    if (!first || (settlement.influenceStrength || 0) > (first.influenceStrength || 0)) {
      second = first;
      first = settlement;
    } else if (!second || (settlement.influenceStrength || 0) > (second.influenceStrength || 0)) {
      second = settlement;
    }
  }
  return { first, second };
}

function buildMigrationStreams(settlements) {
  const activeSettlements = (settlements || []).filter(isSettlementActive);
  if (!activeSettlements.length) {
    return [];
  }
  const threshold = 6;
  const streams = [];
  const { first: topInfluence, second: secondInfluence } = pickTopInfluenceSettlements(activeSettlements);

  for (const settlement of activeSettlements) {
    const migrationIn = settlement.migrationIn ?? 0;
    const migrationOut = settlement.migrationOut ?? 0;
    const netOut = migrationOut - migrationIn;
    const netIn = migrationIn - migrationOut;

    if (netOut > threshold && topInfluence && topInfluence.id !== settlement.id) {
      const from = settlementCenter(settlement);
      const to = settlementCenter(topInfluence);
      const vec = normalizeVector(to.x - from.x, to.y - from.y);
      streams.push({
        fromSettlementId: settlement.id,
        toSettlementId: topInfluence.id,
        intensity: clamp(netOut / Math.max(12, settlement.population || 1), 0.08, 1),
        directionVector: vec
      });
    }

    if (netIn > threshold && secondInfluence && secondInfluence.id !== settlement.id) {
      const from = settlementCenter(secondInfluence);
      const to = settlementCenter(settlement);
      const vec = normalizeVector(to.x - from.x, to.y - from.y);
      streams.push({
        fromSettlementId: secondInfluence.id,
        toSettlementId: settlement.id,
        intensity: clamp(netIn / Math.max(12, settlement.population || 1), 0.08, 1),
        directionVector: vec
      });
    }
  }

  return streams;
}

function buildCivVisualSignatures(civilizations, settlements) {
  const agg = new Map();
  for (const settlement of settlements) {
    if (!isSettlementActive(settlement)) {
      continue;
    }
    if (!settlement.civId) {
      continue;
    }
    if (!agg.has(settlement.civId)) {
      agg.set(settlement.civId, {
        count: 0,
        conflictRate: 0,
        tradeConsistency: 0,
        stability: 0
      });
    }
    const row = agg.get(settlement.civId);
    row.count += 1;
    row.conflictRate += settlement.conflictRate ?? 0;
    row.tradeConsistency += settlement.tradeConsistency ?? 0;
    row.stability += settlement.stability ?? settlement.stabilityScore ?? 0;
  }

  const out = {};
  for (const civ of civilizations) {
    const row = agg.get(civ.id);
    if (!row || row.count === 0) {
      out[civ.id] = { warmth: 0.5, saturationShift: 0, brightnessShift: 0 };
      continue;
    }

    const conflictRate = row.conflictRate / row.count;
    const tradeConsistency = row.tradeConsistency / row.count;
    const stability = row.stability / row.count;

    const warmth = clamp(0.45 + conflictRate * 0.55 - tradeConsistency * 0.28, 0, 1);
    const saturationShift = clamp(conflictRate * 0.24 - tradeConsistency * 0.2, -0.22, 0.28);
    const brightnessShift = clamp((stability - 0.5) * 0.42, -0.22, 0.28);

    out[civ.id] = { warmth, saturationShift, brightnessShift };
  }
  return out;
}

module.exports = {
  buildSettlementVisualSignals,
  buildMigrationStreams,
  buildInfluenceAura,
  buildCivVisualSignatures
};

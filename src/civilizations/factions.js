function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function lerp(from, to, alpha) {
  return from + (to - from) * alpha;
}

function stableUnit(id, salt = 0) {
  const str = `${id || "civ"}:${salt}`;
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (hash % 10000) / 9999;
}

function buildFaction(civId, index) {
  const base = stableUnit(civId, 100 + index * 13);
  return {
    id: `${civId}-F${index + 1}`,
    ideology: {
      trade: clamp(stableUnit(civId, 110 + index * 11) * 2 - 1, -1, 1),
      hawkish: clamp(stableUnit(civId, 111 + index * 11) * 2 - 1, -1, 1),
      collectivist: clamp(stableUnit(civId, 112 + index * 11) * 2 - 1, -1, 1),
      openness: clamp(stableUnit(civId, 113 + index * 11) * 2 - 1, -1, 1)
    },
    powerShare: base,
    momentum: 0
  };
}

function ensureCivilizationFactions(civilization) {
  if (!Array.isArray(civilization.factions) || !civilization.factions.length) {
    const count = 2 + Math.floor(stableUnit(civilization.id, 90) * 3);
    civilization.factions = [];
    for (let i = 0; i < count; i += 1) {
      civilization.factions.push(buildFaction(civilization.id, i));
    }
  }

  let sum = civilization.factions.reduce((acc, f) => acc + (f.powerShare || 0), 0);
  if (sum <= 1e-9) {
    const equal = 1 / civilization.factions.length;
    for (const faction of civilization.factions) {
      faction.powerShare = equal;
    }
    sum = 1;
  }
  for (const faction of civilization.factions) {
    faction.powerShare = clamp01((faction.powerShare || 0) / sum);
    faction.momentum = clamp(faction.momentum || 0, -1, 1);
  }

  if (!civilization.institutionLevers) {
    civilization.institutionLevers = {
      conscription: 0.5,
      tariffRate: 0.5,
      borderOpenness: 0.5,
      welfareSpend: 0.5
    };
  } else {
    civilization.institutionLevers.conscription = clamp01(civilization.institutionLevers.conscription ?? 0.5);
    civilization.institutionLevers.tariffRate = clamp01(civilization.institutionLevers.tariffRate ?? 0.5);
    civilization.institutionLevers.borderOpenness = clamp01(civilization.institutionLevers.borderOpenness ?? 0.5);
    civilization.institutionLevers.welfareSpend = clamp01(civilization.institutionLevers.welfareSpend ?? 0.5);
  }
}

function aggregateMetricsForCiv(civilization, settlementsById) {
  const rows = (civilization.settlementIds || [])
    .map((id) => settlementsById.get(id))
    .filter(Boolean);

  if (!rows.length) {
    return {
      tradeSuccess: 0,
      conflictRate: 0,
      pressure: 0,
      stability: 0,
      legitimacyStress: 0,
      frontierRate: 0,
      growth: 0,
      externalPressure: 0
    };
  }

  const mean = (fn) => rows.reduce((acc, s) => acc + fn(s), 0) / rows.length;
  return {
    tradeSuccess: mean((s) => clamp((s.tradeConsistency || 0) * 0.65 + (s.tradeFlowNorm || 0) * 0.35, 0, 1)),
    conflictRate: mean((s) => clamp(s.conflictRate || 0, 0, 1)),
    pressure: mean((s) => clamp(s.resourcePressure || 0, 0, 1)),
    stability: mean((s) => clamp(s.stability || s.stabilityScore || 0, 0, 1)),
    legitimacyStress: mean((s) => clamp(s.legitimacyStress || 0, 0, 1)),
    frontierRate: mean((s) => clamp((s.frontierPressure || 0) * 0.65 + Math.max(0, s.growthRate || 0) * 6, 0, 1)),
    growth: mean((s) => s.growthRate || 0),
    externalPressure: mean((s) => {
      const regional = s.regionalInfluence || {};
      const internal = regional.internalInfluence || 0;
      const external = regional.externalInfluence || 0;
      return clamp(external / Math.max(1e-6, internal + external), 0, 1);
    })
  };
}

function normalizeFactionPower(factions) {
  const sum = factions.reduce((acc, f) => acc + (f.powerShare || 0), 0);
  if (sum <= 1e-9) {
    const equal = 1 / Math.max(1, factions.length);
    for (const faction of factions) {
      faction.powerShare = equal;
    }
    return;
  }
  for (const faction of factions) {
    faction.powerShare = clamp01((faction.powerShare || 0) / sum);
  }
}

function updateCivilizationFactions(civilizations, settlements, tick, options = {}) {
  const interval = options.interval ?? 240;
  if (tick % interval !== 0) {
    for (const civ of civilizations) {
      ensureCivilizationFactions(civ);
    }
    return;
  }

  const policyBlendAlpha = options.policyBlendAlpha ?? 0.06;
  const factionAlpha = options.factionAlpha ?? 0.12;
  const settlementsById = new Map(settlements.map((s) => [s.id, s]));

  for (const civ of civilizations) {
    ensureCivilizationFactions(civ);
    const metrics = aggregateMetricsForCiv(civ, settlementsById);
    const factions = civ.factions;

    let tensionNumerator = 0;
    const desired = [];
    for (const faction of factions) {
      const ide = faction.ideology || {};
      const tradeAxis = ide.trade || 0;
      const hawkAxis = ide.hawkish || 0;
      const collectivistAxis = ide.collectivist || 0;
      const openAxis = ide.openness || 0;

      const tradeFit = tradeAxis * (metrics.tradeSuccess - metrics.conflictRate * 0.4);
      const securityFit = hawkAxis * (metrics.conflictRate * 0.72 + metrics.externalPressure * 0.28);
      const welfareFit = collectivistAxis * (metrics.legitimacyStress * 0.6 + (1 - metrics.stability) * 0.4);
      const opennessFit = openAxis * (metrics.tradeSuccess * 0.7 - metrics.externalPressure * 0.5);
      const frontierFit = hawkAxis * metrics.frontierRate * 0.45;
      const netFit = clamp(
        0.5 + tradeFit * 0.15 + securityFit * 0.17 + welfareFit * 0.16 + opennessFit * 0.12 + frontierFit * 0.1,
        0.04,
        0.96
      );
      desired.push(netFit);
    }

    const desiredSum = desired.reduce((acc, v) => acc + v, 0);
    for (let i = 0; i < factions.length; i += 1) {
      const faction = factions[i];
      const nextShare = desiredSum > 1e-9 ? desired[i] / desiredSum : (1 / factions.length);
      faction.powerShare = clamp01(lerp(faction.powerShare || 0, nextShare, factionAlpha));
      faction.momentum = clamp(
        lerp(faction.momentum || 0, nextShare - (faction.powerShare || 0), 0.22),
        -1,
        1
      );
    }
    normalizeFactionPower(factions);

    let rationingPush = 0;
    let tradePush = 0;
    let expansionPush = 0;
    let welfarePush = 0;
    let conscriptionPush = 0;
    let tariffPush = 0;
    let borderPush = 0;
    for (const faction of factions) {
      const p = faction.powerShare || 0;
      const ide = faction.ideology || {};
      const tradeAxis = ide.trade || 0;
      const hawkAxis = ide.hawkish || 0;
      const collectivistAxis = ide.collectivist || 0;
      const openAxis = ide.openness || 0;

      rationingPush += p * (
        collectivistAxis * 0.2 +
        metrics.pressure * 0.45 +
        metrics.conflictRate * 0.2 -
        metrics.tradeSuccess * 0.15
      );
      tradePush += p * (tradeAxis * 0.32 + openAxis * 0.24 - hawkAxis * 0.14);
      expansionPush += p * (
        hawkAxis * 0.22 +
        metrics.frontierRate * 0.26 +
        Math.max(0, metrics.growth) * 2.8 * 0.14 -
        metrics.pressure * 0.16
      );
      welfarePush += p * (
        collectivistAxis * 0.32 +
        metrics.legitimacyStress * 0.28 +
        (1 - metrics.stability) * 0.2
      );

      conscriptionPush += p * (hawkAxis * 0.45 + metrics.conflictRate * 0.25 + metrics.externalPressure * 0.2);
      tariffPush += p * ((-openAxis) * 0.35 + metrics.externalPressure * 0.24 - metrics.tradeSuccess * 0.18);
      borderPush += p * (openAxis * 0.4 - hawkAxis * 0.22 - metrics.externalPressure * 0.18);

      tensionNumerator += Math.abs(tradeAxis - openAxis) * p + Math.abs(hawkAxis - collectivistAxis) * p;
    }

    if (civ.policy) {
      civ.policy.rationing = clamp01(lerp(civ.policy.rationing, clamp01(0.5 + rationingPush * 0.18), policyBlendAlpha));
      civ.policy.tradeOpenness = clamp01(lerp(civ.policy.tradeOpenness, clamp01(0.5 + tradePush * 0.22), policyBlendAlpha));
      civ.policy.expansionism = clamp01(lerp(civ.policy.expansionism, clamp01(0.5 + expansionPush * 0.21), policyBlendAlpha));
      civ.policy.welfare = clamp01(lerp(civ.policy.welfare, clamp01(0.5 + welfarePush * 0.2), policyBlendAlpha));
    }

    civ.institutionLevers = civ.institutionLevers || {};
    civ.institutionLevers.conscription = clamp01(
      lerp(civ.institutionLevers.conscription ?? 0.5, clamp01(0.5 + conscriptionPush * 0.22), 0.08)
    );
    civ.institutionLevers.tariffRate = clamp01(
      lerp(civ.institutionLevers.tariffRate ?? 0.5, clamp01(0.5 + tariffPush * 0.2), 0.08)
    );
    civ.institutionLevers.borderOpenness = clamp01(
      lerp(civ.institutionLevers.borderOpenness ?? 0.5, clamp01(0.5 + borderPush * 0.22), 0.08)
    );
    civ.institutionLevers.welfareSpend = clamp01(
      lerp(civ.institutionLevers.welfareSpend ?? 0.5, clamp01(civ.policy?.welfare ?? 0.5), 0.08)
    );
    civ.factionTension = Number(clamp01(tensionNumerator).toFixed(4));
    civ.factionSummary = {
      tradePush: Number(tradePush.toFixed(4)),
      expansionPush: Number(expansionPush.toFixed(4)),
      welfarePush: Number(welfarePush.toFixed(4)),
      securityPush: Number(conscriptionPush.toFixed(4))
    };
  }
}

module.exports = {
  ensureCivilizationFactions,
  updateCivilizationFactions
};

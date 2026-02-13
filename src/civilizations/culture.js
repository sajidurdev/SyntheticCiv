function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const DEFAULT_CULTURE = Object.freeze({
  cooperationBias: 0,
  aggressionBias: 0,
  tradePreference: 0,
  expansionism: 0,
  stabilityFocus: 0
});

function ensureCulture(civilization) {
  if (!civilization.culture) {
    civilization.culture = { ...DEFAULT_CULTURE };
    return civilization.culture;
  }

  for (const key of Object.keys(DEFAULT_CULTURE)) {
    if (typeof civilization.culture[key] !== "number") {
      civilization.culture[key] = DEFAULT_CULTURE[key];
    }
    civilization.culture[key] = clamp(civilization.culture[key], -1, 1);
  }
  return civilization.culture;
}

function buildCivExperience(civilization, settlementsById) {
  const settlements = civilization.settlementIds
    .map((id) => settlementsById.get(id))
    .filter(Boolean);

  if (!settlements.length) {
    return {
      tradeSignal: 0,
      conflictRate: 0,
      stability: 0,
      tradeConsistency: 0,
      cooperationSignal: 0,
      expansionSignal: 0,
      instabilityIndex: 0
    };
  }

  const tradeFlowNorm = settlements.reduce((acc, s) => acc + (s.tradeFlowNorm || 0), 0) / settlements.length;
  const conflictRate = settlements.reduce((acc, s) => acc + (s.conflictRate || 0), 0) / settlements.length;
  const stability = settlements.reduce((acc, s) => acc + (s.stability || s.stabilityScore || 0), 0) / settlements.length;
  const tradeConsistency = settlements.reduce((acc, s) => acc + (s.tradeConsistency || 0), 0) / settlements.length;
  const growth = settlements.reduce((acc, s) => acc + (s.growthRate || 0), 0) / settlements.length;
  const legitimacyStress = settlements.reduce((acc, s) => acc + (s.legitimacyStress || 0), 0) / settlements.length;
  const pressure = settlements.reduce((acc, s) => acc + (s.resourcePressure || 0), 0) / settlements.length;
  const securityStress = settlements.reduce((acc, s) => acc + (s.securityStress || 0), 0) / settlements.length;
  const shockActivity = settlements.reduce((acc, s) => (
    acc + ((s.shockState && s.shockState.activeShock) ? 1 : 0)
  ), 0) / settlements.length;
  const warExhaustionProxy = clamp(
    conflictRate * 0.6 + securityStress * 0.4,
    0,
    1
  );
  const instabilityIndex = clamp(
    conflictRate * 0.3 +
      legitimacyStress * 0.22 +
      pressure * 0.2 +
      shockActivity * 0.18 +
      warExhaustionProxy * 0.1,
    0,
    1
  );
  const migrationNet = settlements.reduce(
    (acc, s) => acc + ((s.migrationOut || 0) - (s.migrationIn || 0)),
    0
  );

  return {
    tradeSignal: clamp(tradeFlowNorm * 0.7 + tradeConsistency * 0.3, 0, 1),
    conflictRate,
    stability,
    tradeConsistency,
    cooperationSignal: clamp(stability - conflictRate, -1, 1),
    expansionSignal: clamp(growth * 12 + migrationNet * 0.0015, -1, 1),
    instabilityIndex
  };
}

function updateCultureWithExperience(culture, experience) {
  const baseReversion = 0.006;
  const reversion = clamp(baseReversion * (1 - (experience.instabilityIndex || 0)), 0.001, 0.008);
  for (const key of Object.keys(culture)) {
    culture[key] *= (1 - reversion);
  }

  culture.tradePreference += (experience.tradeSignal - 0.5) * 0.004;
  culture.aggressionBias += experience.conflictRate * 0.0015;
  culture.aggressionBias -= experience.stability * 0.001;
  culture.aggressionBias -= experience.tradeConsistency * 0.0008;
  culture.stabilityFocus += experience.stability * 0.001;

  culture.cooperationBias += experience.cooperationSignal * 0.005;
  culture.expansionism += experience.expansionSignal * 0.006;

  for (const key of Object.keys(culture)) {
    culture[key] = clamp(culture[key], -1, 1);
  }
}

function updateCivilizationCultures(civilizations, settlements) {
  const settlementsById = new Map(settlements.map((s) => [s.id, s]));
  for (const civilization of civilizations) {
    const culture = ensureCulture(civilization);
    const experience = buildCivExperience(civilization, settlementsById);
    updateCultureWithExperience(culture, experience);
  }
}

module.exports = {
  ensureCulture,
  updateCivilizationCultures,
  DEFAULT_CULTURE
};

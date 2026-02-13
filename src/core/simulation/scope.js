const { RollingCounter } = require("../../systems/rollingWindow");
const {
  updateSettlementMembership,
  computeSettlementMetrics,
  createSettlementWindows,
  hydrateSettlementWindows,
  serializeSettlementWindows
} = require("../../settlements/metrics");
const {
  computeInfluenceStrengths,
  scoreMoveWithInfluence,
  computeInfluenceSteering,
  computeTopInfluenceSources
} = require("../../systems/influenceField");
const {
  applyAgentEvent,
  decayAgentRelations,
  getSentiment,
  updateCivRelationsEMA,
  accumulateCivDelta,
  pairKey
} = require("../../systems/relations");
const { buildKeyframe } = require("../../core/persistence");
const {
  buildSettlementVisualSignals,
  buildMigrationStreams,
  buildInfluenceAura,
  buildCivVisualSignatures
} = require("../../systems/perception");
const {
  ensureCulture,
  updateCivilizationCultures
} = require("../../civilizations/culture");
const { classifySettlementRoles } = require("../../settlements/roles");
const {
  updateCivilizationStrategies,
  ensureStrategyModifiers,
  ensureCivilizationPolicy,
  ensurePolicyDrift,
  updateCivilizationPolicies,
  applyCivilizationPolicyEffects
} = require("../../civilizations/policy");
const { stepDemographics } = require("../../systems/demographics");
const { isSettlementActive, isSettlementRuined } = require("../../settlements/activity");
const { compressHistory } = require("../../systems/historyCompression");
const { economyStep, ensureSettlementEconomyState, defaultResources } = require("../../systems/economy");
const { ensureRegionalState, computeRegionalInfluence } = require("../../systems/regionalInfluence");
const { ensureInfluenceSaturationState, computeInfluenceSaturation } = require("../../systems/influenceSaturation");
const { ensureCivilizationFactions, updateCivilizationFactions } = require("../../civilizations/factions");
const { ensureSettlementInnovationState, stepInnovation } = require("../../systems/innovation");
const { ensureSettlementShockState, stepShockSystem } = require("../../systems/shocks");
const {
  ensureCivAlignment,
  createStrategicAlignmentState,
  serializeStrategicAlignmentState,
  computeStrategicAlignment,
  getPairDisposition
} = require("../../civilizations/alignment");
const {
  createEraHistoryState,
  hydrateEraHistoryState,
  serializeEraHistoryState,
  updateEraHistoryState,
  getEraHistorySnapshot
} = require("../../systems/eraHistory");

const RESOURCE_TYPES = ["food", "ore", "fiber"];
const STATE_SCHEMA_VERSION = 2;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function createPopulationCounterSet() {
  return {
    spawnedInit: 0,
    spawnedBirth: 0,
    spawnedOther: 0,
    despawnedDeath: 0,
    despawnedOther: 0
  };
}

function createBirthDiagnosticsWindow() {
  return {
    ticks: 0,
    settlementsConsidered: 0,
    populationConsidered: 0,
    expectedBirthsTotal: 0,
    expectedBirthsFromSettlementSum: 0,
    birthAttempts: 0,
    birthsSucceeded: 0,
    weightedBirthRateSum: 0,
    avgFactorsWeightedSum: {
      stabilityFactor: 0,
      pressureFactor: 0,
      conflictFactor: 0,
      tradeFactor: 0,
      foodFactor: 0,
      logisticLimiter: 0
    },
    suppressionWins: {
      stabilityFactor: 0,
      pressureFactor: 0,
      conflictFactor: 0,
      tradeFactor: 0,
      foodFactor: 0,
      logisticLimiter: 0
    },
    lastSettlementBreakdown: []
  };
}

function createDeathDiagnosticsWindow() {
  return {
    ticks: 0,
    settlementsConsidered: 0,
    populationConsidered: 0,
    expectedDeathsTotal: 0,
    expectedDeathsFromSettlementSum: 0,
    deathAttempts: 0,
    deathsApplied: 0,
    weightedDeathRateSum: 0,
    avgFactorsWeightedSum: {
      stress: 0,
      conflict: 0,
      pressure: 0,
      foodDeficitRatio: 0
    },
    lastSettlementBreakdown: []
  };
}

module.exports = {
  RollingCounter,
  updateSettlementMembership,
  computeSettlementMetrics,
  createSettlementWindows,
  hydrateSettlementWindows,
  serializeSettlementWindows,
  computeInfluenceStrengths,
  scoreMoveWithInfluence,
  computeInfluenceSteering,
  computeTopInfluenceSources,
  applyAgentEvent,
  decayAgentRelations,
  getSentiment,
  updateCivRelationsEMA,
  accumulateCivDelta,
  pairKey,
  buildKeyframe,
  buildSettlementVisualSignals,
  buildMigrationStreams,
  buildInfluenceAura,
  buildCivVisualSignatures,
  ensureCulture,
  updateCivilizationCultures,
  classifySettlementRoles,
  updateCivilizationStrategies,
  ensureStrategyModifiers,
  ensureCivilizationPolicy,
  ensurePolicyDrift,
  updateCivilizationPolicies,
  applyCivilizationPolicyEffects,
  stepDemographics,
  isSettlementActive,
  isSettlementRuined,
  compressHistory,
  economyStep,
  ensureSettlementEconomyState,
  defaultResources,
  ensureRegionalState,
  computeRegionalInfluence,
  ensureInfluenceSaturationState,
  computeInfluenceSaturation,
  ensureCivilizationFactions,
  updateCivilizationFactions,
  ensureSettlementInnovationState,
  stepInnovation,
  ensureSettlementShockState,
  stepShockSystem,
  ensureCivAlignment,
  createStrategicAlignmentState,
  serializeStrategicAlignmentState,
  computeStrategicAlignment,
  getPairDisposition,
  createEraHistoryState,
  hydrateEraHistoryState,
  serializeEraHistoryState,
  updateEraHistoryState,
  getEraHistorySnapshot,
  RESOURCE_TYPES,
  STATE_SCHEMA_VERSION,
  clamp,
  distSq,
  createPopulationCounterSet,
  createBirthDiagnosticsWindow,
  createDeathDiagnosticsWindow
};

const {
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
} = require("./scope");

const SettlementSimulationMethods = require("./methods/settlements");
const SystemSimulationMethods = require("./methods/systems");
const CivilizationSimulationMethods = require("./methods/civilizations");
const AgentSimulationMethods = require("./methods/agents");
const StateSimulationMethods = require("./methods/state");

class SeededRandom {
  constructor(seed, state = null) {
    this.seed = seed >>> 0;
    this.state = state == null ? this.seed : state >>> 0;
    if (this.state === 0) {
      this.state = 1;
    }
  }

  next() {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 4294967296;
  }

  getState() {
    return this.state >>> 0;
  }
}

class Simulation {
  constructor(config = {}, persistedPayload = null) {
    this.saveEveryTicks = config.saveEveryTicks || 500;
    this.detectInterval = config.detectInterval || 50;
    this.snapshotInterval = config.snapshotInterval || 2;
    this.keyframeInterval = config.keyframeInterval || 20;
    this.windowSize = config.windowSize || 2000;
    this.debugMetricsEnabled = config.debugMetricsEnabled === true;
    this.debugMetricsVerbose = config.debugMetricsVerbose === true;
    const configuredDebugEvery = Number(config.debugMetricsEvery);
    this.debugMetricsEvery = Number.isFinite(configuredDebugEvery)
      ? Math.max(1, Math.floor(configuredDebugEvery))
      : 1000;
    this.interactionBudgetPerAgent = config.interactionBudgetPerAgent || 12;
    this.interactionNeighborSampleCap = config.interactionNeighborSampleCap || 20;
    this.interactionGlobalPairScale = config.interactionGlobalPairScale || 0.8;
    this.conflictCooldownTicks = config.conflictCooldownTicks || 12;
    this.infoContactRadius = config.infoContactRadius || 2.2;
    this.interactionWeightEpsilon = config.interactionWeightEpsilon || 1e-5;
    this.interactionNoneWeightFloor = config.interactionNoneWeightFloor || 0.2;
    this.viabilityThreshold = config.viabilityThreshold || 20;
    this.policyUpdateInterval = config.policyUpdateInterval || 400;
    this.demographicsConfig = {
      maxAgents: config.maxAgents || 2000,
      perAgentNeed: config.perAgentNeed || 120,
      baseBirth: config.baseBirth || 0.0006,
      baseDeath: config.baseDeath || 0.000002,
      deathStressCoef: config.deathStressCoef || 0.00002,
      deathConflictCoef: config.deathConflictCoef || 0.000015,
      deathFoodCoef: config.deathFoodCoef || 0.00003,
      deathPressureCoef: config.deathPressureCoef || 0.00001,
      enableDeaths: config.enableDeaths !== false
    };
    this.economyConfig = {
      kFood: config.econKFood || 1.6,
      kMat: config.econKMat || 0.72,
      kWealth: config.econKWealth || 0.3,
      cFood: config.econCFood || 0.12,
      cMat: config.econCMat || 0.04,
      cWealth: config.econCWealth || 0.01,
      foodPerCapTarget: config.econFoodPerCapTarget || 8,
      matPerCapTarget: config.econMatPerCapTarget || 4.5,
      stressEmaAlpha: config.econStressEmaAlpha || 0.05,
      kTradeFood: config.econTradeFood || 0.95,
      kTradeMat: config.econTradeMaterials || 0.5,
      kTradeWealth: config.econTradeWealth || 0.3,
      maxTradeFoodPerRoute: config.econMaxTradeFoodPerRoute || 2.5,
      maxTradeMatPerRoute: config.econMaxTradeMatPerRoute || 1.4
    };
    this.fissionConfig = {
      pressureThreshold: config.fissionPressureThreshold || 0.8,
      minMembers: config.fissionMinMembers || 120,
      minStability: config.fissionMinStability || 0.2,
      highPressureTicksRequired: config.fissionPressureTicks || 400,
      parentCooldownTicks: config.fissionParentCooldown || 2000,
      childCooldownTicks: config.fissionChildCooldown || 3000,
      childSupportTicks: config.fissionChildSupportTicks || 900,
      childSupportStrength: config.fissionChildSupportStrength || 0.22,
      childStabilityFloor: config.fissionChildStabilityFloor || 0.42,
      splitFractionMin: config.fissionSplitFractionMin || 0.08,
      splitFractionMax: config.fissionSplitFractionMax || 0.12,
      splitMinAgents: config.fissionSplitMinAgents || 10,
      minParentAgentsAfterSplit: config.fissionParentMinAgents || 20
    };
    this.tradeDistanceConfig = {
      routeDistanceDecay: config.routeDistanceDecay || 42,
      routeMinReliability: config.routeMinReliability || 0.36,
      routeDistanceCostScale: config.routeDistanceCostScale || 0.012,
      targetDistanceDecay: config.tradeTargetDistanceDecay || 34
    };
    this.movementFrictionConfig = {
      stepCost: config.movementStepCost || 0.11,
      turnCost: config.movementTurnCost || 0.08,
      tradePullDistanceDecay: config.tradePullDistanceDecay || 36
    };
    this.logisticsConfig = {
      diplomacyDistanceScale: config.diplomacyDistanceScale || 48,
      projectionDistanceScale: config.projectionDistanceScale || 34,
      minProjectionFactor: config.minProjectionFactor || 0.45
    };
    this.beliefConfig = {
      observeRadius: config.beliefObserveRadius || 18,
      directAlpha: config.beliefDirectAlpha || 0.16,
      rumorAlpha: config.beliefRumorAlpha || 0.08,
      decayAlpha: config.beliefDecayAlpha || 0.01,
      noiseAmplitude: config.beliefNoiseAmplitude || 0.03,
      updateInterval: config.beliefUpdateInterval || 3
    };
    this.factionConfig = {
      interval: config.factionInterval || 240,
      policyBlendAlpha: config.factionPolicyBlendAlpha || 0.06,
      factionAlpha: config.factionPowerAlpha || 0.12
    };
    this.innovationConfig = {
      baseResearchRate: config.innovationBaseResearchRate || 0.0011,
      conflictDecayRate: config.innovationConflictDecayRate || 0.00045,
      routeDiffusionRate: config.innovationRouteDiffusionRate || 0.0022,
      localDiffusionRate: config.innovationLocalDiffusionRate || 0.0012,
      localDiffusionRadius: config.innovationLocalDiffusionRadius || 22
    };
    this.shockConfig = {
      evaluateInterval: config.shockEvaluateInterval || 20,
      baseIgnition: config.shockBaseIgnition || 0.02,
      riskThreshold: config.shockRiskThreshold || 0.46,
      minDuration: config.shockMinDuration || 260,
      maxDuration: config.shockMaxDuration || 820,
      cooldownTicks: config.shockCooldownTicks || 900
    };
    this.regionalInfluenceConfig = {
      influenceScale: config.regionalInfluenceScale || 4.2,
      falloffFactor: config.regionalFalloffFactor || 0.003,
      maxTradeForInfluence: config.regionalMaxTrade || 120,
      maxEnergyForInfluence: config.regionalMaxEnergy || 120,
      stabilityDecayRate: config.regionalStabilityDecayRate || 0.02,
      cohesionBonus: config.regionalCohesionBonus || 0.012,
      growthConflictRate: config.regionalGrowthConflictRate || 0.015,
      growthCohesionBonus: config.regionalGrowthCohesionBonus || 0.008,
      driftThreshold: config.regionalDriftThreshold || 1.28,
      driftRate: config.regionalDriftRate || 0.012,
      driftDecay: config.regionalDriftDecay || 0.0035,
      civTensionRate: config.regionalCivTensionRate || 0.008
    };
    this.influenceSaturationConfig = {
      radiusScale: config.saturationRadiusScale || 4.1,
      densityRadiusMultiplier: config.saturationDensityRadiusMultiplier || 2.1,
      falloffFactor: config.saturationFalloffFactor || 0.0032,
      densityThreshold: config.saturationDensityThreshold || 95,
      thresholdBand: config.saturationThresholdBand || 85,
      saturationGrowthPenalty: config.saturationGrowthPenalty || 0.34,
      saturationInstabilityFactor: config.saturationInstabilityFactor || 0.016,
      saturationSplitBonus: config.saturationSplitBonus || 0.2,
      outwardTradeSpreadFactor: config.saturationOutwardTradeSpreadFactor || 0.18,
      maxTradeForInfluence: config.regionalMaxTrade || 120,
      maxEnergyForInfluence: config.regionalMaxEnergy || 120
    };
    this.tradeMomentumConfig = {
      successWeight: config.routeMomentumSuccessWeight || 0.07,
      decayPerTick: config.routeMomentumDecayPerTick || 0.9994,
      conflictDecay: config.routeMomentumConflictDecay || 0.08,
      instabilityDecayRate: config.routeMomentumInstabilityDecayRate || 0.012,
      momentumMultiplier: config.routeMomentumMultiplier || 0.9,
      volumeScale: config.routeMomentumVolumeScale || 0.22,
      maxMomentum: config.routeMomentumMax || 4.5,
      pruneAfterIdleTicks: config.routeMomentumPruneAfterIdleTicks || (this.windowSize * 2)
    };
    this.influenceConfig = {
      sigma: config.influenceSigma || 120,
      closestK: config.influenceClosestK || 3,
      strengthEma: config.influenceStrengthEma || 0.05,
      movementGain: config.influenceGain || 0.04,
      maxAccelPerTick: config.influenceMaxAccelPerTick || 0.06,
      velocityDecay: config.influenceVelocityDecay || 0.9,
      maxVelocity: config.influenceMaxVelocity || 0.55,
      directionalWeight: config.influenceDirectionalWeight || 1.35,
      interactionBiasEnabled: config.influenceInteractionBias !== false,
      sameZoneTradeBonus: config.influenceSameZoneTradeBonus || 0.03,
      sameZoneCooperateBonus: config.influenceSameZoneCooperateBonus || 0.03,
      sameZoneConflictPenalty: config.influenceSameZoneConflictPenalty || 0.04,
      frontierThreshold: config.frontierThreshold || 0.5,
      frontierConflictBias: config.frontierConflictBias || 0.03,
      frontierCooperateBias: config.frontierCooperateBias || 0.02,
      frontierTradeBias: config.frontierTradeBias || 0.01
    };
    this.alignmentConfig = {
      interval: config.alignmentInterval || 200,
      alignedThreshold: config.alignedThreshold || 0.7,
      hostileRelationThreshold: config.hostileRelationThreshold || -0.8,
      hostileSustainTicks: config.hostileSustainTicks || 600
    };
    this.eraConfig = {
      evaluationInterval: config.eraEvaluationInterval || 240,
      historyLimit: config.eraHistoryLimit || 160,
      milestoneLimit: config.eraMilestoneLimit || 220,
      minEraDuration: config.eraMinDuration || 540,
      shortWindowLongOffset: config.eraShortWindowLongOffset || 6,
      longWindowOffset: config.eraLongWindowOffset || 12,
      longWindowBuffer: config.eraLongWindowBuffer || 12,
      saturationSpikeLevel: config.eraSaturationSpikeLevel || 0.72,
      saturationSpikeDelta: config.eraSaturationSpikeDelta || 0.09,
      saturationPlateauLevel: config.eraSaturationPlateauLevel || 0.8,
      saturationPlateauSustain: config.eraSaturationPlateauSustain || 6,
      borderWarConflictLevel: config.eraBorderWarConflictLevel || 0.7,
      highPressurePlateauLevel: config.eraHighPressurePlateauLevel || 0.6,
      slowAttritionGrowthLevel: config.eraSlowAttritionGrowthLevel || -0.001,
      plateauSustainCount: config.eraPlateauSustainCount || 6,
      collapseStabilityLevel: config.eraCollapseStabilityLevel || 0.35,
      collapseStabilityDelta: config.eraCollapseStabilityDelta || 0.06,
      collapseLongStabilityDelta: config.eraCollapseLongStabilityDelta || 0.1,
      collapseConflictLongRise: config.eraCollapseConflictLongRise || 0.1,
      pressureCrisisLevel: config.eraPressureCrisisLevel || 0.68,
      expansionSettlementDelta: config.eraExpansionSettlementDelta || 2,
      expansionTradeDelta: config.eraExpansionTradeDelta || 0.18,
      expansionLongSettlementDelta: config.eraExpansionLongSettlementDelta || 2,
      expansionLongTradeGrowth: config.eraExpansionLongTradeGrowth || 0.08,
      emergenceSettlementDelta: config.eraEmergenceSettlementDelta || 1,
      diplomacyShiftDelta: config.eraDiplomacyShiftDelta || 0.15,
      diplomacyLongShiftDelta: config.eraDiplomacyLongShiftDelta || 0.18,
      diplomacyShortSustainDelta: config.eraDiplomacyShortSustainDelta || 0.06,
      diplomacyShortSustainCount: config.eraDiplomacyShortSustainCount || 3,
      stabilizationStabilityMin: config.eraStabilizationStabilityMin || 0.58,
      stabilizationPressureMax: config.eraStabilizationPressureMax || 0.52,
      stabilizationSaturationMax: config.eraStabilizationSaturationMax || 0.58,
      milestoneMinInterval: config.eraMilestoneMinInterval || 1200,
      milestoneMaxInterval: config.eraMilestoneMaxInterval || 2400,
      milestoneDiplomacyLongDelta: config.eraMilestoneDiplomacyLongDelta || 0.14,
      milestoneStabilityLongDelta: config.eraMilestoneStabilityLongDelta || 0.08,
      milestoneTradeFlowLongDelta: config.eraMilestoneTradeFlowLongDelta || 0.1,
      milestoneSaturationLongDelta: config.eraMilestoneSaturationLongDelta || 0.1,
      milestoneSettlementLongDelta: config.eraMilestoneSettlementLongDelta || 2,
      milestoneConflictLongDelta: config.eraMilestoneConflictLongDelta || 0.08,
      dedupeStabilityEpsilon: config.eraDedupeStabilityEpsilon || 0.02,
      dedupeSaturationEpsilon: config.eraDedupeSaturationEpsilon || 0.02,
      dedupeDiplomacyEpsilon: config.eraDedupeDiplomacyEpsilon || 0.03,
      dedupeTradeNormEpsilon: config.eraDedupeTradeNormEpsilon || 0.08
    };
    this.events = [];
    this.recentEvents = [];
    this.tradeEvents = [];
    this.maxRecentEvents = 500;
    this.maxTradeEvents = 5000;

    this.history = [];
    this.maxHistory = 500;
    this.keyframes = [];
    this.maxKeyframes = 60;
    this.latestSnapshot = null;

    this.spatialCellSize = 6;
    this.interactionRadius = 5;
    this.spatialHash = new Map();
    this.contactCooldown = new Map();
    this.conflictCooldown = new Map();

    this.agentSettlement = new Map();
    this.previousAgentSettlement = new Map();
    this.agentDominantInfluence = new Map();
    this.frontierContactCount = new RollingCounter(this.windowSize);
    this.frontierConflictCount = new RollingCounter(this.windowSize);
    this.civBorderWindows = new Map();
    this.membersBySettlementId = new Map();
    this.wildAgentIds = [];
    this.settlementRadiusMultiplier = 1;
    this.settlementToCiv = new Map();
    this.influenceBySettlement = new Map();
    this.influenceFieldState = { tradeFlowCap: null };
    this.conflictSensitivityBySettlement = new Map();
    this.tradeOpennessBySettlement = new Map();
    this.tariffRateBySettlement = new Map();
    this.borderOpennessBySettlement = new Map();
    this.conscriptionBySettlement = new Map();
    this.welfareSpendBySettlement = new Map();
    this.diplomacyFrictionReliefBySettlement = new Map();
    this.expansionFissionBoostBySettlement = new Map();
    this.policyByCivId = new Map();
    this.regionalCivDeltas = new Map();
    this.regionalInfluenceBySettlement = new Map();
    this.regionalTradeBiasBySettlement = new Map();
    this.saturationBySettlement = new Map();
    this.saturationFissionBonusBySettlement = new Map();
    this.saturationTradeSpreadBySettlement = new Map();
    this.routeMemory = new Map();

    this.settlementWindowsById = new Map();
    this.pairTradeWindows = new Map();
    this.pairInfoWindows = new Map();
    this.civEventDeltas = new Map();

    this.civRelations = {};
    this.civilizations = [];
    this.settlements = [];
    this.nextSettlementId = 1;
    this.nextCivId = 1;
    this.nextAgentId = 1;
    this.lastDemographics = null;
    this.eraState = createEraHistoryState(this.eraConfig);
    this.strategicAlignmentState = createStrategicAlignmentState();
    this.pendingAlignmentEffectsBySettlement = new Map();
    this.settlementBeliefs = new Map();
    this.lastInteractionDiagnostics = {
      consideredPairs: 0,
      processedPairs: 0,
      seenDedupSkips: 0,
      budgetSkips: 0,
      globalCapSkips: 0,
      globalPairCap: 0,
      avgNearbySampled: 0
    };
    this.birthReservoir = new Map();
    this.deathReservoir = new Map();
    this.populationCounters = createPopulationCounterSet();
    this.populationCounterTotals = createPopulationCounterSet();
    this.birthDiagnosticsWindow = createBirthDiagnosticsWindow();
    this.deathDiagnosticsWindow = createDeathDiagnosticsWindow();
    this.agentsAtLastDebug = 0;
    this.lastPolicyTickApplied = -1;

    this.pendingSave = false;

    if (
      persistedPayload &&
      persistedPayload.version === STATE_SCHEMA_VERSION &&
      persistedPayload.state?.schemaVersion === STATE_SCHEMA_VERSION &&
      persistedPayload.state
    ) {
      this.hydrateFromPersistence(persistedPayload);
    } else {
      if (persistedPayload && persistedPayload.version !== STATE_SCHEMA_VERSION) {
        console.warn(
          `Ignoring persisted payload with schema version ${persistedPayload.version}; expected ${STATE_SCHEMA_VERSION}.`
        );
      } else if (persistedPayload && persistedPayload.state?.schemaVersion !== STATE_SCHEMA_VERSION) {
        console.warn(
          `Ignoring persisted state schema ${persistedPayload?.state?.schemaVersion}; expected ${STATE_SCHEMA_VERSION}.`
        );
      }
      this.initializeNewState(config);
    }

    this.rebuildSpatialHash();
    this.agentsAtLastDebug = this.agents.length;
    this.resetPopulationCountersWindow();
    if (!this.latestSnapshot) {
      this.captureSnapshot();
    }
  }


  initializeNewState(config = {}) {
    this.width = config.width || 96;
    this.height = config.height || 96;
    this.agentCount = config.agentCount || 200;
    this.tick = 0;

    this.seed = typeof config.seed === "number" ? config.seed : (Date.now() & 0xffffffff);
    this.random = new SeededRandom(this.seed);

    this.grid = this.createWorldGrid();
    this.agents = this.createAgents(this.agentCount);
    this.incrementPopulationCounter("spawnedInit", this.agents.length);
    this.nextAgentId = this.agents.length + 1;

    this.detectSettlements();
    this.refreshMembership();
    this.computeSettlementMetricsForTick([]);
    this.updateSettlementFrontierPressure();
    this.updateCivilizations(true);
    this.runCivilizationPolicyStep();
    this.runRegionalInfluenceStep();
    this.runInfluenceSaturationStep();
    const initRoutes = this.buildTradeRoutes();
    this.runInnovationStep(initRoutes);
    this.updateRouteMomentumPressure();
    this.runEconomyStep(initRoutes);
    this.applyPostSplitSupport();
    this.updateSettlementStressAxes();
    this.refreshSettlementInfluence();
    this.updateSettlementBeliefs(true);
    this.updateAgentInfluenceContext(this.getActiveSettlements());
    this.eraState = createEraHistoryState(this.eraConfig);
    this.strategicAlignmentState = createStrategicAlignmentState();
    this.updateStrategicAlignment(true);
    this.updateEraHistory(true);
    this.captureKeyframe();
  }


  hydrateFromPersistence(payload) {
    const state = payload.state;
    this.width = state.width;
    this.height = state.height;
    this.agentCount = state.agentCount;
    this.tick = state.tick;

    this.seed = state.seed;
    this.random = new SeededRandom(this.seed, state.rngState);
    this.eraState = hydrateEraHistoryState(state.eraHistory, this.eraConfig);
    this.strategicAlignmentState = createStrategicAlignmentState(state.strategicAlignment);

    this.grid = state.grid;
    this.agents = (state.agents || []).map((agent) => ({
      ...agent,
      velocity: agent.velocity || { x: 0, y: 0 },
      morale: clamp(Number.isFinite(agent.morale) ? agent.morale : 0.5, 0, 1),
      warExhaustion: clamp(Number.isFinite(agent.warExhaustion) ? agent.warExhaustion : 0, 0, 1),
      contested: clamp(agent.contested || 0, 0, 1),
      influenceTopSettlementId: agent.influenceTopSettlementId || null,
      influenceSecondSettlementId: agent.influenceSecondSettlementId || null,
      relations: agent.relations || {}
    }));

    this.settlements = (state.settlements || []).map((s) => ({
      ...s,
      members: Array.isArray(s.members) ? s.members : [],
      isRuined: typeof s.isRuined === "boolean" ? s.isRuined : !isSettlementActive(s),
      highPressureTicks: Number.isFinite(s.highPressureTicks) ? s.highPressureTicks : 0,
      fissionCooldown: Number.isFinite(s.fissionCooldown) ? s.fissionCooldown : 0,
      frontierPressure: clamp(s.frontierPressure || 0, 0, 1),
      frontierPressureRaw: clamp(s.frontierPressureRaw || 0, 0, 1),
      prevConflictRate: clamp(s.prevConflictRate || s.conflictRate || 0, 0, 1),
      economicStress: clamp(s.economicStress || 0, 0, 1),
      securityStress: clamp(s.securityStress || 0, 0, 1),
      legitimacyStress: clamp(s.legitimacyStress || 0, 0, 1),
      socialStress: clamp(s.socialStress || 0, 0, 1),
      environmentStress: clamp(s.environmentStress || 0, 0, 1),
      compositeStress: clamp(s.compositeStress || 0, 0, 1),
      knowledge: s.knowledge ? { ...s.knowledge } : {
        farming: 0,
        medicine: 0,
        governance: 0,
        logistics: 0
      },
      knowledgeLevel: clamp(s.knowledgeLevel || 0, 0, 1),
      innovationEffects: s.innovationEffects ? { ...s.innovationEffects } : {
        foodProdMult: 1,
        materialProdMult: 1,
        wealthProdMult: 1,
        birthRateMult: 1,
        deathRiskMult: 1,
        legitimacyRelief: 0,
        tradeRangeMult: 1,
        tradeReliabilityBonus: 0,
        infoFlowBonus: 0,
        militarySupplyBonus: 0
      },
      shockState: s.shockState ? { ...s.shockState } : {
        cooldownTicks: 0,
        activeShock: null,
        risk: { famine: 0, rebellion: 0, epidemic: 0, crash: 0 }
      },
      shockEffects: s.shockEffects ? { ...s.shockEffects } : {
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
      },
      pressureAxes: s.pressureAxes
        ? {
          economicStress: clamp(s.pressureAxes.economicStress || s.economicStress || 0, 0, 1),
          securityStress: clamp(s.pressureAxes.securityStress || s.securityStress || 0, 0, 1),
          legitimacyStress: clamp(s.pressureAxes.legitimacyStress || s.legitimacyStress || 0, 0, 1),
          socialStress: clamp(s.pressureAxes.socialStress || s.socialStress || 0, 0, 1),
          environmentStress: clamp(s.pressureAxes.environmentStress || s.environmentStress || 0, 0, 1),
          compositeStress: clamp(s.pressureAxes.compositeStress || s.compositeStress || 0, 0, 1)
        }
        : {
          economicStress: clamp(s.economicStress || 0, 0, 1),
          securityStress: clamp(s.securityStress || 0, 0, 1),
          legitimacyStress: clamp(s.legitimacyStress || 0, 0, 1),
          socialStress: clamp(s.socialStress || 0, 0, 1),
          environmentStress: clamp(s.environmentStress || 0, 0, 1),
          compositeStress: clamp(s.compositeStress || 0, 0, 1)
        },
      postSplitProtectionUntil: Number.isFinite(s.postSplitProtectionUntil) ? s.postSplitProtectionUntil : 0,
      postSplitSupportTicks: Number.isFinite(s.postSplitSupportTicks) ? s.postSplitSupportTicks : 0,
      postSplitSupportStrength: Number.isFinite(s.postSplitSupportStrength) ? s.postSplitSupportStrength : 0,
      migrationInRate: clamp(s.migrationInRate || 0, 0, 1),
      migrationOutRate: clamp(s.migrationOutRate || 0, 0, 1),
      migrationNetRate: clamp(s.migrationNetRate || 0, -1, 1),
      center: s.center || s.centerPosition,
      centerPosition: s.centerPosition || s.center,
      influenceSaturation: s.influenceSaturation
        ? { ...s.influenceSaturation }
        : {
          localDensity: 0,
          saturationLevel: 0,
          growthPenaltyMult: 1,
          stabilityPenalty: 0,
          splitBonus: 0,
          outwardTradeSpread: 0
        }
    }));
    for (const settlement of this.settlements) {
      ensureSettlementEconomyState(settlement);
      ensureSettlementInnovationState(settlement);
      ensureSettlementShockState(settlement);
      ensureRegionalState(settlement);
      ensureInfluenceSaturationState(settlement);
    }
    this.civilizations = (state.civilizations || []).map((c) => {
      const civ = { ...c };
      ensureCulture(civ);
      ensureStrategyModifiers(civ);
      ensureCivilizationPolicy(civ);
      ensurePolicyDrift(civ);
      ensureCivilizationFactions(civ);
      ensureCivAlignment(civ);
      return civ;
    });
    this.civRelations = state.civRelations || {};
    this.nextSettlementId = state.nextSettlementId || 1;
    this.nextCivId = state.nextCivId || 1;
    this.nextAgentId = state.nextAgentId || ((this.agents.reduce((max, a) => Math.max(max, a.id || 0), 0)) + 1);

    this.agentSettlement = new Map(state.agentSettlement || []);
    this.previousAgentSettlement = new Map(state.previousAgentSettlement || []);
    this.settlementToCiv = new Map(state.settlementToCiv || []);

    this.settlementWindowsById = new Map();
    const serializedWindows = state.settlementWindows || {};
    for (const sid of Object.keys(serializedWindows)) {
      this.settlementWindowsById.set(
        sid,
        hydrateSettlementWindows(serializedWindows[sid], this.windowSize)
      );
    }

    this.pairTradeWindows = new Map();
    const serializedPairWindows = state.pairTradeWindows || {};
    for (const key of Object.keys(serializedPairWindows)) {
      this.pairTradeWindows.set(key, new RollingCounter(this.windowSize, serializedPairWindows[key]));
    }
    this.pairInfoWindows = new Map();
    const serializedInfoWindows = state.pairInfoWindows || {};
    for (const key of Object.keys(serializedInfoWindows)) {
      this.pairInfoWindows.set(key, new RollingCounter(this.windowSize, serializedInfoWindows[key]));
    }
    this.routeMemory = new Map();
    const serializedRouteMemory = state.routeMemory || {};
    for (const key of Object.keys(serializedRouteMemory)) {
      const row = serializedRouteMemory[key] || {};
      this.routeMemory.set(key, {
        routeMomentum: clamp(row.routeMomentum || 0, 0, this.tradeMomentumConfig.maxMomentum),
        routeAge: Math.max(0, Math.floor(row.routeAge || 0)),
        lastTradeTick: Number.isFinite(row.lastTradeTick) ? row.lastTradeTick : -1,
        lastUpdatedTick: Number.isFinite(row.lastUpdatedTick) ? row.lastUpdatedTick : this.tick
      });
    }
    this.birthReservoir = new Map();
    const serializedBirthReservoir = state.birthReservoir || {};
    for (const key of Object.keys(serializedBirthReservoir)) {
      const value = serializedBirthReservoir[key];
      if (!Number.isFinite(value)) continue;
      this.birthReservoir.set(key, Math.max(0, value));
    }
    this.deathReservoir = new Map();
    const serializedDeathReservoir = state.deathReservoir || {};
    for (const key of Object.keys(serializedDeathReservoir)) {
      const value = serializedDeathReservoir[key];
      if (!Number.isFinite(value)) continue;
      this.deathReservoir.set(key, Math.max(0, value));
    }
    this.settlementBeliefs = new Map();
    const serializedBeliefs = state.settlementBeliefs || {};
    for (const key of Object.keys(serializedBeliefs)) {
      const row = serializedBeliefs[key] || {};
      this.settlementBeliefs.set(key, {
        beliefFood: clamp(row.beliefFood || 0, 0, 1),
        beliefThreat: clamp(row.beliefThreat || 0, 0, 1),
        beliefStability: clamp(row.beliefStability || 0, 0, 1),
        beliefTradeReliability: clamp(row.beliefTradeReliability || 0, 0, 1),
        lastTick: Number.isFinite(row.lastTick) ? row.lastTick : this.tick
      });
    }

    this.frontierContactCount = new RollingCounter(
      this.windowSize,
      state.frontierEventWindows?.frontierContactCount || null
    );
    this.frontierConflictCount = new RollingCounter(
      this.windowSize,
      state.frontierEventWindows?.frontierConflictCount || null
    );
    this.civBorderWindows = new Map();
    const serializedCivBorder = state.civBorderWindows || {};
    for (const key of Object.keys(serializedCivBorder)) {
      const row = serializedCivBorder[key] || {};
      this.civBorderWindows.set(key, {
        contact: new RollingCounter(this.windowSize, row.contact || null),
        conflict: new RollingCounter(this.windowSize, row.conflict || null)
      });
    }

    this.tradeEvents = state.tradeEvents || [];
    this.recentEvents = payload.recentEvents || [];
    this.settlementRadiusMultiplier = state.settlementRadiusMultiplier || 1;
    this.influenceFieldState = state.influenceFieldState || { tradeFlowCap: null };
    this.conflictSensitivityBySettlement = new Map();
    this.tradeOpennessBySettlement = new Map();
    this.tariffRateBySettlement = new Map();
    this.borderOpennessBySettlement = new Map();
    this.conscriptionBySettlement = new Map();
    this.welfareSpendBySettlement = new Map();
    this.diplomacyFrictionReliefBySettlement = new Map();
    this.expansionFissionBoostBySettlement = new Map();
    this.policyByCivId = new Map();
    this.regionalCivDeltas = new Map();
    this.regionalInfluenceBySettlement = new Map();
    this.regionalTradeBiasBySettlement = new Map();
    this.saturationBySettlement = new Map();
    this.saturationFissionBonusBySettlement = new Map();
    this.saturationTradeSpreadBySettlement = new Map();
    this.agentDominantInfluence = new Map();

    this.keyframes = Array.isArray(payload.keyframes) ? payload.keyframes.slice(-this.maxKeyframes) : [];
    if (this.keyframes.length) {
      this.history = this.keyframes.map((k) => this.snapshotFromKeyframe(k));
    }

    this.refreshMembership();
    this.computeSettlementMetricsForTick([]);
    this.updateSettlementFrontierPressure();
    this.updateCivilizations(true);
    this.runCivilizationPolicyStep();
    this.runRegionalInfluenceStep();
    this.runInfluenceSaturationStep();
    const hydrateRoutes = this.buildTradeRoutes();
    this.runInnovationStep(hydrateRoutes);
    this.updateRouteMomentumPressure();
    this.runEconomyStep(hydrateRoutes);
    this.applyPostSplitSupport();
    this.updateSettlementStressAxes();
    this.refreshSettlementInfluence();
    this.updateSettlementBeliefs(true);
    this.updateAgentInfluenceContext(this.getActiveSettlements());
    this.updateStrategicAlignment(true);
    this.updateEraHistory(true);
    this.agentCount = this.agents.length;
    this.captureSnapshot();
  }


  nextRandom() {
    return this.random.next();
  }


  rand(min, max) {
    return min + this.nextRandom() * (max - min);
  }


  randomChoice(list) {
    return list[Math.floor(this.nextRandom() * list.length)];
  }


  incrementPopulationCounter(counterKey, delta) {
    const amount = Math.max(0, Math.floor(delta || 0));
    if (amount <= 0) return;
    if (!Object.prototype.hasOwnProperty.call(this.populationCounters, counterKey)) return;
    this.populationCounters[counterKey] += amount;
    this.populationCounterTotals[counterKey] += amount;
  }


  resetPopulationCountersWindow() {
    this.populationCounters = createPopulationCounterSet();
    this.birthDiagnosticsWindow = createBirthDiagnosticsWindow();
    this.deathDiagnosticsWindow = createDeathDiagnosticsWindow();
  }


  accumulateBirthDiagnosticsWindow(diag) {
    if (!diag) return;
    const win = this.birthDiagnosticsWindow;
    win.ticks += 1;
    win.settlementsConsidered += diag.settlementsConsidered || 0;
    win.populationConsidered += diag.populationConsidered || 0;
    win.expectedBirthsTotal += diag.expectedBirthsTotal || 0;
    win.expectedBirthsFromSettlementSum += diag.expectedBirthsFromSettlementSum || 0;
    win.birthAttempts += diag.birthAttempts || 0;
    win.birthsSucceeded += diag.birthsSucceeded || 0;
    win.weightedBirthRateSum += (diag.weightedBirthRate || 0) * (diag.populationConsidered || 0);
    const factors = diag.avgFactors || {};
    win.avgFactorsWeightedSum.stabilityFactor += (factors.stabilityFactor || 0) * (diag.populationConsidered || 0);
    win.avgFactorsWeightedSum.pressureFactor += (factors.pressureFactor || 0) * (diag.populationConsidered || 0);
    win.avgFactorsWeightedSum.conflictFactor += (factors.conflictFactor || 0) * (diag.populationConsidered || 0);
    win.avgFactorsWeightedSum.tradeFactor += (factors.tradeFactor || 0) * (diag.populationConsidered || 0);
    win.avgFactorsWeightedSum.foodFactor += (factors.foodFactor || 0) * (diag.populationConsidered || 0);
    win.avgFactorsWeightedSum.logisticLimiter += (factors.logisticLimiter || 0) * (diag.populationConsidered || 0);

    const suppression = diag.suppressionWins || {};
    win.suppressionWins.stabilityFactor += suppression.stabilityFactor || 0;
    win.suppressionWins.pressureFactor += suppression.pressureFactor || 0;
    win.suppressionWins.conflictFactor += suppression.conflictFactor || 0;
    win.suppressionWins.tradeFactor += suppression.tradeFactor || 0;
    win.suppressionWins.foodFactor += suppression.foodFactor || 0;
    win.suppressionWins.logisticLimiter += suppression.logisticLimiter || 0;
    win.lastSettlementBreakdown = Array.isArray(diag.settlementBreakdown) ? diag.settlementBreakdown : [];
  }


  accumulateDeathDiagnosticsWindow(diag) {
    if (!diag) return;
    const win = this.deathDiagnosticsWindow;
    win.ticks += 1;
    win.settlementsConsidered += diag.settlementsConsidered || 0;
    win.populationConsidered += diag.populationConsidered || 0;
    win.expectedDeathsTotal += diag.expectedDeathsTotal || 0;
    win.expectedDeathsFromSettlementSum += diag.expectedDeathsFromSettlementSum || 0;
    win.deathAttempts += diag.deathAttempts || 0;
    win.deathsApplied += diag.deathsApplied || 0;
    win.weightedDeathRateSum += (diag.weightedDeathRate || 0) * (diag.populationConsidered || 0);
    const factors = diag.avgFactors || {};
    win.avgFactorsWeightedSum.stress += (factors.stress || 0) * (diag.populationConsidered || 0);
    win.avgFactorsWeightedSum.conflict += (factors.conflict || 0) * (diag.populationConsidered || 0);
    win.avgFactorsWeightedSum.pressure += (factors.pressure || 0) * (diag.populationConsidered || 0);
    win.avgFactorsWeightedSum.foodDeficitRatio += (factors.foodDeficitRatio || 0) * (diag.populationConsidered || 0);
    win.lastSettlementBreakdown = Array.isArray(diag.settlementBreakdown) ? diag.settlementBreakdown : [];
  }


  step() {
    this.tick += 1;
    this.events = [];
    this.civEventDeltas = new Map();
    this.pendingAlignmentEffectsBySettlement.clear();

    this.updateResources();

    if (this.tick % this.detectInterval === 0) {
      this.detectSettlements();
    }

    for (const agent of this.agents) {
      decayAgentRelations(agent, this.tick);
    }

    this.rebuildSpatialHash();
    this.updateAgents();
    this.rebuildSpatialHash();

    const migrations = this.refreshMembership();
    this.handleInteractions();

    this.computeSettlementMetricsForTick(migrations);
    this.applyAlignmentSettlementEffects();
    this.updateSettlementFrontierPressure();
    this.runRegionalInfluenceStep();
    this.runInfluenceSaturationStep();
    const tradeRoutesTick = this.buildTradeRoutes();
    this.runInnovationStep(tradeRoutesTick);
    this.runShockStep(tradeRoutesTick);
    this.updateRouteMomentumPressure();
    this.runEconomyStep(tradeRoutesTick);
    this.applyPostSplitSupport();
    this.updateSettlementStressAxes();
    this.refreshSettlementInfluence();
    this.applySettlementFission();
    const demographics = this.runDemographicsStep();
    this.refreshSettlementInfluence();
    this.updateSettlementStressAxes();
    this.updateCivilizations(this.tick % this.detectInterval === 0);
    updateCivilizationCultures(this.civilizations, this.settlements);
    updateCivilizationStrategies(this.civilizations, this.settlements, this.tick, 100);
    this.runCivilizationPolicyStep();
    this.runRegionalInfluenceStep(false);
    this.runInfluenceSaturationStep(false);
    this.applyRegionalInfluenceDeltas();
    this.applyBorderTensionDeltas();
    this.updateSettlementStressAxes();
    this.updateSettlementBeliefs();

    updateCivRelationsEMA(this.civRelations, this.civEventDeltas, 0.05, {
      maxStep: 0.4,
      dt: 1
    });
    this.syncCivilizationMatrices();
    this.updateStrategicAlignment();
    this.updateEraHistory();
    this.agentCount = this.agents.length;
    this.logDiagnostics(demographics);

    if (this.tick % this.snapshotInterval === 0) {
      this.captureSnapshot();
    }
    if (this.tick % this.keyframeInterval === 0) {
      this.captureKeyframe();
    }
    if (this.tick % this.saveEveryTicks === 0) {
      this.pendingSave = true;
    }
  }


  exportState() {
    const pairTradeWindows = {};
    for (const [key, counter] of this.pairTradeWindows.entries()) {
      pairTradeWindows[key] = counter.toJSON();
    }
    const pairInfoWindows = {};
    for (const [key, counter] of this.pairInfoWindows.entries()) {
      pairInfoWindows[key] = counter.toJSON();
    }
    const routeMemory = {};
    for (const [key, entry] of this.routeMemory.entries()) {
      routeMemory[key] = {
        routeMomentum: entry.routeMomentum || 0,
        routeAge: entry.routeAge || 0,
        lastTradeTick: Number.isFinite(entry.lastTradeTick) ? entry.lastTradeTick : -1,
        lastUpdatedTick: Number.isFinite(entry.lastUpdatedTick) ? entry.lastUpdatedTick : this.tick
      };
    }
    const birthReservoir = {};
    for (const [sid, value] of this.birthReservoir.entries()) {
      if (!Number.isFinite(value) || value <= 0) continue;
      birthReservoir[sid] = Number(value.toFixed(6));
    }
    const deathReservoir = {};
    for (const [sid, value] of this.deathReservoir.entries()) {
      if (!Number.isFinite(value) || value <= 0) continue;
      deathReservoir[sid] = Number(value.toFixed(6));
    }
    const civBorderWindows = {};
    for (const [key, windows] of this.civBorderWindows.entries()) {
      civBorderWindows[key] = {
        contact: windows.contact.toJSON(),
        conflict: windows.conflict.toJSON()
      };
    }
    const settlementBeliefs = {};
    for (const [key, belief] of this.settlementBeliefs.entries()) {
      settlementBeliefs[key] = {
        beliefFood: clamp(belief.beliefFood || 0, 0, 1),
        beliefThreat: clamp(belief.beliefThreat || 0, 0, 1),
        beliefStability: clamp(belief.beliefStability || 0, 0, 1),
        beliefTradeReliability: clamp(belief.beliefTradeReliability || 0, 0, 1),
        lastTick: Number.isFinite(belief.lastTick) ? belief.lastTick : this.tick
      };
    }

    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      tick: this.tick,
      width: this.width,
      height: this.height,
      agentCount: this.agentCount,
      seed: this.seed,
      rngState: this.random.getState(),
      influenceFieldState: this.influenceFieldState,
      grid: this.grid,
      agents: this.agents,
      settlements: this.settlements.map((s) => ({
        id: s.id,
        civId: s.civId || null,
        center: s.center || s.centerPosition,
        centerPosition: s.centerPosition || s.center,
        members: Array.isArray(s.members) ? [...s.members] : [],
        population: s.population || 0,
        avgEnergy: s.avgEnergy || 0,
        tradeFlow: s.tradeFlow || s.tradeVolume || 0,
        tradeVolume: s.tradeFlow || s.tradeVolume || 0,
        conflictRate: s.conflictRate || 0,
        migrationIn: s.migrationIn || 0,
        migrationOut: s.migrationOut || 0,
        migrationInRate: s.migrationInRate || 0,
        migrationOutRate: s.migrationOutRate || 0,
        migrationNetRate: s.migrationNetRate || 0,
        resourcePressure: s.resourcePressure || 0,
        resources: s.resources
          ? {
            food: s.resources.food || 0,
            materials: s.resources.materials || 0,
            wealth: s.resources.wealth || 0
          }
          : defaultResources(s.population || 0),
        resourceEMA: s.resourceEMA
          ? {
            foodStress: s.resourceEMA.foodStress || 0,
            materialStress: s.resourceEMA.materialStress || 0
          }
          : { foodStress: 0, materialStress: 0 },
        birthMultiplier: s.birthMultiplier ?? 1,
        conflictSensitivity: s.conflictSensitivity || 0,
        economyMigrationPressure: s.economyMigrationPressure || 0,
        economicProfile: s.economicProfile || "Balanced",
        economicStress: s.economicStress || 0,
        securityStress: s.securityStress || 0,
        legitimacyStress: s.legitimacyStress || 0,
        socialStress: s.socialStress || 0,
        environmentStress: s.environmentStress || 0,
        compositeStress: s.compositeStress || 0,
        pressureAxes: s.pressureAxes
          ? { ...s.pressureAxes }
          : {
            economicStress: s.economicStress || 0,
            securityStress: s.securityStress || 0,
            legitimacyStress: s.legitimacyStress || 0,
            socialStress: s.socialStress || 0,
            environmentStress: s.environmentStress || 0,
            compositeStress: s.compositeStress || 0
          },
        foodPerCap: s.foodPerCap || 0,
        materialsPerCap: s.materialsPerCap || 0,
        wealthPerCap: s.wealthPerCap || 0,
        regionalInfluence: s.regionalInfluence
          ? { ...s.regionalInfluence }
          : {
            baseInfluence: 0,
            radius: 0,
            dominantCivId: s.civId || null,
            dominantInfluence: 0,
            internalInfluence: 0,
            externalInfluence: 0,
            conflictPressure: 0,
            cohesionPressure: 0,
            stabilityModifier: 0,
            growthModifier: 0,
            driftProgress: 0,
            driftTargetCivId: null,
            alignmentCivId: s.civId || null
          },
        influenceSaturation: s.influenceSaturation
          ? { ...s.influenceSaturation }
          : {
            localDensity: 0,
            saturationLevel: 0,
            growthPenaltyMult: 1,
            stabilityPenalty: 0,
            splitBonus: 0,
            outwardTradeSpread: 0
          },
        civAlignment: s.civAlignment ? { ...s.civAlignment } : {},
        frontierPressure: s.frontierPressure || 0,
        frontierPressureRaw: s.frontierPressureRaw || 0,
        stability: s.stability || s.stabilityScore || 0,
        stabilityScore: s.stability || s.stabilityScore || 0,
        growthRate: s.growthRate || 0,
        prevConflictRate: s.prevConflictRate || 0,
        influenceStrength: s.influenceStrength || 0,
        isRuined: typeof s.isRuined === "boolean" ? s.isRuined : isSettlementRuined(s),
        highPressureTicks: Number.isFinite(s.highPressureTicks) ? s.highPressureTicks : 0,
        fissionCooldown: Number.isFinite(s.fissionCooldown) ? s.fissionCooldown : 0,
        postSplitProtectionUntil: Number.isFinite(s.postSplitProtectionUntil) ? s.postSplitProtectionUntil : 0,
        postSplitSupportTicks: Number.isFinite(s.postSplitSupportTicks) ? s.postSplitSupportTicks : 0,
        postSplitSupportStrength: Number.isFinite(s.postSplitSupportStrength) ? s.postSplitSupportStrength : 0,
        tradeConsistency: s.tradeConsistency || 0,
        role: s.role || "General",
        roleInfluenceMultiplier: s.roleInfluenceMultiplier || 1
      })),
      civilizations: this.civilizations,
      civRelations: this.civRelations,
      strategicAlignment: serializeStrategicAlignmentState(this.strategicAlignmentState),
      nextSettlementId: this.nextSettlementId,
      nextCivId: this.nextCivId,
      nextAgentId: this.nextAgentId,
      agentSettlement: Array.from(this.agentSettlement.entries()),
      previousAgentSettlement: Array.from(this.previousAgentSettlement.entries()),
      settlementRadiusMultiplier: this.settlementRadiusMultiplier,
      settlementToCiv: Array.from(this.settlementToCiv.entries()),
      settlementWindows: serializeSettlementWindows(this.settlementWindowsById),
      pairTradeWindows,
      pairInfoWindows,
      routeMemory,
      birthReservoir,
      deathReservoir,
      civBorderWindows,
      settlementBeliefs,
      eraHistory: serializeEraHistoryState(this.eraState),
      frontierEventWindows: {
        frontierContactCount: this.frontierContactCount.toJSON(),
        frontierConflictCount: this.frontierConflictCount.toJSON()
      },
      tradeEvents: this.tradeEvents.slice(-this.maxTradeEvents),
      recentEvents: this.recentEvents.slice(-this.maxRecentEvents)
    };
  }


  consumePendingSaveFlag() {
    if (!this.pendingSave) {
      return false;
    }
    this.pendingSave = false;
    return true;
  }


  getStateSince(sinceTickRaw) {
    const parsed = Number(sinceTickRaw);
    const sinceTick = Number.isFinite(parsed) ? parsed : null;

    let snapshots;
    if (sinceTick === null) {
      snapshots = this.history.slice(-450);
    } else {
      snapshots = this.history.filter((s) => s.tick > sinceTick);
    }

    return {
      currentTick: this.tick,
      latestTick: this.latestSnapshot ? this.latestSnapshot.tick : this.tick,
      snapshots,
      eraHistory: this.getEraHistorySnapshot(160),
      recentEvents: this.recentEvents.slice(-120)
    };
  }
}

function attachPrototypeMethods(targetClass, sourceClass) {
  for (const name of Object.getOwnPropertyNames(sourceClass.prototype)) {
    if (name === "constructor") {
      continue;
    }
    Object.defineProperty(
      targetClass.prototype,
      name,
      Object.getOwnPropertyDescriptor(sourceClass.prototype, name)
    );
  }
}

for (const sourceClass of [
  SettlementSimulationMethods,
  SystemSimulationMethods,
  CivilizationSimulationMethods,
  AgentSimulationMethods,
  StateSimulationMethods
]) {
  attachPrototypeMethods(Simulation, sourceClass);
}

module.exports = Simulation;

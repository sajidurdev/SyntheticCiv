const {
  buildKeyframe,
  buildSettlementVisualSignals,
  buildMigrationStreams,
  buildInfluenceAura,
  buildCivVisualSignatures,
  isSettlementActive,
  isSettlementRuined,
  compressHistory,
  defaultResources,
  getEraHistorySnapshot,
  clamp
} = require("../scope");

class StateSimulationMethods {
  snapshotFromCurrent() {
    const settlementSnapshot = this.settlements.map((s) => {
      const center = s.center || s.centerPosition;
      const normalized = {
        id: s.id,
        civId: s.civId || null,
        center,
        centerPosition: center,
        members: Array.isArray(s.members) ? [...s.members] : [],
        population: s.population || 0,
        avgEnergy: s.avgEnergy || 0,
        tradeFlow: s.tradeFlow || 0,
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
            food: Number((s.resources.food || 0).toFixed(3)),
            materials: Number((s.resources.materials || 0).toFixed(3)),
            wealth: Number((s.resources.wealth || 0).toFixed(3))
          }
          : defaultResources(s.population || 0),
        resourceEMA: s.resourceEMA
          ? {
            foodStress: Number(((s.resourceEMA.foodStress || 0)).toFixed(4)),
            materialStress: Number(((s.resourceEMA.materialStress || 0)).toFixed(4))
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
        knowledge: s.knowledge ? { ...s.knowledge } : {
          farming: 0,
          medicine: 0,
          governance: 0,
          logistics: 0
        },
        knowledgeLevel: s.knowledgeLevel || 0,
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
        frontierPressure: s.frontierPressure || 0,
        frontierPressureRaw: s.frontierPressureRaw || 0,
        stability: s.stability || s.stabilityScore || 0,
        stabilityScore: s.stability || s.stabilityScore || 0,
        growthRate: s.growthRate || 0,
        influenceStrength: s.influenceStrength || 0,
        isRuined: typeof s.isRuined === "boolean" ? s.isRuined : isSettlementRuined(s),
        highPressureTicks: Number.isFinite(s.highPressureTicks) ? s.highPressureTicks : 0,
        fissionCooldown: Number.isFinite(s.fissionCooldown) ? s.fissionCooldown : 0,
        postSplitProtectionUntil: Number.isFinite(s.postSplitProtectionUntil) ? s.postSplitProtectionUntil : 0,
        postSplitSupportTicks: Number.isFinite(s.postSplitSupportTicks) ? s.postSplitSupportTicks : 0,
        postSplitSupportStrength: Number.isFinite(s.postSplitSupportStrength) ? s.postSplitSupportStrength : 0,
        role: s.role || "General",
        roleInfluenceMultiplier: s.roleInfluenceMultiplier || 1,
        tradeConsistency: s.tradeConsistency || 0,
        influenceCutoff: clamp(0.25 * Math.min(this.width, this.height), 18, 40)
      };
      normalized.visualSignals = buildSettlementVisualSignals(normalized, this.tick);
      normalized.visualState = normalized.visualSignals;
      normalized.aura = buildInfluenceAura(normalized);
      return normalized;
    });

    const activeSettlementSnapshot = settlementSnapshot.filter(isSettlementActive);
    const civVisualSignatures = buildCivVisualSignatures(this.civilizations, activeSettlementSnapshot);
    for (const settlement of settlementSnapshot) {
      settlement.civVisualSignature = settlement.civId
        ? civVisualSignatures[settlement.civId] || null
        : null;
    }

    const migrationStreams = buildMigrationStreams(activeSettlementSnapshot);

    return {
      tick: this.tick,
      world: { width: this.width, height: this.height },
      agents: this.agents.map((a) => ({
        id: a.id,
        position: { ...a.position },
        energy: Number(a.energy.toFixed(2)),
        morale: Number(((a.morale ?? 0.5)).toFixed(4)),
        warExhaustion: Number(((a.warExhaustion ?? 0)).toFixed(4)),
        currentAction: a.currentAction,
        settlementId: this.getAgentSettlementId(a.id),
        contested: Number((a.contested || 0).toFixed(4)),
        influenceTopSettlementId: a.influenceTopSettlementId || null,
        influenceSecondSettlementId: a.influenceSecondSettlementId || null
      })),
      settlements: settlementSnapshot,
      civilizations: this.civilizations.map((c) => ({
        id: c.id,
        settlementIds: [...c.settlementIds],
        influenceRadius: c.influenceRadius,
        centroid: { ...c.centroid },
        relationMatrix: { ...c.relationMatrix },
        culture: c.culture ? { ...c.culture } : undefined,
        strategyModifiers: c.strategyModifiers ? { ...c.strategyModifiers } : undefined,
        policy: c.policy ? { ...c.policy } : undefined,
        factions: Array.isArray(c.factions) ? c.factions.map((f) => ({
          id: f.id,
          ideology: { ...(f.ideology || {}) },
          powerShare: f.powerShare || 0,
          momentum: f.momentum || 0
        })) : undefined,
        institutionLevers: c.institutionLevers ? { ...c.institutionLevers } : undefined,
        factionTension: c.factionTension || 0,
        policyDrift: c.policyDrift ? { ...c.policyDrift } : undefined,
        policyInputs: c.policyInputs ? { ...c.policyInputs } : undefined,
        strategicAlignment: c.strategicAlignment ? { ...c.strategicAlignment } : undefined
      })),
      tradeRoutes: this.buildTradeRoutes(),
      migrationStreams,
      civVisualSignatures,
      diplomacyLines: this.buildDiplomacyLines(),
      eraHistory: this.getEraHistorySnapshot(120),
      events: this.recentEvents.slice(-60),
      stats: {
        interactionsThisTick: this.events.length,
        totalTradeEvents: this.tradeEvents.length,
        avgEnergy: this.getAverageEnergy(),
        wildPopulation: this.wildAgentIds.length,
        frontierContactRate: Number((this.frontierContactCount.sum() / Math.max(1, this.windowSize)).toFixed(4)),
        frontierConflictRate: Number((this.frontierConflictCount.sum() / Math.max(1, this.windowSize)).toFixed(4)),
        interactionPairsProcessed: this.lastInteractionDiagnostics?.processedPairs || 0,
        interactionPairsConsidered: this.lastInteractionDiagnostics?.consideredPairs || 0,
        interactionPairCap: this.lastInteractionDiagnostics?.globalPairCap || 0
      }
    };
  }


  snapshotFromKeyframe(keyframe) {
    const settlementSnapshot = (keyframe.settlements || []).map((s) => {
      const center = s.center || s.centerPosition;
      const normalized = {
        ...s,
        center,
        centerPosition: center,
        members: Array.isArray(s.members) ? [...s.members] : [],
        tradeFlow: s.tradeFlow ?? s.tradeVolume ?? 0,
        tradeVolume: s.tradeFlow ?? s.tradeVolume ?? 0,
        stability: s.stability ?? s.stabilityScore ?? 0,
        stabilityScore: s.stability ?? s.stabilityScore ?? 0,
        isRuined: typeof s.isRuined === "boolean" ? s.isRuined : (s.population || 0) <= 0,
        highPressureTicks: Number.isFinite(s.highPressureTicks) ? s.highPressureTicks : 0,
        fissionCooldown: Number.isFinite(s.fissionCooldown) ? s.fissionCooldown : 0,
        postSplitProtectionUntil: Number.isFinite(s.postSplitProtectionUntil) ? s.postSplitProtectionUntil : 0,
        postSplitSupportTicks: Number.isFinite(s.postSplitSupportTicks) ? s.postSplitSupportTicks : 0,
        postSplitSupportStrength: Number.isFinite(s.postSplitSupportStrength) ? s.postSplitSupportStrength : 0,
        role: s.role || "General",
        roleInfluenceMultiplier: s.roleInfluenceMultiplier || 1,
        frontierPressure: s.frontierPressure || 0,
        frontierPressureRaw: s.frontierPressureRaw || 0,
        resources: s.resources || defaultResources(s.population || 0),
        resourceEMA: s.resourceEMA || { foodStress: 0, materialStress: 0 },
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
        knowledgeLevel: s.knowledgeLevel || 0,
        knowledge: s.knowledge ? { ...s.knowledge } : {
          farming: 0,
          medicine: 0,
          governance: 0,
          logistics: 0
        },
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
        influenceCutoff: clamp(0.25 * Math.min(this.width, this.height), 18, 40)
      };
      normalized.visualSignals = buildSettlementVisualSignals(normalized, keyframe.tick);
      normalized.visualState = normalized.visualSignals;
      normalized.aura = buildInfluenceAura(normalized);
      return normalized;
    });

    const activeSettlementSnapshot = settlementSnapshot.filter(isSettlementActive);
    const civVisualSignatures = buildCivVisualSignatures(
      keyframe.civilizations || [],
      activeSettlementSnapshot
    );
    for (const settlement of settlementSnapshot) {
      settlement.civVisualSignature = settlement.civId
        ? civVisualSignatures[settlement.civId] || null
        : null;
    }

    const migrationStreams = buildMigrationStreams(activeSettlementSnapshot);

    return {
      tick: keyframe.tick,
      world: { width: this.width, height: this.height },
      agents: [],
      settlements: settlementSnapshot,
      civilizations: keyframe.civilizations || [],
      tradeRoutes: (keyframe.topTradeRoutes || []).map((r) => ({
        ...r,
        fromPosition: settlementSnapshot.find((s) => s.id === r.from)?.center || { x: 0, y: 0 },
        toPosition: settlementSnapshot.find((s) => s.id === r.to)?.center || { x: 0, y: 0 }
      })),
      migrationStreams,
      civVisualSignatures,
      diplomacyLines: [],
      eraHistory: keyframe.eraHistory || this.getEraHistorySnapshot(120),
      events: [],
      stats: keyframe.stats || {}
    };
  }


  captureSnapshot() {
    const snapshot = this.snapshotFromCurrent();
    this.latestSnapshot = snapshot;
    this.history.push(snapshot);
    compressHistory(this.history, {
      maxSnapshots: this.maxHistory,
      keepFull: 200,
      keepSettlementAverages: 200
    });
  }


  captureKeyframe() {
    const keyframe = buildKeyframe(this);
    this.keyframes.push(keyframe);
    if (this.keyframes.length > this.maxKeyframes) {
      this.keyframes.shift();
    }
  }


  getAverageEnergy() {
    if (!this.agents.length) return 0;
    const total = this.agents.reduce((acc, a) => acc + a.energy, 0);
    return Number((total / this.agents.length).toFixed(2));
  }
}

module.exports = StateSimulationMethods;

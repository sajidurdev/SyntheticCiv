const {
  RollingCounter,
  createSettlementWindows,
  accumulateCivDelta,
  ensureCulture,
  ensureStrategyModifiers,
  ensureCivilizationPolicy,
  ensurePolicyDrift,
  updateCivilizationPolicies,
  applyCivilizationPolicyEffects,
  isSettlementActive,
  defaultResources,
  ensureRegionalState,
  computeRegionalInfluence,
  ensureInfluenceSaturationState,
  computeInfluenceSaturation,
  ensureCivilizationFactions,
  updateCivilizationFactions,
  ensureCivAlignment,
  computeStrategicAlignment,
  getPairDisposition,
  updateEraHistoryState,
  getEraHistorySnapshot,
  clamp,
  distSq
} = require("../scope");

class CivilizationSimulationMethods {
  getCivPairKey(civA, civB) {
    if (!civA || !civB || civA === civB) {
      return null;
    }
    return civA < civB ? `${civA}|${civB}` : `${civB}|${civA}`;
  }


  ensureCivBorderWindow(civA, civB) {
    const key = this.getCivPairKey(civA, civB);
    if (!key) {
      return null;
    }
    if (!this.civBorderWindows.has(key)) {
      this.civBorderWindows.set(key, {
        contact: new RollingCounter(this.windowSize),
        conflict: new RollingCounter(this.windowSize)
      });
    }
    return this.civBorderWindows.get(key);
  }


  trackCivBorderEvent(agentA, agentB, eventType, frontierFactor) {
    if (frontierFactor <= this.influenceConfig.frontierThreshold) {
      return;
    }
    const topA = agentA.influenceTopSettlementId || null;
    const topB = agentB.influenceTopSettlementId || null;
    if (!topA || !topB) {
      return;
    }
    const settlementA = this.getSettlementById(topA);
    const settlementB = this.getSettlementById(topB);
    const civA = settlementA?.civId || null;
    const civB = settlementB?.civId || null;
    const window = this.ensureCivBorderWindow(civA, civB);
    if (!window) {
      return;
    }
    if (eventType === "contact") {
      window.contact.increment(this.tick, 1);
    } else if (eventType === "conflict") {
      window.contact.increment(this.tick, 1);
      window.conflict.increment(this.tick, 1);
    }
  }


  getSettlementMemberAgents(settlement) {
    const memberIds = this.membersBySettlementId.get(settlement.id) || settlement.members || [];
    const agentById = new Map(this.agents.map((agent) => [agent.id, agent]));
    return memberIds.map((id) => agentById.get(id)).filter(Boolean);
  }


  chooseFissionAgents(settlement) {
    const members = this.getSettlementMemberAgents(settlement);
    if (!members.length) {
      return [];
    }
    const center = settlement.center || settlement.centerPosition;
    const ranked = members
      .map((agent) => ({
        agent,
        dSq: distSq(agent.position, center)
      }))
      .sort((a, b) => b.dSq - a.dSq || a.agent.id - b.agent.id);

    const fraction = this.rand(
      this.fissionConfig.splitFractionMin,
      this.fissionConfig.splitFractionMax
    );
    const rawCount = Math.round(members.length * fraction);
    const maxSplit = Math.max(0, members.length - this.fissionConfig.minParentAgentsAfterSplit);
    const splitCount = clamp(
      rawCount,
      this.fissionConfig.splitMinAgents,
      maxSplit
    );
    if (splitCount < this.fissionConfig.splitMinAgents) {
      return [];
    }
    return ranked.slice(0, splitCount).map((row) => row.agent);
  }


  buildSettlementFromSplit(parent, splitAgents) {
    if (!splitAgents.length) {
      return null;
    }
    const id = `S${this.nextSettlementId++}`;
    const center = this.averagePosition(splitAgents);
    const childStability = clamp(
      Math.max((parent.stability || parent.stabilityScore || 0) * 0.8, this.fissionConfig.childStabilityFloor),
      0,
      1
    );
    const childAvgEnergy = Math.max(0, (parent.avgEnergy || 0) * 0.6);
    const childDefaults = defaultResources(splitAgents.length);
    const parentMarketPrices = parent.market?.prices || {};
    const supportStrength = clamp(this.fissionConfig.childSupportStrength || 0.22, 0, 0.4);
    const supportTicks = Math.max(1, Math.floor(this.fissionConfig.childSupportTicks || 900));
    const postSplitProtectionUntil = this.tick + supportTicks;
    return {
      id,
      civId: parent.civId || null,
      center,
      centerPosition: center,
      members: splitAgents.map((a) => a.id),
      population: splitAgents.length,
      isRuined: false,
      highPressureTicks: 0,
      fissionCooldown: this.fissionConfig.childCooldownTicks,
      tradeFlow: 0.5,
      tradeVolume: 0.5,
      stability: childStability,
      stabilityScore: childStability,
      avgEnergy: childAvgEnergy,
      energyLevel: childAvgEnergy,
      resourcePressure: 0,
      pressure: 0,
      conflictRate: 0,
      migrationIn: 0,
      migrationOut: 0,
      migrationInRate: 0,
      migrationOutRate: 0,
      migrationNetRate: 0,
      frontierPressure: 0,
      frontierPressureRaw: 0,
      growthRate: 0,
      resources: {
        food: childDefaults.food * (1 + supportStrength * 1.4),
        materials: childDefaults.materials * (1 + supportStrength),
        wealth: childDefaults.wealth * (1 + supportStrength * 0.8)
      },
      market: {
        prices: {
          food: Number.isFinite(parentMarketPrices.food) ? parentMarketPrices.food : 1,
          materials: Number.isFinite(parentMarketPrices.materials) ? parentMarketPrices.materials : 1,
          wealth: Number.isFinite(parentMarketPrices.wealth) ? parentMarketPrices.wealth : 1
        },
        volatility: Number.isFinite(parent.market?.volatility) ? parent.market.volatility : 0.03,
        lastUpdateTick: this.tick,
        tickObs: {
          attempts: { food: 0, materials: 0, wealth: 0 },
          failures: { food: 0, materials: 0, wealth: 0 },
          successObservedPriceSum: { food: 0, materials: 0, wealth: 0 },
          successObservedPriceCount: { food: 0, materials: 0, wealth: 0 }
        }
      },
      resourceEMA: { foodStress: 0, materialStress: 0 },
      birthMultiplier: clamp(0.9 + supportStrength * 0.3, 0.85, 1),
      conflictSensitivity: 0,
      economyMigrationPressure: 0,
      economicProfile: "Balanced",
      knowledge: {
        farming: 0,
        medicine: 0,
        governance: 0,
        logistics: 0
      },
      innovationEffects: {
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
      shockState: {
        cooldownTicks: 0,
        activeShock: null,
        risk: { famine: 0, rebellion: 0, epidemic: 0, crash: 0 }
      },
      shockEffects: {
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
      regionalInfluence: {
        baseInfluence: 0,
        radius: 0,
        dominantCivId: parent.civId || null,
        dominantInfluence: 0,
        internalInfluence: 0,
        externalInfluence: 0,
        conflictPressure: 0,
        cohesionPressure: 0,
        stabilityModifier: 0,
        growthModifier: 0,
        driftProgress: 0,
        driftTargetCivId: null,
        alignmentCivId: parent.civId || null
      },
      influenceSaturation: {
        localDensity: 0,
        saturationLevel: 0,
        growthPenaltyMult: 1,
        stabilityPenalty: 0,
        splitBonus: 0,
        outwardTradeSpread: 0
      },
      civAlignment: parent.civId ? { [parent.civId]: 1 } : {},
      tradeConsistency: clamp((parent.tradeConsistency || 0) * 0.7 + supportStrength * 0.35, 0, 1),
      influenceStrength: 0,
      role: "General",
      roleInfluenceMultiplier: 1,
      postSplitProtectionUntil,
      postSplitSupportTicks: supportTicks,
      postSplitSupportStrength: supportStrength,
      visualState: null
    };
  }


  applySettlementFission() {
    const created = [];

    for (const settlement of this.settlements) {
      if (!isSettlementActive(settlement)) {
        settlement.highPressureTicks = 0;
        settlement.fissionCooldown = Math.max(0, (settlement.fissionCooldown || 0) - 1);
        continue;
      }

      settlement.fissionCooldown = Math.max(0, (settlement.fissionCooldown || 0) - 1);
      const members = this.membersBySettlementId.get(settlement.id) || settlement.members || [];
      const memberCount = members.length;
      const pressure = settlement.resourcePressure || 0;
      const stability = settlement.stability || settlement.stabilityScore || 0;
      const highPressure = pressure > this.fissionConfig.pressureThreshold &&
        memberCount >= this.fissionConfig.minMembers &&
        stability > this.fissionConfig.minStability;
      settlement.highPressureTicks = highPressure ? (settlement.highPressureTicks || 0) + 1 : 0;

      const eligible = highPressure &&
        settlement.fissionCooldown <= 0 &&
        settlement.highPressureTicks >= this.fissionConfig.highPressureTicksRequired;
      if (!eligible) {
        continue;
      }
      const expansionBoost = this.expansionFissionBoostBySettlement.get(settlement.id) || 0;
      const saturationSplitBonus = this.saturationFissionBonusBySettlement.get(settlement.id) || 0;
      const fissionChance = clamp(0.46 + expansionBoost + saturationSplitBonus, 0.22, 0.85);
      if (this.nextRandom() > fissionChance) {
        continue;
      }

      const splitAgents = this.chooseFissionAgents(settlement);
      if (splitAgents.length < this.fissionConfig.splitMinAgents) {
        continue;
      }

      const child = this.buildSettlementFromSplit(settlement, splitAgents);
      if (!child) {
        continue;
      }

      // Transfer a small resource slice from parent to child so splits are viable without hard scripting.
      if (settlement.resources && child.resources) {
        const baseMembers = Math.max(1, members.length);
        const splitShare = clamp(splitAgents.length / baseMembers, 0.05, 0.35);
        const foodTransfer = Math.min(settlement.resources.food || 0, (settlement.resources.food || 0) * splitShare * 0.6);
        const materialsTransfer = Math.min(settlement.resources.materials || 0, (settlement.resources.materials || 0) * splitShare * 0.55);
        const wealthTransfer = Math.min(settlement.resources.wealth || 0, (settlement.resources.wealth || 0) * splitShare * 0.45);
        settlement.resources.food = Math.max(0, (settlement.resources.food || 0) - foodTransfer);
        settlement.resources.materials = Math.max(0, (settlement.resources.materials || 0) - materialsTransfer);
        settlement.resources.wealth = Math.max(0, (settlement.resources.wealth || 0) - wealthTransfer);
        child.resources.food += foodTransfer;
        child.resources.materials += materialsTransfer;
        child.resources.wealth += wealthTransfer;
      }

      const splitSet = new Set(splitAgents.map((a) => a.id));
      const parentMembers = (this.membersBySettlementId.get(settlement.id) || settlement.members || [])
        .filter((id) => !splitSet.has(id));

      settlement.members = parentMembers;
      settlement.population = parentMembers.length;
      settlement.isRuined = parentMembers.length === 0;
      settlement.fissionCooldown = this.fissionConfig.parentCooldownTicks;
      settlement.highPressureTicks = 0;

      this.membersBySettlementId.set(settlement.id, parentMembers);
      this.membersBySettlementId.set(child.id, child.members);

      for (const agent of splitAgents) {
        this.agentSettlement.set(agent.id, child.id);
        agent.settlementId = child.id;
      }

      if (child.civId) {
        this.settlementToCiv.set(child.id, child.civId);
      }
      this.settlementWindowsById.set(child.id, createSettlementWindows(this.windowSize));
      created.push(child);
    }

    if (created.length > 0) {
      this.settlements.push(...created);
      this.syncPopulationFromMembership();
    }

    return created.length;
  }


  runCivilizationPolicyStep() {
    if (this.lastPolicyTickApplied === this.tick) {
      return;
    }
    updateCivilizationPolicies(
      this.civilizations,
      this.settlements,
      this.tick,
      this.policyUpdateInterval
    );
    updateCivilizationFactions(this.civilizations, this.settlements, this.tick, this.factionConfig);
    applyCivilizationPolicyEffects(this.civilizations, this.settlements);

    this.policyByCivId.clear();
    for (const civ of this.civilizations) {
      this.policyByCivId.set(civ.id, civ.policy || null);
    }
    this.tradeOpennessBySettlement.clear();
    this.tariffRateBySettlement.clear();
    this.borderOpennessBySettlement.clear();
    this.conscriptionBySettlement.clear();
    this.welfareSpendBySettlement.clear();
    this.diplomacyFrictionReliefBySettlement.clear();
    this.expansionFissionBoostBySettlement.clear();
    for (const settlement of this.settlements) {
      const effects = settlement.policyEffects || {};
      this.tradeOpennessBySettlement.set(settlement.id, effects.tradeOpenness ?? 0.5);
      this.tariffRateBySettlement.set(settlement.id, effects.tariffRate ?? 0.5);
      this.borderOpennessBySettlement.set(settlement.id, effects.borderOpenness ?? 0.5);
      this.conscriptionBySettlement.set(settlement.id, effects.conscriptionLevel ?? 0.5);
      this.welfareSpendBySettlement.set(settlement.id, effects.welfareSpend ?? 0.5);
      this.diplomacyFrictionReliefBySettlement.set(
        settlement.id,
        effects.diplomacyFrictionRelief ?? 0
      );
      this.expansionFissionBoostBySettlement.set(
        settlement.id,
        effects.expansionFissionBoost ?? 0
      );
    }
    this.lastPolicyTickApplied = this.tick;
  }


  updateStrategicAlignment(force = false) {
    const result = computeStrategicAlignment(
      this.civilizations,
      this.settlements,
      this.civRelations,
      this.buildTradeRoutes(),
      this.tick,
      this.strategicAlignmentState,
      { ...this.alignmentConfig, force }
    );
    this.strategicAlignmentState = result.state || this.strategicAlignmentState;

    const byId = result.civAlignmentById || new Map();
    for (const civ of this.civilizations) {
      const alignment = byId.get(civ.id) || ensureCivAlignment(civ);
      civ.strategicAlignment = { ...alignment };
    }
  }


  getAlignmentDisposition(civA, civB) {
    return getPairDisposition(this.strategicAlignmentState, civA, civB);
  }


  registerAlignmentTradeEffects(settlementAId, settlementBId, civA, civB) {
    const disposition = this.getAlignmentDisposition(civA, civB);
    if (disposition !== "aligned" && disposition !== "hostile") {
      return;
    }

    const ensureEffect = (settlementId) => {
      if (!settlementId || settlementId === "wild") return null;
      if (!this.pendingAlignmentEffectsBySettlement.has(settlementId)) {
        this.pendingAlignmentEffectsBySettlement.set(settlementId, {
          stabilityDelta: 0,
          pressureDelta: 0
        });
      }
      return this.pendingAlignmentEffectsBySettlement.get(settlementId);
    };

    const effectA = ensureEffect(settlementAId);
    const effectB = ensureEffect(settlementBId);
    const stabilityBonus = 0.0018;
    const pressurePenalty = 0.0016;

    if (disposition === "aligned") {
      if (effectA) effectA.stabilityDelta += stabilityBonus;
      if (effectB) effectB.stabilityDelta += stabilityBonus;
    } else if (disposition === "hostile") {
      if (effectA) effectA.pressureDelta += pressurePenalty;
      if (effectB) effectB.pressureDelta += pressurePenalty;
    }
  }


  applyAlignmentSettlementEffects() {
    if (!this.pendingAlignmentEffectsBySettlement.size) {
      return;
    }

    for (const settlement of this.settlements) {
      const effect = this.pendingAlignmentEffectsBySettlement.get(settlement.id);
      if (!effect) continue;
      const stability = settlement.stability || settlement.stabilityScore || 0;
      const pressure = settlement.resourcePressure || 0;
      settlement.stability = clamp(stability + effect.stabilityDelta, 0, 1);
      settlement.stabilityScore = settlement.stability;
      settlement.resourcePressure = clamp(pressure + effect.pressureDelta, 0, 1);
      settlement.growthRate = clamp(
        (settlement.growthRate || 0) + effect.stabilityDelta * 0.35 - effect.pressureDelta * 0.28,
        -0.08,
        0.08
      );
    }

    this.pendingAlignmentEffectsBySettlement.clear();
  }


  runRegionalInfluenceStep(applySettlementEffects = true) {
    const result = computeRegionalInfluence(this.settlements, this.regionalInfluenceConfig);
    this.regionalCivDeltas = result.civDeltas || new Map();
    this.regionalInfluenceBySettlement = new Map();
    this.regionalTradeBiasBySettlement.clear();

    for (const settlement of this.settlements) {
      ensureRegionalState(settlement);
      this.regionalInfluenceBySettlement.set(settlement.id, settlement.regionalInfluence);
      const info = settlement.regionalInfluence;
      const own = settlement.civId || null;
      let tradeBias = 0;
      if (info?.dominantCivId && own && info.dominantCivId === own) {
        tradeBias += 0.08 * (info.cohesionPressure || 0);
      }
      if (info?.dominantCivId && own && info.dominantCivId !== own) {
        tradeBias -= 0.12 * (info.conflictPressure || 0);
      }
      if (info?.alignmentCivId && own && info.alignmentCivId === own) {
        tradeBias += 0.035;
      }
      this.regionalTradeBiasBySettlement.set(settlement.id, clamp(tradeBias, -0.2, 0.2));
    }

    if (applySettlementEffects) {
      for (const settlement of this.settlements) {
        const info = settlement.regionalInfluence;
        if (!info) {
          continue;
        }
        settlement.stability = clamp(
          (settlement.stability || settlement.stabilityScore || 0) + (info.stabilityModifier || 0),
          0,
          1
        );
        settlement.stabilityScore = settlement.stability;
        settlement.growthRate = clamp(
          (settlement.growthRate || 0) + (info.growthModifier || 0),
          -0.08,
          0.08
        );
      }
    }
  }


  runInfluenceSaturationStep(applySettlementEffects = true) {
    const result = computeInfluenceSaturation(this.settlements, this.influenceSaturationConfig);
    this.saturationBySettlement = result.densityBySettlement || new Map();
    this.saturationFissionBonusBySettlement.clear();
    this.saturationTradeSpreadBySettlement.clear();

    for (const settlement of this.settlements) {
      ensureInfluenceSaturationState(settlement);
      const sat = settlement.influenceSaturation || {};
      this.saturationFissionBonusBySettlement.set(settlement.id, sat.splitBonus || 0);
      this.saturationTradeSpreadBySettlement.set(settlement.id, sat.outwardTradeSpread || 0);
    }

    if (applySettlementEffects) {
      for (const settlement of this.settlements) {
        const sat = settlement.influenceSaturation;
        if (!sat) continue;
        settlement.growthRate = clamp(
          (settlement.growthRate || 0) * (sat.growthPenaltyMult || 1),
          -0.08,
          0.08
        );
        settlement.stability = clamp(
          (settlement.stability || settlement.stabilityScore || 0) - (sat.stabilityPenalty || 0),
          0,
          1
        );
        settlement.stabilityScore = settlement.stability;
      }
    }
  }


  clusterSettlements(settlements, linkDistance) {
    const clusters = [];
    const visited = new Set();
    const maxDistSq = linkDistance * linkDistance;

    for (const settlement of settlements) {
      if (visited.has(settlement.id)) continue;
      visited.add(settlement.id);
      const queue = [settlement];
      const group = [];

      while (queue.length) {
        const current = queue.pop();
        group.push(current);
        const centerA = current.center || current.centerPosition;
        for (const candidate of settlements) {
          if (visited.has(candidate.id)) continue;
          const centerB = candidate.center || candidate.centerPosition;
          if (distSq(centerA, centerB) <= maxDistSq) {
            visited.add(candidate.id);
            queue.push(candidate);
          }
        }
      }
      clusters.push(group);
    }
    return clusters;
  }


  civilizationCentroid(settlements) {
    let wx = 0;
    let wy = 0;
    let weight = 0;
    for (const s of settlements) {
      const w = Math.max(1, s.population || 0);
      const c = s.center || s.centerPosition;
      wx += c.x * w;
      wy += c.y * w;
      weight += w;
    }
    return { x: wx / Math.max(1, weight), y: wy / Math.max(1, weight) };
  }


  updateCivilizations(forceRecluster = false) {
    const liveSettlements = this.getActiveSettlements();
    if (!liveSettlements.length) {
      this.civilizations = [];
      this.settlementToCiv.clear();
      for (const settlement of this.settlements) {
        settlement.civId = null;
      }
      return;
    }

    if (!forceRecluster && this.civilizations.length > 0 && this.tick % this.detectInterval !== 0) {
      this.syncCivilizationMatrices();
      return;
    }

    const prev = this.civilizations;
    const used = new Set();
    const groups = this.clusterSettlements(liveSettlements, 28);
    const next = [];

    for (const group of groups) {
      const centroid = this.civilizationCentroid(group);
      const pop = group.reduce((acc, s) => acc + (s.population || 0), 0);
      const trade = group.reduce((acc, s) => acc + (s.tradeFlow || 0), 0);
      const influenceRadius = Number((12 + Math.sqrt(pop) * 2.1 + Math.min(20, trade * 0.12)).toFixed(2));

      let bestPrev = null;
      let bestDist = Infinity;
      for (const p of prev) {
        if (used.has(p.id)) continue;
        const d = distSq(centroid, p.centroid);
        if (d < bestDist) {
          bestDist = d;
          bestPrev = p;
        }
      }

      const civId = bestPrev && bestDist <= 20 * 20 ? bestPrev.id : `C${this.nextCivId++}`;
      if (bestPrev) {
        used.add(bestPrev.id);
      }

      next.push({
        id: civId,
        settlementIds: group.map((s) => s.id),
        influenceRadius,
        centroid,
        relationMatrix: {},
        culture: bestPrev?.culture ? { ...bestPrev.culture } : undefined,
        strategyModifiers: bestPrev?.strategyModifiers
          ? { ...bestPrev.strategyModifiers }
          : {
            migrationBias: 0,
            tradeBias: 0,
            conflictTolerance: 0
          },
        policy: bestPrev?.policy ? { ...bestPrev.policy } : undefined,
        policyState: bestPrev?.policyState ? { ...bestPrev.policyState } : undefined,
        policyDrift: bestPrev?.policyDrift ? { ...bestPrev.policyDrift } : undefined,
        policyInputs: bestPrev?.policyInputs ? { ...bestPrev.policyInputs } : undefined,
        factions: Array.isArray(bestPrev?.factions)
          ? bestPrev.factions.map((f) => ({
            id: f.id,
            ideology: { ...(f.ideology || {}) },
            powerShare: f.powerShare || 0,
            momentum: f.momentum || 0
          }))
          : undefined,
        institutionLevers: bestPrev?.institutionLevers ? { ...bestPrev.institutionLevers } : undefined,
        factionTension: bestPrev?.factionTension || 0,
        factionSummary: bestPrev?.factionSummary ? { ...bestPrev.factionSummary } : undefined,
        strategicAlignment: bestPrev?.strategicAlignment
          ? { ...bestPrev.strategicAlignment }
          : undefined
      });
    }

    this.civilizations = next;
    for (const civ of this.civilizations) {
      ensureCulture(civ);
      ensureStrategyModifiers(civ);
      ensureCivilizationPolicy(civ);
      ensurePolicyDrift(civ);
      ensureCivilizationFactions(civ);
      ensureCivAlignment(civ);
    }
    this.settlementToCiv.clear();
    for (const civ of this.civilizations) {
      for (const sid of civ.settlementIds) {
        this.settlementToCiv.set(sid, civ.id);
      }
    }

    for (const settlement of this.settlements) {
      settlement.civId = this.settlementToCiv.get(settlement.id) || null;
    }

    this.syncCivilizationMatrices();
  }


  syncCivilizationMatrices() {
    const ids = this.civilizations.map((c) => c.id);
    for (const id of ids) {
      if (!this.civRelations[id]) {
        this.civRelations[id] = {};
      }
      for (const other of ids) {
        if (id === other) continue;
        if (typeof this.civRelations[id][other] !== "number") {
          this.civRelations[id][other] = 0;
        }
      }
    }

    for (const civ of this.civilizations) {
      civ.relationMatrix = {};
      for (const other of this.civilizations) {
        if (civ.id === other.id) continue;
        civ.relationMatrix[other.id] = Number((this.civRelations[civ.id]?.[other.id] || 0).toFixed(3));
      }
    }
  }


  applyCivDeltaFromEvent(event) {
    if (!event.civA || !event.civB || event.civA === event.civB) {
      return;
    }
    const civA = this.getCivilizationById(event.civA);
    const civB = this.getCivilizationById(event.civB);
    const civDistance = civA?.centroid && civB?.centroid
      ? Math.hypot(civA.centroid.x - civB.centroid.x, civA.centroid.y - civB.centroid.y)
      : 0;
    const distanceFriction = clamp(
      1 / (1 + civDistance / Math.max(8, this.logisticsConfig.diplomacyDistanceScale)),
      0.35,
      1
    );
    const policyA = this.policyByCivId.get(event.civA) || null;
    const policyB = this.policyByCivId.get(event.civB) || null;
    const avgTradeOpenness = (
      (policyA?.tradeOpenness ?? 0.5) +
      (policyB?.tradeOpenness ?? 0.5)
    ) * 0.5;
    const avgTariff = (
      (civA?.institutionLevers?.tariffRate ?? 0.5) +
      (civB?.institutionLevers?.tariffRate ?? 0.5)
    ) * 0.5;
    const frictionRelief = clamp(avgTradeOpenness * 0.08, 0, 0.08);
    const diplomaticFriction = clamp(1 - avgTariff * 0.16, 0.6, 1);
    const deltaScale = distanceFriction * diplomaticFriction;

    if (event.type === "trade") {
      accumulateCivDelta(
        this.civEventDeltas,
        event.civA,
        event.civB,
        (0.03 + frictionRelief * 0.2) * deltaScale
      );
    } else if (event.type === "cooperate") {
      accumulateCivDelta(
        this.civEventDeltas,
        event.civA,
        event.civB,
        (0.012 + frictionRelief * 0.16) * deltaScale
      );
    } else if (event.type === "conflict") {
      accumulateCivDelta(
        this.civEventDeltas,
        event.civA,
        event.civB,
        (-0.055 + frictionRelief * 0.35) * deltaScale
      );
    }
  }


  applyBorderTensionDeltas() {
    for (const [key, windows] of this.civBorderWindows.entries()) {
      windows.contact.advanceToTick(this.tick);
      windows.conflict.advanceToTick(this.tick);

      const contactSum = windows.contact.sum();
      const conflictSum = windows.conflict.sum();
      if (contactSum <= 0.0001 && conflictSum <= 0.0001) {
        continue;
      }

      const borderConflictRate = clamp(conflictSum / Math.max(1, contactSum), 0, 1);
      const borderContactRate = clamp(1 - borderConflictRate, 0, 1);
      const activityScale = clamp(contactSum / (this.windowSize * 0.08), 0, 1);
      const delta = clamp(
        (borderContactRate * 0.006 - borderConflictRate * 0.01) * activityScale,
        -0.012,
        0.008
      );
      if (Math.abs(delta) < 1e-6) {
        continue;
      }

      const [civA, civB] = key.split("|");
      accumulateCivDelta(this.civEventDeltas, civA, civB, delta);
    }
  }


  recordEvent(event) {
    this.events.push(event);
    this.recentEvents.push(event);

    if (event.type === "trade") {
      this.tradeEvents.push(event);
      if (this.tradeEvents.length > this.maxTradeEvents) {
        this.tradeEvents.shift();
      }
    }

    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.shift();
    }

    this.applyCivDeltaFromEvent(event);
  }


  relationColor(value) {
    if (value > 0.2) return "green";
    if (value < -0.2) return "red";
    return "yellow";
  }


  getSettlementMarketPrice(settlement, commodity) {
    const value = settlement?.market?.prices?.[commodity];
    return clamp(Number.isFinite(value) ? value : 1, 0.25, 4);
  }


  computeRoutePriceGap(fromSettlement, toSettlement) {
    const weights = {
      food: 0.42,
      materials: 0.38,
      wealth: 0.2
    };
    let gap = 0;
    for (const commodity of Object.keys(weights)) {
      const pFrom = this.getSettlementMarketPrice(fromSettlement, commodity);
      const pTo = this.getSettlementMarketPrice(toSettlement, commodity);
      const logRatio = Math.abs(Math.log(pFrom / Math.max(1e-6, pTo)));
      gap += logRatio * weights[commodity];
    }
    return clamp(gap, 0, 2.5);
  }


  computeRouteArbitrageScore(fromSettlement, toSettlement, distanceCost, tariffMult) {
    const priceGap = this.computeRoutePriceGap(fromSettlement, toSettlement);
    const avgLogistics = clamp(
      (
        (fromSettlement.innovationEffects?.tradeRangeMult || 1) +
        (toSettlement.innovationEffects?.tradeRangeMult || 1)
      ) * 0.5,
      0.75,
      1.7
    );
    const logisticsFactor = clamp(0.82 + (avgLogistics - 1) * 0.85, 0.6, 1.35);
    return clamp(priceGap * distanceCost * tariffMult * logisticsFactor, 0, 3.2);
  }


  buildTradeRoutes() {
    const settlementById = new Map(this.settlements.map((s) => [s.id, s]));
    const routes = [];

    for (const [key, counter] of this.pairTradeWindows.entries()) {
      counter.advanceToTick(this.tick);
      const rawVolume = counter.sum();
      if (rawVolume <= 0.001) continue;

      const [from, to] = key.split("|");
      const fromSettlement = settlementById.get(from);
      const toSettlement = settlementById.get(to);
      if (!fromSettlement || !toSettlement) continue;
      if (!isSettlementActive(fromSettlement) || !isSettlementActive(toSettlement)) continue;
      const routeMomentum = this.getRouteMomentum(key);
      const routeAge = this.getRouteAge(key);
      const fromPos = fromSettlement.center || fromSettlement.centerPosition;
      const toPos = toSettlement.center || toSettlement.centerPosition;
      const distance = Math.max(1, Math.hypot(toPos.x - fromPos.x, toPos.y - fromPos.y));
      const tradeRangeMult = (
        (fromSettlement.innovationEffects?.tradeRangeMult || 1) +
        (toSettlement.innovationEffects?.tradeRangeMult || 1)
      ) * 0.5;
      const distanceReliability = clamp(
        Math.exp(-distance / Math.max(1, this.tradeDistanceConfig.routeDistanceDecay * tradeRangeMult)),
        this.tradeDistanceConfig.routeMinReliability,
        1
      );
      const distanceCost = 1 / (1 + distance * this.tradeDistanceConfig.routeDistanceCostScale);
      const avgTariff = (
        (this.tariffRateBySettlement.get(fromSettlement.id) ?? 0.5) +
        (this.tariffRateBySettlement.get(toSettlement.id) ?? 0.5)
      ) * 0.5;
      const tariffMult = clamp(1 - avgTariff * 0.3, 0.55, 1);
      const shockMult = clamp(
        (fromSettlement.shockEffects?.tradeReliabilityMult ?? 1) *
        (toSettlement.shockEffects?.tradeReliabilityMult ?? 1),
        0.45,
        1.2
      );
      const innovationReliability = clamp(
        1 + (
          (fromSettlement.innovationEffects?.tradeReliabilityBonus || 0) +
          (toSettlement.innovationEffects?.tradeReliabilityBonus || 0)
        ) * 0.5,
        0.8,
        1.35
      );
      const routeReliability = clamp(distanceReliability * tariffMult * shockMult * innovationReliability, 0.22, 1.3);
      const routePriceGap = this.computeRoutePriceGap(fromSettlement, toSettlement);
      const routeArbitrageScore = this.computeRouteArbitrageScore(
        fromSettlement,
        toSettlement,
        distanceCost,
        tariffMult
      );
      const priceGapDemandMult = 1 + routeArbitrageScore * this.routePriceGapDemandScale;
      const volume =
        rawVolume *
        (1 + routeMomentum * this.tradeMomentumConfig.volumeScale) *
        routeReliability *
        distanceCost *
        priceGapDemandMult;

      routes.push({
        from,
        to,
        routeKey: key,
        rawTradeVolume: Number(rawVolume.toFixed(3)),
        tradeVolume: Number(volume.toFixed(3)),
        trades: Number(volume.toFixed(2)),
        routeDistance: Number(distance.toFixed(3)),
        routeReliability: Number(routeReliability.toFixed(4)),
        routeDistanceCost: Number(distanceCost.toFixed(4)),
        routeTariffFriction: Number(tariffMult.toFixed(4)),
        routeShockReliability: Number(shockMult.toFixed(4)),
        routeInnovationReliability: Number(innovationReliability.toFixed(4)),
        routePriceGap: Number(routePriceGap.toFixed(5)),
        routeArbitrageScore: Number(routeArbitrageScore.toFixed(5)),
        routeMomentum: Number(routeMomentum.toFixed(4)),
        routeAge: Math.max(0, Math.floor(routeAge)),
        fromPosition: fromPos,
        toPosition: toPos
      });
    }

    routes.sort((a, b) => {
      const diff = b.tradeVolume - a.tradeVolume;
      if (Math.abs(diff) > 1e-9) {
        return diff;
      }
      return String(a.routeKey || `${a.from}|${a.to}`).localeCompare(
        String(b.routeKey || `${b.from}|${b.to}`)
      );
    });
    return routes;
  }


  buildDiplomacyLines() {
    const lines = [];
    const activeCivIds = new Set(
      this.getActiveSettlements().map((settlement) => settlement.civId).filter(Boolean)
    );
    for (let i = 0; i < this.civilizations.length; i += 1) {
      for (let j = i + 1; j < this.civilizations.length; j += 1) {
        const civA = this.civilizations[i];
        const civB = this.civilizations[j];
        if (!activeCivIds.has(civA.id) || !activeCivIds.has(civB.id)) {
          continue;
        }
        const relation = this.civRelations[civA.id]?.[civB.id] || 0;
        lines.push({
          civA: civA.id,
          civB: civB.id,
          relation: Number(relation.toFixed(3)),
          color: this.relationColor(relation),
          from: civA.centroid,
          to: civB.centroid
        });
      }
    }
    return lines;
  }


  updateEraHistory(force = false) {
    const interval = this.eraConfig.evaluationInterval || 240;
    const lastEval = this.eraState?.lastEvaluationTick ?? -1;
    const shouldEvaluate = force || lastEval < 0 || (this.tick - lastEval) >= interval;
    const input = shouldEvaluate
      ? {
        tick: this.tick,
        settlements: this.settlements,
        civilizations: this.civilizations,
        civRelations: this.civRelations,
        tradeRoutes: this.buildTradeRoutes()
      }
      : { tick: this.tick };

    const result = updateEraHistoryState(
      this.eraState,
      input,
      this.eraConfig,
      force
    );

    if (result?.createdEra) {
      this.recordEvent({
        type: "system",
        tick: this.tick,
        message: `${result.createdEra.title}: ${result.createdEra.summary}`,
        civA: result.createdEra.dominantCivilization || null,
        civB: null
      });
    }
    if (result?.createdMilestone) {
      this.recordEvent({
        type: "system",
        tick: this.tick,
        message: `${result.createdMilestone.title}: ${result.createdMilestone.summary}`,
        civA: result.createdMilestone.dominantCivilization || null,
        civB: null
      });
    }
  }


  getEraHistorySnapshot(limit = 80) {
    return getEraHistorySnapshot(this.eraState, limit);
  }

}

module.exports = CivilizationSimulationMethods;

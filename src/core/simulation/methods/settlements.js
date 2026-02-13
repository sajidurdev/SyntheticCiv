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
} = require("../scope");

class SettlementSimulationMethods {
  createWorldGrid() {
    const grid = [];
    for (let y = 0; y < this.height; y += 1) {
      const row = [];
      for (let x = 0; x < this.width; x += 1) {
        const resourceType = this.randomChoice(RESOURCE_TYPES);
        const maxResource = this.rand(18, 42);
        row.push({
          resourceAmount: this.rand(6, maxResource * 0.8),
          regenRate: this.rand(0.03, 0.22),
          resourceType,
          maxResource
        });
      }
      grid.push(row);
    }
    return grid;
  }


  createAgents(count) {
    const agents = [];
    for (let i = 0; i < count; i += 1) {
      const preferredResource = this.randomChoice(RESOURCE_TYPES);
      agents.push({
        id: i + 1,
        position: {
          x: Math.floor(this.nextRandom() * this.width),
          y: Math.floor(this.nextRandom() * this.height)
        },
        energy: this.rand(65, 120),
        inventory: {
          food: this.rand(0, 4),
          ore: this.rand(0, 4),
          fiber: this.rand(0, 4)
        },
        preferredResource,
        traits: {
          risk: this.rand(0, 1),
          greed: this.rand(0, 1),
          social: this.rand(0, 1),
          aggression: this.rand(0, 1)
        },
        relations: {},
        velocity: { x: 0, y: 0 },
        morale: 0.5,
        warExhaustion: 0,
        contested: 0,
        influenceTopSettlementId: null,
        influenceSecondSettlementId: null,
        currentAction: "move"
      });
    }
    return agents;
  }


  updateResources() {
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const cell = this.grid[y][x];
        cell.resourceAmount = clamp(cell.resourceAmount + cell.regenRate, 0, cell.maxResource);
      }
    }
  }


  cellKey(x, y) {
    return `${x}:${y}`;
  }


  rebuildSpatialHash() {
    this.spatialHash.clear();
    for (const agent of this.agents) {
      const cx = Math.floor(agent.position.x / this.spatialCellSize);
      const cy = Math.floor(agent.position.y / this.spatialCellSize);
      const key = this.cellKey(cx, cy);
      if (!this.spatialHash.has(key)) {
        this.spatialHash.set(key, []);
      }
      this.spatialHash.get(key).push(agent);
    }
  }


  getNearbyAgents(agent, radius) {
    const nearby = [];
    const rSq = radius * radius;
    const minCx = Math.floor((agent.position.x - radius) / this.spatialCellSize);
    const maxCx = Math.floor((agent.position.x + radius) / this.spatialCellSize);
    const minCy = Math.floor((agent.position.y - radius) / this.spatialCellSize);
    const maxCy = Math.floor((agent.position.y + radius) / this.spatialCellSize);

    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cy = minCy; cy <= maxCy; cy += 1) {
        const bucket = this.spatialHash.get(this.cellKey(cx, cy));
        if (!bucket) continue;
        for (const other of bucket) {
          if (other.id === agent.id) continue;
          if (distSq(agent.position, other.position) <= rSq) {
            nearby.push(other);
          }
        }
      }
    }
    return nearby;
  }


  getNearbyCountAt(x, y, radius) {
    const temp = { id: -1, position: { x, y } };
    return this.getNearbyAgents(temp, radius).length;
  }


  getCell(x, y) {
    const ix = clamp(Math.floor(x), 0, this.width - 1);
    const iy = clamp(Math.floor(y), 0, this.height - 1);
    return this.grid[iy][ix];
  }


  computeUtility(agent, inventoryOverride) {
    const inv = inventoryOverride || agent.inventory;
    let score = agent.energy * 0.15;
    for (const type of RESOURCE_TYPES) {
      const w = type === agent.preferredResource ? 2.2 + agent.traits.greed * 0.8 : 1;
      score += inv[type] * w;
    }
    return score;
  }

  findNeighborsByDistance(baseAgent, candidates, radiusSq) {
    const out = [];
    for (const other of candidates) {
      if (other.id === baseAgent.id) continue;
      if (distSq(baseAgent.position, other.position) <= radiusSq) {
        out.push(other);
      }
    }
    return out;
  }


  findAgentClusters() {
    const eps = 7;
    const epsSq = eps * eps;
    const minPoints = 6;
    const visited = new Set();
    const assigned = new Set();
    const clusters = [];

    for (const agent of this.agents) {
      if (visited.has(agent.id)) continue;
      visited.add(agent.id);
      const seed = this.findNeighborsByDistance(agent, this.agents, epsSq);
      if (seed.length + 1 < minPoints) continue;

      const queue = [agent, ...seed];
      const cluster = [];
      while (queue.length) {
        const current = queue.pop();
        if (!current || assigned.has(current.id)) continue;
        assigned.add(current.id);
        cluster.push(current);

        const neighbors = this.findNeighborsByDistance(current, this.agents, epsSq);
        if (neighbors.length + 1 >= minPoints) {
          for (const n of neighbors) {
            if (!visited.has(n.id)) {
              visited.add(n.id);
              queue.push(n);
            }
            if (!assigned.has(n.id)) {
              queue.push(n);
            }
          }
        }
      }
      if (cluster.length >= 8) {
        clusters.push(cluster);
      }
    }
    return clusters;
  }


  averagePosition(list) {
    if (!list.length) {
      return { x: 0, y: 0 };
    }
    let x = 0;
    let y = 0;
    for (const item of list) {
      x += item.position.x;
      y += item.position.y;
    }
    return { x: x / list.length, y: y / list.length };
  }


  detectSettlements() {
    const clusters = this.findAgentClusters();
    const previous = this.settlements;
    const used = new Set();
    const next = [];

    for (const cluster of clusters) {
      const center = this.averagePosition(cluster);
      let best = null;
      let bestDist = Infinity;
      for (const prev of previous) {
        if (used.has(prev.id)) continue;
        const d = distSq(center, prev.center || prev.centerPosition);
        if (d < bestDist) {
          bestDist = d;
          best = prev;
        }
      }

      const id = best && bestDist <= 16 * 16 ? best.id : `S${this.nextSettlementId++}`;
      if (best) {
        used.add(best.id);
      }

      next.push({
        id,
        civId: best?.civId || null,
        center: center,
        centerPosition: center,
        population: cluster.length,
        members: cluster.map((agent) => agent.id),
        isRuined: false,
        highPressureTicks: best?.highPressureTicks || 0,
        fissionCooldown: best?.fissionCooldown || 0,
        avgEnergy: 0,
        tradeFlow: 0,
        tradeVolume: 0,
        conflictRate: 0,
        migrationIn: 0,
        migrationOut: 0,
        migrationInRate: 0,
        migrationOutRate: 0,
        migrationNetRate: 0,
        resourcePressure: 0,
        stability: 0,
        stabilityScore: 0,
        growthRate: 0,
        resources: best?.resources || defaultResources(cluster.length),
        resourceEMA: best?.resourceEMA || { foodStress: 0, materialStress: 0 },
        birthMultiplier: best?.birthMultiplier ?? 1,
        conflictSensitivity: best?.conflictSensitivity ?? 0,
        economyMigrationPressure: best?.economyMigrationPressure ?? 0,
        economicProfile: best?.economicProfile || "Balanced",
        economicStress: best?.economicStress || 0,
        securityStress: best?.securityStress || 0,
        legitimacyStress: best?.legitimacyStress || 0,
        socialStress: best?.socialStress || 0,
        environmentStress: best?.environmentStress || 0,
        compositeStress: best?.compositeStress || 0,
        pressureAxes: best?.pressureAxes
          ? { ...best.pressureAxes }
          : {
            economicStress: best?.economicStress || 0,
            securityStress: best?.securityStress || 0,
            legitimacyStress: best?.legitimacyStress || 0,
            socialStress: best?.socialStress || 0,
            environmentStress: best?.environmentStress || 0,
            compositeStress: best?.compositeStress || 0
          },
        knowledge: best?.knowledge
          ? { ...best.knowledge }
          : { farming: 0, medicine: 0, governance: 0, logistics: 0 },
        knowledgeLevel: best?.knowledgeLevel || 0,
        innovationEffects: best?.innovationEffects
          ? { ...best.innovationEffects }
          : {
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
        shockState: best?.shockState
          ? { ...best.shockState }
          : {
            cooldownTicks: 0,
            activeShock: null,
            risk: { famine: 0, rebellion: 0, epidemic: 0, crash: 0 }
          },
        shockEffects: best?.shockEffects
          ? { ...best.shockEffects }
          : {
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
        regionalInfluence: best?.regionalInfluence
          ? { ...best.regionalInfluence }
          : {
            baseInfluence: 0,
            radius: 0,
            dominantCivId: best?.civId || null,
            dominantInfluence: 0,
            internalInfluence: 0,
            externalInfluence: 0,
            conflictPressure: 0,
            cohesionPressure: 0,
            stabilityModifier: 0,
            growthModifier: 0,
            driftProgress: 0,
            driftTargetCivId: null,
            alignmentCivId: best?.civId || null
          },
        influenceSaturation: best?.influenceSaturation
          ? { ...best.influenceSaturation }
          : {
            localDensity: 0,
            saturationLevel: 0,
            growthPenaltyMult: 1,
            stabilityPenalty: 0,
            splitBonus: 0,
            outwardTradeSpread: 0
          },
        civAlignment: best?.civAlignment ? { ...best.civAlignment } : {},
        influenceStrength: best?.influenceStrength || 0,
        postSplitProtectionUntil: Number.isFinite(best?.postSplitProtectionUntil)
          ? best.postSplitProtectionUntil
          : 0,
        postSplitSupportTicks: Number.isFinite(best?.postSplitSupportTicks)
          ? best.postSplitSupportTicks
          : 0,
        postSplitSupportStrength: Number.isFinite(best?.postSplitSupportStrength)
          ? best.postSplitSupportStrength
          : 0,
        visualState: best?.visualState || null
      });
    }

    for (const prev of previous) {
      if (used.has(prev.id)) {
        continue;
      }
      next.push({
        ...prev,
        population: 0,
        members: [],
        isRuined: true,
        influenceStrength: 0
      });
    }

    this.settlements = next;
    for (const settlement of this.settlements) {
      ensureSettlementEconomyState(settlement);
      ensureSettlementInnovationState(settlement);
      ensureSettlementShockState(settlement);
      ensureRegionalState(settlement);
      ensureInfluenceSaturationState(settlement);
    }
  }


  refreshMembership() {
    const previousMembership = new Map(this.agentSettlement);
    const activeSettlements = this.getActiveSettlements();

    const runMembership = (radiusMultiplier) => updateSettlementMembership(this.agents, activeSettlements, {
      previousMembership,
      influenceBySettlementId: this.influenceBySettlement,
      base: 18,
      k: 3,
      minRadius: 20,
      maxRadius: 65,
      enterMargin: 0.08,
      exitMargin: 0.12,
      radiusMultiplier,
      tick: this.tick,
      overcrowdingWeight: 0.55,
      populationSoftCap: 220
    });

    let membership = runMembership(this.settlementRadiusMultiplier);
    const wildRatio = this.agents.length > 0 ? membership.wildAgentIds.length / this.agents.length : 0;

    if (wildRatio > 0.6) {
      this.settlementRadiusMultiplier = 1.1;
      membership = runMembership(this.settlementRadiusMultiplier);
    } else {
      this.settlementRadiusMultiplier = 1;
    }

    this.previousAgentSettlement = previousMembership;
    this.agentSettlement = membership.membershipByAgentId;
    this.membersBySettlementId = membership.membersBySettlementId;
    this.wildAgentIds = membership.wildAgentIds;
    this.membershipRadii = membership.radiusBySettlementId;
    for (const settlement of this.settlements) {
      const members = membership.membersBySettlementId.get(settlement.id) || [];
      settlement.members = members;
      settlement.isRuined = members.length === 0;
    }

    return membership.migrationTransitions;
  }


  computeSettlementMetricsForTick(migrationTransitions) {
    const avgGreed = this.agents.length
      ? this.agents.reduce((acc, a) => acc + a.traits.greed, 0) / this.agents.length
      : 0;
    const consumePerTick = 0.55 + avgGreed * 0.18;

    const metrics = computeSettlementMetrics(
      { width: this.width, height: this.height, grid: this.grid },
      this.agents,
      this.settlements,
      this.events,
      this.tick,
      {
        windowSize: this.windowSize,
        windowsBySettlementId: this.settlementWindowsById,
        membersBySettlementId: this.membersBySettlementId,
        migrationTransitions,
        consumePerTick,
        horizonTicks: 200,
        sampleRadiusCells: 8
      }
    );

    this.settlementWindowsById = metrics.windowsBySettlementId;
    const byId = new Map(metrics.settlements.map((s) => [s.id, s]));
    this.settlements = this.settlements.map((base) => {
      const m = byId.get(base.id);
      if (!m) return base;
      const prevConflictRate = base.conflictRate || 0;
      return {
        ...base,
        prevConflictRate,
        ...m,
        center: m.center,
        centerPosition: m.center
      };
    });

  }


  updateSettlementFrontierPressure() {
    const agentById = new Map(this.agents.map((agent) => [agent.id, agent]));
    const emaAlpha = 0.05;

    for (const settlement of this.settlements) {
      const members = this.membersBySettlementId.get(settlement.id) || settlement.members || [];
      if (!members.length) {
        const prev = clamp(settlement.frontierPressure || 0, 0, 1);
        settlement.frontierPressureRaw = 0;
        settlement.frontierPressure = Number((prev + (0 - prev) * emaAlpha).toFixed(4));
        continue;
      }

      const center = settlement.center || settlement.centerPosition;
      let maxDist = 0;
      const distances = [];
      for (const memberId of members) {
        const agent = agentById.get(memberId);
        if (!agent) {
          continue;
        }
        const d = Math.hypot(agent.position.x - center.x, agent.position.y - center.y);
        distances.push({ id: memberId, d });
        if (d > maxDist) {
          maxDist = d;
        }
      }

      if (distances.length === 0) {
        settlement.frontierPressureRaw = 0;
        settlement.frontierPressure = 0;
        continue;
      }

      const safeMaxDist = Math.max(1, maxDist);
      let weightedSum = 0;
      let weightTotal = 0;
      for (const row of distances) {
        const agent = agentById.get(row.id);
        const contested = clamp(agent?.contested || 0, 0, 1);
        const edgeWeight = row.d / safeMaxDist;
        const weight = 0.35 + edgeWeight * 0.65;
        weightedSum += contested * weight;
        weightTotal += weight;
      }

      const raw = clamp(weightedSum / Math.max(1e-6, weightTotal), 0, 1);
      const prev = clamp(settlement.frontierPressure || 0, 0, 1);
      const smoothed = prev + (raw - prev) * emaAlpha;
      settlement.frontierPressureRaw = Number(raw.toFixed(4));
      settlement.frontierPressure = Number(smoothed.toFixed(4));
    }
  }


  refreshSettlementInfluence() {
    classifySettlementRoles(this.settlements);
    this.influenceBySettlement = computeInfluenceStrengths(this.settlements, {
      state: this.influenceFieldState,
      emaAlpha: this.influenceConfig.strengthEma
    });
  }


  buildCultureByCivId() {
    const map = new Map();
    for (const civ of this.civilizations) {
      if (civ?.id) {
        map.set(civ.id, civ.culture || null);
      }
    }
    return map;
  }


  syncPopulationFromMembership() {
    const agentById = new Map(this.agents.map((a) => [a.id, a]));
    for (const settlement of this.settlements) {
      ensureSettlementEconomyState(settlement);
      ensureSettlementInnovationState(settlement);
      ensureSettlementShockState(settlement);
      ensureRegionalState(settlement);
      ensureInfluenceSaturationState(settlement);
      const members = this.membersBySettlementId.get(settlement.id) || [];
      settlement.members = members;
      settlement.population = members.length;
      settlement.isRuined = members.length === 0;
      settlement.highPressureTicks = Number.isFinite(settlement.highPressureTicks)
        ? settlement.highPressureTicks
        : 0;
      settlement.fissionCooldown = Number.isFinite(settlement.fissionCooldown)
        ? settlement.fissionCooldown
        : 0;
      settlement.avgEnergy = members.length
        ? members.reduce((acc, id) => acc + (agentById.get(id)?.energy || 0), 0) / members.length
        : 0;
    }
  }


  getActiveSettlements() {
    return this.settlements.filter(isSettlementActive);
  }


  getViableSettlements() {
    return this.settlements.filter((settlement) => {
      if (isSettlementActive(settlement)) {
        return true;
      }
      const resources = settlement.resources || {};
      const stockpile = (resources.food || 0) + (resources.materials || 0) + (resources.wealth || 0);
      return stockpile >= this.viabilityThreshold;
    });
  }


  settlementBeliefKey(observerSettlementId, targetSettlementId) {
    return `${observerSettlementId}|${targetSettlementId}`;
  }


  buildSettlementSignal(settlement) {
    const economicStress = clamp(settlement.economicStress || settlement.resourceEMA?.foodStress || 0, 0, 1);
    const securityStress = clamp(settlement.securityStress || 0, 0, 1);
    const legitimacyStress = clamp(settlement.legitimacyStress || 0, 0, 1);
    const food = clamp(
      Number.isFinite(settlement.foodPerCap) ? settlement.foodPerCap : (1 - economicStress),
      0,
      1
    );
    const threat = clamp(
      securityStress * 0.65 +
      legitimacyStress * 0.2 +
      (settlement.conflictRate || 0) * 0.15,
      0,
      1
    );
    const stability = clamp(settlement.stability || settlement.stabilityScore || 0, 0, 1);
    const tradeReliability = clamp(
      (settlement.tradeConsistency || 0) * 0.52 +
      (1 - economicStress) * 0.28 +
      (1 - securityStress) * 0.2,
      0,
      1
    );
    return {
      beliefFood: food,
      beliefThreat: threat,
      beliefStability: stability,
      beliefTradeReliability: tradeReliability
    };
  }


  getSettlementBelief(observerSettlementId, targetSettlement) {
    if (!targetSettlement) {
      return {
        beliefFood: 0.5,
        beliefThreat: 0.5,
        beliefStability: 0.5,
        beliefTradeReliability: 0.5,
        lastTick: this.tick
      };
    }
    if (!observerSettlementId || observerSettlementId === "wild") {
      return this.buildSettlementSignal(targetSettlement);
    }
    const key = this.settlementBeliefKey(observerSettlementId, targetSettlement.id);
    const belief = this.settlementBeliefs.get(key);
    if (belief) {
      return belief;
    }
    const seeded = this.buildSettlementSignal(targetSettlement);
    this.settlementBeliefs.set(key, {
      ...seeded,
      lastTick: this.tick
    });
    return this.settlementBeliefs.get(key);
  }


  updateSettlementBeliefs(force = false) {
    if (!force && this.tick % this.beliefConfig.updateInterval !== 0) {
      return;
    }

    const active = this.getActiveSettlements();
    if (active.length < 2) {
      return;
    }

    const tradeConfidence = new Map();
    const infoConfidence = new Map();
    let tradeMax = 1;
    let infoMax = 1;
    for (const [key, counter] of this.pairTradeWindows.entries()) {
      counter.advanceToTick(this.tick);
      const volume = counter.sum();
      tradeConfidence.set(key, volume);
      if (volume > tradeMax) {
        tradeMax = volume;
      }
    }
    for (const [key, counter] of this.pairInfoWindows.entries()) {
      counter.advanceToTick(this.tick);
      const volume = counter.sum();
      infoConfidence.set(key, volume);
      if (volume > infoMax) {
        infoMax = volume;
      }
    }
    const radiusSq = this.beliefConfig.observeRadius * this.beliefConfig.observeRadius;
    const noise = this.beliefConfig.noiseAmplitude;
    const directAlpha = this.beliefConfig.directAlpha;
    const rumorAlpha = this.beliefConfig.rumorAlpha;
    const decayAlpha = this.beliefConfig.decayAlpha;

    for (const observer of active) {
      const observerCenter = observer.center || observer.centerPosition;
      for (const target of active) {
        if (target.id === observer.id) continue;
        const signal = this.buildSettlementSignal(target);
        const targetCenter = target.center || target.centerPosition;
        const dSq = distSq(observerCenter, targetCenter);
        const routeKey = this.getRouteKeyBySettlements(observer.id, target.id);
        const tradeWeight = routeKey ? clamp((tradeConfidence.get(routeKey) || 0) / tradeMax, 0, 1) : 0;
        const infoWeight = routeKey ? clamp((infoConfidence.get(routeKey) || 0) / infoMax, 0, 1) : 0;
        const observerInfo = clamp(observer.innovationEffects?.infoFlowBonus || 0, 0, 0.2);
        const targetInfo = clamp(target.innovationEffects?.infoFlowBonus || 0, 0, 0.2);
        const routeSignal = clamp(
          (tradeWeight * 0.65 + infoWeight * 0.35) * (1 + observerInfo + targetInfo),
          0,
          1.6
        );
        const alpha = dSq <= radiusSq
          ? directAlpha * (1 + observerInfo)
          : (routeSignal > 0 ? rumorAlpha * clamp(routeSignal, 0.45, 1.4) : decayAlpha);

        const key = this.settlementBeliefKey(observer.id, target.id);
        const prev = this.settlementBeliefs.get(key) || {
          ...signal,
          lastTick: this.tick
        };
        const jitter = () => (this.nextRandom() * 2 - 1) * noise;

        const next = {
          beliefFood: clamp(prev.beliefFood + ((signal.beliefFood + jitter()) - prev.beliefFood) * alpha, 0, 1),
          beliefThreat: clamp(prev.beliefThreat + ((signal.beliefThreat + jitter()) - prev.beliefThreat) * alpha, 0, 1),
          beliefStability: clamp(prev.beliefStability + ((signal.beliefStability + jitter()) - prev.beliefStability) * alpha, 0, 1),
          beliefTradeReliability: clamp(
            prev.beliefTradeReliability + ((signal.beliefTradeReliability + jitter()) - prev.beliefTradeReliability) * alpha,
            0,
            1
          ),
          lastTick: this.tick
        };
        this.settlementBeliefs.set(key, next);
      }
    }
  }


  updateSettlementStressAxes() {
    for (const settlement of this.settlements) {
      if (!isSettlementActive(settlement)) {
        settlement.economicStress = 0;
        settlement.securityStress = 0;
        settlement.legitimacyStress = 0;
        settlement.socialStress = 0;
        settlement.environmentStress = 0;
        settlement.compositeStress = 0;
        settlement.pressureAxes = {
          economicStress: 0,
          securityStress: 0,
          legitimacyStress: 0,
          socialStress: 0,
          environmentStress: 0,
          compositeStress: 0
        };
        continue;
      }

      const foodStress = clamp(settlement.resourceEMA?.foodStress || 0, 0, 1);
      const conflictRate = clamp(settlement.conflictRate || 0, 0, 1);
      const frontierPressure = clamp(settlement.frontierPressure || 0, 0, 1);
      const migrationOutRate = clamp(settlement.migrationOutRate || 0, 0, 1);
      const migrationChurn = clamp(settlement.migrationInRate || 0, 0, 1);
      const wealthPerCap = clamp((settlement.wealthPerCap || 0) / 2.2, 0, 1);
      const resourcePressure = clamp(settlement.resourcePressure || 0, 0, 1);
      const saturation = clamp(settlement.influenceSaturation?.saturationLevel || 0, 0, 1);
      const legitimacyRelief = clamp(settlement.innovationEffects?.legitimacyRelief || 0, 0, 0.16);
      const shockPenalty = clamp(settlement.shockEffects?.stabilityPenalty || 0, 0, 0.02);

      const economicStress = clamp(0.55 * foodStress + 0.25 * resourcePressure + 0.2 * (1 - wealthPerCap), 0, 1);
      const securityStress = clamp(0.65 * conflictRate + 0.35 * frontierPressure, 0, 1);
      const socialStress = clamp(0.6 * migrationOutRate + 0.25 * frontierPressure + 0.15 * migrationChurn, 0, 1);
      const legitimacyStress = clamp(0.45 * economicStress + 0.35 * securityStress + 0.2 * socialStress - legitimacyRelief + shockPenalty * 4, 0, 1);
      const environmentStress = clamp(0.6 * resourcePressure + 0.4 * saturation, 0, 1);
      const compositeStress = clamp(
        0.32 * economicStress +
        0.26 * securityStress +
        0.18 * legitimacyStress +
        0.14 * socialStress +
        0.1 * environmentStress,
        0,
        1
      );

      settlement.economicStress = Number(economicStress.toFixed(4));
      settlement.securityStress = Number(securityStress.toFixed(4));
      settlement.legitimacyStress = Number(legitimacyStress.toFixed(4));
      settlement.socialStress = Number(socialStress.toFixed(4));
      settlement.environmentStress = Number(environmentStress.toFixed(4));
      settlement.compositeStress = Number(compositeStress.toFixed(4));
      settlement.pressureAxes = {
        economicStress: settlement.economicStress,
        securityStress: settlement.securityStress,
        legitimacyStress: settlement.legitimacyStress,
        socialStress: settlement.socialStress,
        environmentStress: settlement.environmentStress,
        compositeStress: settlement.compositeStress
      };
    }
  }


  getSettlementStressMix(settlement) {
    if (!settlement) {
      return {
        economicStress: 0,
        securityStress: 0,
        legitimacyStress: 0,
        socialStress: 0,
        environmentStress: 0,
        compositeStress: 0
      };
    }
    return {
      economicStress: clamp(settlement.economicStress || 0, 0, 1),
      securityStress: clamp(settlement.securityStress || 0, 0, 1),
      legitimacyStress: clamp(settlement.legitimacyStress || 0, 0, 1),
      socialStress: clamp(settlement.socialStress || 0, 0, 1),
      environmentStress: clamp(settlement.environmentStress || 0, 0, 1),
      compositeStress: clamp(settlement.compositeStress || 0, 0, 1)
    };
  }


  updateAgentInfluenceContext(activeSettlements = this.getActiveSettlements()) {
    this.agentDominantInfluence.clear();
    if (!activeSettlements.length) {
      for (const agent of this.agents) {
        agent.contested = 0;
        agent.influenceTopSettlementId = null;
        agent.influenceSecondSettlementId = null;
      }
      return;
    }

    for (const agent of this.agents) {
      const top = computeTopInfluenceSources(agent.position, activeSettlements, {
        sigma: this.influenceConfig.sigma,
        closestK: this.influenceConfig.closestK
      });
      const topId = top.top?.id || null;
      const secondId = top.second?.id || null;
      agent.contested = clamp(top.contested || 0, 0, 1);
      agent.influenceTopSettlementId = topId;
      agent.influenceSecondSettlementId = secondId;
      if (topId) {
        this.agentDominantInfluence.set(agent.id, topId);
      }
    }
  }

}

module.exports = SettlementSimulationMethods;

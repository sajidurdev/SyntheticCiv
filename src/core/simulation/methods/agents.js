const {
  RollingCounter,
  scoreMoveWithInfluence,
  computeInfluenceSteering,
  applyAgentEvent,
  getSentiment,
  pairKey,
  isSettlementActive,
  RESOURCE_TYPES,
  clamp,
  distSq
} = require("../scope");

const MARKET_COMMODITIES = new Set(["food", "materials", "wealth"]);

class AgentSimulationMethods {
  getSettlementById(id) {
    if (!id || id === "wild") return null;
    return this.settlements.find((s) => s.id === id) || null;
  }


  getAgentSettlementId(agentId) {
    return this.agentSettlement.get(agentId) || "wild";
  }


  getAgentCivilization(agentId) {
    const sid = this.getAgentSettlementId(agentId);
    if (!sid || sid === "wild") return null;
    return this.settlementToCiv.get(sid) || null;
  }


  getCivilizationById(civId) {
    if (!civId) return null;
    return this.civilizations.find((c) => c.id === civId) || null;
  }


  getStrategyForAgent(agentId) {
    const civId = this.getAgentCivilization(agentId);
    const civ = this.getCivilizationById(civId);
    if (!civ) {
      return null;
    }
    return civ.strategyModifiers || null;
  }


  ensureAgentCombatState(agent) {
    if (!Number.isFinite(agent.morale)) {
      agent.morale = 0.5;
    }
    if (!Number.isFinite(agent.warExhaustion)) {
      agent.warExhaustion = 0;
    }
    agent.morale = clamp(agent.morale, 0, 1);
    agent.warExhaustion = clamp(agent.warExhaustion, 0, 1);
  }


  computeSettlementSupplyFactor(settlement) {
    if (!settlement) {
      return 0.8;
    }
    const food = clamp(settlement.foodPerCap || 0, 0, 1);
    const materials = clamp((settlement.materialsPerCap || 0) / 2.2, 0, 1);
    const pressure = clamp(settlement.resourcePressure || 0, 0, 1);
    const logistics = clamp(settlement.innovationEffects?.militarySupplyBonus || 0, 0, 0.25);
    const shockPenalty = clamp(1 - (1 - (settlement.shockEffects?.tradeReliabilityMult ?? 1)) * 0.6, 0.5, 1.1);
    return clamp((0.58 + food * 0.2 + materials * 0.16 + logistics - pressure * 0.14) * shockPenalty, 0.35, 1.25);
  }


  computeCivProjectionFactor(civId, position) {
    if (!civId || !position) {
      return 1;
    }
    const civ = this.getCivilizationById(civId);
    if (!civ?.centroid) {
      return 1;
    }
    const civSettlements = (civ.settlementIds || [])
      .map((sid) => this.getSettlementById(sid))
      .filter(Boolean);
    const avgLogistics = civSettlements.length
      ? civSettlements.reduce((acc, s) => acc + (s.innovationEffects?.tradeRangeMult || 1), 0) / civSettlements.length
      : 1;
    const scale = this.logisticsConfig.projectionDistanceScale * clamp(avgLogistics, 0.7, 1.5);
    const d = Math.hypot((position.x || 0) - civ.centroid.x, (position.y || 0) - civ.centroid.y);
    return clamp(1 / (1 + d / Math.max(8, scale)), this.logisticsConfig.minProjectionFactor, 1);
  }


  updateAgentPsyche(agent, homeSettlement = null) {
    this.ensureAgentCombatState(agent);
    const conflict = clamp(homeSettlement?.conflictRate || 0, 0, 1);
    const stress = clamp(homeSettlement?.securityStress || homeSettlement?.compositeStress || 0, 0, 1);
    const stability = clamp(homeSettlement?.stability || homeSettlement?.stabilityScore || 0.5, 0, 1);

    agent.warExhaustion = clamp(
      agent.warExhaustion * 0.997 + conflict * 0.0009 + stress * 0.0006,
      0,
      1
    );
    const moraleTarget = clamp(0.52 + stability * 0.24 - conflict * 0.2 - agent.warExhaustion * 0.28, 0.05, 0.95);
    agent.morale = clamp(agent.morale + (moraleTarget - agent.morale) * 0.02, 0, 1);
    if (agent.energy < 24) {
      agent.morale = clamp(agent.morale - 0.006, 0, 1);
    }
  }


  getAverageAffinity(agent, neighbors) {
    if (!neighbors.length) return 0;
    let sum = 0;
    for (const n of neighbors) {
      const rel = agent.relations[String(n.id)];
      if (typeof rel === "number") {
        sum += rel;
      } else if (rel) {
        sum += (rel.trust || 0) + (rel.momentum || 0) * 0.5;
      }
    }
    return sum / neighbors.length;
  }


  getNeighborhoodAggression(neighbors) {
    if (!neighbors.length) return 0;
    let sum = 0;
    for (const n of neighbors) {
      sum += n.traits.aggression;
    }
    return sum / neighbors.length;
  }


  getMarketCommodityForInventoryType(resourceType) {
    if (resourceType === "food") {
      return "food";
    }
    if (resourceType === "ore" || resourceType === "fiber" || resourceType === "materials") {
      return "materials";
    }
    if (resourceType === "wealth") {
      return "wealth";
    }
    return "materials";
  }


  getAgentCommodityInventory(agent, commodity, inventoryOverride = null) {
    const inv = inventoryOverride || agent.inventory || {};
    if (commodity === "food") {
      return Math.max(0, inv.food || 0);
    }
    if (commodity === "materials") {
      return Math.max(0, (inv.ore || 0) + (inv.fiber || 0) + (inv.materials || 0));
    }
    return Math.max(0, inv.wealth || 0);
  }


  getSettlementMarketPrice(settlement, commodity) {
    if (!settlement) {
      return 1;
    }
    const price = settlement.market?.prices?.[commodity];
    return clamp(Number.isFinite(price) ? price : 1, 0.25, 4);
  }


  getAgentNeedWeight(agent, commodity, settlement, inventoryOverride = null) {
    if (commodity === "food") {
      const qty = this.getAgentCommodityInventory(agent, "food", inventoryOverride);
      const inventoryScarcity = clamp(1 - qty / 4.5, 0, 1);
      const energyNeed = clamp((60 - (agent.energy || 0)) / 60, 0, 1);
      const localStress = clamp(
        (settlement?.resourceEMA?.foodStress ?? settlement?.economicStress ?? 0),
        0,
        1
      );
      return 1 + inventoryScarcity * 1.25 + energyNeed * 0.95 + localStress * 0.5;
    }
    if (commodity === "materials") {
      const qty = this.getAgentCommodityInventory(agent, "materials", inventoryOverride);
      const inventoryScarcity = clamp(1 - qty / 5.4, 0, 1);
      const localStress = clamp(settlement?.resourceEMA?.materialStress || 0, 0, 1);
      return 1 + inventoryScarcity * 1.05 + localStress * 0.48;
    }
    const pressure = clamp(settlement?.resourcePressure || 0, 0, 1);
    return 1 + pressure * 0.3;
  }


  getAgentCommodityValue(agent, commodity, settlement, inventoryOverride = null) {
    const price = this.getSettlementMarketPrice(settlement, commodity);
    const needWeight = this.getAgentNeedWeight(agent, commodity, settlement, inventoryOverride);
    return price * needWeight;
  }


  ensureSettlementMarketObservation(settlement) {
    if (!settlement) {
      return null;
    }
    if (!settlement.market || typeof settlement.market !== "object") {
      settlement.market = {
        prices: { food: 1, materials: 1, wealth: 1 },
        volatility: 0.03,
        lastUpdateTick: this.tick,
        tickObs: {
          attempts: { food: 0, materials: 0, wealth: 0 },
          failures: { food: 0, materials: 0, wealth: 0 },
          successObservedPriceSum: { food: 0, materials: 0, wealth: 0 },
          successObservedPriceCount: { food: 0, materials: 0, wealth: 0 }
        }
      };
    }
    if (!settlement.market.tickObs || typeof settlement.market.tickObs !== "object") {
      settlement.market.tickObs = {};
    }
    const obs = settlement.market.tickObs;
    for (const key of ["attempts", "failures", "successObservedPriceSum", "successObservedPriceCount"]) {
      if (!obs[key] || typeof obs[key] !== "object") {
        obs[key] = {};
      }
    }
    for (const type of MARKET_COMMODITIES) {
      obs.attempts[type] = Math.max(0, Number.isFinite(obs.attempts[type]) ? obs.attempts[type] : 0);
      obs.failures[type] = Math.max(0, Number.isFinite(obs.failures[type]) ? obs.failures[type] : 0);
      obs.successObservedPriceSum[type] = Math.max(
        0,
        Number.isFinite(obs.successObservedPriceSum[type]) ? obs.successObservedPriceSum[type] : 0
      );
      obs.successObservedPriceCount[type] = Math.max(
        0,
        Number.isFinite(obs.successObservedPriceCount[type]) ? obs.successObservedPriceCount[type] : 0
      );
    }
    return obs;
  }


  recordSettlementMarketObservation(settlementId, commodity, update = {}) {
    if (!settlementId || settlementId === "wild" || !MARKET_COMMODITIES.has(commodity)) {
      return;
    }
    const settlement = this.getSettlementById(settlementId);
    const obs = this.ensureSettlementMarketObservation(settlement);
    if (!obs) {
      return;
    }
    if (update.attempt === true) {
      obs.attempts[commodity] += 1;
    }
    if (update.failure === true) {
      obs.failures[commodity] += 1;
    }
    const observedPrice = update.successObservedPrice;
    if (Number.isFinite(observedPrice) && observedPrice > 0) {
      obs.successObservedPriceSum[commodity] += observedPrice;
      obs.successObservedPriceCount[commodity] += 1;
    }
  }


  calculateActionScores(agent, neighbors) {
    const cell = this.getCell(agent.position.x, agent.position.y);
    const avgAffinity = this.getAverageAffinity(agent, neighbors);
    const localAggression = this.getNeighborhoodAggression(neighbors);
    const inventoryTotal = RESOURCE_TYPES.reduce((acc, type) => acc + agent.inventory[type], 0);
    const scarcity = clamp(1 - inventoryTotal / 18, 0, 1);
    const energyPressure = clamp(1 - agent.energy / 120, 0, 1);

    const scoreGather =
      cell.resourceAmount * 0.35 +
      (cell.resourceType === agent.preferredResource ? 4 : 0) +
      energyPressure * 5 +
      scarcity * 3 -
      localAggression * 1.5;

    const scoreMove =
      1.4 +
      agent.traits.risk * 2.5 +
      energyPressure * 0.9 +
      scarcity * 1.2 +
      this.nextRandom() * 0.8;

    const scoreTrade =
      neighbors.length * (0.8 + agent.traits.social * 2.5) +
      (avgAffinity + 1) * 1.4 +
      scarcity * 1.1;

    const scoreCooperate =
      neighbors.length * (0.5 + agent.traits.social * 2.8) +
      (avgAffinity + 1) * 1.8 -
      agent.traits.aggression * 2;

    const scoreCompete =
      neighbors.length * (0.6 + agent.traits.aggression * 2.8) +
      (1 - avgAffinity) * 2.1 +
      localAggression * 0.9 +
      agent.traits.risk * 1.5;

    return {
      gather: scoreGather,
      move: scoreMove,
      trade: scoreTrade,
      cooperate: scoreCooperate,
      compete: scoreCompete
    };
  }


  findTradeTarget(agent) {
    const activeSettlements = this.getActiveSettlements();
    if (activeSettlements.length < 2) {
      return null;
    }
    const home = this.getSettlementById(this.getAgentSettlementId(agent.id));
    const strategy = this.getStrategyForAgent(agent.id);
    const tradeBias = strategy?.tradeBias || 0;
    const homeRegional = home?.regionalInfluence || null;
    const homeRegionalBias = home ? (this.regionalTradeBiasBySettlement.get(home.id) || 0) : 0;
    const homeSaturationSpread = home ? (this.saturationTradeSpreadBySettlement.get(home.id) || 0) : 0;
    const homeDensity = home?.influenceSaturation?.localDensity || 0;
    const homeTariff = home ? (this.tariffRateBySettlement.get(home.id) ?? 0.5) : 0.5;
    const homeBorder = home ? (this.borderOpennessBySettlement.get(home.id) ?? 0.5) : 0.5;
    const homeTradeRange = clamp(home?.innovationEffects?.tradeRangeMult || 1, 0.8, 1.5);
    let best = null;
    let bestScore = -Infinity;

    for (const settlement of activeSettlements) {
      if (home && settlement.id === home.id) continue;
      const center = settlement.center || settlement.centerPosition;
      const dx = center.x - agent.position.x;
      const dy = center.y - agent.position.y;
      const distance = Math.max(4, Math.hypot(dx, dy));
      const distanceReliability = clamp(
        Math.exp(-distance / Math.max(1, this.tradeDistanceConfig.targetDistanceDecay * homeTradeRange)),
        0.28,
        1
      );
      const score = (
        (settlement.population || 1) * (0.7 + tradeBias * 0.05) +
        (settlement.tradeFlow || 0) * (0.35 + tradeBias * 0.06) +
        (settlement.stability || 0) * 8
      ) / distance;
      const belief = this.getSettlementBelief(home?.id || "wild", settlement);
      const perceivedReliability = clamp(belief?.beliefTradeReliability ?? 0.5, 0, 1);
      const perceivedThreat = clamp(belief?.beliefThreat ?? 0.5, 0, 1);
      const perceivedStability = clamp(belief?.beliefStability ?? 0.5, 0, 1);
      const perceivedFood = clamp(belief?.beliefFood ?? 0.5, 0, 1);
      const beliefMultiplier = clamp(
        0.78 +
        perceivedReliability * 0.24 +
        perceivedStability * 0.08 +
        perceivedFood * 0.06 -
        perceivedThreat * 0.2,
        0.55,
        1.25
      );
      const candidateRegional = settlement.regionalInfluence || null;
      const candidateTariff = this.tariffRateBySettlement.get(settlement.id) ?? 0.5;
      const candidateBorder = this.borderOpennessBySettlement.get(settlement.id) ?? 0.5;
      const candidateShockReliability = clamp(settlement.shockEffects?.tradeReliabilityMult ?? 1, 0.5, 1.2);
      const candidateInnovationReliability = clamp(
        1 + (settlement.innovationEffects?.tradeReliabilityBonus || 0),
        0.8,
        1.25
      );
      let regionalMultiplier = 1;
      if (homeRegional && candidateRegional) {
        if (
          homeRegional.dominantCivId &&
          candidateRegional.dominantCivId &&
          homeRegional.dominantCivId === candidateRegional.dominantCivId
        ) {
          regionalMultiplier += 0.08;
        }
        if (
          home?.civId &&
          candidateRegional.dominantCivId &&
          candidateRegional.dominantCivId !== home.civId
        ) {
          regionalMultiplier -= 0.12 * (candidateRegional.conflictPressure || 0);
        }
      }
      regionalMultiplier += homeRegionalBias * 0.4;
      const routeKey = home ? this.getRouteKeyBySettlements(home.id, settlement.id) : null;
      const routeMomentum = routeKey ? this.getRouteMomentum(routeKey) : 0;
      const routeAge = routeKey ? this.getRouteAge(routeKey) : 0;
      const momentumBonus =
        routeMomentum * this.tradeMomentumConfig.momentumMultiplier +
        Math.min(0.45, routeAge * 0.0009);

      const candidateDensity = settlement.influenceSaturation?.localDensity || 0;
      const densitySpreadFactor = homeSaturationSpread > 0
        ? clamp((homeDensity - candidateDensity) / Math.max(20, homeDensity + 1), -0.35, 1)
        : 0;
      regionalMultiplier += homeSaturationSpread * densitySpreadFactor * 0.55;

      const tariffPenalty = clamp(1 - ((homeTariff + candidateTariff) * 0.5) * 0.22, 0.6, 1);
      const borderMultiplier = clamp(0.88 + (homeBorder + candidateBorder) * 0.12, 0.72, 1.15);
      const finalScore =
        score *
        clamp(regionalMultiplier, 0.6, 1.35) *
        distanceReliability *
        beliefMultiplier *
        tariffPenalty *
        borderMultiplier *
        candidateShockReliability *
        candidateInnovationReliability +
        momentumBonus * distanceReliability;
      if (finalScore > bestScore) {
        bestScore = finalScore;
        best = center;
      }
    }
    return best;
  }


  updateAgents() {
    const activeSettlements = this.getActiveSettlements();
    for (const agent of this.agents) {
      this.ensureAgentCombatState(agent);
      const neighbors = this.getNearbyAgents(agent, this.interactionRadius);
      const scores = this.calculateActionScores(agent, neighbors);
      const action = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
      agent.currentAction = action;

      if (action === "gather") {
        this.handleGather(agent);
      } else if (action === "move" || (neighbors.length === 0 && action !== "gather") || action === "trade") {
        this.handleMove(agent, action, activeSettlements);
      }

      agent.energy -= 0.55 + agent.traits.greed * 0.18;
      if (agent.energy < 20) {
        this.consumeInventoryForEnergy(agent);
      }
      agent.energy = clamp(agent.energy, 10, 145);
      this.updateAgentPsyche(agent, this.getSettlementById(this.getAgentSettlementId(agent.id)));
    }
    this.updateAgentInfluenceContext(activeSettlements);
  }


  consumeInventoryForEnergy(agent) {
    const choices = [...RESOURCE_TYPES].sort((a, b) => agent.inventory[b] - agent.inventory[a]);
    const target = choices[0];
    if (agent.inventory[target] >= 0.7) {
      agent.inventory[target] -= 0.7;
      agent.energy += 8;
    }
  }


  handleGather(agent) {
    const cell = this.getCell(agent.position.x, agent.position.y);
    const amount = Math.min(cell.resourceAmount, 0.5 + agent.traits.greed * 1.6);
    if (amount <= 0) return;

    cell.resourceAmount = clamp(cell.resourceAmount - amount, 0, cell.maxResource);
    if (cell.resourceAmount < cell.maxResource * 0.6) {
      cell.resourceType = this.randomChoice(RESOURCE_TYPES);
    }

    agent.inventory[cell.resourceType] += amount;
    agent.energy += amount * (cell.resourceType === agent.preferredResource ? 2.4 : 1.5);
  }


  handleMove(agent, action = "move", activeSettlements = this.getActiveSettlements()) {
    const directions = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: -1, y: 1 }
    ];

    const tradeTarget = action === "trade" ? this.findTradeTarget(agent) : null;
    const currentSettlement = this.getSettlementById(this.getAgentSettlementId(agent.id));
    const strategy = this.getStrategyForAgent(agent.id);
    const strategyMigrationBias = strategy?.migrationBias || 0;
    if (!agent.velocity) {
      agent.velocity = { x: 0, y: 0 };
    }
    const steering = computeInfluenceSteering(agent.position, activeSettlements, {
      sigma: this.influenceConfig.sigma,
      closestK: this.influenceConfig.closestK
    });
    let accelX = steering.x * this.influenceConfig.movementGain;
    let accelY = steering.y * this.influenceConfig.movementGain;
    const accelMag = Math.hypot(accelX, accelY);
    if (accelMag > this.influenceConfig.maxAccelPerTick) {
      const scale = this.influenceConfig.maxAccelPerTick / accelMag;
      accelX *= scale;
      accelY *= scale;
    }
    agent.velocity.x = (agent.velocity.x + accelX) * this.influenceConfig.velocityDecay;
    agent.velocity.y = (agent.velocity.y + accelY) * this.influenceConfig.velocityDecay;
    const velMag = Math.hypot(agent.velocity.x, agent.velocity.y);
    if (velMag > this.influenceConfig.maxVelocity) {
      const scale = this.influenceConfig.maxVelocity / velMag;
      agent.velocity.x *= scale;
      agent.velocity.y *= scale;
    }

    let best = null;
    let bestScore = -Infinity;
    for (const d of directions) {
      const nx = clamp(agent.position.x + d.x, 0, this.width - 1);
      const ny = clamp(agent.position.y + d.y, 0, this.height - 1);
      const cell = this.getCell(nx, ny);
      const crowd = this.getNearbyCountAt(nx, ny, 3);

      let travelBias = 0;
      if (tradeTarget) {
        const before = Math.hypot(tradeTarget.x - agent.position.x, tradeTarget.y - agent.position.y);
        const after = Math.hypot(tradeTarget.x - nx, tradeTarget.y - ny);
        const tradePullDecay = 1 / (1 + before / Math.max(1, this.movementFrictionConfig.tradePullDistanceDecay));
        travelBias = (before - after) * 3.5 * tradePullDecay;
      }

      let score =
        cell.resourceAmount * (cell.resourceType === agent.preferredResource ? 1.6 : 1) +
        cell.regenRate * 6 -
        crowd * 0.8 +
        travelBias +
        this.nextRandom() * (1.1 + agent.traits.risk);

      const moveMag = Math.hypot(d.x, d.y);
      if (moveMag > 0) {
        const moveX = d.x / moveMag;
        const moveY = d.y / moveMag;
        const steerDot = moveX * agent.velocity.x + moveY * agent.velocity.y;
        score += steerDot * this.influenceConfig.directionalWeight;
        score -= this.movementFrictionConfig.stepCost;
        const velMagLocal = Math.hypot(agent.velocity.x, agent.velocity.y);
        if (velMagLocal > 1e-6) {
          const normDot = clamp(steerDot / velMagLocal, -1, 1);
          const turnPenalty = (1 - normDot) * 0.5 * this.movementFrictionConfig.turnCost;
          score -= turnPenalty;
        }
      }

      score = scoreMoveWithInfluence(
        agent,
        { x: nx, y: ny },
        score,
        activeSettlements,
        { width: this.width, height: this.height },
        {
          alpha: 0.35 + strategyMigrationBias * 0.06,
          influenceMax: 1.1,
          currentSettlement,
          strategyModifiers: strategy,
          sigma: this.influenceConfig.sigma,
          closestK: this.influenceConfig.closestK
        }
      );

      if (score > bestScore) {
        bestScore = score;
        best = { x: nx, y: ny };
      }
    }

    if (best) {
      agent.position = best;
    }
  }


  handleInteractions() {
    const seen = new Set();
    const budgetByAgent = new Map();
    const perAgentBudget = Math.max(1, Math.floor(this.interactionBudgetPerAgent));
    const neighborCap = Math.max(1, Math.floor(this.interactionNeighborSampleCap));
    const globalPairCap = Math.max(
      this.agents.length,
      Math.floor(this.agents.length * perAgentBudget * this.interactionGlobalPairScale)
    );
    for (const agent of this.agents) {
      budgetByAgent.set(agent.id, perAgentBudget);
    }

    let consideredPairs = 0;
    let processedPairs = 0;
    let seenDedupSkips = 0;
    let budgetSkips = 0;
    let globalCapSkips = 0;
    let nearbySampledTotal = 0;

    for (const agent of this.agents) {
      const nearby = this.getNearbyAgents(agent, this.interactionRadius);
      nearby.sort((a, b) => {
        const da = distSq(agent.position, a.position);
        const db = distSq(agent.position, b.position);
        if (Math.abs(da - db) > 1e-9) return da - db;
        return a.id - b.id;
      });
      const sampled = nearby.slice(0, neighborCap);
      nearbySampledTotal += sampled.length;

      for (const other of sampled) {
        if (processedPairs >= globalPairCap) {
          globalCapSkips += 1;
          break;
        }
        consideredPairs += 1;
        const key = pairKey(agent.id, other.id);
        if (seen.has(key)) {
          seenDedupSkips += 1;
          continue;
        }
        const budgetA = budgetByAgent.get(agent.id) || 0;
        const budgetB = budgetByAgent.get(other.id) || 0;
        if (budgetA <= 0 || budgetB <= 0) {
          budgetSkips += 1;
          continue;
        }
        seen.add(key);
        budgetByAgent.set(agent.id, budgetA - 1);
        budgetByAgent.set(other.id, budgetB - 1);
        this.processPairInteraction(agent, other);
        processedPairs += 1;
      }
      if (processedPairs >= globalPairCap) {
        break;
      }
    }

    this.lastInteractionDiagnostics = {
      consideredPairs,
      processedPairs,
      seenDedupSkips,
      budgetSkips,
      globalCapSkips,
      globalPairCap,
      avgNearbySampled: this.agents.length > 0 ? nearbySampledTotal / this.agents.length : 0
    };
  }


  processPairInteraction(agentA, agentB) {
    const key = pairKey(agentA.id, agentB.id);
    const position = {
      x: (agentA.position.x + agentB.position.x) / 2,
      y: (agentA.position.y + agentB.position.y) / 2
    };
    const frontierFactor = Math.max(agentA.contested || 0, agentB.contested || 0);
    const isFrontier = frontierFactor > this.influenceConfig.frontierThreshold;
    const socialIntents = new Set(["trade", "cooperate", "compete"]);
    const intentA = agentA.currentAction || "move";
    const intentB = agentB.currentAction || "move";
    const socialEligible = socialIntents.has(intentA) || socialIntents.has(intentB);

    const settlementAId = this.getAgentSettlementId(agentA.id);
    const settlementBId = this.getAgentSettlementId(agentB.id);
    const civAId = this.getAgentCivilization(agentA.id);
    const civBId = this.getAgentCivilization(agentB.id);
    const sameSettlement = settlementAId !== "wild" && settlementAId === settlementBId;
    const pairDistance = Math.sqrt(distSq(agentA.position, agentB.position));
    const infoBridgeEligible = (
      ((intentA === "move" || intentB === "move") && pairDistance <= this.infoContactRadius) ||
      sameSettlement ||
      socialEligible
    );

    const lastContact = this.contactCooldown.get(key) || -9999;
    if (infoBridgeEligible && this.tick - lastContact >= 3) {
      this.contactCooldown.set(key, this.tick);
      this.recordEvent({
        type: "info_contact",
        agentA: agentA.id,
        agentB: agentB.id,
        position,
        tick: this.tick,
        settlementA: settlementAId,
        settlementB: settlementBId,
        civA: civAId,
        civB: civBId
      });
      this.registerInfoContact(settlementAId, settlementBId);
      if (isFrontier) {
        this.frontierContactCount.increment(this.tick, 1);
        this.trackCivBorderEvent(agentA, agentB, "contact", frontierFactor);
      }
    }

    if (!socialEligible) {
      return;
    }

    const sentiment = getSentiment(agentA, agentB, this.tick);
    const threshold = 0.22;
    const avgSocial = (agentA.traits.social + agentB.traits.social) / 2;
    const avgAggression = (agentA.traits.aggression + agentB.traits.aggression) / 2;
    const stratA = this.getStrategyForAgent(agentA.id);
    const stratB = this.getStrategyForAgent(agentB.id);
    const settlementA = this.getSettlementById(settlementAId);
    const settlementB = this.getSettlementById(settlementBId);
    const beliefAB = this.getSettlementBelief(settlementAId, settlementB);
    const beliefBA = this.getSettlementBelief(settlementBId, settlementA);
    const perceivedThreat = clamp(
      ((beliefAB?.beliefThreat ?? 0.5) + (beliefBA?.beliefThreat ?? 0.5)) * 0.5,
      0,
      1
    );
    const perceivedReliability = clamp(
      ((beliefAB?.beliefTradeReliability ?? 0.5) + (beliefBA?.beliefTradeReliability ?? 0.5)) * 0.5,
      0,
      1
    );
    const perceivedStability = clamp(
      ((beliefAB?.beliefStability ?? 0.5) + (beliefBA?.beliefStability ?? 0.5)) * 0.5,
      0,
      1
    );
    const stressA = this.getSettlementStressMix(settlementA);
    const stressB = this.getSettlementStressMix(settlementB);
    const avgSecurityStress = (stressA.securityStress + stressB.securityStress) * 0.5;
    const avgLegitimacyStress = (stressA.legitimacyStress + stressB.legitimacyStress) * 0.5;
    const regionalA = settlementA?.regionalInfluence || null;
    const regionalB = settlementB?.regionalInfluence || null;
    const economyConflictSensitivity = (
      (this.conflictSensitivityBySettlement.get(settlementAId) || 0) +
      (this.conflictSensitivityBySettlement.get(settlementBId) || 0)
    ) * 0.5;
    const policyTradeOpenness = (
      (this.tradeOpennessBySettlement.get(settlementAId) || 0.5) +
      (this.tradeOpennessBySettlement.get(settlementBId) || 0.5)
    ) * 0.5;
    const diplomacyFrictionRelief = (
      (this.diplomacyFrictionReliefBySettlement.get(settlementAId) || 0) +
      (this.diplomacyFrictionReliefBySettlement.get(settlementBId) || 0)
    ) * 0.5;
    const avgTariff = (
      (this.tariffRateBySettlement.get(settlementAId) ?? 0.5) +
      (this.tariffRateBySettlement.get(settlementBId) ?? 0.5)
    ) * 0.5;
    const avgBorderOpenness = (
      (this.borderOpennessBySettlement.get(settlementAId) ?? 0.5) +
      (this.borderOpennessBySettlement.get(settlementBId) ?? 0.5)
    ) * 0.5;
    const avgConscription = (
      (this.conscriptionBySettlement.get(settlementAId) ?? 0.5) +
      (this.conscriptionBySettlement.get(settlementBId) ?? 0.5)
    ) * 0.5;
    const tradeBias = ((stratA?.tradeBias || 0) + (stratB?.tradeBias || 0)) * 0.5;
    const conflictTolerance = ((stratA?.conflictTolerance || 0) + (stratB?.conflictTolerance || 0)) * 0.5;
    const avgMorale = clamp(((agentA.morale ?? 0.5) + (agentB.morale ?? 0.5)) * 0.5, 0, 1);
    const avgWarExhaustion = clamp(((agentA.warExhaustion ?? 0) + (agentB.warExhaustion ?? 0)) * 0.5, 0, 1);

    const epsilon = this.interactionWeightEpsilon;
    let wTrade = Math.max(epsilon, 0.1 + avgSocial * 0.25);
    let wCooperate = Math.max(epsilon, 0.08 + avgSocial * 0.22);
    let wConflict = Math.max(epsilon, 0.05 + avgAggression * 0.24);

    const applyIntentMultipliers = (intent) => {
      if (intent === "trade") {
        wTrade *= 1.45;
        wCooperate *= 1.12;
        wConflict *= 0.78;
      } else if (intent === "cooperate") {
        wTrade *= 1.08;
        wCooperate *= 1.5;
        wConflict *= 0.72;
      } else if (intent === "compete") {
        wTrade *= 0.84;
        wCooperate *= 0.82;
        wConflict *= 1.45;
      }
    };
    applyIntentMultipliers(intentA);
    applyIntentMultipliers(intentB);

    if (sentiment > threshold) {
      wTrade += 0.18;
      wCooperate += 0.14;
      wConflict -= 0.16;
    } else if (sentiment < -threshold) {
      wTrade -= 0.15;
      wCooperate -= 0.11;
      wConflict += 0.2;
    }

    wTrade += tradeBias * 0.07;
    wCooperate += tradeBias * 0.04;
    wConflict += conflictTolerance * 0.08;
    wConflict += economyConflictSensitivity;
    wTrade += (policyTradeOpenness - 0.5) * 0.06;
    wCooperate += (policyTradeOpenness - 0.5) * 0.03;
    wConflict -= diplomacyFrictionRelief * 0.06;
    wTrade -= avgTariff * 0.05;
    wTrade += (avgBorderOpenness - 0.5) * 0.05;
    wCooperate += (avgBorderOpenness - 0.5) * 0.03;
    wConflict += (avgConscription - 0.5) * 0.08;
    wConflict -= avgWarExhaustion * 0.07;
    wCooperate += avgWarExhaustion * 0.04;
    wTrade += (avgMorale - 0.5) * 0.03;
    wConflict += (0.5 - avgMorale) * 0.04;
    wTrade += (perceivedReliability - 0.5) * 0.08 + (perceivedStability - 0.5) * 0.04;
    wCooperate += (perceivedStability - 0.5) * 0.07 + (perceivedReliability - 0.5) * 0.03;
    wConflict += (perceivedThreat - 0.5) * 0.1;
    wTrade -= avgSecurityStress * 0.03;
    wCooperate -= avgLegitimacyStress * 0.025;
    wConflict += avgSecurityStress * 0.04 + avgLegitimacyStress * 0.02;

    if (
      regionalA &&
      regionalB &&
      regionalA.dominantCivId &&
      regionalB.dominantCivId &&
      regionalA.dominantCivId === regionalB.dominantCivId
    ) {
      wTrade += 0.035;
      wCooperate += 0.018;
      wConflict -= 0.022;
    } else if (
      regionalA &&
      regionalB &&
      regionalA.dominantCivId &&
      regionalB.dominantCivId &&
      regionalA.dominantCivId !== regionalB.dominantCivId
    ) {
      const opposingPressure = ((regionalA.conflictPressure || 0) + (regionalB.conflictPressure || 0)) * 0.5;
      wTrade -= 0.05 * opposingPressure;
      wConflict += 0.04 * opposingPressure;
    }

    if (settlementA?.civId && settlementB?.civId && settlementA.civId !== settlementB.civId) {
      const borderFriction = clamp(1 - avgBorderOpenness, 0, 1);
      wTrade -= borderFriction * 0.035;
      wCooperate -= borderFriction * 0.015;
      wConflict += borderFriction * 0.022;
    }

    wTrade -= frontierFactor * this.influenceConfig.frontierTradeBias;
    wCooperate -= frontierFactor * this.influenceConfig.frontierCooperateBias;
    wConflict += frontierFactor * this.influenceConfig.frontierConflictBias;

    if (this.influenceConfig.interactionBiasEnabled) {
      const dominantA = this.agentDominantInfluence.get(agentA.id) || null;
      const dominantB = this.agentDominantInfluence.get(agentB.id) || null;
      if (dominantA && dominantA === dominantB) {
        wTrade += this.influenceConfig.sameZoneTradeBonus;
        wCooperate += this.influenceConfig.sameZoneCooperateBonus;
        wConflict -= this.influenceConfig.sameZoneConflictPenalty;
      }
    }

    wTrade = Math.max(epsilon, wTrade);
    wCooperate = Math.max(epsilon, wCooperate);
    wConflict = Math.max(epsilon, wConflict);

    const cooldownUntil = this.conflictCooldown.get(key) || -1;
    if (this.tick < cooldownUntil) {
      wConflict = 0;
    }

    const summed = wTrade + wCooperate + wConflict;
    if (summed > 0.8) {
      const scale = 0.8 / summed;
      wTrade *= scale;
      wCooperate *= scale;
      wConflict *= scale;
    }

    const tradeW = Math.max(0, wTrade);
    const cooperateW = Math.max(0, wCooperate);
    const conflictW = Math.max(0, wConflict);
    const noneW = Math.max(this.interactionNoneWeightFloor, 1 - (tradeW + cooperateW + conflictW));
    const totalW = tradeW + cooperateW + conflictW + noneW;
    const roll = this.nextRandom() * totalW;

    let outcome = "none";
    if (roll < tradeW) {
      outcome = "trade";
    } else if (roll < tradeW + cooperateW) {
      outcome = "cooperate";
    } else if (roll < tradeW + cooperateW + conflictW) {
      outcome = "conflict";
    }

    if (outcome === "trade") {
      this.tryTrade(agentA, agentB, position);
      return;
    }
    if (outcome === "cooperate") {
      this.tryCooperate(agentA, agentB, position);
      return;
    }
    if (outcome === "conflict") {
      const didConflict = this.tryConflict(agentA, agentB, position);
      if (didConflict) {
        if (isFrontier) {
          this.frontierConflictCount.increment(this.tick, 1);
          this.trackCivBorderEvent(agentA, agentB, "conflict", frontierFactor);
        }
        this.conflictCooldown.set(key, this.tick + this.conflictCooldownTicks);
      }
    }
  }


  pickGiveResource(agent, wantedByOther) {
    if (agent.inventory[wantedByOther] > 1.1 && wantedByOther !== agent.preferredResource) {
      return wantedByOther;
    }

    let best = null;
    let bestQty = 1.1;
    for (const type of RESOURCE_TYPES) {
      const qty = agent.inventory[type];
      if (qty <= bestQty) continue;
      if (type === agent.preferredResource && qty < 2.5) continue;
      bestQty = qty;
      best = type;
    }
    return best;
  }

  tryTrade(agentA, agentB, position) {
    const settlementAId = this.getAgentSettlementId(agentA.id);
    const settlementBId = this.getAgentSettlementId(agentB.id);
    const settlementA = this.getSettlementById(settlementAId);
    const settlementB = this.getSettlementById(settlementBId);
    const desiredCommodityA = this.getMarketCommodityForInventoryType(agentB.preferredResource);
    const desiredCommodityB = this.getMarketCommodityForInventoryType(agentA.preferredResource);
    this.recordSettlementMarketObservation(settlementAId, desiredCommodityA, { attempt: true });
    this.recordSettlementMarketObservation(settlementBId, desiredCommodityB, { attempt: true });

    const giveA = this.pickGiveResource(agentA, agentB.preferredResource);
    const giveB = this.pickGiveResource(agentB, agentA.preferredResource);
    if (!giveA || !giveB) {
      this.recordSettlementMarketObservation(settlementAId, desiredCommodityA, { failure: true });
      this.recordSettlementMarketObservation(settlementBId, desiredCommodityB, { failure: true });
      return false;
    }
    if (agentA.inventory[giveA] < 1 || agentB.inventory[giveB] < 1) {
      this.recordSettlementMarketObservation(settlementAId, desiredCommodityA, { failure: true });
      this.recordSettlementMarketObservation(settlementBId, desiredCommodityB, { failure: true });
      return false;
    }

    const giveCommodityA = this.getMarketCommodityForInventoryType(giveA);
    const giveCommodityB = this.getMarketCommodityForInventoryType(giveB);

    const beforeA = this.computeUtility(agentA);
    const beforeB = this.computeUtility(agentB);

    const invA = { ...agentA.inventory };
    const invB = { ...agentB.inventory };
    invA[giveA] -= 1;
    invA[giveB] += 1;
    invB[giveB] -= 1;
    invB[giveA] += 1;

    const afterA = this.computeUtility(agentA, invA);
    const afterB = this.computeUtility(agentB, invB);
    const giveValueA = this.getAgentCommodityValue(agentA, giveCommodityA, settlementA);
    const recvValueA = this.getAgentCommodityValue(agentA, giveCommodityB, settlementA, invA);
    const giveValueB = this.getAgentCommodityValue(agentB, giveCommodityB, settlementB);
    const recvValueB = this.getAgentCommodityValue(agentB, giveCommodityA, settlementB, invB);
    const valueTolerance = 0.9;
    const valueApproved = recvValueA >= giveValueA * valueTolerance && recvValueB >= giveValueB * valueTolerance;

    if (afterA <= beforeA || afterB <= beforeB || !valueApproved) {
      this.recordSettlementMarketObservation(settlementAId, desiredCommodityA, { failure: true });
      this.recordSettlementMarketObservation(settlementBId, desiredCommodityB, { failure: true });
      return false;
    }

    agentA.inventory = invA;
    agentB.inventory = invB;
    agentA.energy = clamp(agentA.energy + 1.2, 0, 145);
    agentB.energy = clamp(agentB.energy + 1.2, 0, 145);

    const observedPriceA = this.getSettlementMarketPrice(settlementA, giveCommodityA);
    const observedPriceB = this.getSettlementMarketPrice(settlementB, giveCommodityB);
    this.recordSettlementMarketObservation(settlementAId, giveCommodityB, { successObservedPrice: observedPriceA });
    this.recordSettlementMarketObservation(settlementBId, giveCommodityA, { successObservedPrice: observedPriceB });

    applyAgentEvent(agentA, agentB, "trade", this.tick);

    const civA = this.getAgentCivilization(agentA.id);
    const civB = this.getAgentCivilization(agentB.id);

    this.recordEvent({
      type: "trade",
      agentA: agentA.id,
      agentB: agentB.id,
      value: Number((afterA - beforeA + (afterB - beforeB)).toFixed(3)),
      resourceType: `${giveA}/${giveB}`,
      position,
      tick: this.tick,
      settlementA: settlementAId,
      settlementB: settlementBId,
      civA,
      civB
    });

    if (civA && civB && civA !== civB) {
      this.registerAlignmentTradeEffects(settlementAId, settlementBId, civA, civB);
    }

    if (
      settlementAId &&
      settlementBId &&
      settlementAId !== settlementBId &&
      settlementAId !== "wild" &&
      settlementBId !== "wild"
    ) {
      const fromSettlement = this.getSettlementById(settlementAId);
      const toSettlement = this.getSettlementById(settlementBId);
      if (!isSettlementActive(fromSettlement) || !isSettlementActive(toSettlement)) {
        return true;
      }
      const routeKey = this.getRouteKeyBySettlements(settlementAId, settlementBId);
      if (!this.pairTradeWindows.has(routeKey)) {
        this.pairTradeWindows.set(routeKey, new RollingCounter(this.windowSize));
      }
      this.pairTradeWindows.get(routeKey).increment(this.tick, 1);
      this.registerRouteTradeSuccess(routeKey);
    }

    return true;
  }


  tryCooperate(agentA, agentB, position) {
    let transferred = 0;
    if (agentA.energy > agentB.energy + 8) {
      transferred = 2;
      agentA.energy -= transferred;
      agentB.energy += transferred;
    } else if (agentB.energy > agentA.energy + 8) {
      transferred = 2;
      agentB.energy -= transferred;
      agentA.energy += transferred;
    } else {
      const donor = agentA.inventory[agentB.preferredResource] > agentB.inventory[agentA.preferredResource]
        ? agentA
        : agentB;
      const receiver = donor.id === agentA.id ? agentB : agentA;
      const resource = receiver.preferredResource;
      if (donor.inventory[resource] >= 0.7) {
        donor.inventory[resource] -= 0.7;
        receiver.inventory[resource] += 0.7;
        transferred = 0.7;
      }
    }

    if (transferred <= 0) {
      return false;
    }

    applyAgentEvent(agentA, agentB, "cooperate", this.tick);

    this.recordEvent({
      type: "cooperate",
      agentA: agentA.id,
      agentB: agentB.id,
      value: Number(transferred.toFixed(2)),
      resourceType: "support",
      position,
      tick: this.tick,
      settlementA: this.getAgentSettlementId(agentA.id),
      settlementB: this.getAgentSettlementId(agentB.id),
      civA: this.getAgentCivilization(agentA.id),
      civB: this.getAgentCivilization(agentB.id)
    });
    return true;
  }


  totalInventory(agent) {
    return RESOURCE_TYPES.reduce((acc, type) => acc + agent.inventory[type], 0);
  }


  stealResource(winner, loser) {
    const options = RESOURCE_TYPES.filter((type) => loser.inventory[type] > 0.3);
    if (!options.length) {
      return "none";
    }
    options.sort((a, b) => loser.inventory[b] - loser.inventory[a]);
    const chosen = options[0];
    const amount = Math.min(0.9, loser.inventory[chosen]);
    loser.inventory[chosen] -= amount;
    winner.inventory[chosen] += amount;
    return chosen;
  }


  tryConflict(agentA, agentB, position) {
    const sentiment = getSentiment(agentA, agentB, this.tick);
    if (sentiment > 0.5 && this.nextRandom() < 0.65) {
      return false;
    }

    this.ensureAgentCombatState(agentA);
    this.ensureAgentCombatState(agentB);
    const settlementA = this.getSettlementById(this.getAgentSettlementId(agentA.id));
    const settlementB = this.getSettlementById(this.getAgentSettlementId(agentB.id));
    const civAId = this.getAgentCivilization(agentA.id);
    const civBId = this.getAgentCivilization(agentB.id);
    const civA = this.getCivilizationById(civAId);
    const civB = this.getCivilizationById(civBId);

    const supplyA = this.computeSettlementSupplyFactor(settlementA);
    const supplyB = this.computeSettlementSupplyFactor(settlementB);
    const projectionA = this.computeCivProjectionFactor(civAId, position);
    const projectionB = this.computeCivProjectionFactor(civBId, position);
    const commandA = clamp(
      0.82 +
      this.nextRandom() * 0.32 +
      (civA?.culture?.aggressionBias || 0) * 0.04 +
      (civA?.culture?.stabilityFocus || 0) * 0.03 +
      (settlementA?.innovationEffects?.militarySupplyBonus || 0),
      0.62,
      1.35
    );
    const commandB = clamp(
      0.82 +
      this.nextRandom() * 0.32 +
      (civB?.culture?.aggressionBias || 0) * 0.04 +
      (civB?.culture?.stabilityFocus || 0) * 0.03 +
      (settlementB?.innovationEffects?.militarySupplyBonus || 0),
      0.62,
      1.35
    );

    const powerA =
      (agentA.energy * 0.014 +
        agentA.traits.aggression * 1.75 +
        agentA.traits.risk * 0.7 +
        this.nextRandom()) *
      clamp(0.5 + (agentA.morale || 0.5), 0.35, 1.35) *
      clamp(1 - (agentA.warExhaustion || 0) * 0.55, 0.4, 1) *
      supplyA *
      projectionA *
      commandA;
    const powerB =
      (agentB.energy * 0.014 +
        agentB.traits.aggression * 1.75 +
        agentB.traits.risk * 0.7 +
        this.nextRandom()) *
      clamp(0.5 + (agentB.morale || 0.5), 0.35, 1.35) *
      clamp(1 - (agentB.warExhaustion || 0) * 0.55, 0.4, 1) *
      supplyB *
      projectionB *
      commandB;

    const winner = powerA >= powerB ? agentA : agentB;
    const loser = winner.id === agentA.id ? agentB : agentA;
    const stolen = this.stealResource(winner, loser);

    winner.energy = clamp(winner.energy - 1.8, 0, 145);
    loser.energy = clamp(loser.energy - 3.4, 0, 145);

    applyAgentEvent(agentA, agentB, "conflict", this.tick);

    winner.morale = clamp((winner.morale || 0.5) + 0.035, 0, 1);
    loser.morale = clamp((loser.morale || 0.5) - 0.055, 0, 1);
    winner.warExhaustion = clamp((winner.warExhaustion || 0) + 0.018, 0, 1);
    loser.warExhaustion = clamp((loser.warExhaustion || 0) + 0.034, 0, 1);
    if (settlementA?.knowledge && settlementB?.knowledge) {
      const adaptation = 0.00055;
      settlementA.knowledge.logistics = clamp((settlementA.knowledge.logistics || 0) + adaptation * projectionA, 0, 1);
      settlementB.knowledge.logistics = clamp((settlementB.knowledge.logistics || 0) + adaptation * projectionB, 0, 1);
      settlementA.knowledge.medicine = clamp((settlementA.knowledge.medicine || 0) + adaptation * 0.5, 0, 1);
      settlementB.knowledge.medicine = clamp((settlementB.knowledge.medicine || 0) + adaptation * 0.5, 0, 1);
    }

    this.recordEvent({
      type: "conflict",
      agentA: agentA.id,
      agentB: agentB.id,
      winner: winner.id,
      value: Number((this.totalInventory(winner) - this.totalInventory(loser)).toFixed(2)),
      resourceType: stolen,
      details: {
        supplyA: Number(supplyA.toFixed(3)),
        supplyB: Number(supplyB.toFixed(3)),
        projectionA: Number(projectionA.toFixed(3)),
        projectionB: Number(projectionB.toFixed(3)),
        commandA: Number(commandA.toFixed(3)),
        commandB: Number(commandB.toFixed(3))
      },
      position,
      tick: this.tick,
      settlementA: this.getAgentSettlementId(agentA.id),
      settlementB: this.getAgentSettlementId(agentB.id),
      civA: this.getAgentCivilization(agentA.id),
      civB: this.getAgentCivilization(agentB.id)
    });

    const settlementAId = this.getAgentSettlementId(agentA.id);
    const settlementBId = this.getAgentSettlementId(agentB.id);
    const routeKey = this.getRouteKeyBySettlements(settlementAId, settlementBId);
    if (routeKey) {
      this.registerRouteConflictPenalty(routeKey);
    }
    return true;
  }

}

module.exports = AgentSimulationMethods;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomRange(rng, min, max) {
  return min + rng() * (max - min);
}

function getCenter(settlement) {
  return settlement.center || settlement.centerPosition || { x: 0, y: 0 };
}

function computeCarryingCap(world, perAgentNeed) {
  const need = Math.max(1e-6, perAgentNeed);
  let totalResources = 0;
  for (let y = 0; y < world.height; y += 1) {
    for (let x = 0; x < world.width; x += 1) {
      const cell = world.grid[y][x];
      totalResources += (cell.resourceAmount || 0) + (cell.regenRate || 0) * 80;
    }
  }
  return Math.max(1, Math.floor(totalResources / need));
}

function resolveCulture(civId, cultureByCivId) {
  if (!civId || !cultureByCivId) {
    return null;
  }
  if (cultureByCivId instanceof Map) {
    return cultureByCivId.get(civId) || null;
  }
  return cultureByCivId[civId] || null;
}

function baseTraitsFromCulture(culture) {
  if (!culture) {
    return {
      risk: 0.5,
      greed: 0.5,
      social: 0.5,
      aggression: 0.5
    };
  }

  const cooperation = clamp(culture.cooperationBias || 0, -1, 1);
  const aggressionBias = clamp(culture.aggressionBias || 0, -1, 1);
  const tradePreference = clamp(culture.tradePreference || 0, -1, 1);
  const expansionism = clamp(culture.expansionism || 0, -1, 1);
  const stabilityFocus = clamp(culture.stabilityFocus || 0, -1, 1);

  return {
    risk: clamp(0.5 + expansionism * 0.22 + aggressionBias * 0.08, 0.05, 0.95),
    greed: clamp(0.5 + tradePreference * 0.24 + expansionism * 0.08, 0.05, 0.95),
    social: clamp(0.5 + cooperation * 0.23 + tradePreference * 0.12, 0.05, 0.95),
    aggression: clamp(0.5 + aggressionBias * 0.28 - stabilityFocus * 0.08, 0.05, 0.95)
  };
}

function sampleTraitsFromCulture(culture, rng, noise = 0.12) {
  const base = baseTraitsFromCulture(culture);
  return {
    risk: clamp(base.risk + randomRange(rng, -noise, noise), 0, 1),
    greed: clamp(base.greed + randomRange(rng, -noise, noise), 0, 1),
    social: clamp(base.social + randomRange(rng, -noise, noise), 0, 1),
    aggression: clamp(base.aggression + randomRange(rng, -noise, noise), 0, 1)
  };
}

function pickPreferredResource(world, position, rng, resourceTypes) {
  const x = clamp(Math.round(position.x), 0, world.width - 1);
  const y = clamp(Math.round(position.y), 0, world.height - 1);
  const cellType = world.grid[y]?.[x]?.resourceType;
  if (cellType && resourceTypes.includes(cellType)) {
    return cellType;
  }
  return resourceTypes[Math.floor(rng() * resourceTypes.length)];
}

function buildBirthFactors(settlement, population, options) {
  const stability = clamp(settlement.stability ?? settlement.stabilityScore ?? 0, 0, 1);
  const pressure = clamp(settlement.resourcePressure ?? 0, 0, 1);
  const conflictRate = clamp(settlement.conflictRate ?? 0, 0, 1);
  const tradeFlowNorm = clamp(
    settlement.tradeFlowNorm ?? (settlement.tradeFlow || settlement.tradeVolume || 0) / (population * 2.2 + 1),
    0,
    1
  );
  const birthMultiplierRaw = Number.isFinite(settlement.birthMultiplier) ? settlement.birthMultiplier : 1;
  const innovationBirthMult = clamp(settlement.innovationEffects?.birthRateMult ?? 1, 0.75, 1.2);
  const shockBirthMult = clamp(settlement.shockEffects?.birthMultiplierMult ?? 1, 0.55, 1.1);
  const birthMultiplier = clamp(birthMultiplierRaw * innovationBirthMult * shockBirthMult, 0, 1.1);
  const factors = {
    stabilityFactor: 0.4 + 0.8 * stability,
    pressureFactor: 1 - pressure,
    conflictFactor: 1 - 0.7 * conflictRate,
    tradeFactor: 0.7 + 0.3 * tradeFlowNorm,
    foodFactor: birthMultiplier
  };
  const localBirthRate =
    options.baseBirth *
    factors.stabilityFactor *
    factors.pressureFactor *
    factors.conflictFactor *
    factors.tradeFactor *
    factors.foodFactor;
  return {
    stability,
    pressure,
    conflictRate,
    tradeFlowNorm,
    ...factors,
    localBirthRate: Math.max(0, localBirthRate)
  };
}

function buildDeathFactors(settlement, options) {
  const stress = clamp(
    settlement.compositeStress ?? settlement.resourceEMA?.foodStress ?? 0,
    0,
    1
  );
  const conflict = clamp(settlement.conflictRate ?? 0, 0, 1);
  const pressure = clamp(settlement.resourcePressure ?? 0, 0, 1);
  const foodProd = Math.max(0, settlement.economyRaw?.foodProd ?? 0);
  const foodCons = Math.max(0, settlement.economyRaw?.foodCons ?? 0);
  const foodDeficitRatio = clamp((foodCons - foodProd) / Math.max(foodCons, 1e-6), 0, 1);

  const base = options.baseDeath;
  const stressTerm = options.deathStressCoef * stress * stress;
  const conflictTerm = options.deathConflictCoef * conflict * conflict;
  const foodTerm = options.deathFoodCoef * foodDeficitRatio;
  const pressureTerm = options.deathPressureCoef * pressure * pressure;
  const innovationDeathMult = clamp(settlement.innovationEffects?.deathRiskMult ?? 1, 0.65, 1.25);
  const shockDeathMult = clamp(settlement.shockEffects?.deathRiskMult ?? 1, 0.8, 1.5);
  const shockDeathAdd = Math.max(0, settlement.shockEffects?.deathRateAdd ?? 0);
  const deathRate = Math.max(0, (base + stressTerm + conflictTerm + foodTerm + pressureTerm) * innovationDeathMult * shockDeathMult + shockDeathAdd);

  return {
    stress,
    conflict,
    pressure,
    foodDeficitRatio,
    foodProd,
    foodCons,
    innovationDeathMult,
    shockDeathMult,
    shockDeathAdd,
    deathRate
  };
}

function emptySuppressionBuckets() {
  return {
    stabilityFactor: 0,
    pressureFactor: 0,
    conflictFactor: 0,
    tradeFactor: 0,
    foodFactor: 0,
    logisticLimiter: 0
  };
}

function stepDemographics(world, agents, settlements, tick, rng, options = {}) {
  const opts = {
    maxAgents: options.maxAgents ?? 2000,
    perAgentNeed: options.perAgentNeed ?? 120,
    baseBirth: options.baseBirth ?? 0.0006,
    baseDeath: options.baseDeath ?? 0.000002,
    deathStressCoef: options.deathStressCoef ?? 0.00002,
    deathConflictCoef: options.deathConflictCoef ?? 0.000015,
    deathFoodCoef: options.deathFoodCoef ?? 0.00003,
    deathPressureCoef: options.deathPressureCoef ?? 0.00001,
    enableDeaths: options.enableDeaths ?? true,
    newbornEnergy: options.newbornEnergy ?? 72,
    spawnRadius: options.spawnRadius ?? 3,
    traitNoise: options.traitNoise ?? 0.12,
    maxBirthsPerSettlementPerTick: options.maxBirthsPerSettlementPerTick ?? 2,
    resourceTypes: options.resourceTypes || ["food", "ore", "fiber"]
  };

  const carryingCap = computeCarryingCap(world, opts.perAgentNeed);
  const effectiveCap = Math.max(1, Math.min(opts.maxAgents, carryingCap));
  const logisticLimiter = clamp(1 - agents.length / effectiveCap, 0, 1);

  const membersBySettlementId = options.membersBySettlementId || null;
  const cultureByCivId = options.cultureByCivId || null;
  const agentSettlement = options.agentSettlement || null;
  const birthReservoir = options.birthReservoir instanceof Map ? options.birthReservoir : new Map();
  const deathReservoir = options.deathReservoir instanceof Map ? options.deathReservoir : new Map();
  const settlementById = new Map(settlements.map((s) => [s.id, s]));

  let nextAgentId = options.nextAgentId;
  if (!Number.isFinite(nextAgentId)) {
    let maxId = 0;
    for (const agent of agents) {
      if (Number.isFinite(agent.id)) {
        maxId = Math.max(maxId, agent.id);
      }
    }
    nextAgentId = maxId + 1;
  }

  const births = [];
  const sortedSettlements = [...settlements].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  let projectedAgents = agents.length;
  const birthDiagnostics = {
    settlementsConsidered: 0,
    populationConsidered: 0,
    expectedBirthsTotal: 0,
    expectedBirthsFromSettlementSum: 0,
    birthAttempts: 0,
    birthsSucceeded: 0,
    weightedBirthRateSum: 0,
    factorWeightedSums: {
      stabilityFactor: 0,
      pressureFactor: 0,
      conflictFactor: 0,
      tradeFactor: 0,
      foodFactor: 0,
      logisticLimiter: 0
    },
    suppressionWins: emptySuppressionBuckets(),
    settlementBreakdown: []
  };

  for (const settlement of sortedSettlements) {
    if (projectedAgents >= effectiveCap) {
      break;
    }

    const members = membersBySettlementId?.get(settlement.id);
    const population = Array.isArray(members) ? members.length : Math.max(0, settlement.population || 0);
    if (population <= 0) {
      continue;
    }

    const factors = buildBirthFactors(settlement, population, opts);
    const birthRate = Math.max(0, factors.localBirthRate * logisticLimiter);
    const expectedBirths = Math.max(0, birthRate * population);
    // Reservoir sampling keeps very low expected rates from vanishing to zero each tick :)
    const previousReservoir = birthReservoir.get(settlement.id) || 0;
    const reservoirWithExpected = previousReservoir + expectedBirths;
    const attempts = Math.floor(reservoirWithExpected);
    const fractional = reservoirWithExpected - attempts;

    birthDiagnostics.settlementsConsidered += 1;
    birthDiagnostics.populationConsidered += population;
    birthDiagnostics.expectedBirthsTotal += expectedBirths;
    birthDiagnostics.expectedBirthsFromSettlementSum += expectedBirths;
    birthDiagnostics.birthAttempts += attempts;
    birthDiagnostics.weightedBirthRateSum += birthRate * population;
    birthDiagnostics.factorWeightedSums.stabilityFactor += factors.stabilityFactor * population;
    birthDiagnostics.factorWeightedSums.pressureFactor += factors.pressureFactor * population;
    birthDiagnostics.factorWeightedSums.conflictFactor += factors.conflictFactor * population;
    birthDiagnostics.factorWeightedSums.tradeFactor += factors.tradeFactor * population;
    birthDiagnostics.factorWeightedSums.foodFactor += factors.foodFactor * population;
    birthDiagnostics.factorWeightedSums.logisticLimiter += logisticLimiter * population;

    const suppressionFactors = {
      stabilityFactor: factors.stabilityFactor,
      pressureFactor: factors.pressureFactor,
      conflictFactor: factors.conflictFactor,
      tradeFactor: factors.tradeFactor,
      foodFactor: factors.foodFactor,
      logisticLimiter
    };
    let weakestName = "logisticLimiter";
    let weakestValue = suppressionFactors.logisticLimiter;
    for (const [name, value] of Object.entries(suppressionFactors)) {
      if (value < weakestValue) {
        weakestName = name;
        weakestValue = value;
      }
    }
    birthDiagnostics.suppressionWins[weakestName] += 1;

    let count = attempts;
    count = Math.min(count, opts.maxBirthsPerSettlementPerTick);
    const capacityRemaining = Math.max(0, effectiveCap - projectedAgents);
    const birthsFromAttempts = Math.min(count, capacityRemaining);
    const spilloverAttempts = Math.max(0, attempts - birthsFromAttempts);
    const reservoirAfter = Math.min(
      opts.maxBirthsPerSettlementPerTick * 4,
      fractional + spilloverAttempts
    );
    birthReservoir.set(settlement.id, reservoirAfter);
    birthDiagnostics.settlementBreakdown.push({
      settlementId: settlement.id,
      population,
      birthRate,
      expectedBirths,
      attempts,
      births: birthsFromAttempts,
      reservoir: reservoirAfter,
      ...factors
    });
    if (birthsFromAttempts <= 0) {
      continue;
    }

    const center = getCenter(settlement);
    const culture = resolveCulture(settlement.civId, cultureByCivId);

    for (let i = 0; i < birthsFromAttempts; i += 1) {
      const pos = {
        x: clamp(center.x + randomRange(rng, -opts.spawnRadius, opts.spawnRadius), 0, world.width - 1),
        y: clamp(center.y + randomRange(rng, -opts.spawnRadius, opts.spawnRadius), 0, world.height - 1)
      };

      births.push({
        id: nextAgentId++,
        position: pos,
        energy: opts.newbornEnergy,
        inventory: {
          food: 0,
          ore: 0,
          fiber: 0
        },
        preferredResource: pickPreferredResource(world, pos, rng, opts.resourceTypes),
        traits: sampleTraitsFromCulture(culture, rng, opts.traitNoise),
        relations: {},
        velocity: { x: 0, y: 0 },
        contested: 0,
        influenceTopSettlementId: null,
        influenceSecondSettlementId: null,
        currentAction: "move",
        morale: 0.5,
        warExhaustion: 0,
        civId: settlement.civId || null,
        bornTick: tick,
        age: 0
      });
    }

    birthDiagnostics.birthsSucceeded += birthsFromAttempts;
    projectedAgents += birthsFromAttempts;
  }

  if (births.length > 0) {
    agents.push(...births);
  }

  const deaths = [];
  const deathDiagnostics = {
    settlementsConsidered: 0,
    populationConsidered: 0,
    expectedDeathsTotal: 0,
    expectedDeathsFromSettlementSum: 0,
    deathAttempts: 0,
    deathsApplied: 0,
    weightedDeathRateSum: 0,
    factorWeightedSums: {
      stress: 0,
      conflict: 0,
      pressure: 0,
      foodDeficitRatio: 0
    },
    settlementBreakdown: []
  };
  if (opts.enableDeaths && agents.length > 0) {
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    const removed = new Set();

    for (const settlement of sortedSettlements) {
      const memberIds = membersBySettlementId?.get(settlement.id);
      const populationIds = Array.isArray(memberIds)
        ? memberIds
        : agents
          .filter((agent) => (agentSettlement?.get(agent.id) || "wild") === settlement.id)
          .map((agent) => agent.id);
      const eligibleIds = populationIds
        .filter((id) => !removed.has(id))
        .filter((id) => {
          const agent = agentById.get(id);
          return agent && agent.bornTick !== tick;
        });
      const population = eligibleIds.length;
      if (population <= 0) continue;

      const factors = buildDeathFactors(settlement, opts);
      const expectedDeaths = Math.max(0, factors.deathRate * population);
      // Same reservoir strategy for deaths to avoid all-or-nothing sparse Bernoulli behavior 
      const prevReservoir = deathReservoir.get(settlement.id) || 0;
      const reservoirWithExpected = prevReservoir + expectedDeaths;
      const attempts = Math.floor(reservoirWithExpected);
      const deathsFromAttempts = Math.min(attempts, population);
      const overflow = Math.max(0, attempts - deathsFromAttempts);
      const reservoirAfter = Math.min(8, (reservoirWithExpected - attempts) + overflow);
      deathReservoir.set(settlement.id, reservoirAfter);

      deathDiagnostics.settlementsConsidered += 1;
      deathDiagnostics.populationConsidered += population;
      deathDiagnostics.expectedDeathsTotal += expectedDeaths;
      deathDiagnostics.expectedDeathsFromSettlementSum += expectedDeaths;
      deathDiagnostics.deathAttempts += attempts;
      deathDiagnostics.weightedDeathRateSum += factors.deathRate * population;
      deathDiagnostics.factorWeightedSums.stress += factors.stress * population;
      deathDiagnostics.factorWeightedSums.conflict += factors.conflict * population;
      deathDiagnostics.factorWeightedSums.pressure += factors.pressure * population;
      deathDiagnostics.factorWeightedSums.foodDeficitRatio += factors.foodDeficitRatio * population;

      let applied = 0;
      if (deathsFromAttempts > 0) {
        const victims = eligibleIds
          .map((id) => agentById.get(id))
          .filter(Boolean)
          .sort((a, b) => (a.energy || 0) - (b.energy || 0) || a.id - b.id)
          .slice(0, deathsFromAttempts);
        for (const victim of victims) {
          removed.add(victim.id);
          deaths.push(victim.id);
        }
        applied = victims.length;
      }
      deathDiagnostics.deathsApplied += applied;
      deathDiagnostics.settlementBreakdown.push({
        settlementId: settlement.id,
        population,
        expectedDeaths,
        attempts,
        deaths: applied,
        reservoir: reservoirAfter,
        ...factors
      });
    }

    for (const agent of agents) {
      if (typeof agent.age === "number") {
        agent.age += 1;
      }
    }

    if (removed.size > 0) {
      const survivors = agents.filter((agent) => !removed.has(agent.id));
      agents.length = 0;
      agents.push(...survivors);
    }
  }

  return {
    births: births.length,
    deaths: deaths.length,
    birthAgentIds: births.map((a) => a.id),
    deathAgentIds: deaths,
    nextAgentId,
    carryingCap,
    effectiveCap,
    logisticLimiter,
    birthDiagnostics: {
      ...birthDiagnostics,
      weightedBirthRate:
        birthDiagnostics.populationConsidered > 0
          ? birthDiagnostics.weightedBirthRateSum / birthDiagnostics.populationConsidered
          : 0,
      avgFactors:
        birthDiagnostics.populationConsidered > 0
          ? {
            stabilityFactor: birthDiagnostics.factorWeightedSums.stabilityFactor / birthDiagnostics.populationConsidered,
            pressureFactor: birthDiagnostics.factorWeightedSums.pressureFactor / birthDiagnostics.populationConsidered,
            conflictFactor: birthDiagnostics.factorWeightedSums.conflictFactor / birthDiagnostics.populationConsidered,
            tradeFactor: birthDiagnostics.factorWeightedSums.tradeFactor / birthDiagnostics.populationConsidered,
            foodFactor: birthDiagnostics.factorWeightedSums.foodFactor / birthDiagnostics.populationConsidered,
            logisticLimiter: birthDiagnostics.factorWeightedSums.logisticLimiter / birthDiagnostics.populationConsidered
          }
          : {
            stabilityFactor: 0,
            pressureFactor: 0,
            conflictFactor: 0,
            tradeFactor: 0,
            foodFactor: 0,
            logisticLimiter: logisticLimiter
          },
      expectedSumMismatch: Math.abs(
        birthDiagnostics.expectedBirthsTotal - birthDiagnostics.expectedBirthsFromSettlementSum
      ),
      settlementBreakdown: birthDiagnostics.settlementBreakdown
        .slice()
        .sort((a, b) => b.expectedBirths - a.expectedBirths)
        .slice(0, 8)
    },
    birthReservoirSize: birthReservoir.size,
    deathDiagnostics: {
      ...deathDiagnostics,
      weightedDeathRate:
        deathDiagnostics.populationConsidered > 0
          ? deathDiagnostics.weightedDeathRateSum / deathDiagnostics.populationConsidered
          : 0,
      avgFactors:
        deathDiagnostics.populationConsidered > 0
          ? {
            stress: deathDiagnostics.factorWeightedSums.stress / deathDiagnostics.populationConsidered,
            conflict: deathDiagnostics.factorWeightedSums.conflict / deathDiagnostics.populationConsidered,
            pressure: deathDiagnostics.factorWeightedSums.pressure / deathDiagnostics.populationConsidered,
            foodDeficitRatio:
              deathDiagnostics.factorWeightedSums.foodDeficitRatio / deathDiagnostics.populationConsidered
          }
          : { stress: 0, conflict: 0, pressure: 0, foodDeficitRatio: 0 },
      expectedSumMismatch: Math.abs(
        deathDiagnostics.expectedDeathsTotal - deathDiagnostics.expectedDeathsFromSettlementSum
      ),
      settlementBreakdown: deathDiagnostics.settlementBreakdown
        .slice()
        .sort((a, b) => b.expectedDeaths - a.expectedDeaths)
        .slice(0, 8)
    },
    deathReservoirSize: deathReservoir.size
  };
}

module.exports = {
  stepDemographics
};

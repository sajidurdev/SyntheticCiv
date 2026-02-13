const { RollingCounter, RollingAvg, RollingVar } = require("../systems/rollingWindow");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function getCenter(settlement) {
  return settlement.center || settlement.centerPosition;
}

function createSettlementWindows(windowSize) {
  return {
    tradeFlow: new RollingCounter(windowSize),
    conflictCount: new RollingCounter(windowSize),
    interactionCount: new RollingCounter(windowSize),
    migrationIn: new RollingCounter(windowSize),
    migrationOut: new RollingCounter(windowSize),
    tradeMean: new RollingAvg(windowSize),
    tradeVar: new RollingVar(windowSize)
  };
}

function hydrateSettlementWindows(serialized, windowSize) {
  if (!serialized) {
    return createSettlementWindows(windowSize);
  }
  return {
    tradeFlow: new RollingCounter(windowSize, serialized.tradeFlow),
    conflictCount: new RollingCounter(windowSize, serialized.conflictCount),
    interactionCount: new RollingCounter(windowSize, serialized.interactionCount),
    migrationIn: new RollingCounter(windowSize, serialized.migrationIn),
    migrationOut: new RollingCounter(windowSize, serialized.migrationOut),
    tradeMean: new RollingAvg(windowSize, serialized.tradeMean),
    tradeVar: new RollingVar(windowSize, serialized.tradeVar)
  };
}

function serializeSettlementWindows(windowsBySettlementId) {
  const out = {};
  for (const [id, windows] of windowsBySettlementId.entries()) {
    out[id] = {
      tradeFlow: windows.tradeFlow.toJSON(),
      conflictCount: windows.conflictCount.toJSON(),
      interactionCount: windows.interactionCount.toJSON(),
      migrationIn: windows.migrationIn.toJSON(),
      migrationOut: windows.migrationOut.toJSON(),
      tradeMean: windows.tradeMean.toJSON(),
      tradeVar: windows.tradeVar.toJSON()
    };
  }
  return out;
}

function radiusForSettlement(settlement, options) {
  const population = Math.max(1, settlement.population || 1);
  const radiusRaw = options.base + options.k * Math.sqrt(population);
  const scaled = radiusRaw * (options.radiusMultiplier ?? 1);
  return clamp(scaled, options.minRadius, options.maxRadius);
}

function updateSettlementMembership(agents, settlements, options = {}) {
  const base = options.base ?? 18;
  const k = options.k ?? 3;
  const minRadius = options.minRadius ?? 20;
  const maxRadius = options.maxRadius ?? 65;
  const enterMargin = options.enterMargin ?? 0.08;
  const exitMargin = options.exitMargin ?? 0.12;
  const radiusMultiplier = options.radiusMultiplier ?? 1;
  const tick = options.tick ?? 0;
  const overcrowdingWeight = options.overcrowdingWeight ?? 0.55;
  const populationSoftCap = options.populationSoftCap ?? 220;
  const influenceBySettlementId = options.influenceBySettlementId || new Map();
  const previousMembership = options.previousMembership || new Map();

  const settlementById = new Map();
  const radiusBySettlementId = new Map();
  const enterBySettlementId = new Map();
  const exitBySettlementId = new Map();
  const membersBySettlementId = new Map();

  for (const settlement of settlements) {
    settlementById.set(settlement.id, settlement);
    membersBySettlementId.set(settlement.id, []);
    const radius = radiusForSettlement(settlement, { base, k, minRadius, maxRadius, radiusMultiplier });
    radiusBySettlementId.set(settlement.id, radius);
    enterBySettlementId.set(settlement.id, radius * (1 - enterMargin));
    exitBySettlementId.set(settlement.id, radius * (1 + exitMargin));
  }

  const membershipByAgentId = new Map();
  const wildAgentIds = [];
  const migrationTransitions = [];

  for (const agent of agents) {
    const prev = previousMembership.get(agent.id) || "wild";
    const prevSettlement = prev !== "wild" ? settlementById.get(prev) : null;

    if (prevSettlement) {
      const center = getCenter(prevSettlement);
      const d = Math.sqrt(distSq(agent.position, center));
      const exitThreshold = exitBySettlementId.get(prevSettlement.id);
      if (d <= exitThreshold) {
        membershipByAgentId.set(agent.id, prevSettlement.id);
        membersBySettlementId.get(prevSettlement.id).push(agent.id);
        continue;
      }
    }

    const candidates = [];
    for (const settlement of settlements) {
      const center = getCenter(settlement);
      const dSq = distSq(agent.position, center);
      const d = Math.sqrt(dSq);
      const enterThreshold = enterBySettlementId.get(settlement.id);
      if (d < enterThreshold) {
        const influence = influenceBySettlementId.get(settlement.id) ?? settlement.influenceStrength ?? 0;
        const saturation = clamp(settlement.influenceSaturation?.saturationLevel || 0, 0, 1);
        const pressure = clamp(settlement.resourcePressure || 0, 0, 1);
        const populationNorm = clamp((settlement.population || 0) / Math.max(1, populationSoftCap), 0, 1);
        let overcrowding = clamp(
          pressure * 0.45 + saturation * 0.35 + populationNorm * 0.2,
          0,
          0.95
        );

        const postSplitProtectionUntil = settlement.postSplitProtectionUntil || 0;
        let supportBonus = 0;
        if (postSplitProtectionUntil > tick) {
          const supportWindow = Math.max(1, settlement.postSplitSupportTicks || 1);
          const supportPhase = clamp((postSplitProtectionUntil - tick) / supportWindow, 0, 1);
          const supportStrength = clamp(settlement.postSplitSupportStrength || 0.22, 0, 0.4);
          overcrowding *= (1 - supportStrength * 0.7);
          supportBonus = supportStrength * 0.08 * supportPhase;
        }

        const diminishing = clamp(1 - overcrowdingWeight * overcrowding, 0.35, 1);
        const score = ((influence + 0.15) * diminishing + supportBonus) / (1 + dSq);
        candidates.push({
          id: settlement.id,
          score,
          dSq
        });
      }
    }

    if (!candidates.length) {
      membershipByAgentId.set(agent.id, "wild");
      wildAgentIds.push(agent.id);
      if (prev !== "wild") {
        migrationTransitions.push({ agentId: agent.id, from: prev, to: "wild" });
      }
      continue;
    }

    candidates.sort((a, b) => {
      const epsilon = 1e-12;
      const scoreDiff = b.score - a.score;
      if (Math.abs(scoreDiff) > epsilon) {
        return scoreDiff;
      }
      const distDiff = a.dSq - b.dSq;
      if (Math.abs(distDiff) > epsilon) {
        return distDiff;
      }
      return String(a.id).localeCompare(String(b.id));
    });

    const chosenId = candidates[0].id;
    membershipByAgentId.set(agent.id, chosenId);
    membersBySettlementId.get(chosenId).push(agent.id);
    if (prev !== chosenId) {
      migrationTransitions.push({ agentId: agent.id, from: prev, to: chosenId });
    }
  }

  return {
    membershipByAgentId,
    membersBySettlementId,
    wildAgentIds,
    migrationTransitions,
    radiusBySettlementId,
    enterBySettlementId,
    exitBySettlementId
  };
}

function sampleResources(world, center, sampleRadiusCells) {
  const cx = Math.round(center.x);
  const cy = Math.round(center.y);
  let total = 0;
  for (let dy = -sampleRadiusCells; dy <= sampleRadiusCells; dy += 1) {
    for (let dx = -sampleRadiusCells; dx <= sampleRadiusCells; dx += 1) {
      if (dx * dx + dy * dy > sampleRadiusCells * sampleRadiusCells) {
        continue;
      }
      const x = clamp(cx + dx, 0, world.width - 1);
      const y = clamp(cy + dy, 0, world.height - 1);
      total += world.grid[y][x].resourceAmount;
    }
  }
  return total;
}

function computeSettlementMetrics(world, agents, settlements, events, tick, context = {}) {
  const windowSize = context.windowSize ?? 2000;
  const windowsBySettlementId = context.windowsBySettlementId || new Map();
  const membersBySettlementId = context.membersBySettlementId || new Map();
  const migrations = context.migrationTransitions || [];
  const consumePerTick = context.consumePerTick ?? 0.64;
  const horizonTicks = context.horizonTicks ?? 200;
  const tradeBySettlement = new Map();
  const conflictBySettlement = new Map();
  const interactionBySettlement = new Map();
  const migrationInBySettlement = new Map();
  const migrationOutBySettlement = new Map();

  const addSettlementCount = (map, settlementA, settlementB, delta = 1) => {
    const a = settlementA && settlementA !== "wild" ? settlementA : null;
    const b = settlementB && settlementB !== "wild" ? settlementB : null;

    if (a && b) {
      if (a === b) {
        map.set(a, (map.get(a) || 0) + delta);
      } else {
        map.set(a, (map.get(a) || 0) + delta);
        map.set(b, (map.get(b) || 0) + delta);
      }
      return;
    }
    if (a) {
      map.set(a, (map.get(a) || 0) + delta);
      return;
    }
    if (b) {
      map.set(b, (map.get(b) || 0) + delta);
    }
  };

  for (const event of events) {
    if (event.type === "trade") {
      if (event.settlementA && event.settlementA !== "wild") {
        tradeBySettlement.set(
          event.settlementA,
          (tradeBySettlement.get(event.settlementA) || 0) + (event.value || 1)
        );
      }
      if (event.settlementB && event.settlementB !== "wild") {
        tradeBySettlement.set(
          event.settlementB,
          (tradeBySettlement.get(event.settlementB) || 0) + (event.value || 1)
        );
      }
    }
    if (event.type === "trade" || event.type === "cooperate" || event.type === "conflict") {
      addSettlementCount(interactionBySettlement, event.settlementA, event.settlementB, 1);
    }
    if (event.type === "conflict") {
      addSettlementCount(conflictBySettlement, event.settlementA, event.settlementB, 1);
    }
  }

  for (const transition of migrations) {
    if (transition.from && transition.from !== "wild") {
      migrationOutBySettlement.set(
        transition.from,
        (migrationOutBySettlement.get(transition.from) || 0) + 1
      );
    }
    if (transition.to && transition.to !== "wild") {
      migrationInBySettlement.set(
        transition.to,
        (migrationInBySettlement.get(transition.to) || 0) + 1
      );
    }
  }

  const agentById = new Map(agents.map((a) => [a.id, a]));
  const metrics = [];

  for (const settlement of settlements) {
    const sid = settlement.id;
    if (!windowsBySettlementId.has(sid)) {
      windowsBySettlementId.set(sid, createSettlementWindows(windowSize));
    }
    const windows = windowsBySettlementId.get(sid);

    const tradeNow = tradeBySettlement.get(sid) || 0;
    const conflictNow = conflictBySettlement.get(sid) || 0;
    const interactionsNow = interactionBySettlement.get(sid) || 0;
    const migrationInNow = migrationInBySettlement.get(sid) || 0;
    const migrationOutNow = migrationOutBySettlement.get(sid) || 0;

    windows.tradeFlow.record(tick, tradeNow);
    windows.conflictCount.record(tick, conflictNow);
    windows.interactionCount.record(tick, interactionsNow);
    windows.migrationIn.record(tick, migrationInNow);
    windows.migrationOut.record(tick, migrationOutNow);
    windows.tradeMean.record(tick, tradeNow);
    windows.tradeVar.record(tick, tradeNow);

    const members = membersBySettlementId.get(sid) || [];
    const population = members.length;
    const avgEnergy = population
      ? members.reduce((acc, id) => acc + (agentById.get(id)?.energy || 0), 0) / population
      : 0;

    const center = getCenter(settlement);
    const availableResources = sampleResources(world, center, context.sampleRadiusCells ?? 8);
    const perCapitaNeed = consumePerTick * horizonTicks;
    const resourcePressure = clamp(
      1 - availableResources / (Math.max(1, population) * perCapitaNeed + 1e-6),
      0,
      1
    );

    const tradeFlow = windows.tradeFlow.sum();
    const mean = windows.tradeMean.avg();
    const variance = windows.tradeVar.variance();
    const tradeVarNorm = variance / (mean * mean + 1e-6);
    const tradeConsistency = 1 - clamp(tradeVarNorm / 2.5, 0, 1);

    const conflictSum = windows.conflictCount.sum();
    const interactionSum = windows.interactionCount.sum();
    const conflictRateRaw = conflictSum / Math.max(1, interactionSum);
    const conflictRate = clamp(conflictRateRaw, 0, 1);

    const migrationIn = windows.migrationIn.sum();
    const migrationOut = windows.migrationOut.sum();

    const resourceBalance = 1 - resourcePressure;
    const frontierPressure = clamp(settlement.frontierPressure || 0, 0, 1);
    const stability = clamp(
      0.4 * resourceBalance +
      0.3 * tradeConsistency +
      0.3 * (1 - conflictRate) -
      frontierPressure * 0.02,
      0,
      1
    );

    const tradeFlowNorm = clamp(tradeFlow / (population * 2.2 + 1), 0, 1);
    const migrationInRate = migrationIn / (windowSize * Math.max(population, 1));
    const migrationOutRate = migrationOut / (windowSize * Math.max(population, 1));
    const migrationNetRate = migrationInRate - migrationOutRate;
    const growthRate = clamp(
      0.03 * (1 - resourcePressure) +
      0.02 * tradeFlowNorm -
      0.035 * conflictRate -
      0.02 * migrationNetRate,
      -0.05,
      0.05
    );

    const metric = {
      id: sid,
      civId: settlement.civId || null,
      center: { ...center },
      centerPosition: { ...center },
      population,
      isRuined: population <= 0,
      avgEnergy: Number(avgEnergy.toFixed(2)),
      tradeFlow: Number(tradeFlow.toFixed(3)),
      tradeVolume: Number(tradeFlow.toFixed(3)),
      tradeFlowNorm: Number(tradeFlowNorm.toFixed(4)),
      conflictRate: Number(conflictRate.toFixed(4)),
      conflictRateRaw: Number(conflictRateRaw.toFixed(6)),
      interactionRateWindow: Number(interactionSum.toFixed(2)),
      conflictCountWindow: Number(conflictSum.toFixed(2)),
      migrationIn: Number(migrationIn.toFixed(2)),
      migrationOut: Number(migrationOut.toFixed(2)),
      migrationInRate: Number(migrationInRate.toFixed(4)),
      migrationOutRate: Number(migrationOutRate.toFixed(4)),
      migrationNetRate: Number(migrationNetRate.toFixed(4)),
      resourcePressure: Number(resourcePressure.toFixed(4)),
      frontierPressure: Number(frontierPressure.toFixed(4)),
      stability: Number(stability.toFixed(4)),
      stabilityScore: Number(stability.toFixed(4)),
      growthRate: Number(growthRate.toFixed(4)),
      tradeConsistency: Number(tradeConsistency.toFixed(4))
    };

    metric.visualState = getSettlementVisualState(metric, tick);
    metrics.push(metric);
  }

  return {
    settlements: metrics,
    windowsBySettlementId
  };
}

function getSettlementVisualState(settlement, tick) {
  const stability = settlement.stability ?? settlement.stabilityScore ?? 0;
  const pressure = settlement.resourcePressure ?? 0;
  const stablePulse = 0.7 + stability * 1.2;
  const frequency = 0.003 + (1 - stability) * 0.002;
  const unstableFactor = clamp((0.45 - stability) / 0.45, 0, 1);
  const jitter = unstableFactor * 1.8;
  const flicker = unstableFactor * (0.45 + 0.55 * Math.sin(tick * 0.75));
  const collapseWarning = stability < 0.2 && pressure > 0.7;

  return {
    pulseAmplitude: stablePulse,
    pulseFrequency: frequency,
    jitter,
    flicker,
    collapseWarningAlpha: collapseWarning ? 0.55 + 0.35 * Math.sin(tick * 0.4) : 0
  };
}

module.exports = {
  updateSettlementMembership,
  computeSettlementMetrics,
  getSettlementVisualState,
  createSettlementWindows,
  hydrateSettlementWindows,
  serializeSettlementWindows
};

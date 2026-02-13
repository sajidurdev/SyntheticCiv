function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function getRelation(civRelations, civA, civB) {
  if (!civA || !civB || civA === civB) return 0;
  return civRelations?.[civA]?.[civB] ?? civRelations?.[civB]?.[civA] ?? 0;
}

function ensureCivAlignment(civilization) {
  if (!civilization.strategicAlignment || typeof civilization.strategicAlignment !== "object") {
    civilization.strategicAlignment = {
      state: "neutral",
      alignmentScore: 0,
      alignedWith: null,
      hostileWith: null,
      components: {
        tradeDependency: 0,
        sharedEnemyFactor: 0,
        proximityInfluence: 0,
        pressurePenalty: 0
      },
      lastUpdatedTick: -1
    };
  }
  return civilization.strategicAlignment;
}

function createStrategicAlignmentState(serialized = null) {
  const state = {
    hostilitySustainByPair: new Map(),
    pairDisposition: new Map(),
    pairScores: new Map(),
    lastUpdatedTick: -1
  };

  if (!serialized || typeof serialized !== "object") {
    return state;
  }

  const sustain = serialized.hostilitySustainByPair || {};
  for (const key of Object.keys(sustain)) {
    state.hostilitySustainByPair.set(key, Math.max(0, Math.floor(sustain[key] || 0)));
  }
  const disposition = serialized.pairDisposition || {};
  for (const key of Object.keys(disposition)) {
    state.pairDisposition.set(key, disposition[key]);
  }
  const scores = serialized.pairScores || {};
  for (const key of Object.keys(scores)) {
    state.pairScores.set(key, Number(scores[key] || 0));
  }
  state.lastUpdatedTick = Number.isFinite(serialized.lastUpdatedTick)
    ? serialized.lastUpdatedTick
    : -1;

  return state;
}

function serializeStrategicAlignmentState(state) {
  const hostilitySustainByPair = {};
  const pairDisposition = {};
  const pairScores = {};
  for (const [key, value] of state.hostilitySustainByPair.entries()) {
    hostilitySustainByPair[key] = value;
  }
  for (const [key, value] of state.pairDisposition.entries()) {
    pairDisposition[key] = value;
  }
  for (const [key, value] of state.pairScores.entries()) {
    pairScores[key] = value;
  }
  return {
    hostilitySustainByPair,
    pairDisposition,
    pairScores,
    lastUpdatedTick: state.lastUpdatedTick
  };
}

function defaultConfig(options = {}) {
  return {
    interval: options.interval ?? 200,
    alignedThreshold: options.alignedThreshold ?? 0.7,
    hostileRelationThreshold: options.hostileRelationThreshold ?? -0.8,
    hostileSustainTicks: options.hostileSustainTicks ?? 600,
    hostilityDecayPerInterval: options.hostilityDecayPerInterval ?? 1,
    tradeDependencyWeight: options.tradeDependencyWeight ?? 0.45,
    sharedEnemyWeight: options.sharedEnemyWeight ?? 0.3,
    proximityWeight: options.proximityWeight ?? 0.35,
    pressurePenaltyWeight: options.pressurePenaltyWeight ?? 0.4
  };
}

function distance(a, b) {
  const dx = (a?.x || 0) - (b?.x || 0);
  const dy = (a?.y || 0) - (b?.y || 0);
  return Math.hypot(dx, dy);
}

function computeSharedEnemyFactor(civA, civB, civIds, civRelations) {
  const enemies = [];
  for (const civC of civIds) {
    if (civC === civA || civC === civB) continue;
    const relAC = getRelation(civRelations, civA, civC);
    const relBC = getRelation(civRelations, civB, civC);
    const hostilityA = clamp01((-relAC - 0.2) / 0.8);
    const hostilityB = clamp01((-relBC - 0.2) / 0.8);
    enemies.push(Math.min(hostilityA, hostilityB));
  }
  if (!enemies.length) return 0;
  return enemies.reduce((acc, v) => acc + v, 0) / enemies.length;
}

function computeStrategicAlignment(
  civilizations,
  settlements,
  civRelations,
  tradeRoutes,
  tick,
  state,
  options = {}
) {
  const cfg = defaultConfig(options);
  const resultState = state || createStrategicAlignmentState();
  const dt = resultState.lastUpdatedTick < 0 ? cfg.interval : Math.max(1, tick - resultState.lastUpdatedTick);
  const force = options?.force === true;
  if (!force && tick % cfg.interval !== 0) {
    return {
      updated: false,
      state: resultState,
      civAlignmentById: new Map(civilizations.map((c) => [c.id, ensureCivAlignment(c)]))
    };
  }

  const settlementById = new Map(settlements.map((s) => [s.id, s]));
  const civIds = civilizations.map((c) => c.id);
  const settlementsByCiv = new Map();
  for (const civ of civilizations) {
    const rows = (civ.settlementIds || [])
      .map((sid) => settlementById.get(sid))
      .filter(Boolean)
      .filter((s) => (s.population || 0) > 0 && !s.isRuined);
    settlementsByCiv.set(civ.id, rows);
  }

  const tradeByPair = new Map();
  const externalTradeTotals = new Map(civIds.map((id) => [id, 0]));
  for (const route of tradeRoutes || []) {
    const from = settlementById.get(route.from);
    const to = settlementById.get(route.to);
    const civA = from?.civId || null;
    const civB = to?.civId || null;
    if (!civA || !civB || civA === civB) continue;
    const volume = Math.max(0, route.rawTradeVolume || route.tradeVolume || route.trades || 0);
    if (volume <= 0) continue;
    const key = pairKey(civA, civB);
    tradeByPair.set(key, (tradeByPair.get(key) || 0) + volume);
    externalTradeTotals.set(civA, (externalTradeTotals.get(civA) || 0) + volume);
    externalTradeTotals.set(civB, (externalTradeTotals.get(civB) || 0) + volume);
  }

  const civPressure = new Map();
  for (const civ of civilizations) {
    const rows = settlementsByCiv.get(civ.id) || [];
    const pressure = rows.length
      ? rows.reduce((acc, s) => acc + (s.resourcePressure || 0), 0) / rows.length
      : 0;
    civPressure.set(civ.id, clamp01(pressure));
  }

  const hostilePairs = new Set();
  const activePairKeys = new Set();
  for (let i = 0; i < civIds.length; i += 1) {
    for (let j = i + 1; j < civIds.length; j += 1) {
      const civA = civIds[i];
      const civB = civIds[j];
      const key = pairKey(civA, civB);
      activePairKeys.add(key);
      const relation = getRelation(civRelations, civA, civB);
      const prev = resultState.hostilitySustainByPair.get(key) || 0;
      let next = prev;
      if (relation <= cfg.hostileRelationThreshold) {
        next += dt;
      } else {
        next = Math.max(0, next - dt * cfg.hostilityDecayPerInterval);
      }
      resultState.hostilitySustainByPair.set(key, next);
      if (next >= cfg.hostileSustainTicks) {
        hostilePairs.add(key);
      }
    }
  }
  for (const key of resultState.hostilitySustainByPair.keys()) {
    if (!activePairKeys.has(key)) {
      resultState.hostilitySustainByPair.delete(key);
    }
  }

  let maxDistance = 1;
  for (let i = 0; i < civilizations.length; i += 1) {
    for (let j = i + 1; j < civilizations.length; j += 1) {
      maxDistance = Math.max(maxDistance, distance(civilizations[i].centroid, civilizations[j].centroid));
    }
  }

  const civAlignmentById = new Map();
  const pairScores = new Map();

  for (const civ of civilizations) {
    const align = ensureCivAlignment(civ);
    let bestScore = -Infinity;
    let bestCiv = null;
    let bestComponents = {
      tradeDependency: 0,
      sharedEnemyFactor: 0,
      proximityInfluence: 0,
      pressurePenalty: civPressure.get(civ.id) * cfg.pressurePenaltyWeight
    };

    let mostHostile = null;
    let mostHostileRel = 1;
    for (const other of civilizations) {
      if (other.id === civ.id) continue;
      const rel = getRelation(civRelations, civ.id, other.id);
      if (rel < mostHostileRel) {
        mostHostileRel = rel;
        mostHostile = other.id;
      }
    }

    for (const other of civilizations) {
      if (other.id === civ.id) continue;
      const key = pairKey(civ.id, other.id);
      const pairTrade = tradeByPair.get(key) || 0;
      const totalTrade = Math.max(1, externalTradeTotals.get(civ.id) || 0);
      const tradeDependency = clamp01(pairTrade / totalTrade) * cfg.tradeDependencyWeight;
      const sharedEnemyRaw = computeSharedEnemyFactor(civ.id, other.id, civIds, civRelations);
      const sharedEnemyFactor = sharedEnemyRaw * cfg.sharedEnemyWeight;
      const proximityRaw = 1 - clamp01(distance(civ.centroid, other.centroid) / maxDistance);
      const proximityInfluence = proximityRaw * cfg.proximityWeight;
      const pressurePenalty = (civPressure.get(civ.id) || 0) * cfg.pressurePenaltyWeight;
      const score = tradeDependency + sharedEnemyFactor + proximityInfluence - pressurePenalty;
      pairScores.set(key, score);
      if (score > bestScore) {
        bestScore = score;
        bestCiv = other.id;
        bestComponents = {
          tradeDependency,
          sharedEnemyFactor,
          proximityInfluence,
          pressurePenalty
        };
      }
    }

    const hostilePairKey = mostHostile ? pairKey(civ.id, mostHostile) : null;
    const sustainedHostile = hostilePairKey ? hostilePairs.has(hostilePairKey) : false;

    let nextState = "neutral";
    if (sustainedHostile && mostHostileRel <= cfg.hostileRelationThreshold) {
      nextState = "hostile";
    } else if (bestScore > cfg.alignedThreshold && bestCiv) {
      nextState = "aligned";
    }

    align.state = nextState;
    align.alignmentScore = Number((Number.isFinite(bestScore) ? bestScore : 0).toFixed(4));
    align.alignedWith = nextState === "aligned" ? bestCiv : null;
    align.hostileWith = nextState === "hostile" ? mostHostile : null;
    align.components = {
      tradeDependency: Number(bestComponents.tradeDependency.toFixed(4)),
      sharedEnemyFactor: Number(bestComponents.sharedEnemyFactor.toFixed(4)),
      proximityInfluence: Number(bestComponents.proximityInfluence.toFixed(4)),
      pressurePenalty: Number(bestComponents.pressurePenalty.toFixed(4))
    };
    align.lastUpdatedTick = tick;
    civAlignmentById.set(civ.id, { ...align });
  }

  const pairDisposition = new Map();
  for (let i = 0; i < civIds.length; i += 1) {
    for (let j = i + 1; j < civIds.length; j += 1) {
      const civA = civIds[i];
      const civB = civIds[j];
      const key = pairKey(civA, civB);
      let disposition = "neutral";
      if (hostilePairs.has(key)) {
        disposition = "hostile";
      } else {
        const alignA = civAlignmentById.get(civA);
        const alignB = civAlignmentById.get(civB);
        const mutual =
          alignA?.state === "aligned" &&
          alignB?.state === "aligned" &&
          alignA.alignedWith === civB &&
          alignB.alignedWith === civA;
        const score = pairScores.get(key) || 0;
        if (mutual || score > cfg.alignedThreshold + 0.08) {
          disposition = "aligned";
        }
      }
      pairDisposition.set(key, disposition);
    }
  }

  resultState.pairDisposition = pairDisposition;
  resultState.pairScores = pairScores;
  resultState.lastUpdatedTick = tick;

  return {
    updated: true,
    state: resultState,
    civAlignmentById
  };
}

function getPairDisposition(state, civA, civB) {
  if (!civA || !civB || civA === civB) {
    return "neutral";
  }
  return state?.pairDisposition?.get(pairKey(civA, civB)) || "neutral";
}

module.exports = {
  ensureCivAlignment,
  createStrategicAlignmentState,
  serializeStrategicAlignmentState,
  computeStrategicAlignment,
  getPairDisposition
};

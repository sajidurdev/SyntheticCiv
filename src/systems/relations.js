function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function toRelationObject(entry, tick = 0) {
  if (!entry && entry !== 0) {
    return { trust: 0, momentum: 0, lastTick: tick };
  }
  if (typeof entry === "number") {
    return { trust: clamp(entry, -1, 1), momentum: 0, lastTick: tick };
  }
  return {
    trust: clamp(entry.trust || 0, -1, 1),
    momentum: clamp(entry.momentum || 0, -1, 1),
    lastTick: typeof entry.lastTick === "number" ? entry.lastTick : tick
  };
}

function getRelation(agent, otherId, tick) {
  const key = String(otherId);
  const rel = toRelationObject(agent.relations[key], tick);
  agent.relations[key] = rel;
  return rel;
}

function decayAgentRelationObject(rel, tick) {
  const dt = Math.max(0, tick - rel.lastTick);
  if (dt > 0) {
    rel.trust *= Math.pow(0.995, dt);
    rel.momentum *= Math.pow(0.99, dt);
    rel.lastTick = tick;
    rel.trust = clamp(rel.trust, -1, 1);
    rel.momentum = clamp(rel.momentum, -1, 1);
  }
}

function applyAgentEvent(agentA, agentB, eventType, tick, tuning = {}) {
  const posTrust = tuning.posTrust ?? 0.035;
  const posMomentum = tuning.posMomentum ?? 0.02;
  const negTrust = tuning.negTrust ?? 0.06;
  const negMomentum = tuning.negMomentum ?? 0.04;

  const relAB = getRelation(agentA, agentB.id, tick);
  const relBA = getRelation(agentB, agentA.id, tick);
  decayAgentRelationObject(relAB, tick);
  decayAgentRelationObject(relBA, tick);

  if (eventType === "trade" || eventType === "cooperate") {
    relAB.trust += posTrust;
    relBA.trust += posTrust;
    relAB.momentum += posMomentum;
    relBA.momentum += posMomentum;
  } else if (eventType === "conflict") {
    relAB.trust -= negTrust;
    relBA.trust -= negTrust;
    relAB.momentum -= negMomentum;
    relBA.momentum -= negMomentum;
  }

  relAB.trust = clamp(relAB.trust, -1, 1);
  relBA.trust = clamp(relBA.trust, -1, 1);
  relAB.momentum = clamp(relAB.momentum, -1, 1);
  relBA.momentum = clamp(relBA.momentum, -1, 1);
  relAB.lastTick = tick;
  relBA.lastTick = tick;
}

function decayAgentRelations(agent, tick) {
  const ids = Object.keys(agent.relations);
  for (const id of ids) {
    const rel = toRelationObject(agent.relations[id], tick);
    decayAgentRelationObject(rel, tick);
    if (Math.abs(rel.trust) < 0.0005 && Math.abs(rel.momentum) < 0.0005) {
      delete agent.relations[id];
      continue;
    }
    agent.relations[id] = rel;
  }
}

function getSentiment(agentA, agentB, tick) {
  const relAB = getRelation(agentA, agentB.id, tick);
  const relBA = getRelation(agentB, agentA.id, tick);
  decayAgentRelationObject(relAB, tick);
  decayAgentRelationObject(relBA, tick);
  return (relAB.trust + relAB.momentum + relBA.trust + relBA.momentum) / 2;
}

function updateCivRelationsEMA(civRelations, civEventDeltas, beta = 0.05, options = {}) {
  const maxStep = options.maxStep ?? 0.4;
  const dt = Math.max(1, options.dt ?? 1);
  for (const [key, delta] of civEventDeltas.entries()) {
    const [civA, civB] = key.split("|");
    if (!civA || !civB || civA === civB) {
      continue;
    }
    if (!civRelations[civA]) {
      civRelations[civA] = {};
    }
    if (!civRelations[civB]) {
      civRelations[civB] = {};
    }
    const currentAB = civRelations[civA][civB] || 0;
    const currentBA = civRelations[civB][civA] || 0;
    const emaAB = currentAB * (1 - beta) + delta * beta;
    const emaBA = currentBA * (1 - beta) + delta * beta;
    const stepLimit = maxStep / dt;
    const nextAB = currentAB + clamp(emaAB - currentAB, -stepLimit, stepLimit);
    const nextBA = currentBA + clamp(emaBA - currentBA, -stepLimit, stepLimit);
    civRelations[civA][civB] = clamp(nextAB, -1, 1);
    civRelations[civB][civA] = clamp(nextBA, -1, 1);
  }
}

function accumulateCivDelta(civEventDeltas, civA, civB, delta) {
  if (!civA || !civB || civA === civB) {
    return;
  }
  const key = civA < civB ? `${civA}|${civB}` : `${civB}|${civA}`;
  const signedDelta = civA < civB ? delta : delta;
  civEventDeltas.set(key, (civEventDeltas.get(key) || 0) + signedDelta);
}

module.exports = {
  applyAgentEvent,
  decayAgentRelations,
  getSentiment,
  updateCivRelationsEMA,
  accumulateCivDelta,
  toRelationObject,
  pairKey
};

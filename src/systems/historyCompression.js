function cloneCivilizationMinimal(civ) {
  return {
    id: civ.id,
    centroid: civ.centroid,
    influenceRadius: civ.influenceRadius,
    relationMatrix: civ.relationMatrix,
    culture: civ.culture,
    strategyModifiers: civ.strategyModifiers,
    strategicAlignment: civ.strategicAlignment
  };
}

function averageSettlementMetrics(settlements) {
  if (!settlements.length) {
    return {
      center: { x: 0, y: 0 },
      population: 0,
      avgEnergy: 0,
      tradeFlow: 0,
      conflictRate: 0,
      resourcePressure: 0,
      stability: 0,
      growthRate: 0,
      migrationIn: 0,
      migrationOut: 0,
      influenceStrength: 0
    };
  }

  const total = settlements.length;
  return {
    center: {
      x: settlements.reduce((acc, s) => acc + (s.center?.x ?? s.centerPosition?.x ?? 0), 0) / total,
      y: settlements.reduce((acc, s) => acc + (s.center?.y ?? s.centerPosition?.y ?? 0), 0) / total
    },
    population: settlements.reduce((acc, s) => acc + (s.population || 0), 0),
    avgEnergy: settlements.reduce((acc, s) => acc + (s.avgEnergy || 0), 0) / total,
    tradeFlow: settlements.reduce((acc, s) => acc + (s.tradeFlow || s.tradeVolume || 0), 0) / total,
    conflictRate: settlements.reduce((acc, s) => acc + (s.conflictRate || 0), 0) / total,
    resourcePressure: settlements.reduce((acc, s) => acc + (s.resourcePressure || 0), 0) / total,
    stability: settlements.reduce((acc, s) => acc + (s.stability || s.stabilityScore || 0), 0) / total,
    growthRate: settlements.reduce((acc, s) => acc + (s.growthRate || 0), 0) / total,
    migrationIn: settlements.reduce((acc, s) => acc + (s.migrationIn || 0), 0) / total,
    migrationOut: settlements.reduce((acc, s) => acc + (s.migrationOut || 0), 0) / total,
    influenceStrength: settlements.reduce((acc, s) => acc + (s.influenceStrength || 0), 0) / total
  };
}

function compressToSettlementAverage(snapshot) {
  const byCiv = new Map();
  for (const settlement of snapshot.settlements || []) {
    const civId = settlement.civId || "unciv";
    if (!byCiv.has(civId)) {
      byCiv.set(civId, []);
    }
    byCiv.get(civId).push(settlement);
  }

  const settlements = [];
  for (const [civId, group] of byCiv.entries()) {
    const avg = averageSettlementMetrics(group);
    settlements.push({
      id: `AVG-${civId}`,
      civId: civId === "unciv" ? null : civId,
      center: avg.center,
      centerPosition: avg.center,
      population: avg.population,
      avgEnergy: avg.avgEnergy,
      tradeFlow: avg.tradeFlow,
      tradeVolume: avg.tradeFlow,
      conflictRate: avg.conflictRate,
      migrationIn: avg.migrationIn,
      migrationOut: avg.migrationOut,
      resourcePressure: avg.resourcePressure,
      stability: avg.stability,
      stabilityScore: avg.stability,
      growthRate: avg.growthRate,
      influenceStrength: avg.influenceStrength
    });
  }

  return {
    ...snapshot,
    agents: [],
    settlements,
    civilizations: (snapshot.civilizations || []).map(cloneCivilizationMinimal),
    events: [],
    tradeRoutes: (snapshot.tradeRoutes || []).slice(0, 8),
    diplomacyLines: (snapshot.diplomacyLines || []).slice(0, 16),
    migrationStreams: (snapshot.migrationStreams || []).slice(0, 8),
    compressionLevel: "settlement_avg"
  };
}

function compressToCivilizationAggregate(snapshot) {
  const civs = (snapshot.civilizations || []).map(cloneCivilizationMinimal);
  const settlements = civs.map((civ) => ({
    id: `CIV-${civ.id}`,
    civId: civ.id,
    center: civ.centroid || { x: 0, y: 0 },
    centerPosition: civ.centroid || { x: 0, y: 0 },
    population: 0,
    avgEnergy: 0,
    tradeFlow: 0,
    tradeVolume: 0,
    conflictRate: 0,
    migrationIn: 0,
    migrationOut: 0,
    resourcePressure: 0,
    stability: 0,
    stabilityScore: 0,
    growthRate: 0,
    influenceStrength: 0
  }));

  return {
    ...snapshot,
    agents: [],
    settlements,
    civilizations: civs,
    tradeRoutes: [],
    migrationStreams: [],
    events: [],
    compressionLevel: "civ_aggregate"
  };
}

function compressHistory(history, options = {}) {
  const maxSnapshots = options.maxSnapshots ?? 500;
  const keepFull = options.keepFull ?? 200;
  const keepSettlementAverages = options.keepSettlementAverages ?? 200;

  if (history.length > maxSnapshots) {
    history.splice(0, history.length - maxSnapshots);
  }

  const latestIndex = history.length - 1;
  for (let i = 0; i < history.length; i += 1) {
    const age = latestIndex - i;
    const snap = history[i];
    if (age < keepFull) {
      continue;
    }
    if (age < keepFull + keepSettlementAverages) {
      if (snap.compressionLevel !== "settlement_avg") {
        history[i] = compressToSettlementAverage(snap);
      }
      continue;
    }
    if (snap.compressionLevel !== "civ_aggregate") {
      history[i] = compressToCivilizationAggregate(snap);
    }
  }
}

module.exports = {
  compressHistory
};

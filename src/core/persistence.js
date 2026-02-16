const fs = require("fs");
const path = require("path");
const fsp = fs.promises;

function ensureDirectory(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

async function saveLatestAtomic(filePath, payload) {
  ensureDirectory(filePath);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmpPath, JSON.stringify(payload), "utf-8");
  let renamed = false;
  try {
    await fsp.rename(tmpPath, filePath);
    renamed = true;
  } catch (_) {
    await fsp.copyFile(tmpPath, filePath);
  } finally {
    if (!renamed) {
      try {
        await fsp.unlink(tmpPath);
      } catch (_) {
        // cleanup on Windows file-lock edge cases
      }
    }
  }
}

function loadLatest(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Failed to load latest persistence file:", err);
    return null;
  }
}

function buildKeyframe(sim) {
  const routes = sim.buildTradeRoutes().slice(0, 14);
  return {
    tick: sim.tick,
    settlements: sim.settlements.map((s) => ({
      id: s.id,
      center: s.center || s.centerPosition,
      population: s.population,
      tradeFlow: s.tradeFlow ?? s.tradeVolume ?? 0,
      tradeConsistency: s.tradeConsistency ?? 0,
      conflictRate: s.conflictRate ?? 0,
      frontierPressure: s.frontierPressure ?? 0,
      migrationIn: s.migrationIn ?? 0,
      migrationOut: s.migrationOut ?? 0,
      stability: s.stability ?? s.stabilityScore ?? 0,
      resourcePressure: s.resourcePressure ?? 0,
      growthRate: s.growthRate ?? 0,
      influenceStrength: s.influenceStrength ?? 0,
      resources: s.resources
        ? {
          food: s.resources.food ?? 0,
          materials: s.resources.materials ?? 0,
          wealth: s.resources.wealth ?? 0
        }
        : null,
      market: s.market
        ? {
          prices: {
            food: s.market.prices?.food ?? 1,
            materials: s.market.prices?.materials ?? 1,
            wealth: s.market.prices?.wealth ?? 1
          },
          volatility: s.market.volatility ?? 0.03,
          lastUpdateTick: s.market.lastUpdateTick ?? sim.tick
        }
        : null,
      resourceEMA: s.resourceEMA
        ? {
          foodStress: s.resourceEMA.foodStress ?? 0,
          materialStress: s.resourceEMA.materialStress ?? 0
        }
        : null,
      birthMultiplier: s.birthMultiplier ?? 1,
      conflictSensitivity: s.conflictSensitivity ?? 0,
      economyMigrationPressure: s.economyMigrationPressure ?? 0,
      economicProfile: s.economicProfile || "Balanced",
      economicStress: s.economicStress ?? 0,
      securityStress: s.securityStress ?? 0,
      legitimacyStress: s.legitimacyStress ?? 0,
      socialStress: s.socialStress ?? 0,
      environmentStress: s.environmentStress ?? 0,
      compositeStress: s.compositeStress ?? 0,
      pressureAxes: s.pressureAxes ? { ...s.pressureAxes } : null,
      foodPerCap: s.foodPerCap ?? 0,
      materialsPerCap: s.materialsPerCap ?? 0,
      wealthPerCap: s.wealthPerCap ?? 0,
      knowledge: s.knowledge ? { ...s.knowledge } : null,
      knowledgeLevel: s.knowledgeLevel ?? 0,
      innovationEffects: s.innovationEffects ? { ...s.innovationEffects } : null,
      shockState: s.shockState ? { ...s.shockState } : null,
      shockEffects: s.shockEffects ? { ...s.shockEffects } : null,
      regionalInfluence: s.regionalInfluence
        ? { ...s.regionalInfluence }
        : null,
      influenceSaturation: s.influenceSaturation
        ? { ...s.influenceSaturation }
        : null,
      isRuined: !!s.isRuined,
      highPressureTicks: s.highPressureTicks ?? 0,
      fissionCooldown: s.fissionCooldown ?? 0,
      role: s.role || "General",
      roleInfluenceMultiplier: s.roleInfluenceMultiplier || 1,
      civId: s.civId || null
    })),
    civilizations: sim.civilizations.map((c) => ({
      id: c.id,
      centroid: c.centroid,
      influenceRadius: c.influenceRadius,
      relationMatrix: c.relationMatrix,
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
    eraHistory: typeof sim.getEraHistorySnapshot === "function"
      ? sim.getEraHistorySnapshot(120)
      : null,
    topTradeRoutes: routes.map((r) => ({
      from: r.from,
      to: r.to,
      tradeVolume: r.tradeVolume,
      trades: r.trades,
      routeMomentum: r.routeMomentum ?? 0,
      routeAge: r.routeAge ?? 0
    })),
    stats: {
      avgEnergy: sim.getAverageEnergy(),
      totalTrades: sim.tradeEvents.length,
      recentEvents: sim.recentEvents.length,
      frontierContactRate: Number((sim.frontierContactCount.sum() / Math.max(1, sim.windowSize)).toFixed(4)),
      frontierConflictRate: Number((sim.frontierConflictCount.sum() / Math.max(1, sim.windowSize)).toFixed(4))
    }
  };
}

function buildPersistencePayload(sim, options = {}) {
  const eventLimit = options.eventLimit ?? 500;
  const keyframeLimit = options.keyframeLimit ?? 60;
  const includeKeyframes = options.includeKeyframes ?? true;

  const payload = {
    version: 2,
    savedAt: Date.now(),
    tick: sim.tick,
    state: sim.exportState(),
    recentEvents: sim.recentEvents.slice(-eventLimit)
  };

  if (includeKeyframes) {
    const keyframes = sim.keyframes.slice(-keyframeLimit);
    payload.keyframes = keyframes;
  }
  return payload;
}

module.exports = {
  saveLatestAtomic,
  loadLatest,
  buildPersistencePayload,
  buildKeyframe
};

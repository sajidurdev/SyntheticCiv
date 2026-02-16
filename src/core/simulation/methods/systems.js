const {
  RollingCounter,
  accumulateCivDelta,
  stepDemographics,
  isSettlementActive,
  economyStep,
  stepInnovation,
  ensureSettlementShockState,
  stepShockSystem,
  RESOURCE_TYPES,
  clamp
} = require("../scope");

class SystemSimulationMethods {
  runDemographicsStep() {
    const demographics = stepDemographics(
      { width: this.width, height: this.height, grid: this.grid },
      this.agents,
      this.settlements,
      this.tick,
      () => this.nextRandom(),
      {
        ...this.demographicsConfig,
        membersBySettlementId: this.membersBySettlementId,
        agentSettlement: this.agentSettlement,
        cultureByCivId: this.buildCultureByCivId(),
        birthReservoir: this.birthReservoir,
        deathReservoir: this.deathReservoir,
        nextAgentId: this.nextAgentId,
        resourceTypes: RESOURCE_TYPES
      }
    );

    this.nextAgentId = demographics.nextAgentId;
    this.lastDemographics = demographics;
    this.incrementPopulationCounter("spawnedBirth", demographics.births || 0);
    this.incrementPopulationCounter("despawnedDeath", demographics.deaths || 0);
    this.accumulateBirthDiagnosticsWindow(demographics.birthDiagnostics);
    this.accumulateDeathDiagnosticsWindow(demographics.deathDiagnostics);
    if (demographics.births > 0 || demographics.deaths > 0) {
      this.agentCount = this.agents.length;
      this.rebuildSpatialHash();
      this.refreshMembership();
      this.syncPopulationFromMembership();
      this.updateSettlementFrontierPressure();
      this.runRegionalInfluenceStep(false);
      this.runInfluenceSaturationStep(false);
    }
    return demographics;
  }


  runEconomyStep(tradeRoutes = this.buildTradeRoutes()) {
    economyStep(this.settlements, tradeRoutes, { ...this.economyConfig, tick: this.tick });
    this.conflictSensitivityBySettlement.clear();
    for (const settlement of this.settlements) {
      this.conflictSensitivityBySettlement.set(
        settlement.id,
        (settlement.conflictSensitivity || 0) + (settlement.shockEffects?.conflictSensitivityAdd || 0)
      );
    }
  }


  runInnovationStep(tradeRoutes = this.buildTradeRoutes()) {
    stepInnovation(this.settlements, tradeRoutes, this.tick, this.innovationConfig);
  }


  runShockStep(tradeRoutes = this.buildTradeRoutes()) {
    const outcome = stepShockSystem(
      this.settlements,
      tradeRoutes,
      this.tick,
      () => this.nextRandom(),
      this.shockConfig
    );
    for (const settlement of this.settlements) {
      ensureSettlementShockState(settlement);
      const effects = settlement.shockEffects || {};
      if ((effects.stabilityPenalty || 0) > 0) {
        settlement.stability = clamp(
          (settlement.stability || settlement.stabilityScore || 0) - effects.stabilityPenalty,
          0,
          1
        );
        settlement.stabilityScore = settlement.stability;
      }
      if ((effects.migrationPressureAdd || 0) > 0) {
        settlement.migrationOutRate = clamp(
          (settlement.migrationOutRate || 0) + effects.migrationPressureAdd,
          0,
          1
        );
      }
      if ((effects.birthMultiplierMult || 1) !== 1) {
        settlement.birthMultiplier = clamp(
          (settlement.birthMultiplier || 1) * effects.birthMultiplierMult,
          0.12,
          1
        );
      }
    }

    for (const event of outcome.created || []) {
      this.recordEvent({
        type: "system",
        tick: this.tick,
        message: `Shock started (${event.type}) at ${event.settlementId}, severity ${event.severity.toFixed(2)}`,
        settlementA: event.settlementId,
        settlementB: null,
        civA: this.getSettlementById(event.settlementId)?.civId || null,
        civB: null
      });
    }
    for (const event of outcome.resolved || []) {
      this.recordEvent({
        type: "system",
        tick: this.tick,
        message: `Shock resolved (${event.type}) at ${event.settlementId}`,
        settlementA: event.settlementId,
        settlementB: null,
        civA: this.getSettlementById(event.settlementId)?.civId || null,
        civB: null
      });
    }
  }


  applyPostSplitSupport() {
    for (const settlement of this.settlements) {
      const until = settlement.postSplitProtectionUntil || 0;
      if (!until || this.tick >= until || !isSettlementActive(settlement)) {
        continue;
      }
      const supportTicks = Math.max(1, settlement.postSplitSupportTicks || this.fissionConfig.childSupportTicks || 900);
      const supportStrength = clamp(settlement.postSplitSupportStrength || this.fissionConfig.childSupportStrength || 0.22, 0, 0.4);
      const supportPhase = clamp((until - this.tick) / supportTicks, 0, 1);
      const support = supportStrength * supportPhase;

      settlement.stability = clamp((settlement.stability || settlement.stabilityScore || 0) + support * 0.06, 0, 1);
      settlement.stabilityScore = settlement.stability;
      settlement.resourcePressure = clamp((settlement.resourcePressure || 0) - support * 0.08, 0, 1);
      settlement.tradeConsistency = clamp((settlement.tradeConsistency || 0) + support * 0.1, 0, 1);
      settlement.birthMultiplier = Math.max(settlement.birthMultiplier || 0, clamp(0.82 + support * 0.5, 0.82, 1));
      settlement.migrationOutRate = clamp((settlement.migrationOutRate || 0) * (1 - support * 0.18), 0, 1);
    }
  }


  getRouteKeyBySettlements(settlementA, settlementB) {
    if (!settlementA || !settlementB || settlementA === settlementB) {
      return null;
    }
    if (settlementA === "wild" || settlementB === "wild") {
      return null;
    }
    return settlementA < settlementB ? `${settlementA}|${settlementB}` : `${settlementB}|${settlementA}`;
  }


  registerInfoContact(settlementA, settlementB) {
    const key = this.getRouteKeyBySettlements(settlementA, settlementB);
    if (!key) {
      return;
    }
    if (!this.pairInfoWindows.has(key)) {
      this.pairInfoWindows.set(key, new RollingCounter(this.windowSize));
    }
    this.pairInfoWindows.get(key).increment(this.tick, 1);
  }


  ensureRouteMemoryEntry(routeKey) {
    if (!routeKey) {
      return null;
    }
    if (!this.routeMemory.has(routeKey)) {
      this.routeMemory.set(routeKey, {
        routeMomentum: 0,
        routeAge: 0,
        lastTradeTick: -1,
        lastUpdatedTick: this.tick
      });
    }
    return this.routeMemory.get(routeKey);
  }


  decayRouteMemoryEntryToTick(entry, tick = this.tick) {
    if (!entry) {
      return;
    }
    const dt = Math.max(0, tick - (entry.lastUpdatedTick || tick));
    if (dt <= 0) {
      return;
    }
    entry.routeMomentum *= Math.pow(this.tradeMomentumConfig.decayPerTick, dt);
    entry.lastUpdatedTick = tick;
  }


  getRouteMomentum(routeKey) {
    const entry = this.ensureRouteMemoryEntry(routeKey);
    if (!entry) return 0;
    this.decayRouteMemoryEntryToTick(entry, this.tick);
    return entry.routeMomentum || 0;
  }


  getRouteAge(routeKey) {
    const entry = this.ensureRouteMemoryEntry(routeKey);
    if (!entry) return 0;
    return entry.routeAge || 0;
  }


  registerRouteTradeSuccess(routeKey) {
    const entry = this.ensureRouteMemoryEntry(routeKey);
    if (!entry) return;
    this.decayRouteMemoryEntryToTick(entry, this.tick);
    entry.routeMomentum = clamp(
      (entry.routeMomentum || 0) + this.tradeMomentumConfig.successWeight,
      0,
      this.tradeMomentumConfig.maxMomentum
    );
    entry.routeAge = Math.max(0, (entry.routeAge || 0) + 1);
    entry.lastTradeTick = this.tick;
    entry.lastUpdatedTick = this.tick;
  }


  registerRouteConflictPenalty(routeKey) {
    const entry = this.ensureRouteMemoryEntry(routeKey);
    if (!entry) return;
    this.decayRouteMemoryEntryToTick(entry, this.tick);
    const ageResilience = clamp(1 - Math.min(0.55, (entry.routeAge || 0) * 0.0006), 0.45, 1);
    entry.routeMomentum = clamp(
      (entry.routeMomentum || 0) - this.tradeMomentumConfig.conflictDecay * ageResilience,
      0,
      this.tradeMomentumConfig.maxMomentum
    );
    entry.lastUpdatedTick = this.tick;
  }


  updateRouteMomentumPressure() {
    const settlementById = new Map(this.settlements.map((s) => [s.id, s]));
    const remove = [];
    for (const [routeKey, entry] of this.routeMemory.entries()) {
      this.decayRouteMemoryEntryToTick(entry, this.tick);
      const [sidA, sidB] = routeKey.split("|");
      const a = settlementById.get(sidA);
      const b = settlementById.get(sidB);
      if (!a || !b || !isSettlementActive(a) || !isSettlementActive(b)) {
        entry.routeMomentum = clamp(entry.routeMomentum * 0.994, 0, this.tradeMomentumConfig.maxMomentum);
      } else {
        const ageResilience = clamp(1 - Math.min(0.6, (entry.routeAge || 0) * 0.0007), 0.4, 1);
        const instability = clamp(
          ((1 - (a.stability || a.stabilityScore || 0)) + (1 - (b.stability || b.stabilityScore || 0))) * 0.5 +
          ((a.conflictRate || 0) + (b.conflictRate || 0)) * 0.22 +
          ((a.influenceSaturation?.saturationLevel || 0) + (b.influenceSaturation?.saturationLevel || 0)) * 0.28,
          0,
          2
        );
        entry.routeMomentum = clamp(
          entry.routeMomentum - instability * this.tradeMomentumConfig.instabilityDecayRate * ageResilience,
          0,
          this.tradeMomentumConfig.maxMomentum
        );

        const priceGap = this.computeRoutePriceGap(a, b);
        const avgTariff = (
          (this.tariffRateBySettlement.get(a.id) ?? 0.5) +
          (this.tariffRateBySettlement.get(b.id) ?? 0.5)
        ) * 0.5;
        const tariffExploitability = clamp(1 - avgTariff * 0.28, 0.55, 1.05);
        const avgLogistics = clamp(
          (
            (a.innovationEffects?.tradeRangeMult || 1) +
            (b.innovationEffects?.tradeRangeMult || 1)
          ) * 0.5,
          0.75,
          1.7
        );
        const logisticsBoost = clamp(0.9 + (avgLogistics - 1) * 0.6, 0.65, 1.25);
        const arbitragePersistence = priceGap * tariffExploitability * logisticsBoost;
        entry.routeMomentum = clamp(
          entry.routeMomentum + arbitragePersistence * this.routePriceGapMomentumScale * ageResilience,
          0,
          this.tradeMomentumConfig.maxMomentum
        );
      }

      const idleTicks = this.tick - (entry.lastTradeTick || -1);
      if (entry.routeMomentum < 1e-4 && idleTicks > this.tradeMomentumConfig.pruneAfterIdleTicks) {
        remove.push(routeKey);
      }
    }
    for (const key of remove) {
      this.routeMemory.delete(key);
    }
  }


  applyRegionalInfluenceDeltas() {
    for (const [key, delta] of this.regionalCivDeltas.entries()) {
      const [civA, civB] = key.split("|");
      if (!civA || !civB) {
        continue;
      }
      accumulateCivDelta(this.civEventDeltas, civA, civB, delta);
    }
  }


  logDiagnostics(demographics) {
    if (!this.debugMetricsEnabled) {
      return;
    }
    if (this.tick % this.debugMetricsEvery !== 0 || this.settlements.length === 0) {
      return;
    }
    const activeSettlements = this.settlements.filter(isSettlementActive);
    const scope = activeSettlements.length ? activeSettlements : this.settlements;
    const count = scope.length;
    const avg = (field) => (
      scope.reduce((acc, s) => acc + (s[field] || 0), 0) / Math.max(1, count)
    );
    const avgConflict = avg("conflictRate");
    const avgConflictRaw = avg("conflictRateRaw");
    const avgPressure = avg("resourcePressure");
    const avgGrowth = avg("growthRate");
    const avgTradeNorm = avg("tradeFlowNorm");
    const avgMigrationOutRate = avg("migrationOutRate");
    const avgFoodStress = scope.reduce(
      (acc, s) => acc + (s.resourceEMA?.foodStress || 0),
      0
    ) / Math.max(1, count);
    const avgFoodPerCap = scope.reduce(
      (acc, s) => acc + (s.foodPerCap || 0),
      0
    ) / Math.max(1, count);
    this.frontierContactCount.advanceToTick(this.tick);
    this.frontierConflictCount.advanceToTick(this.tick);
    const frontierContactRate = this.frontierContactCount.sum() / Math.max(1, this.windowSize);
    const frontierConflictRate = this.frontierConflictCount.sum() / Math.max(1, this.windowSize);
    const interaction = this.lastInteractionDiagnostics || {};

    const cap = demographics?.effectiveCap || this.demographicsConfig.maxAgents;
    const limiter = demographics?.logisticLimiter ?? 0;
    const agentsPrev = this.agentsAtLastDebug;
    const agentsNow = this.agents.length;
    const agentsDelta = agentsNow - agentsPrev;
    let spawnedWindow =
      this.populationCounters.spawnedInit +
      this.populationCounters.spawnedBirth +
      this.populationCounters.spawnedOther;
    let despawnedWindow =
      this.populationCounters.despawnedDeath +
      this.populationCounters.despawnedOther;
    const expectedDeltaBefore = spawnedWindow - despawnedWindow;
    const unexplained = agentsDelta - expectedDeltaBefore;
    if (unexplained > 0) {
      this.incrementPopulationCounter("spawnedOther", unexplained);
    } else if (unexplained < 0) {
      this.incrementPopulationCounter("despawnedOther", Math.abs(unexplained));
    }

    console.log(
      `[sim-debug] t=${this.tick} ` +
      `agents=${agentsNow} (${agentsDelta >= 0 ? "+" : ""}${agentsDelta}) cap=${cap} limiter=${limiter.toFixed(3)} ` +
      `util=${(interaction.globalPairCap || 0) > 0 ? ((interaction.processedPairs || 0) / interaction.globalPairCap).toFixed(3) : "0.000"} ` +
      `conf=${avgConflict.toFixed(3)} press=${avgPressure.toFixed(3)} growth=${avgGrowth.toFixed(4)} ` +
      `tradeNorm=${avgTradeNorm.toFixed(3)} foodStress=${avgFoodStress.toFixed(3)} foodPerCap=${avgFoodPerCap.toFixed(2)} ` +
      `frontier=${frontierContactRate.toFixed(3)}/${frontierConflictRate.toFixed(3)}`
    );

    if (this.debugMetricsVerbose) {
      const avgFoodProdRaw = scope.reduce((acc, s) => acc + (s.economyRaw?.foodProd || 0), 0) / Math.max(1, count);
      const avgFoodConsRaw = scope.reduce((acc, s) => acc + (s.economyRaw?.foodCons || 0), 0) / Math.max(1, count);

      const birthWin = this.birthDiagnosticsWindow;
      const birthPopWeight = Math.max(1, birthWin.populationConsidered);
      const weightedBirthRate = birthWin.weightedBirthRateSum / birthPopWeight;
      const birthExpectedFromSum = birthWin.expectedBirthsFromSettlementSum || 0;
      const birthExpectedMismatch = Math.abs((birthWin.expectedBirthsTotal || 0) - birthExpectedFromSum);
      const factorAverages = {
        stabilityFactor: birthWin.avgFactorsWeightedSum.stabilityFactor / birthPopWeight,
        pressureFactor: birthWin.avgFactorsWeightedSum.pressureFactor / birthPopWeight,
        conflictFactor: birthWin.avgFactorsWeightedSum.conflictFactor / birthPopWeight,
        tradeFactor: birthWin.avgFactorsWeightedSum.tradeFactor / birthPopWeight,
        foodFactor: birthWin.avgFactorsWeightedSum.foodFactor / birthPopWeight,
        logisticLimiter: birthWin.avgFactorsWeightedSum.logisticLimiter / birthPopWeight
      };
      const suppressionPairs = Object.entries(birthWin.suppressionWins).sort((a, b) => b[1] - a[1]);
      const dominantSuppression = suppressionPairs[0]?.[0] || "none";
      const topBirthSettlements = (birthWin.lastSettlementBreakdown || [])
        .slice(0, 3)
        .map((row) => `${row.settlementId}:r=${row.birthRate.toFixed(5)} e=${row.expectedBirths.toFixed(3)} b=${row.births}`)
        .join(" | ");

      const deathWin = this.deathDiagnosticsWindow;
      const deathPopWeight = Math.max(1, deathWin.populationConsidered);
      const weightedDeathRate = deathWin.weightedDeathRateSum / deathPopWeight;
      const deathFactors = {
        stress: deathWin.avgFactorsWeightedSum.stress / deathPopWeight,
        conflict: deathWin.avgFactorsWeightedSum.conflict / deathPopWeight,
        pressure: deathWin.avgFactorsWeightedSum.pressure / deathPopWeight,
        foodDeficitRatio: deathWin.avgFactorsWeightedSum.foodDeficitRatio / deathPopWeight
      };
      const topDeathSettlements = (deathWin.lastSettlementBreakdown || [])
        .slice(0, 3)
        .map((row) => `${row.settlementId}:r=${row.deathRate.toFixed(6)} e=${row.expectedDeaths.toFixed(3)} d=${row.deaths}`)
        .join(" | ");

      console.log(
        `[sim-debug:birth] expected(global/sum)=${birthWin.expectedBirthsTotal.toFixed(2)}/${birthExpectedFromSum.toFixed(2)} ` +
        `mismatch=${birthExpectedMismatch.toExponential(2)} attempts=${birthWin.birthAttempts} births=${birthWin.birthsSucceeded} ` +
        `rate=${weightedBirthRate.toFixed(6)} suppression=${dominantSuppression} ` +
        `factors=${factorAverages.stabilityFactor.toFixed(3)}/${factorAverages.pressureFactor.toFixed(3)}/${factorAverages.conflictFactor.toFixed(3)}/${factorAverages.tradeFactor.toFixed(3)}/${factorAverages.foodFactor.toFixed(3)}/${factorAverages.logisticLimiter.toFixed(3)}` +
        (topBirthSettlements ? ` top=[${topBirthSettlements}]` : "")
      );
      console.log(
        `[sim-debug:death] expected(global/sum)=${deathWin.expectedDeathsTotal.toFixed(2)}/${(deathWin.expectedDeathsFromSettlementSum || 0).toFixed(2)} ` +
        `attempts=${deathWin.deathAttempts} deaths=${deathWin.deathsApplied} rate=${weightedDeathRate.toFixed(6)} ` +
        `factors=${deathFactors.stress.toFixed(3)}/${deathFactors.conflict.toFixed(3)}/${deathFactors.pressure.toFixed(3)}/${deathFactors.foodDeficitRatio.toFixed(3)}` +
        (topDeathSettlements ? ` top=[${topDeathSettlements}]` : "")
      );
      console.log(
        `[sim-debug:econ] foodRaw(prod/cons)=${avgFoodProdRaw.toFixed(3)}/${avgFoodConsRaw.toFixed(3)} ` +
        `conflict(avg/raw)=${avgConflict.toFixed(3)}/${avgConflictRaw.toFixed(4)} ` +
        `migrationOutRate=${avgMigrationOutRate.toFixed(3)} growth=${avgGrowth.toFixed(4)}`
      );
    }

    this.agentsAtLastDebug = agentsNow;
    this.resetPopulationCountersWindow();
  }

}

module.exports = SystemSimulationMethods;

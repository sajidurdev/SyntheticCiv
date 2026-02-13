function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function popValue(settlement) {
  if (Array.isArray(settlement.members)) {
    return settlement.members.length;
  }
  return Math.max(0, settlement.population || 0);
}

function defaultResources(population) {
  const pop = Math.max(0, population || 0);
  return {
    food: pop * 8,
    materials: pop * 4,
    wealth: pop * 2
  };
}

function ensureSettlementEconomyState(settlement) {
  const pop = popValue(settlement);
  const defaults = defaultResources(pop);
  const resources = settlement.resources || {};
  settlement.resources = {
    food: Math.max(0, Number.isFinite(resources.food) ? resources.food : defaults.food),
    materials: Math.max(0, Number.isFinite(resources.materials) ? resources.materials : defaults.materials),
    wealth: Math.max(0, Number.isFinite(resources.wealth) ? resources.wealth : defaults.wealth)
  };

  const ema = settlement.resourceEMA || {};
  settlement.resourceEMA = {
    foodStress: clamp01(Number.isFinite(ema.foodStress) ? ema.foodStress : 0),
    materialStress: clamp01(Number.isFinite(ema.materialStress) ? ema.materialStress : 0)
  };

  settlement.birthMultiplier = clamp01(
    Number.isFinite(settlement.birthMultiplier) ? settlement.birthMultiplier : 1
  );
  settlement.conflictSensitivity = clamp(
    Number.isFinite(settlement.conflictSensitivity) ? settlement.conflictSensitivity : 0,
    0,
    0.05
  );
  settlement.economyMigrationPressure = clamp(
    Number.isFinite(settlement.economyMigrationPressure) ? settlement.economyMigrationPressure : 0,
    0,
    0.1
  );
}

function storageCap(population, popFactor, type) {
  if (type === "food") {
    return population * 14 + popFactor * 28 + 80;
  }
  if (type === "materials") {
    return population * 8 + popFactor * 18 + 45;
  }
  return population * 12 + popFactor * 30 + 120;
}

function applySoftCap(value, cap) {
  if (value <= cap) {
    return value;
  }
  const overflow = value - cap;
  return cap + overflow * 0.9;
}

function transferByPerCapGap(source, target, type, perCapGap, routeWeight, kTransfer, maxPerRouteTick) {
  if (perCapGap <= 0) {
    return 0;
  }
  const desired = kTransfer * routeWeight * perCapGap;
  const amount = Math.min(source.resources[type], Math.min(maxPerRouteTick, desired));
  if (amount <= 0) {
    return 0;
  }
  source.resources[type] -= amount;
  target.resources[type] += amount;
  return amount;
}

function deriveEconomicProfile(settlement, foodPerCap, matPerCap, wealthPerCap) {
  const stability = settlement.stability || settlement.stabilityScore || 0;
  const pressure = settlement.resourcePressure || 0;
  const frontier = settlement.frontierPressure || 0;
  const tradeFlowNorm = settlement.tradeFlowNorm || 0;

  if (stability > 0.55 && pressure < 0.45 && foodPerCap > matPerCap * 1.3) {
    return "Breadbasket";
  }
  if (frontier > 0.45 && matPerCap > foodPerCap * 1.1) {
    return "Industrial";
  }
  if (
    tradeFlowNorm > 0.55 &&
    wealthPerCap > 2.0 &&
    wealthPerCap > Math.max(foodPerCap, matPerCap) * 0.22 &&
    frontier < 0.55
  ) {
    return "Commercial";
  }
  return "Balanced";
}

function economyStep(settlements, tradeRoutes, options = {}) {
  const cfg = {
    kFood: options.kFood ?? 1.6,
    kMat: options.kMat ?? 0.72,
    kWealth: options.kWealth ?? 0.3,
    cFood: options.cFood ?? 0.12,
    cMat: options.cMat ?? 0.04,
    cWealth: options.cWealth ?? 0.01,
    foodPerCapTarget: options.foodPerCapTarget ?? 8,
    matPerCapTarget: options.matPerCapTarget ?? 4.5,
    stressEmaAlpha: options.stressEmaAlpha ?? 0.05,
    kTradeFood: options.kTradeFood ?? 0.95,
    kTradeMat: options.kTradeMat ?? 0.5,
    kTradeWealth: options.kTradeWealth ?? 0.3,
    maxTradeFoodPerRoute: options.maxTradeFoodPerRoute ?? 2.5,
    maxTradeMatPerRoute: options.maxTradeMatPerRoute ?? 1.4
  };

  const byId = new Map();
  for (const settlement of settlements) {
    ensureSettlementEconomyState(settlement);
    byId.set(settlement.id, settlement);
  }

  const active = settlements.filter((s) => popValue(s) > 0);

  for (const settlement of active) {
    const pop = popValue(settlement);
    const popFactor = Math.sqrt(Math.max(1, pop));
    const stability = clamp01(settlement.stability || settlement.stabilityScore || 0);
    const pressure = clamp01(settlement.resourcePressure || 0);
    const conflictRate = clamp01(settlement.conflictRate || 0);
    const frontierPressure = clamp01(settlement.frontierPressure || 0);
    const tradeFlowNorm = clamp01(settlement.tradeFlowNorm || 0);
    const innovation = settlement.innovationEffects || {};
    const shock = settlement.shockEffects || {};

    let foodProd =
      cfg.kFood *
      (0.4 + 0.6 * stability) *
      (1 - 0.8 * pressure) *
      (1 - 0.6 * conflictRate) *
      popFactor;
    let matProd =
      cfg.kMat *
      (0.5 + 0.5 * frontierPressure) *
      (0.3 + 0.7 * stability) *
      popFactor;
    let wealthProd = cfg.kWealth * tradeFlowNorm * popFactor;

    foodProd = Math.max(0, foodProd);
    matProd = Math.max(0, matProd);
    wealthProd = Math.max(0, wealthProd);

    const policy = settlement.policyEffects || {};
    const foodConsumptionMult = policy.foodConsumptionMult ?? 1;
    const tradeOpenness = policy.tradeOpenness ?? 0.5;
    const tariffRate = clamp01(policy.tariffRate ?? 0.5);
    const foodProdStabilizer = 0.6 + 0.8 * tradeFlowNorm + 0.4 * stability;
    const foodConsStabilizer = 0.8 + 0.6 * pressure + 0.4 * conflictRate;
    foodProd *= foodProdStabilizer;
    foodProd *= innovation.foodProdMult ?? 1;
    foodProd *= shock.foodProdMult ?? 1;
    matProd *= innovation.materialProdMult ?? 1;
    matProd *= shock.materialProdMult ?? 1;
    wealthProd *= innovation.wealthProdMult ?? 1;
    wealthProd *= shock.wealthProdMult ?? 1;

    const foodCons = pop * cfg.cFood * foodConsumptionMult * foodConsStabilizer * (shock.foodConsMult ?? 1);
    const matCons = pop * cfg.cMat;
    const wealthCons = pop * cfg.cWealth;
    settlement.economyRaw = {
      foodProd,
      foodCons,
      matProd,
      matCons,
      wealthProd,
      wealthCons,
      foodProdStabilizer,
      foodConsStabilizer
    };

    settlement.resources.food += foodProd - foodCons;
    settlement.resources.materials += matProd - matCons;
    settlement.resources.wealth += wealthProd * (0.9 + tradeOpenness * 0.2) * (1 - tariffRate * 0.06) - wealthCons;

    settlement.resources.food = applySoftCap(
      Math.max(0, settlement.resources.food),
      storageCap(pop, popFactor, "food")
    );
    settlement.resources.materials = applySoftCap(
      Math.max(0, settlement.resources.materials),
      storageCap(pop, popFactor, "materials")
    );
    settlement.resources.wealth = applySoftCap(
      Math.max(0, settlement.resources.wealth),
      storageCap(pop, popFactor, "wealth")
    );
  }

  const validRoutes = (tradeRoutes || [])
    .filter((r) => byId.has(r.from) && byId.has(r.to))
    .map((r) => ({
      ...r,
      routeKey: `${r.from}|${r.to}`
    }))
    .sort((a, b) => {
      const volDiff = (b.tradeVolume || 0) - (a.tradeVolume || 0);
      if (Math.abs(volDiff) > 1e-9) {
        return volDiff;
      }
      return a.routeKey.localeCompare(b.routeKey);
    });

  const maxVolume = Math.max(
    1,
    ...validRoutes.map((route) => route.tradeVolume || route.trades || 0)
  );

  for (const route of validRoutes) {
    const a = byId.get(route.from);
    const b = byId.get(route.to);
    if (popValue(a) <= 0 || popValue(b) <= 0) {
      continue;
    }

    const routeWeight = clamp01((route.tradeVolume || route.trades || 0) / maxVolume);
    if (routeWeight <= 0) {
      continue;
    }
    const policyA = a.policyEffects || {};
    const policyB = b.policyEffects || {};
    const tariffFriction = clamp(
      1 - (((policyA.tariffRate ?? 0.5) + (policyB.tariffRate ?? 0.5)) * 0.5) * 0.35,
      0.55,
      1
    );
    const shockReliability = clamp(
      (a.shockEffects?.tradeReliabilityMult ?? 1) * (b.shockEffects?.tradeReliabilityMult ?? 1),
      0.5,
      1.15
    );
    const innovationReliability = 1 +
      (((a.innovationEffects?.tradeReliabilityBonus ?? 0) + (b.innovationEffects?.tradeReliabilityBonus ?? 0)) * 0.5);
    const routeAdjustedWeight = clamp(routeWeight * tariffFriction * shockReliability * innovationReliability, 0, 1.2);

    const popA = Math.max(1, popValue(a));
    const popB = Math.max(1, popValue(b));
    const foodPerCapA = a.resources.food / popA;
    const foodPerCapB = b.resources.food / popB;
    const matPerCapA = a.resources.materials / popA;
    const matPerCapB = b.resources.materials / popB;

    if (foodPerCapA > foodPerCapB) {
      transferByPerCapGap(
        a,
        b,
        "food",
        foodPerCapA - foodPerCapB,
        routeAdjustedWeight,
        cfg.kTradeFood,
        cfg.maxTradeFoodPerRoute
      );
    } else {
      transferByPerCapGap(
        b,
        a,
        "food",
        foodPerCapB - foodPerCapA,
        routeAdjustedWeight,
        cfg.kTradeFood,
        cfg.maxTradeFoodPerRoute
      );
    }

    if (matPerCapA > matPerCapB) {
      transferByPerCapGap(
        a,
        b,
        "materials",
        matPerCapA - matPerCapB,
        routeAdjustedWeight,
        cfg.kTradeMat,
        cfg.maxTradeMatPerRoute
      );
    } else {
      transferByPerCapGap(
        b,
        a,
        "materials",
        matPerCapB - matPerCapA,
        routeAdjustedWeight,
        cfg.kTradeMat,
        cfg.maxTradeMatPerRoute
      );
    }

    const opennessA = a.policyEffects?.tradeOpenness ?? 0.5;
    const opennessB = b.policyEffects?.tradeOpenness ?? 0.5;
    const wealthBonus = cfg.kTradeWealth * routeAdjustedWeight * (0.86 + ((opennessA + opennessB) * 0.5) * 0.28);
    a.resources.wealth += wealthBonus;
    b.resources.wealth += wealthBonus;
  }

  for (const settlement of active) {
    const pop = Math.max(1, popValue(settlement));
    const pressure = clamp01(settlement.resourcePressure || 0);
    const conflictRate = clamp01(settlement.conflictRate || 0);
    const foodProdRaw = Math.max(0, settlement.economyRaw?.foodProd || 0);
    const foodConsRaw = Math.max(0, settlement.economyRaw?.foodCons || 0);
    const foodPerCap = clamp01(foodProdRaw / Math.max(foodConsRaw, 1e-6));
    const matPerCap = settlement.resources.materials / pop;
    const wealthPerCap = settlement.resources.wealth / pop;

    const foodStressTarget = clamp01(
      0.55 * (1 - foodPerCap) +
      0.25 * pressure +
      0.20 * conflictRate
    );
    const matStressTarget = clamp01(1 - matPerCap / Math.max(0.1, cfg.matPerCapTarget));
    settlement.resourceEMA.foodStress +=
      (foodStressTarget - settlement.resourceEMA.foodStress) * cfg.stressEmaAlpha;
    settlement.resourceEMA.materialStress +=
      (matStressTarget - settlement.resourceEMA.materialStress) * cfg.stressEmaAlpha;

    const foodStress = clamp01(settlement.resourceEMA.foodStress);
    const materialStress = clamp01(settlement.resourceEMA.materialStress);
    settlement.compositeStress = Number(foodStress.toFixed(4));

    const stability = settlement.stability || settlement.stabilityScore || 0;
    const policy = settlement.policyEffects || {};
    const welfareRelief = policy.welfareStabilityRelief ?? 0;
    const collapseRelief = policy.welfareCollapseRelief ?? 0;
    const expansionMigrationBoost = policy.expansionMigrationBoost ?? 0;
    const birthRateMult = policy.birthRateMult ?? 1;

    const foodPenalty = foodStress * 0.02 * (1 - welfareRelief * 0.62);
    const welfareRecovery = welfareRelief * (foodStress > 0.45 ? 0.008 : 0.0035);
    settlement.stability = clamp(stability - foodPenalty + welfareRecovery, 0, 1);
    settlement.stabilityScore = settlement.stability;

    settlement.economyMigrationPressure = clamp(
      foodStress * 0.03 * (1 - welfareRelief * 0.45) + Math.max(0, expansionMigrationBoost) * 0.02,
      0,
      0.12
    );
    settlement.migrationOutRate = clamp(
      (settlement.migrationOutRate || 0) + settlement.economyMigrationPressure,
      0,
      1
    );
    settlement.birthMultiplier = clamp(
      (1 - 0.6 * foodStress) * birthRateMult * (1 + collapseRelief * 0.08),
      0.18,
      1
    );
    settlement.conflictSensitivity = clamp(
      materialStress * 0.02 * (1 - welfareRelief * 0.5),
      0,
      0.05
    );
    settlement.economicProfile = deriveEconomicProfile(
      settlement,
      foodPerCap,
      matPerCap,
      wealthPerCap
    );
    settlement.foodDeficitRatio = clamp01((foodConsRaw - foodProdRaw) / Math.max(foodConsRaw, 1e-6));

    settlement.foodPerCap = Number(foodPerCap.toFixed(4));
    settlement.materialsPerCap = Number(matPerCap.toFixed(4));
    settlement.wealthPerCap = Number(wealthPerCap.toFixed(4));
  }

  for (const settlement of settlements) {
    if (popValue(settlement) > 0) {
      continue;
    }
    ensureSettlementEconomyState(settlement);
    settlement.resources.food *= 0.999;
    settlement.resources.materials *= 0.999;
    settlement.resources.wealth *= 0.999;
    settlement.birthMultiplier = 0;
    settlement.conflictSensitivity = 0;
    settlement.economyMigrationPressure = 0;
    settlement.economicProfile = settlement.economicProfile || "Balanced";
    settlement.compositeStress = 0;
    settlement.economyRaw = {
      foodProd: 0,
      foodCons: 0,
      matProd: 0,
      matCons: 0,
      wealthProd: 0,
      wealthCons: 0,
      foodProdStabilizer: 0,
      foodConsStabilizer: 0
    };
    settlement.foodDeficitRatio = 0;
    settlement.foodPerCap = 0;
    settlement.materialsPerCap = 0;
    settlement.wealthPerCap = 0;
  }
}

module.exports = {
  economyStep,
  ensureSettlementEconomyState,
  defaultResources
};

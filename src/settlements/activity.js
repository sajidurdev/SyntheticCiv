function memberCount(settlement) {
  if (!settlement) {
    return 0;
  }
  if (Array.isArray(settlement.members)) {
    return settlement.members.length;
  }
  if (typeof settlement.population === "number") {
    return settlement.population;
  }
  return 0;
}

function isSettlementActive(settlement) {
  return memberCount(settlement) > 0;
}

function isSettlementRuined(settlement) {
  return !isSettlementActive(settlement);
}

module.exports = {
  memberCount,
  isSettlementActive,
  isSettlementRuined
};

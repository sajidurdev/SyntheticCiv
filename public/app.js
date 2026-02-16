const canvas = document.getElementById("worldCanvas");
const ctx = canvas.getContext("2d");

const settlementInfoEl = document.getElementById("settlementInfo");
const relationsListEl = document.getElementById("relationsList");
const tradeSummaryEl = document.getElementById("tradeSummary");
const eventsListEl = document.getElementById("eventsList");
const timelineSlider = document.getElementById("timelineSlider");
const timelineLabel = document.getElementById("timelineLabel");
const tickBadge = document.getElementById("tickBadge");
const civSummaryStrip = document.getElementById("civSummaryStrip");
const eraHistoryListEl = document.getElementById("eraHistoryList");
const eraDetailPanelEl = document.getElementById("eraDetailPanel");
const liveBtn = document.getElementById("liveBtn");
const replayBtn = document.getElementById("replayBtn");
const playPauseBtn = document.getElementById("playPauseBtn");
const eraStatusEl = document.getElementById("eraStatus");
const worldSummaryEl = document.getElementById("worldSummary");
const timelineEventsEl = document.getElementById("timelineEvents");
const inspectorPanelEl = document.getElementById("inspectorPanel");
const inspectorCloseBtn = document.getElementById("inspectorClose");
const matrixPanelEl = document.getElementById("civilizationMatrixPanel");
const matrixToggleBtn = document.querySelector("#matrixToggle .toggle-btn");
const globalDashBtn = document.getElementById("globalDashBtn");
const globalDashboardEl = document.getElementById("globalDashboard");
const closeDashBtn = document.getElementById("closeDashBtn");
const linkModeBarEl = document.getElementById("linkModeBar");

// Chart Canvases
const chartPop = document.getElementById("chartPop");
const chartStab = document.getElementById("chartStab");
const chartConflict = document.getElementById("chartConflict");
const chartWealth = document.getElementById("chartWealth");

const historyMap = new Map();
const ticks = [];
const maxClientHistory = 1500;

let world = { width: 96, height: 96 };
let latestTick = 0;
let currentViewTick = 0;
let liveMode = true;
let replayTimer = null;
let selectedSettlementId = null;
let lastFetchedTick = null;
let fetchInFlight = false;
let showInfluenceHeatmap = true;
let hoveredEraId = null;
let hoveredEraData = null;
let selectedEraId = null;
let selectedEraData = null;
let eraTickFilter = null;
let isPaused = false;

const settlementScreenCache = [];
const lineHoverTargets = [];
const previousAgentPositions = new Map();
let pointerCanvasPos = null;
let hoveredLineTarget = null;
let mapLegendOpen = false;
let mapLegendToggleBounds = null;
let mapLegendPanelBounds = null;
let linkMode = "all";

const LINK_MODE_LABELS = {
  all: "All Links",
  trade: "Trade Links",
  diplomacy: "Diplomacy Links",
  migration: "Migration Links",
  knowledge: "Knowledge Links"
};

function pointInRect(x, y, rect) {
  if (!rect) return false;
  return x >= rect.x && x <= (rect.x + rect.w) && y >= rect.y && y <= (rect.y + rect.h);
}

function civHue(civId) {
  const raw = String(civId || "wild");
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

function isSettlementActive(settlement) {
  if (!settlement) return false;
  if (Array.isArray(settlement.members)) {
    return settlement.members.length > 0;
  }
  return (settlement.population || 0) > 0 && !settlement.isRuined;
}

function settlementKnowledgeLevel(settlement) {
  if (!settlement) return 0;
  if (typeof settlement.knowledgeLevel === "number") {
    return Math.max(0, Math.min(1, settlement.knowledgeLevel));
  }
  const k = settlement.knowledge || {};
  const farming = Math.max(0, Math.min(1, k.farming || 0));
  const medicine = Math.max(0, Math.min(1, k.medicine || 0));
  const governance = Math.max(0, Math.min(1, k.governance || 0));
  const logistics = Math.max(0, Math.min(1, k.logistics || 0));
  return (farming + medicine + governance + logistics) / 4;
}

function getShockDescriptor(shock) {
  if (!shock) return null;
  const type = String(shock.type || "shock").toLowerCase();
  if (type === "famine") {
    return { label: "Famine", color: "rgba(255, 176, 92, 0.9)" };
  }
  if (type === "rebellion") {
    return { label: "Rebellion", color: "rgba(255, 102, 115, 0.92)" };
  }
  if (type === "epidemic") {
    return { label: "Epidemic", color: "rgba(160, 255, 186, 0.9)" };
  }
  if (type === "crash") {
    return { label: "Financial Crash", color: "rgba(255, 214, 112, 0.9)" };
  }
  return { label: "Shock", color: "rgba(255, 132, 132, 0.9)" };
}

function updateInspectorVisibility() {
  if (!inspectorPanelEl) return;
  inspectorPanelEl.classList.toggle("hidden", !selectedSettlementId);
}

function getLinkModeLabel(mode = linkMode) {
  return LINK_MODE_LABELS[mode] || LINK_MODE_LABELS.all;
}

function setLinkMode(nextMode) {
  const mode = Object.prototype.hasOwnProperty.call(LINK_MODE_LABELS, nextMode) ? nextMode : "all";
  linkMode = mode;
  if (!linkModeBarEl) {
    return;
  }
  const buttons = linkModeBarEl.querySelectorAll(".link-mode-btn");
  buttons.forEach((button) => {
    button.classList.toggle("active", button.dataset.linkMode === mode);
  });
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const bounds = canvas.getBoundingClientRect();
  const targetWidth = Math.floor(bounds.width * dpr);
  const targetHeight = Math.floor(bounds.height * dpr);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
}

function worldToCanvas(position) {
  return {
    x: (position.x / world.width) * canvas.width,
    y: (position.y / world.height) * canvas.height
  };
}

function colorFromAction(action) {
  if (action === "trade") return "rgba(32, 240, 214, 0.6)";
  if (action === "cooperate") return "rgba(255, 211, 106, 0.65)";
  if (action === "compete") return "rgba(255, 95, 109, 0.62)";
  if (action === "gather") return "rgba(130, 220, 145, 0.56)";
  return "rgba(115, 183, 216, 0.5)";
}

function withScaledAlpha(rgbaColor, scale) {
  const match = /^rgba\(([^)]+)\)$/.exec(String(rgbaColor || ""));
  if (!match) {
    return rgbaColor;
  }
  const parts = match[1].split(",").map((segment) => segment.trim());
  if (parts.length !== 4) {
    return rgbaColor;
  }
  const alpha = Number(parts[3]);
  if (!Number.isFinite(alpha)) {
    return rgbaColor;
  }
  const scaled = Math.max(0, Math.min(1, alpha * scale));
  return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${scaled})`;
}

function withAlpha(rgbaColor, alpha) {
  const match = /^rgba\(([^)]+)\)$/.exec(String(rgbaColor || ""));
  if (!match) {
    return rgbaColor;
  }
  const parts = match[1].split(",").map((segment) => segment.trim());
  if (parts.length !== 4) {
    return rgbaColor;
  }
  const clamped = Math.max(0, Math.min(1, alpha));
  return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${clamped})`;
}

function drawRoundedRect(context, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function addLineHoverTarget(target) {
  if (!target || !Array.isArray(target.points) || target.points.length < 2) {
    return;
  }
  lineHoverTargets.push(target);
}

function sampleQuadraticCurve(from, control, to, segments = 18) {
  const points = [];
  const count = Math.max(6, segments);
  for (let i = 0; i <= count; i += 1) {
    const t = i / count;
    const inv = 1 - t;
    const x = inv * inv * from.x + 2 * inv * t * control.x + t * t * to.x;
    const y = inv * inv * from.y + 2 * inv * t * control.y + t * t * to.y;
    points.push({ x, y });
  }
  return points;
}

function distancePointToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) {
    return Math.hypot(point.x - a.x, point.y - a.y);
  }
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(point.x - projX, point.y - projY);
}

function distancePointToPolyline(point, points) {
  if (!points || points.length < 2) {
    return Infinity;
  }
  let minDist = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    const dist = distancePointToSegment(point, points[i], points[i + 1]);
    if (dist < minDist) {
      minDist = dist;
    }
  }
  return minDist;
}

function resolveHoveredLineTarget() {
  if (!pointerCanvasPos || !lineHoverTargets.length) {
    hoveredLineTarget = null;
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const threshold = 10 * dpr;
  let best = null;
  for (const target of lineHoverTargets) {
    const hitWidth = Math.max(1, target.hitWidth || target.width || 1);
    const targetThreshold = Math.max(threshold, hitWidth * 1.75 + 5 * dpr);
    const dist = distancePointToPolyline(pointerCanvasPos, target.points);
    if (dist > targetThreshold) {
      continue;
    }
    const score = dist - (target.priority || 0) * 0.8;
    if (!best || score < best.score) {
      best = { score, dist, target };
    }
  }
  hoveredLineTarget = best ? { ...best.target, hoverDistance: best.dist } : null;
}

function pathFromPoints(points) {
  if (!points || points.length < 2) {
    return;
  }
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo(points[i].x, points[i].y);
  }
}

function buildSelectionContext(snapshot, tradeRoutes, diplomacyLines) {
  if (!selectedSettlementId) {
    return null;
  }
  const settlements = snapshot.settlements || [];
  const settlementById = new Map(settlements.map((settlement) => [settlement.id, settlement]));
  const selectedSettlement = settlementById.get(selectedSettlementId);
  if (!selectedSettlement) {
    return null;
  }

  const selectedCivId = selectedSettlement.civId || null;
  const sameCivSettlementIds = new Set();
  if (selectedCivId) {
    for (const settlement of settlements) {
      if (settlement.civId === selectedCivId) {
        sameCivSettlementIds.add(settlement.id);
      }
    }
  }

  const directRouteSettlementIds = new Set([selectedSettlement.id]);
  const directRouteKeys = new Set();
  for (const route of (tradeRoutes || [])) {
    if (route.from !== selectedSettlement.id && route.to !== selectedSettlement.id) {
      continue;
    }
    const other = route.from === selectedSettlement.id ? route.to : route.from;
    directRouteSettlementIds.add(other);
    directRouteKeys.add(`${route.from}|${route.to}`);
    directRouteKeys.add(`${route.to}|${route.from}`);
  }

  const relatedSettlementIds = new Set([
    selectedSettlement.id,
    ...sameCivSettlementIds,
    ...directRouteSettlementIds
  ]);
  const relatedCivIds = new Set();
  if (selectedCivId) {
    relatedCivIds.add(selectedCivId);
  }
  for (const settlementId of relatedSettlementIds) {
    const civId = settlementById.get(settlementId)?.civId;
    if (civId) {
      relatedCivIds.add(civId);
    }
  }

  const selectedDiplomacyPairKeys = new Set();
  if (selectedCivId) {
    for (const line of (diplomacyLines || [])) {
      if (line.civA !== selectedCivId && line.civB !== selectedCivId) {
        continue;
      }
      selectedDiplomacyPairKeys.add(`${line.civA}|${line.civB}`);
      selectedDiplomacyPairKeys.add(`${line.civB}|${line.civA}`);
    }
  }

  return {
    selectedSettlement,
    selectedSettlementId: selectedSettlement.id,
    selectedCivId,
    sameCivSettlementIds,
    directRouteSettlementIds,
    directRouteKeys,
    relatedSettlementIds,
    relatedCivIds,
    selectedDiplomacyPairKeys
  };
}

function addSnapshot(snapshot) {
  if (historyMap.has(snapshot.tick)) {
    historyMap.set(snapshot.tick, snapshot);
    return;
  }
  historyMap.set(snapshot.tick, snapshot);
  ticks.push(snapshot.tick);
  ticks.sort((a, b) => a - b);
  if (ticks.length > maxClientHistory) {
    const stale = ticks.shift();
    historyMap.delete(stale);
  }
}

function nearestTick(target) {
  const sourceTicks = getVisibleTicks();
  if (!sourceTicks.length) return 0;
  if (target <= sourceTicks[0]) return sourceTicks[0];
  if (target >= sourceTicks[sourceTicks.length - 1]) return sourceTicks[sourceTicks.length - 1];
  let lo = 0;
  let hi = sourceTicks.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const value = sourceTicks[mid];
    if (value === target) return value;
    if (value < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return sourceTicks[Math.max(0, lo - 1)];
}

function getVisibleTicks() {
  if (!eraTickFilter) {
    return ticks;
  }
  return ticks.filter((tick) => tick >= eraTickFilter.startTick && tick <= eraTickFilter.endTick);
}

function getEraHistory(snapshot) {
  if (!snapshot || !snapshot.eraHistory) {
    return [];
  }
  if (Array.isArray(snapshot.eraHistory.entries) && snapshot.eraHistory.entries.length) {
    return snapshot.eraHistory.entries;
  }
  if (Array.isArray(snapshot.eraHistory.eras)) {
    return snapshot.eraHistory.eras;
  }
  return [];
}

function getEraById(snapshot, eraId) {
  if (!snapshot || !eraId) return null;
  const eras = getEraHistory(snapshot);
  return eras.find((era) => era.id === eraId) || null;
}

function getCurrentEraFromSnapshot(snapshot) {
  if (!snapshot || !snapshot.eraHistory) return null;
  const eras = Array.isArray(snapshot.eraHistory.eras) ? snapshot.eraHistory.eras : [];
  if (!eras.length) return null;
  const currentEraId = snapshot.eraHistory.currentEraId || null;
  if (!currentEraId) {
    return eras[eras.length - 1];
  }
  return eras.find((era) => era.id === currentEraId) || eras[eras.length - 1];
}

function getActiveEra(snapshot) {
  return getEraById(snapshot, hoveredEraId || selectedEraId);
}

function getSnapshotForView() {
  if (!ticks.length) return null;
  const sourceTicks = getVisibleTicks();
  const boundedTicks = sourceTicks.length ? sourceTicks : ticks;
  if (liveMode) {
    return historyMap.get(boundedTicks[boundedTicks.length - 1]);
  }
  return historyMap.get(nearestTick(currentViewTick)) || historyMap.get(boundedTicks[boundedTicks.length - 1]);
}

function updateTimelineBounds() {
  if (!ticks.length) return;
  const sourceTicks = getVisibleTicks();
  const boundedTicks = sourceTicks.length ? sourceTicks : ticks;
  timelineSlider.min = String(boundedTicks[0]);
  timelineSlider.max = String(boundedTicks[boundedTicks.length - 1]);
  timelineSlider.step = "1";
  if (liveMode) {
    timelineSlider.value = String(boundedTicks[boundedTicks.length - 1]);
    currentViewTick = boundedTicks[boundedTicks.length - 1];
  } else {
    const near = nearestTick(currentViewTick);
    timelineSlider.value = String(near);
    currentViewTick = near;
  }
}

function renderBackground() {
  const w = canvas.width;
  const h = canvas.height;
  const gradient = ctx.createLinearGradient(0, 0, w, h);

  // BASE COLOR
  let stop0 = "rgba(3, 18, 32, 0.95)";
  let stop1 = "rgba(5, 16, 28, 0.96)";

  gradient.addColorStop(0, stop0);
  gradient.addColorStop(1, stop1);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(90, 176, 210, 0.09)";
  ctx.lineWidth = 1;
  const spacingX = w / 24;
  const spacingY = h / 24;
  for (let x = 0; x <= w; x += spacingX) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += spacingY) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
}

function drawInfluenceZones(civs, selectionContext = null) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  civs.forEach((civ, index) => {
    const focusMode = Boolean(selectionContext);
    const civInFocus = !focusMode || selectionContext.relatedCivIds.has(civ.id);
    const alphaScale = civInFocus ? 1 : 0.16;
    const emphasis = focusMode && civ.id === selectionContext.selectedCivId;
    const p = worldToCanvas(civ.centroid);
    const radius = Math.max(
      18,
      (civ.influenceRadius / world.width) * canvas.width * (emphasis ? 2.05 : 1.8)
    );
    const hue = (index * 75 + 35) % 360;
    const grad = ctx.createRadialGradient(p.x, p.y, radius * 0.2, p.x, p.y, radius);
    grad.addColorStop(0, `hsla(${hue}, 60%, 50%, ${(emphasis ? 0.12 : 0.08) * alphaScale})`);
    grad.addColorStop(0.5, `hsla(${hue}, 60%, 50%, ${(emphasis ? 0.06 : 0.04) * alphaScale})`);
    grad.addColorStop(1, `hsla(${hue}, 60%, 50%, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

function drawRegionalInfluenceHeatmap(settlements, selectionContext = null) {
  if (!showInfluenceHeatmap) {
    return;
  }
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const settlement of (settlements || [])) {
    if (!isSettlementActive(settlement)) continue;
    const center = settlement.center || settlement.centerPosition;
    const regional = settlement.regionalInfluence;
    if (!center || !regional) continue;
    const worldRadius = Math.max(4, regional.radius || 0);
    const radius = (worldRadius / world.width) * canvas.width;
    if (radius < 4) continue;

    const dominant = regional.alignmentCivId || regional.dominantCivId || settlement.civId || "wild";
    const hue = civHue(dominant);
    const conflict = regional.conflictPressure || 0;
    const cohesion = regional.cohesionPressure || 0;
    const p = worldToCanvas(center);
    const focusMode = Boolean(selectionContext);
    const inFocus = !focusMode || selectionContext.relatedSettlementIds.has(settlement.id);
    const alphaScale = inFocus ? 1 : 0.18;

    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
    grad.addColorStop(0, `hsla(${hue}, 88%, 58%, ${(0.06 + cohesion * 0.07) * alphaScale})`);
    grad.addColorStop(0.65, `hsla(${hue}, 82%, 52%, ${(0.03 + conflict * 0.05) * alphaScale})`);
    grad.addColorStop(1, `hsla(${hue}, 82%, 52%, 0.005)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawInfluenceAuras(settlements, tick, selectionContext = null) {
  (settlements || []).forEach((settlement, index) => {
    if (!isSettlementActive(settlement)) return;
    const center = settlement.center || settlement.centerPosition;
    if (!center) return;
    const aura = settlement.aura;
    if (!aura) return;

    const p = worldToCanvas(center);
    const radius = Math.max(12, (aura.radius / world.width) * canvas.width);
    const sig = settlement.civVisualSignature || { warmth: 0.5, brightnessShift: 0 };
    const hue = 185 - sig.warmth * 60;
    const flickerPhase = (Math.sin(tick * 0.09 + index * 0.7) * 0.5 + 0.5) * aura.flickerAmount;
    const focusMode = Boolean(selectionContext);
    const inFocus = !focusMode || selectionContext.relatedSettlementIds.has(settlement.id);
    const alphaScale = inFocus ? 1 : 0.2;
    const coreAlpha = Math.max(0.04, aura.brightness * (0.2 + sig.brightnessShift) - flickerPhase * 0.12);
    const edgeAlpha = Math.max(0.01, coreAlpha * (1 - aura.softness) * 0.8);

    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
    // Soft Green Halo (Civ Color) logic
    grad.addColorStop(0, `hsla(${hue}, 88%, 60%, ${coreAlpha * 0.8 * alphaScale})`);
    grad.addColorStop(0.6, `hsla(${hue}, 84%, 56%, ${edgeAlpha * 0.6 * alphaScale})`);
    grad.addColorStop(1, `hsla(${hue}, 84%, 56%, 0)`);
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

function edgePairKey(a, b) {
  const first = String(a ?? "");
  const second = String(b ?? "");
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function buildPairCountMap(items, keyFn) {
  const counts = new Map();
  for (const item of (items || [])) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function computeLaneOffset(key, pairCounts, pairSeen) {
  const total = pairCounts.get(key) || 1;
  const seen = pairSeen.get(key) || 0;
  pairSeen.set(key, seen + 1);
  return seen - (total - 1) / 2;
}

function curveControlWithBend(from, to, bend) {
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const nx = -dy / len;
  const ny = dx / len;
  return { x: midX + nx * bend, y: midY + ny * bend };
}

// Marching ants for conflict
function drawDiplomacyLines(lines, tick, selectionContext = null) {
  const pairCounts = buildPairCountMap(lines, (line) => edgePairKey(line.civA, line.civB));
  const pairSeen = new Map();
  lines.forEach((line, index) => {
    const rawA = worldToCanvas(line.from);
    const rawB = worldToCanvas(line.to);
    const pairKey = edgePairKey(line.civA, line.civB);
    const lane = computeLaneOffset(pairKey, pairCounts, pairSeen);
    const distance = Math.max(1, Math.hypot(rawB.x - rawA.x, rawB.y - rawA.y));
    const diplomacyBend = Math.max(14, Math.min(52, distance * 0.08));
    const control = curveControlWithBend(rawA, rawB, diplomacyBend + lane * 5 + (index % 2 === 0 ? 2.4 : -2.4));
    const focusMode = Boolean(selectionContext);
    const includesSelectedCiv = focusMode && (
      line.civA === selectionContext.selectedCivId ||
      line.civB === selectionContext.selectedCivId
    );
    const related = !focusMode || includesSelectedCiv || (
      selectionContext.relatedCivIds.has(line.civA) &&
      selectionContext.relatedCivIds.has(line.civB)
    );
    const alphaScale = related ? (includesSelectedCiv ? 1.05 : 0.92) : 0.58;
    let stroke = "rgba(255, 214, 92, 0.55)";
    if (line.color === "green") stroke = "rgba(84, 255, 154, 0.68)";
    if (line.color === "red") stroke = "rgba(255, 92, 115, 0.7)";

    ctx.save();
    ctx.globalAlpha = alphaScale;
    ctx.strokeStyle = stroke;
    let linkWidth = 1;
    let style = "neutral";

    // DASHED RED LINE = Conflict/Tension
    // If relation is negative, use dashed. If positive, use solid or fine dots
    if (line.relation < -0.1) {
      ctx.setLineDash([8, 6]);
      linkWidth = includesSelectedCiv ? 3 : 2;
      ctx.lineWidth = linkWidth;
      ctx.strokeStyle = "rgba(255, 70, 70, 0.75)";
      style = "hostile";
      // offset based on tick
      ctx.lineDashOffset = -(tick * 0.5) % 14;
    } else {
      ctx.setLineDash([]);
      linkWidth = (1 + line.relation * 2) + (includesSelectedCiv ? 0.9 : 0);
      ctx.lineWidth = linkWidth;
      style = line.relation > 0.2 ? "cooperative" : "neutral";
    }

    ctx.beginPath();
    ctx.moveTo(rawA.x, rawA.y);
    ctx.quadraticCurveTo(control.x, control.y, rawB.x, rawB.y);
    ctx.stroke();
    ctx.restore();

    addLineHoverTarget({
      kind: "diplomacy",
      civA: line.civA,
      civB: line.civB,
      relation: line.relation || 0,
      style,
      width: linkWidth,
      hitWidth: Math.max(9, linkWidth + 6),
      priority: includesSelectedCiv ? 5 : 2,
      points: sampleQuadraticCurve(rawA, control, rawB, 18)
    });
  });
}

function routeCurveControl(from, to, index, laneOffset = 0, channelOffset = 0) {
  const distance = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y));
  const baseBend = Math.max(8, Math.min(34, distance * 0.045));
  const bend = baseBend + (index % 3) * 2.2 + laneOffset * 4 + channelOffset;
  return curveControlWithBend(from, to, bend);
}

// opacity for flows
function drawTradeRoutes(routes, tick, selectionContext = null) {
  const pairCounts = buildPairCountMap(routes, (route) => edgePairKey(route.from, route.to));
  const pairSeen = new Map();
  routes.forEach((route, index) => {
    const from = worldToCanvas(route.fromPosition);
    const to = worldToCanvas(route.toPosition);
    const pairKey = edgePairKey(route.from, route.to);
    const lane = computeLaneOffset(pairKey, pairCounts, pairSeen);
    const control = routeCurveControl(from, to, index, lane, 7.8);
    const focusMode = Boolean(selectionContext);
    const isDirect = focusMode && selectionContext.directRouteKeys.has(`${route.from}|${route.to}`);
    const isRelated = !focusMode || isDirect || (
      selectionContext.relatedSettlementIds.has(route.from) &&
      selectionContext.relatedSettlementIds.has(route.to)
    );
    const isFaded = focusMode && !isRelated;

    // effect
    const phase = Math.sin(tick * 0.1 + index) * 0.5 + 0.5;
    const reliability = Math.max(0.2, Math.min(1.3, route.routeReliability || 1));
    const baseAlpha = Math.min(0.85, (0.22 + route.tradeVolume * 0.03) * (0.72 + reliability * 0.4));
    let alpha = baseAlpha * (0.8 + phase * 0.3);

    ctx.save();
    if (isFaded) {
      alpha *= 0.58;
    } else if (!isDirect && focusMode) {
      alpha *= 0.86;
    } else if (isDirect) {
      alpha = Math.min(0.96, alpha * 1.2);
    }
    // THICK BLUE LINE = Trade Flow
    const isHeavy = route.tradeVolume > 30;
    let width = isHeavy ? 3 + Math.min(4, route.tradeVolume / 20) : 1;
    if (isDirect) {
      width += 1.4;
    } else if (isFaded) {
      width = Math.max(0.9, width * 0.9);
    } else if (focusMode) {
      width = Math.max(1, width * 0.96);
    }
    ctx.lineWidth = width;

    let baseBlue = reliability < 0.55
      ? "rgba(102, 165, 210, "
      : (isHeavy ? "rgba(0, 180, 255, " : "rgba(80, 200, 255, ");
    if (isDirect) {
      baseBlue = "rgba(116, 240, 255, ";
    }
    ctx.strokeStyle = `${baseBlue}${alpha})`;

    ctx.shadowColor = isDirect ? "rgba(116, 240, 255, 0.85)" : "rgba(0, 180, 255, 0.6)";
    ctx.shadowBlur = isFaded ? 0 : (isDirect ? 16 : (isHeavy ? 12 : 0));

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(control.x, control.y, to.x, to.y);
    ctx.stroke();
    ctx.restore();

    addLineHoverTarget({
      kind: "trade",
      from: route.from,
      to: route.to,
      volume: route.tradeVolume || 0,
      reliability: Number.isFinite(route.routeReliability) ? route.routeReliability : 0,
      momentum: Number.isFinite(route.routeMomentum) ? route.routeMomentum : 0,
      distance: Number.isFinite(route.routeDistance)
        ? route.routeDistance
        : (Number.isFinite(route.distance)
          ? route.distance
          : Math.hypot(
            (route.toPosition?.x || 0) - (route.fromPosition?.x || 0),
            (route.toPosition?.y || 0) - (route.fromPosition?.y || 0)
          )),
      width,
      hitWidth: Math.max(8, width + 6),
      style: isDirect ? "direct" : "standard",
      priority: isDirect ? 6 : (isRelated ? 3 : 1),
      points: sampleQuadraticCurve(from, control, to, 16)
    });
  });
}

function drawMigrationStreams(streams, settlements, tick, selectionContext = null) {
  if (!streams || !streams.length) {
    return;
  }
  const byId = new Map((settlements || []).map((s) => [s.id, s]));
  const pairCounts = buildPairCountMap(streams, (stream) => edgePairKey(stream.fromSettlementId, stream.toSettlementId));
  const pairSeen = new Map();
  streams.forEach((stream, index) => {
    const from = byId.get(stream.fromSettlementId);
    const to = byId.get(stream.toSettlementId);
    if (!from || !to) return;
    if (!isSettlementActive(from) || !isSettlementActive(to)) return;

    const fromPosRaw = worldToCanvas(from.center || from.centerPosition);
    const toPosRaw = worldToCanvas(to.center || to.centerPosition);
    const pairKey = edgePairKey(stream.fromSettlementId, stream.toSettlementId);
    const lane = computeLaneOffset(pairKey, pairCounts, pairSeen);
    const distance = Math.max(1, Math.hypot(toPosRaw.x - fromPosRaw.x, toPosRaw.y - fromPosRaw.y));
    const migrationBend = Math.max(16, Math.min(58, distance * 0.095));
    const control = curveControlWithBend(fromPosRaw, toPosRaw, -migrationBend - lane * 5.4);
    const focusMode = Boolean(selectionContext);
    const inFocus = !focusMode || (
      selectionContext.relatedSettlementIds.has(from.id) &&
      selectionContext.relatedSettlementIds.has(to.id)
    );
    const intensity = stream.intensity || 0;
    const width = 0.6 + intensity * 2.2;
    const alpha = (0.16 + intensity * 0.28) * (inFocus ? 1 : 0.52);

    ctx.save();
    ctx.strokeStyle = `rgba(126, 221, 255, ${alpha})`;
    ctx.lineWidth = inFocus ? width : Math.max(0.7, width * 0.85);
    ctx.setLineDash([7, 9]);
    const offset = -((tick * 0.85 + index * 3) % 16);
    ctx.lineDashOffset = offset;
    ctx.beginPath();
    ctx.moveTo(fromPosRaw.x, fromPosRaw.y);
    ctx.quadraticCurveTo(control.x, control.y, toPosRaw.x, toPosRaw.y);
    ctx.stroke();
    ctx.restore();

    addLineHoverTarget({
      kind: "migration",
      from: stream.fromSettlementId,
      to: stream.toSettlementId,
      intensity,
      width: inFocus ? width : Math.max(0.5, width * 0.65),
      hitWidth: Math.max(8.5, width + 6),
      style: "migration",
      priority: inFocus ? 4 : 1,
      points: sampleQuadraticCurve(fromPosRaw, control, toPosRaw, 16)
    });
  });
}

function drawKnowledgeDiffusion(routes, settlements, tick, selectionContext = null) {
  if (!routes || !routes.length || !settlements || !settlements.length) {
    return;
  }
  const settlementById = new Map(settlements.map((s) => [s.id, s]));
  const ranked = routes
    .map((route) => {
      const from = settlementById.get(route.from);
      const to = settlementById.get(route.to);
      if (!from || !to) return null;
      if (!isSettlementActive(from) || !isSettlementActive(to)) return null;
      const kFrom = settlementKnowledgeLevel(from);
      const kTo = settlementKnowledgeLevel(to);
      const gap = Math.abs(kFrom - kTo);
      const innovationSignal = (route.routeInnovationReliability || 1) - 1;
      const score = gap * 0.7 + Math.max(0, innovationSignal) * 0.3;
      return { route, from, to, gap, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 18);

  const pairCounts = buildPairCountMap(ranked, (row) => edgePairKey(row.route.from, row.route.to));
  const pairSeen = new Map();
  for (let i = 0; i < ranked.length; i += 1) {
    const row = ranked[i];
    if (row.score < 0.035) continue;
    const pairKey = edgePairKey(row.route.from, row.route.to);
    const lane = computeLaneOffset(pairKey, pairCounts, pairSeen);
    const focusMode = Boolean(selectionContext);
    const inFocus = !focusMode || (
      selectionContext.relatedSettlementIds.has(row.route.from) &&
      selectionContext.relatedSettlementIds.has(row.route.to)
    );
    const fromPosRaw = worldToCanvas(row.route.fromPosition || row.from.center || row.from.centerPosition);
    const toPosRaw = worldToCanvas(row.route.toPosition || row.to.center || row.to.centerPosition);
    const distance = Math.max(1, Math.hypot(toPosRaw.x - fromPosRaw.x, toPosRaw.y - fromPosRaw.y));
    const knowledgeBend = Math.max(18, Math.min(64, distance * 0.11));
    const control = curveControlWithBend(fromPosRaw, toPosRaw, knowledgeBend + lane * 5.8);
    const flow = 0.18 + Math.min(0.48, row.score * 0.95);
    const wave = 0.85 + (Math.sin(tick * 0.07 + i * 0.9) * 0.5 + 0.5) * 0.3;
    const width = inFocus ? (1.5 + row.score * 3.2) : 1.15;

    ctx.save();
    const alpha = flow * wave * (inFocus ? 1 : 0.45);
    ctx.strokeStyle = `rgba(126, 255, 248, ${Math.min(0.95, alpha * 1.2)})`;
    ctx.lineWidth = width + 1.25;
    ctx.shadowColor = "rgba(126, 255, 248, 0.9)";
    ctx.shadowBlur = inFocus ? 10 : 4;
    ctx.setLineDash([5, 7]);
    ctx.lineDashOffset = -((tick * 0.6 + i * 2) % 12);
    ctx.beginPath();
    ctx.moveTo(fromPosRaw.x, fromPosRaw.y);
    ctx.quadraticCurveTo(control.x, control.y, toPosRaw.x, toPosRaw.y);
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(188, 255, 252, ${Math.min(1, alpha * 0.95)})`;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(fromPosRaw.x, fromPosRaw.y);
    ctx.quadraticCurveTo(control.x, control.y, toPosRaw.x, toPosRaw.y);
    ctx.stroke();
    ctx.restore();

    addLineHoverTarget({
      kind: "knowledge",
      from: row.route.from,
      to: row.route.to,
      diffusion: row.gap || row.score || 0,
      width,
      hitWidth: Math.max(11, width + 8),
      style: "knowledge",
      priority: inFocus ? 5 : 2,
      points: sampleQuadraticCurve(fromPosRaw, control, toPosRaw, 16)
    });
  }
}

function drawShockOverlays(settlements, tick, selectionContext = null) {
  if (!settlements || !settlements.length) return;
  for (let i = 0; i < settlements.length; i += 1) {
    const settlement = settlements[i];
    if (!isSettlementActive(settlement)) continue;
    const activeShock = settlement.shockState && settlement.shockState.activeShock
      ? settlement.shockState.activeShock
      : null;
    if (!activeShock) continue;
    const center = settlement.center || settlement.centerPosition;
    if (!center) continue;
    const descriptor = getShockDescriptor(activeShock);
    const p = worldToCanvas(center);
    const focusMode = Boolean(selectionContext);
    const inFocus = !focusMode || selectionContext.relatedSettlementIds.has(settlement.id);
    const alphaScale = inFocus ? 1 : 0.18;
    const severity = Math.max(0, Math.min(1, activeShock.severity || 0));
    const phase = Math.sin(tick * 0.18 + i * 0.85) * 0.5 + 0.5;
    const radius = 10 + Math.sqrt(Math.max(1, settlement.population || 1)) * 0.85 + severity * 11 + phase * 2.2;

    ctx.save();
    ctx.strokeStyle = withAlpha(descriptor.color, (0.4 + severity * 0.35) * alphaScale);
    ctx.lineWidth = (1.4 + severity * 1.8) * (inFocus ? 1 : 0.75);
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = withScaledAlpha(descriptor.color, alphaScale);
    ctx.font = `${Math.max(10, Math.floor(canvas.width / 180))}px Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.fillText("!", p.x, p.y - radius - 4);
    ctx.restore();
  }
}

function drawBeliefField(settlements, selectionContext = null) {
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (const settlement of (settlements || [])) {
    if (!isSettlementActive(settlement)) continue;
    const center = settlement.center || settlement.centerPosition;
    if (!center) continue;
    const perceivedThreat = Math.max(0, Math.min(1, (settlement.securityStress || 0) * 0.65 + (settlement.legitimacyStress || 0) * 0.35));
    const perceivedStability = Math.max(0, Math.min(1, (settlement.stability || settlement.stabilityScore || 0) * 0.75 + (settlement.tradeConsistency || 0) * 0.25));
    const p = worldToCanvas(center);
    const radius = 20 + Math.sqrt(Math.max(1, settlement.population || 1)) * 1.8;
    const hue = 210 - perceivedThreat * 120;
    const focusMode = Boolean(selectionContext);
    const inFocus = !focusMode || selectionContext.relatedSettlementIds.has(settlement.id);
    const alphaScale = inFocus ? 1 : 0.16;
    const alphaCore = 0.06 + perceivedStability * 0.1;
    const alphaEdge = 0.04 + perceivedThreat * 0.08;
    const grad = ctx.createRadialGradient(p.x, p.y, radius * 0.1, p.x, p.y, radius);
    grad.addColorStop(0, `hsla(${hue}, 35%, 62%, ${alphaCore * alphaScale})`);
    grad.addColorStop(1, `hsla(${hue}, 28%, 46%, ${alphaEdge * alphaScale})`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPoliticsField(settlements, civilizations, selectionContext = null) {
  const civById = new Map((civilizations || []).map((c) => [c.id, c]));
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (const settlement of (settlements || [])) {
    if (!isSettlementActive(settlement)) continue;
    const center = settlement.center || settlement.centerPosition;
    if (!center) continue;
    const civ = civById.get(settlement.civId);
    const tension = Math.max(0, Math.min(1, civ?.factionTension || 0));
    const p = worldToCanvas(center);
    const radius = 18 + Math.sqrt(Math.max(1, settlement.population || 1)) * 1.65;
    const hue = 200 - tension * 90;
    const focusMode = Boolean(selectionContext);
    const inFocus = !focusMode || selectionContext.relatedSettlementIds.has(settlement.id);
    const alphaScale = inFocus ? 1 : 0.16;
    const grad = ctx.createRadialGradient(p.x, p.y, radius * 0.2, p.x, p.y, radius);
    grad.addColorStop(0, `hsla(${hue}, 30%, 58%, ${(0.07 + (1 - tension) * 0.06) * alphaScale})`);
    grad.addColorStop(1, `hsla(${hue}, 24%, 42%, ${(0.05 + tension * 0.08) * alphaScale})`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawWarField(snapshot, selectionContext = null) {
  const settlements = snapshot.settlements || [];
  const agents = snapshot.agents || [];
  const bySettlement = new Map();
  for (const settlement of settlements) {
    bySettlement.set(settlement.id, { morale: 0, exhaustion: 0, count: 0 });
  }
  for (const agent of agents) {
    const sid = agent.settlementId;
    if (!sid || sid === "wild" || !bySettlement.has(sid)) continue;
    const row = bySettlement.get(sid);
    row.morale += Math.max(0, Math.min(1, agent.morale ?? 0.5));
    row.exhaustion += Math.max(0, Math.min(1, agent.warExhaustion ?? 0));
    row.count += 1;
  }

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (const settlement of settlements) {
    if (!isSettlementActive(settlement)) continue;
    const center = settlement.center || settlement.centerPosition;
    if (!center) continue;
    const row = bySettlement.get(settlement.id) || { morale: 0.5, exhaustion: 0, count: 1 };
    const morale = row.count ? row.morale / row.count : 0.5;
    const exhaustion = row.count ? row.exhaustion / row.count : 0;
    const supply = Math.max(0, Math.min(1, (settlement.foodPerCap || 0) * 0.5 + Math.min(1, (settlement.materialsPerCap || 0) / 2) * 0.5));
    const conflict = Math.max(0, Math.min(1, settlement.conflictRate || 0));
    const stress = Math.max(0, Math.min(1, conflict * 0.45 + exhaustion * 0.35 + (1 - supply) * 0.2));
    const p = worldToCanvas(center);
    const radius = 16 + Math.sqrt(Math.max(1, settlement.population || 1)) * 1.6;
    const hue = 32 - stress * 22;
    const focusMode = Boolean(selectionContext);
    const inFocus = !focusMode || selectionContext.relatedSettlementIds.has(settlement.id);
    const alphaScale = inFocus ? 1 : 0.16;
    const grad = ctx.createRadialGradient(p.x, p.y, radius * 0.1, p.x, p.y, radius);
    grad.addColorStop(0, `hsla(${hue}, 38%, 58%, ${(0.06 + (1 - morale) * 0.11) * alphaScale})`);
    grad.addColorStop(1, `hsla(${hue}, 42%, 42%, ${(0.05 + stress * 0.1) * alphaScale})`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawEconomicStressField(settlements, selectionContext = null) {
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (const settlement of (settlements || [])) {
    if (!isSettlementActive(settlement)) continue;
    const center = settlement.center || settlement.centerPosition;
    if (!center) continue;
    const stress = Math.max(0, Math.min(1, settlement.economicStress || 0));
    const p = worldToCanvas(center);
    const radius = 20 + Math.sqrt(Math.max(1, settlement.population || 1)) * 1.7;
    const hue = 210 - stress * 175;
    const focusMode = Boolean(selectionContext);
    const inFocus = !focusMode || selectionContext.relatedSettlementIds.has(settlement.id);
    const alphaScale = inFocus ? 1 : 0.16;
    const grad = ctx.createRadialGradient(p.x, p.y, radius * 0.15, p.x, p.y, radius);
    grad.addColorStop(0, `hsla(${hue}, 34%, 56%, ${(0.05 + (1 - stress) * 0.05) * alphaScale})`);
    grad.addColorStop(1, `hsla(${hue}, 40%, 40%, ${(0.05 + stress * 0.11) * alphaScale})`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawShockRiskField(settlements, tick, selectionContext = null) {
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < (settlements || []).length; i += 1) {
    const settlement = settlements[i];
    if (!isSettlementActive(settlement)) continue;
    const center = settlement.center || settlement.centerPosition;
    if (!center) continue;
    const risk = settlement.shockState && settlement.shockState.risk
      ? Math.max(
        settlement.shockState.risk.famine || 0,
        settlement.shockState.risk.rebellion || 0,
        settlement.shockState.risk.epidemic || 0,
        settlement.shockState.risk.crash || 0
      )
      : 0;
    if (risk < 0.05) continue;
    const p = worldToCanvas(center);
    const focusMode = Boolean(selectionContext);
    const inFocus = !focusMode || selectionContext.relatedSettlementIds.has(settlement.id);
    const wave = Math.sin(tick * 0.12 + i * 0.7) * 0.5 + 0.5;
    const radius = 18 + Math.sqrt(Math.max(1, settlement.population || 1)) * 1.7 + wave * 5;
    const alpha = (0.04 + risk * 0.16) * (inFocus ? 1 : 0.16);
    const grad = ctx.createRadialGradient(p.x, p.y, radius * 0.2, p.x, p.y, radius);
    grad.addColorStop(0, `rgba(190, 135, 135, ${alpha * 0.75})`);
    grad.addColorStop(1, `rgba(124, 92, 92, ${alpha})`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawAgents(agents, tick, selectionContext = null) {
  const focusMode = Boolean(selectionContext);
  const seen = new Set();
  (agents || []).forEach((agent) => {
    seen.add(agent.id);
    const p = worldToCanvas(agent.position);
    const prev = previousAgentPositions.get(agent.id);
    const inSelectedSettlement = focusMode && agent.settlementId === selectionContext.selectedSettlementId;
    const inRelatedSettlement = focusMode && selectionContext.relatedSettlementIds.has(agent.settlementId);
    const alphaScale = !focusMode ? 1 : (inSelectedSettlement ? 1 : (inRelatedSettlement ? 0.55 : 0.14));
    const base = withScaledAlpha(colorFromAction(agent.currentAction), alphaScale);
    const energy = Math.max(0, Math.min(1, (agent.energy || 0) / 150));
    const baseRadius = !focusMode ? 1.5 : (inSelectedSettlement ? 2.6 : (inRelatedSettlement ? 1.9 : 1.1));
    const radius = baseRadius * (0.82 + energy * 0.45);
    if (prev) {
      const dist = Math.hypot(prev.x - p.x, prev.y - p.y);
      if (dist > 0.6) {
        ctx.save();
        ctx.strokeStyle = withScaledAlpha(base, 0.55);
        ctx.lineWidth = Math.max(0.7, radius * 0.85);
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.restore();
      }
    }

    ctx.save();
    ctx.fillStyle = base;
    ctx.shadowColor = withScaledAlpha(base, 0.85);
    ctx.shadowBlur = inSelectedSettlement ? 9 : (inRelatedSettlement ? 6 : 3);
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();

    if (agent.currentAction === "trade" || agent.currentAction === "cooperate" || agent.currentAction === "compete") {
      const pulse = 0.6 + (Math.sin(tick * 0.22 + (agent.id % 31)) * 0.5 + 0.5) * 0.5;
      const ringColor = agent.currentAction === "trade"
        ? "rgba(122, 246, 255, 0.8)"
        : (agent.currentAction === "cooperate" ? "rgba(255, 226, 150, 0.78)" : "rgba(255, 132, 144, 0.82)");
      ctx.strokeStyle = withScaledAlpha(ringColor, alphaScale * pulse);
      ctx.lineWidth = Math.max(0.8, radius * 0.55);
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + 1.1 + pulse * 0.6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    previousAgentPositions.set(agent.id, { x: p.x, y: p.y, tick });
  });

  for (const id of previousAgentPositions.keys()) {
    if (!seen.has(id)) {
      previousAgentPositions.delete(id);
    }
  }
}

function drawSettlements(settlements, tick, highlightSettlementIds = new Set(), selectionContext = null) {
  settlementScreenCache.length = 0;
  const focusMode = Boolean(selectionContext);
  (settlements || []).forEach((settlement, index) => {
    const center = settlement.center || settlement.centerPosition;
    if (!center) return;
    const p = worldToCanvas(center);
    const ruined = !isSettlementActive(settlement);
    const baseRadius = 4 + Math.sqrt(settlement.population) * 0.7;
    const stability = settlement.stability ?? settlement.stabilityScore ?? 0;
    const visualSignals = settlement.visualSignals || {};
    const aura = settlement.aura || {};
    const sig = settlement.civVisualSignature || { warmth: 0.5, saturationShift: 0, brightnessShift: 0 };
    // Keep settlement render centers stable so link endpoints always align with nodes.
    const jitterX = 0;
    const jitterY = 0;
    const pulseFreq = visualSignals.pulseFrequency || 0.02;
    const pulseAmp = visualSignals.pulseAmplitude || (1.2 + stability * 2.8);
    const pulse =
      (Math.sin(tick * pulseFreq + index * 0.85) * 0.5 + 0.5) * pulseAmp;
    const radius = baseRadius + pulse;
    const selected = selectedSettlementId === settlement.id;
    const inFocus = !focusMode || selectionContext.relatedSettlementIds.has(settlement.id) || selected;
    const directTradeNeighbor = focusMode &&
      selectionContext.directRouteSettlementIds.has(settlement.id) &&
      !selected;
    const sameCiv = focusMode &&
      selectionContext.sameCivSettlementIds.has(settlement.id) &&
      !selected;
    const highlightedByEra = highlightSettlementIds.has(String(settlement.id));
    const focusAlpha = inFocus ? 1 : 0.2;

    const decline = visualSignals.declineIndicator || 0;
    const growth = visualSignals.growthIndicator || 0;
    const hueBase = 32 + stability * 120 + (0.5 - sig.warmth) * 50;
    const hue = Math.max(0, Math.min(220, hueBase));
    const sat = Math.max(40, Math.min(98, 84 + sig.saturationShift * 100));
    const light = Math.max(34, Math.min(76, 56 + sig.brightnessShift * 48 + growth * 4 - decline * 6));
    const baseCoreAlpha = Math.max(0.45, 0.8 + (visualSignals.glowIntensity || aura.brightness || 0.4) * 0.18 - decline * 0.15);
    const coreAlpha = (ruined ? 0.18 : baseCoreAlpha) * focusAlpha;
    const coreColor = `hsla(${hue}, ${sat}%, ${light}%, ${coreAlpha})`;
    const glowColor = `hsla(${hue}, ${sat}%, ${Math.min(84, light + 8)}%, ${(visualSignals.glowIntensity || 0.35) * 0.45 * focusAlpha})`;
    const px = p.x + jitterX;
    const py = p.y + jitterY;

    ctx.save();
    if (!ruined) {
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = selected ? 30 : (directTradeNeighbor ? 22 : (inFocus ? 16 : 4));
    }
    ctx.fillStyle = coreColor;
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (selected) {
      const focusPulse = 0.65 + (Math.sin(tick * 0.16) * 0.5 + 0.5) * 0.35;
      ctx.save();
      ctx.strokeStyle = `rgba(132, 239, 255, ${focusPulse})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(px, py, radius + 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(px, py, radius + 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (directTradeNeighbor && !ruined) {
      ctx.save();
      ctx.strokeStyle = "rgba(92, 230, 255, 0.84)";
      ctx.lineWidth = 1.8;
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -(tick * 0.5) % 8;
      ctx.beginPath();
      ctx.arc(px, py, radius + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else if (sameCiv && !ruined) {
      ctx.save();
      ctx.strokeStyle = "rgba(157, 205, 255, 0.42)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(px, py, radius + 3.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (highlightedByEra && !ruined) {
      ctx.save();
      ctx.strokeStyle = "rgba(112, 235, 255, 0.86)";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(px, py, radius + 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    const warningAlpha = ruined ? 0 : (visualSignals.collapseWarningAlpha || 0);

    // ORANGE NODE GLOW = High Saturation
    const satLevel = settlement.influenceSaturation ? settlement.influenceSaturation.saturationLevel : 0;
    const isSaturated = satLevel > 0.8;

    if (warningAlpha > 0.01 && inFocus) {
      ctx.save();
      ctx.strokeStyle = `rgba(255, 90, 90, ${warningAlpha})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, radius + 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (isSaturated && !ruined && inFocus) {
      ctx.save();
      ctx.shadowColor = "rgba(255, 140, 0, 0.9)";
      ctx.shadowBlur = 14;
      ctx.strokeStyle = "rgba(255, 140, 0, 0.7)";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(px, py, radius + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    const roleRings = ruined ? {} : (visualSignals.roleRings || {});
    if ((roleRings.tradeHubHaloAlpha || 0) > 0.01 && inFocus) {
      ctx.save();
      ctx.strokeStyle = `rgba(102, 235, 255, ${roleRings.tradeHubHaloAlpha})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(px, py, radius + 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if ((roleRings.strugglingDistortionAlpha || 0) > 0.01 && inFocus) {
      const distort = 2 + (roleRings.strugglingDistortionAlpha || 0) * 6;
      ctx.save();
      ctx.strokeStyle = `rgba(255, 112, 112, ${roleRings.strugglingDistortionAlpha})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(px, py, radius + 10 + distort, radius + 7, 0.25, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if ((roleRings.frontierRippleAlpha || 0) > 0.01 && inFocus) {
      const ripple = (tick % 48) / 48;
      ctx.save();
      ctx.strokeStyle = `rgba(142, 222, 255, ${roleRings.frontierRippleAlpha * (1 - ripple)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(px, py, radius + 8 + ripple * 18, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    settlementScreenCache.push({ id: settlement.id, x: px, y: py, r: focusMode ? (radius + 10) : (radius + 8) });

    if (selected) {
      const title = `S${settlement.id}  ${settlement.civId || "Wild"}`;
      const subtitle = settlement.role || "General";
      ctx.save();
      ctx.font = "600 11px Inter, Segoe UI, sans-serif";
      const titleWidth = ctx.measureText(title).width;
      ctx.font = "10px Inter, Segoe UI, sans-serif";
      const subtitleWidth = ctx.measureText(subtitle).width;
      const boxWidth = Math.max(titleWidth, subtitleWidth) + 16;
      const boxHeight = 30;
      const boxX = Math.max(10, Math.min(canvas.width - boxWidth - 10, px + radius + 12));
      const boxY = Math.max(10, Math.min(canvas.height - boxHeight - 10, py - boxHeight - 8));
      drawRoundedRect(ctx, boxX, boxY, boxWidth, boxHeight, 7);
      ctx.fillStyle = "rgba(11, 17, 24, 0.9)";
      ctx.fill();
      ctx.strokeStyle = "rgba(132, 239, 255, 0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "rgba(220, 241, 255, 0.96)";
      ctx.font = "600 11px Inter, Segoe UI, sans-serif";
      ctx.fillText(title, boxX + 8, boxY + 12);
      ctx.fillStyle = "rgba(162, 199, 224, 0.92)";
      ctx.font = "10px Inter, Segoe UI, sans-serif";
      ctx.fillText(subtitle, boxX + 8, boxY + 24);
      ctx.restore();
    }
  });
}

function drawSelectionLegend(selectionContext) {
  if (!selectionContext) {
    return;
  }
  const selected = selectionContext.selectedSettlement;
  if (!selected) {
    return;
  }
  const lines = [
    `Selected S${selected.id} (${selected.civId || "Wild"})`,
    `${selectionContext.directRouteSettlementIds.size - 1} direct trade links`,
    `${selectionContext.sameCivSettlementIds.size} settlements in civ`,
    "Click empty map to clear focus"
  ];
  ctx.save();
  ctx.font = "11px Inter, Segoe UI, sans-serif";
  const width = lines.reduce((maxWidth, line) => Math.max(maxWidth, ctx.measureText(line).width), 0) + 18;
  const lineHeight = 14;
  const height = lineHeight * lines.length + 12;
  const x = 14;
  const y = 14;
  drawRoundedRect(ctx, x, y, width, height, 8);
  ctx.fillStyle = "rgba(8, 14, 21, 0.78)";
  ctx.fill();
  ctx.strokeStyle = "rgba(123, 218, 246, 0.45)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "rgba(212, 238, 252, 0.95)";
  lines.forEach((line, index) => {
    const yLine = y + 14 + index * lineHeight;
    if (index === 0) {
      ctx.font = "600 11px Inter, Segoe UI, sans-serif";
      ctx.fillStyle = "rgba(225, 245, 255, 0.98)";
    } else if (index === 3) {
      ctx.font = "10px Inter, Segoe UI, sans-serif";
      ctx.fillStyle = "rgba(159, 194, 220, 0.88)";
    } else {
      ctx.font = "11px Inter, Segoe UI, sans-serif";
      ctx.fillStyle = "rgba(197, 223, 244, 0.92)";
    }
    ctx.fillText(line, x + 9, yLine);
  });
  ctx.restore();
}

function describeHoveredLine(target) {
  if (!target) {
    return null;
  }
  if (target.kind === "trade") {
    const tone = target.reliability < 0.55
      ? "Fragile trade corridor: disruptions likely."
      : (target.volume > 22 ? "Major supply artery: strong cross-settlement flow." : "Regular exchange route.");
    return {
      title: `Trade Route S${target.from} -> S${target.to}`,
      lines: [
        `Flow ${toDecimal(target.volume || 0, 2)}  |  Reliability ${toDecimal(target.reliability || 0, 2)}`,
        `Momentum ${toAdaptiveDecimal(target.momentum || 0, 4, 4)}  |  Distance ${toDecimal(target.distance || 0, 1)}`,
        tone
      ],
      color: "rgba(124, 236, 255, 0.95)"
    };
  }
  if (target.kind === "diplomacy") {
    const relation = target.relation || 0;
    const posture = relation > 0.25
      ? "Cooperative alignment: lower conflict pressure."
      : (relation < -0.2 ? "Hostile alignment: frontier friction and conflict risk." : "Neutral posture: cautious contact.");
    return {
      title: `Diplomacy ${target.civA} <-> ${target.civB}`,
      lines: [
        `Relation ${relation > 0 ? "+" : ""}${toDecimal(relation, 2)} (${relationTone(relation)})`,
        target.style === "hostile" ? "Dashed red line marks active hostility." : "Solid gold line marks active diplomatic channel.",
        posture
      ],
      color: target.style === "hostile" ? "rgba(255, 126, 126, 0.95)" : "rgba(255, 220, 132, 0.95)"
    };
  }
  if (target.kind === "migration") {
    return {
      title: `Migration Stream S${target.from} -> S${target.to}`,
      lines: [
        `Intensity ${toDecimal(target.intensity || 0, 2)}  |  Dashed flow`,
        "Population relocating between settlements.",
        "High intensity can reshape local pressure and growth."
      ],
      color: "rgba(126, 221, 255, 0.95)"
    };
  }
  if (target.kind === "knowledge") {
    return {
      title: `Knowledge Diffusion S${target.from} -> S${target.to}`,
      lines: [
        `Knowledge gap ${(Math.max(0, target.diffusion || 0) * 100).toFixed(0)}%`,
        "Dashed cyan links trace idea and practice spread.",
        "Higher gaps imply stronger one-way learning pressure."
      ],
      color: "rgba(142, 255, 236, 0.95)"
    };
  }
  return null;
}

function drawHoveredLineOverlay() {
  if (!hoveredLineTarget || !hoveredLineTarget.points) {
    return;
  }
  const descriptor = describeHoveredLine(hoveredLineTarget);
  if (!descriptor) {
    return;
  }
  const emphasisBoost = hoveredLineTarget.kind === "knowledge" ? 1.35 : 1;
  const isHostile = hoveredLineTarget.style === "hostile";
  ctx.save();
  pathFromPoints(hoveredLineTarget.points);
  ctx.lineWidth = ((hoveredLineTarget.width || 2) + 6) * emphasisBoost;
  ctx.strokeStyle = withAlpha(descriptor.color, 0.35);
  ctx.shadowColor = withAlpha(descriptor.color, 0.92);
  ctx.shadowBlur = 20 * emphasisBoost;
  ctx.setLineDash(isHostile ? [7, 5] : []);
  ctx.stroke();

  pathFromPoints(hoveredLineTarget.points);
  ctx.lineWidth = ((hoveredLineTarget.width || 2) + 2.7) * emphasisBoost;
  ctx.strokeStyle = withAlpha(descriptor.color, 0.98);
  ctx.shadowBlur = 0;
  ctx.stroke();

  const points = hoveredLineTarget.points || [];
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    ctx.fillStyle = withAlpha(descriptor.color, 0.95);
    ctx.beginPath();
    ctx.arc(first.x, first.y, 2.8 * emphasisBoost, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(last.x, last.y, 2.8 * emphasisBoost, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawHoveredLineTooltip() {
  if (!hoveredLineTarget || !pointerCanvasPos) {
    return;
  }
  const descriptor = describeHoveredLine(hoveredLineTarget);
  if (!descriptor) {
    return;
  }
  const lines = [descriptor.title, ...descriptor.lines];
  ctx.save();
  ctx.font = "11px Inter, Segoe UI, sans-serif";
  let width = 0;
  for (const line of lines) {
    width = Math.max(width, ctx.measureText(line).width);
  }
  width += 18;
  const lineHeight = 14;
  const height = lineHeight * lines.length + 10;
  let x = pointerCanvasPos.x + 16;
  let y = pointerCanvasPos.y + 12;
  if (x + width > canvas.width - 10) {
    x = pointerCanvasPos.x - width - 16;
  }
  if (y + height > canvas.height - 10) {
    y = pointerCanvasPos.y - height - 14;
  }
  x = Math.max(8, x);
  y = Math.max(8, y);

  drawRoundedRect(ctx, x, y, width, height, 7);
  ctx.fillStyle = "rgba(8, 14, 21, 0.92)";
  ctx.fill();
  ctx.strokeStyle = withAlpha(descriptor.color, 0.65);
  ctx.lineWidth = 1;
  ctx.stroke();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (i === 0) {
      ctx.font = "600 11px Inter, Segoe UI, sans-serif";
      ctx.fillStyle = descriptor.color;
    } else {
      ctx.font = "11px Inter, Segoe UI, sans-serif";
      ctx.fillStyle = "rgba(200, 224, 244, 0.94)";
    }
    ctx.fillText(line, x + 9, y + 14 + i * lineHeight);
  }
  ctx.restore();
}

function drawMapLegend() {
  const items = [
    {
      label: "Trade Flow",
      detail: "Thickness tracks route volume",
      drawSample: (sx, sy) => {
        ctx.save();
        ctx.strokeStyle = "rgba(86, 210, 255, 0.95)";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.quadraticCurveTo(sx + 16, sy - 6, sx + 34, sy);
        ctx.stroke();
        ctx.strokeStyle = "rgba(170, 232, 255, 0.85)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.quadraticCurveTo(sx + 16, sy - 6, sx + 34, sy);
        ctx.stroke();
        ctx.restore();
      }
    },
    {
      label: "Diplomacy",
      detail: "Gold solid line = active channel",
      drawSample: (sx, sy) => {
        ctx.save();
        ctx.setLineDash([]);
        ctx.strokeStyle = "rgba(255, 214, 112, 0.95)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + 34, sy);
        ctx.stroke();
        ctx.restore();
      }
    },
    {
      label: "Hostility",
      detail: "Red dashed line = hostile posture",
      drawSample: (sx, sy) => {
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.lineDashOffset = -((currentViewTick || 0) * 0.35) % 10;
        ctx.strokeStyle = "rgba(255, 94, 108, 0.95)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + 34, sy);
        ctx.stroke();
        ctx.restore();
      }
    },
    {
      label: "Migration / Knowledge",
      detail: "Cyan dashed links = movement and diffusion",
      drawSample: (sx, sy) => {
        ctx.save();
        ctx.setLineDash([3, 5]);
        ctx.lineDashOffset = -((currentViewTick || 0) * 0.45) % 8;
        ctx.strokeStyle = "rgba(124, 238, 255, 0.92)";
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + 34, sy);
        ctx.stroke();
        ctx.restore();
      }
    },
    {
      label: "Agent Actions",
      detail: "Teal trade, amber cooperate, red conflict, green gather",
      drawSample: (sx, sy) => {
        const dots = [
          "rgba(32, 240, 214, 0.95)",
          "rgba(255, 211, 106, 0.95)",
          "rgba(255, 95, 109, 0.95)",
          "rgba(130, 220, 145, 0.95)"
        ];
        ctx.save();
        for (let i = 0; i < dots.length; i += 1) {
          ctx.fillStyle = dots[i];
          ctx.beginPath();
          ctx.arc(sx + i * 10, sy, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
  ];

  const panelWidth = 376;
  const rowHeight = 22;
  const panelHeight = 36 + items.length * rowHeight + 10;
  const x = Math.max(12, canvas.width - panelWidth - 14);
  const chipWidth = 88;
  const chipHeight = 26;
  const bottomInset = 62;
  const panelBottom = canvas.height - bottomInset;
  const y = Math.max(14, panelBottom - panelHeight);
  const chipX = x + panelWidth - chipWidth - 10;
  const closedChipY = panelBottom - chipHeight;
  const openChipY = Math.max(8, y - chipHeight - 6);
  const chipY = mapLegendOpen ? openChipY : closedChipY;

  mapLegendToggleBounds = {
    x: chipX,
    y: chipY,
    w: chipWidth,
    h: chipHeight
  };

  if (!mapLegendOpen) {
    mapLegendPanelBounds = null;
    ctx.save();
    drawRoundedRect(ctx, chipX, chipY, chipWidth, chipHeight, 7);
    const chipGrad = ctx.createLinearGradient(chipX, chipY, chipX, chipY + chipHeight);
    chipGrad.addColorStop(0, "rgba(10, 18, 27, 0.86)");
    chipGrad.addColorStop(1, "rgba(8, 13, 19, 0.78)");
    ctx.fillStyle = chipGrad;
    ctx.fill();
    ctx.strokeStyle = "rgba(118, 187, 224, 0.42)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.strokeStyle = "rgba(124, 238, 255, 0.9)";
    ctx.lineWidth = 2.1;
    ctx.beginPath();
    ctx.moveTo(chipX + 8, chipY + 13);
    ctx.quadraticCurveTo(chipX + 20, chipY + 8, chipX + 32, chipY + 13);
    ctx.stroke();

    ctx.font = "600 10px Inter, Segoe UI, sans-serif";
    ctx.fillStyle = "rgba(199, 228, 248, 0.95)";
    ctx.fillText("Map Key", chipX + 39, chipY + 16);
    ctx.restore();
    return;
  }

  mapLegendPanelBounds = {
    x,
    y,
    w: panelWidth,
    h: panelHeight
  };

  ctx.save();
  drawRoundedRect(ctx, x, y, panelWidth, panelHeight, 8);
  const grad = ctx.createLinearGradient(x, y, x, y + panelHeight);
  grad.addColorStop(0, "rgba(9, 16, 24, 0.88)");
  grad.addColorStop(1, "rgba(8, 13, 19, 0.82)");
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = "rgba(118, 187, 224, 0.34)";
  ctx.lineWidth = 1;
  ctx.stroke();

  drawRoundedRect(ctx, chipX, chipY, chipWidth, chipHeight, 7);
  const chipGrad = ctx.createLinearGradient(chipX, chipY, chipX, chipY + chipHeight);
  chipGrad.addColorStop(0, "rgba(10, 18, 27, 0.92)");
  chipGrad.addColorStop(1, "rgba(8, 13, 19, 0.84)");
  ctx.fillStyle = chipGrad;
  ctx.fill();
  ctx.strokeStyle = "rgba(118, 187, 224, 0.5)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.font = "600 10px Inter, Segoe UI, sans-serif";
  ctx.fillStyle = "rgba(199, 228, 248, 0.95)";
  ctx.fillText("Close Key", chipX + 20, chipY + 16);
  ctx.strokeStyle = "rgba(124, 238, 255, 0.92)";
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(chipX + 8, chipY + 9);
  ctx.lineTo(chipX + 14, chipY + 17);
  ctx.moveTo(chipX + 14, chipY + 9);
  ctx.lineTo(chipX + 8, chipY + 17);
  ctx.stroke();

  ctx.fillStyle = "rgba(189, 220, 245, 0.95)";
  ctx.font = "600 12px Inter, Segoe UI, sans-serif";
  ctx.fillText("Map Key", x + 10, y + 15);

  ctx.fillStyle = "rgba(128, 163, 191, 0.95)";
  ctx.font = "10px Inter, Segoe UI, sans-serif";
  ctx.fillText("Line semantics and agent actions", x + 10, y + 28);

  const sampleX = x + 14;
  const textX = x + 62;
  for (let i = 0; i < items.length; i += 1) {
    const row = items[i];
    const rowY = y + 42 + i * rowHeight;
    row.drawSample(sampleX, rowY + 3);

    ctx.fillStyle = "rgba(214, 235, 251, 0.97)";
    ctx.font = "600 10.5px Inter, Segoe UI, sans-serif";
    ctx.fillText(row.label, textX, rowY);

    ctx.fillStyle = "rgba(162, 194, 219, 0.9)";
    ctx.font = "10px Inter, Segoe UI, sans-serif";
    ctx.fillText(row.detail, textX, rowY + 11);
  }
  ctx.restore();
}

function getSemanticStatus(settlement) {
  if (!isSettlementActive(settlement)) return "Abandoned Ruins";

  const satLevel = settlement.influenceSaturation ? settlement.influenceSaturation.saturationLevel : 0;
  const stability = settlement.stability ?? settlement.stabilityScore ?? 0;
  const role = settlement.role || "General";
  const growth = settlement.growthRate || 0;

  if (satLevel > 0.85) return "Overloaded Hub";
  if (stability < 0.25) return "Collapsing Society";
  if (stability < 0.45) return "Declining Stability";
  if (growth > 0.05 && role === "Frontier") return "Booming Frontier";
  if (role === "Frontier") return "Emerging Frontier";
  if (role === "Trade Hub" && satLevel > 0.6) return "Dense Trade Hub";
  if (role === "Trade Hub") return "Major Trade Hub";
  if (role === "Military Node") return "Strategic Fortress";
  if (growth > 0.02) return "Expanding Settlement";

  return "Stable Settlement";
}

function translateEvent(event) {
  const type = event.type;
  if (type === "info_contact") return `Information Exchange`;
  if (type === "contact") return `New Connection`;
  if (type === "conflict") return `Border Skirmish`;
  if (type === "trade") return `Trade Pact Signed`;
  if (type === "cooperate") return `Alliance Formed`;
  if (type === "revolt") return `Civil Unrest`;
  if (type === "collapse") return `Settlement Collapse`;
  if (type === "fission") return `Settlement Split`;
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function toPercent(value) {
  return `${(clamp01(value || 0) * 100).toFixed(0)}%`;
}

function toSigned(value, digits = 3) {
  const num = Number.isFinite(value) ? value : 0;
  return `${num > 0 ? "+" : ""}${num.toFixed(digits)}`;
}

function toSignedPercent(value, digits = 1) {
  const num = Number.isFinite(value) ? value : 0;
  const scaled = num * 100;
  return `${scaled > 0 ? "+" : ""}${scaled.toFixed(digits)}%`;
}

function toDecimal(value, digits = 2) {
  const num = Number.isFinite(value) ? value : 0;
  return num.toFixed(digits);
}

function toAdaptiveDecimal(value, digits = 2, tinyDigits = 4) {
  const num = Number.isFinite(value) ? value : 0;
  const threshold = 10 ** (-digits);
  if (num !== 0 && Math.abs(num) < threshold) {
    return num.toFixed(tinyDigits);
  }
  return num.toFixed(digits);
}

function toneByThreshold(value, options = {}) {
  const num = Number.isFinite(value) ? value : 0;
  const {
    invert = false,
    goodAt = 0.66,
    warnAt = 0.4
  } = options;
  const normalized = invert ? (1 - num) : num;
  if (normalized >= goodAt) return "good";
  if (normalized >= warnAt) return "warn";
  return "danger";
}

function normalizedRouteReliability(route) {
  const reliability = Number.isFinite(route?.routeReliability) ? route.routeReliability : 1;
  return clamp01((reliability - 0.22) / 1.08);
}

function computeSettlementTradeHealth(snapshot, settlement) {
  const settlements = (snapshot.settlements || []).filter(isSettlementActive);
  const allRoutes = snapshot.tradeRoutes || [];
  const settlementId = String(settlement.id);
  const localTradeFlow = settlement.tradeFlow ?? settlement.tradeVolume ?? 0;
  const maxFlow = Math.max(1, ...settlements.map((row) => row.tradeFlow ?? row.tradeVolume ?? 0));
  const flowNorm = clamp01(localTradeFlow / maxFlow);
  const consistency = clamp01(settlement.tradeConsistency || 0);

  const connectedRoutes = allRoutes.filter((route) => (
    String(route.from) === settlementId || String(route.to) === settlementId
  ));
  if (!connectedRoutes.length) {
    return clamp01(flowNorm * 0.72 + consistency * 0.28);
  }

  const maxRouteVolume = Math.max(1, ...allRoutes.map((route) => route.tradeVolume || route.trades || 0));
  const meanConnectedVolume = connectedRoutes.reduce((acc, route) => (
    acc + (route.tradeVolume || route.trades || 0)
  ), 0) / connectedRoutes.length;
  const volumeNorm = clamp01(meanConnectedVolume / maxRouteVolume);
  const reliabilityNorm = connectedRoutes.reduce((acc, route) => (
    acc + normalizedRouteReliability(route)
  ), 0) / connectedRoutes.length;

  return clamp01(
    flowNorm * 0.42 +
    volumeNorm * 0.24 +
    reliabilityNorm * 0.22 +
    consistency * 0.12
  );
}

function stableHash(text) {
  const raw = String(text || "faction");
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getFactionName(faction, civId) {
  if (faction && typeof faction.name === "string" && faction.name.trim()) {
    return faction.name.trim();
  }
  const prefixes = [
    "Civic",
    "Frontier",
    "Mercantile",
    "Steward",
    "Sentinel",
    "Reform",
    "Unity",
    "Industrial",
    "Scholarly",
    "Harbor",
    "Prosperity",
    "Commonwealth"
  ];
  const suffixes = [
    "Council",
    "League",
    "Assembly",
    "Bloc",
    "Union",
    "Forum",
    "Compact",
    "Directorate",
    "Network",
    "Accord",
    "Alliance",
    "Collective"
  ];
  const seed = stableHash(`${civId || "wild"}:${faction?.id || "faction"}`);
  const prefix = prefixes[seed % prefixes.length];
  const suffix = suffixes[Math.floor(seed / prefixes.length) % suffixes.length];
  return `${prefix} ${suffix}`;
}

function renderMetricRow(label, value, emphasis = false) {
  const valueClass = emphasis ? "value emphasis" : "value";
  return `<div class="row"><span class="label">${label}</span><span class="${valueClass}">${value}</span></div>`;
}

function renderKeyValueGrid(items) {
  return `<div class="mini-grid">${items.map((item) => (
    `<div class="mini-cell"><div class="mini-label">${item.label}</div><div class="mini-value mini-value-${item.tone || "neutral"}">${item.value}</div></div>`
  )).join("")}</div>`;
}

function renderFactionBars(factions, civId) {
  if (!factions.length) {
    return '<div class="empty empty-compact">No faction telemetry.</div>';
  }
  return factions
    .slice()
    .sort((a, b) => (b.powerShare || 0) - (a.powerShare || 0))
    .slice(0, 6)
    .map((faction) => {
      const pct = Math.max(0, Math.min(100, (faction.powerShare || 0) * 100));
      const factionName = escapeHtml(getFactionName(faction, civId));
      return `
          <div class="faction-row">
            <span class="faction-name" title="${factionName}">${factionName}</span>
            <div class="faction-bar">
              <div class="faction-bar-fill" style="--fill-width:${pct.toFixed(1)}%;"></div>
            </div>
            <span class="faction-pct">${pct.toFixed(0)}%</span>
          </div>`;
    }).join("");
}

function renderPolicySummary(policy, institutions) {
  if (!policy && !institutions) {
    return '<div class="empty empty-compact">No policy telemetry.</div>';
  }
  const rows = [];
  if (policy) {
    rows.push(renderMetricRow("Rationing", toPercent(policy.rationing)));
    rows.push(renderMetricRow("Trade Openness", toPercent(policy.tradeOpenness)));
    rows.push(renderMetricRow("Expansionism", toPercent(policy.expansionism)));
    rows.push(renderMetricRow("Welfare", toPercent(policy.welfare)));
  }
  if (institutions) {
    rows.push(renderMetricRow("Conscription", toPercent(institutions.conscription)));
    rows.push(renderMetricRow("Tariff Rate", toPercent(institutions.tariffRate)));
    rows.push(renderMetricRow("Border Openness", toPercent(institutions.borderOpenness)));
    rows.push(renderMetricRow("Welfare Spend", toPercent(institutions.welfareSpend)));
  }
  return rows.join("");
}

function relationTone(value) {
  if (value >= 0.45) return "Cooperative";
  if (value <= -0.45) return "Hostile";
  return "Neutral";
}

function relationToneClass(value) {
  if (value >= 0.45) return "relation-badge-cooperative";
  if (value <= -0.45) return "relation-badge-hostile";
  return "relation-badge-neutral";
}

function renderRelationBadge(value) {
  const tone = relationTone(value);
  return `<span class="relation-badge ${relationToneClass(value)}">${tone} (${value.toFixed(2)})</span>`;
}

function statusToneClass(status) {
  if (status.includes("Collapsing") || status.includes("Ruins")) return "inspector-hero-status-danger";
  if (status.includes("Overloaded") || status.includes("Declining")) return "inspector-hero-status-warn";
  if (status.includes("Booming") || status.includes("Expanding")) return "inspector-hero-status-good";
  return "inspector-hero-status-neutral";
}

function renderInspectorHero(status, role) {
  return `
      <div class="inspector-hero">
         <div class="inspector-hero-kicker">Analysis</div>
         <div class="inspector-hero-status ${statusToneClass(status)}">${escapeHtml(status)}</div>
         <div class="inspector-hero-role">Role: ${escapeHtml(role || "General")}</div>
      </div>
  `;
}

function renderFactionSummaryRow(factions, factionTension, factionNames) {
  const summaryRow = `<div class="row row-no-border row-top-gap"><span class="label">Factions</span><span class="value">${factions} groups, tension ${factionTension}%</span></div>`;
  const tagsRow = factionNames
    ? `<div class="row row-no-border row-wrap row-tight-top">${factionNames}</div>`
    : "";
  return `${summaryRow}${tagsRow}`;
}

function shockToneClass(type) {
  const normalized = String(type || "").toLowerCase();
  if (normalized === "rebellion") return "shock-tone-rebellion";
  if (normalized === "famine") return "shock-tone-famine";
  if (normalized === "epidemic") return "shock-tone-epidemic";
  if (normalized === "crash") return "shock-tone-crash";
  return "shock-tone-default";
}

function renderEventMeta(event) {
  const tickLabel = `<span class="event-meta">T${event.tick}</span>`;
  if (event.message) {
    return tickLabel;
  }
  return `${tickLabel}<span class="event-meta event-meta-secondary">(A${event.agentA}/A${event.agentB})</span>`;
}

function settlementLabel(id) {
  const raw = String(id ?? "");
  return raw.startsWith("S") ? raw : `S${raw}`;
}

function renderMatrixMetric(label, value) {
  return `
    <div class="matrix-item">
      <div class="matrix-item-label">${label}</div>
      <div class="matrix-item-value">${value}</div>
    </div>`;
}

function renderSettlementPanel(snapshot) {
  const settlement = snapshot.settlements.find((s) => s.id === selectedSettlementId);
  if (!settlement) {
    settlementInfoEl.innerHTML = '<div class="empty">Select a settlement node.</div>';
    updateInspectorVisibility();
    return;
  }
  const civilization = (snapshot.civilizations || []).find((c) => c.id === settlement.civId) || null;
  const tradeFlow = settlement.tradeFlow ?? settlement.tradeVolume ?? 0;
  const stability = settlement.stability ?? settlement.stabilityScore ?? 0;
  const knowledge = settlement.knowledge || {};
  const knowledgeLevel = settlementKnowledgeLevel(settlement);
  const activeShock = settlement.shockState?.activeShock || null;
  const shockDescriptor = getShockDescriptor(activeShock);
  const shockText = activeShock
    ? `${shockDescriptor.label} ${(activeShock.severity || 0).toFixed(2)} / ${activeShock.remainingTicks || 0}t`
    : "None";
  const perceivedThreat = Math.max(0, Math.min(1, (settlement.securityStress || 0) * 0.65 + (settlement.legitimacyStress || 0) * 0.35));
  const perceivedTradeTrust = Math.max(0, Math.min(1, (settlement.tradeConsistency || 0) * 0.6 + (1 - (settlement.economicStress || 0)) * 0.4));
  const factions = Array.isArray(civilization?.factions) ? civilization.factions : [];
  const policies = civilization?.policy || null;
  const institutions = civilization?.institutionLevers || null;
  const factionBars = renderFactionBars(factions, civilization?.id || settlement.civId);
  const economicStress = settlement.economicStress || 0;
  const securityStress = settlement.securityStress || 0;
  const legitimacyStress = settlement.legitimacyStress || 0;
  const conflictRate = settlement.conflictRate || 0;
  const migrationNetRate = settlement.migrationNetRate || 0;
  const infoHealth = clamp01((1 - economicStress) * 0.5 + (settlement.tradeConsistency || 0) * 0.5);
  const tradeHealth = computeSettlementTradeHealth(snapshot, settlement);
  const marketPrices = settlement.market?.prices || { food: 1, materials: 1, wealth: 1 };
  const marketVolatility = settlement.market?.volatility ?? 0.03;
  const marketRows = `
      ${renderMetricRow("Food Price", toDecimal(marketPrices.food || 1, 3))}
      ${renderMetricRow("Materials Price", toDecimal(marketPrices.materials || 1, 3))}
      ${renderMetricRow("Wealth Price", toDecimal(marketPrices.wealth || 1, 3))}
      ${renderMetricRow("Price Volatility", toDecimal(marketVolatility, 3))}
  `;

  const simplifiedOverview = renderKeyValueGrid([
    { label: "Population", value: String(settlement.population || 0) },
    { label: "Stability", value: toPercent(stability) },
    { label: "Pressure", value: toPercent(settlement.resourcePressure || 0) },
    { label: "Growth", value: toSigned(settlement.growthRate || 0, 3) }
  ]);

  const simplifiedSignals = renderKeyValueGrid([
    {
      label: "Trade Health",
      value: toPercent(tradeHealth),
      tone: toneByThreshold(tradeHealth, { goodAt: 0.62, warnAt: 0.34 })
    },
    {
      label: "Conflict Risk",
      value: toPercent(conflictRate),
      tone: toneByThreshold(conflictRate, { invert: true, goodAt: 0.72, warnAt: 0.5 })
    },
    {
      label: "Migration Net",
      value: toSignedPercent(migrationNetRate, 2),
      tone: Math.abs(migrationNetRate || 0) >= 0.012 ? "warn" : "neutral"
    },
    {
      label: "Info Reliability",
      value: toPercent(infoHealth),
      tone: toneByThreshold(infoHealth, { goodAt: 0.68, warnAt: 0.42 })
    }
  ]);

  const simplifiedDetails = `
      ${renderMetricRow("Trade Flow", toDecimal(tradeFlow, 1))}
      ${renderMetricRow("Average Energy", toDecimal(settlement.avgEnergy || 0, 1))}
      ${renderMetricRow("Resource Pressure", toPercent(settlement.resourcePressure || 0))}
      ${renderMetricRow("Growth Rate", toSigned(settlement.growthRate || 0, 3))}
      ${renderMetricRow("Knowledge Level", toPercent(knowledgeLevel))}
      ${renderMetricRow("Economic Stress", toPercent(economicStress))}
      ${renderMetricRow("Security Stress", toPercent(securityStress))}
      ${renderMetricRow("Legitimacy Stress", toPercent(legitimacyStress))}
      ${renderMetricRow("Conflict Rate", toPercent(conflictRate))}
      ${renderMetricRow("Trade Consistency", toPercent(settlement.tradeConsistency || 0))}
      ${renderMetricRow("Shock State", activeShock ? shockText : "None", true)}
  `;

  const beliefsRows = `
      ${renderMetricRow("Perceived Threat", toPercent(perceivedThreat))}
      ${renderMetricRow("Trade Trust", toPercent(perceivedTradeTrust))}
  `;

  const policyRows = renderPolicySummary(policies, institutions);
  const status = getSemanticStatus(settlement);

  settlementInfoEl.innerHTML = `
      ${renderInspectorHero(status, settlement.role)}

      ${renderMetricRow("Identity", `S${settlement.id} / ${settlement.civId || "Wild"}`)}
      ${simplifiedOverview}
      
      <div class="panel-subtitle">Details</div>
      ${simplifiedDetails}
      <div class="panel-subtitle">Local Market</div>
      ${marketRows}
      <div class="panel-subtitle">Current Signals</div>
      ${simplifiedSignals}

      <div class="panel-subtitle">Beliefs</div>
      ${beliefsRows}

      <div class="panel-subtitle">Internal Politics</div>
      ${factionBars}
      ${renderMetricRow("Faction Tension", toPercent(civilization?.factionTension || 0))}
      ${policyRows}
    `;
  updateInspectorVisibility();
}

function renderRelationsPanel(snapshot) {
  const activeSettlements = (snapshot.settlements || []).filter(isSettlementActive);
  const settlementById = new Map(activeSettlements.map((s) => [s.id, s]));
  const activeSettlementIds = new Set(activeSettlements.map((s) => s.id));
  const activeCivIds = new Set(activeSettlements.map((s) => s.civId).filter(Boolean));
  const activeCivs = (snapshot.civilizations || []).filter((c) => activeCivIds.has(c.id));
  const diplomacyLines = (snapshot.diplomacyLines || []).filter(
    (line) => activeCivIds.has(line.civA) && activeCivIds.has(line.civB)
  );
  let tradeRoutes = (snapshot.tradeRoutes || []).filter(
    (route) => activeSettlementIds.has(route.from) && activeSettlementIds.has(route.to)
  );
  let events = snapshot.events || [];
  const selectedEra = getEraById(snapshot, selectedEraId);
  const selectedEraSettlementIds = new Set(selectedEra?.globalStateSnapshot?.affectedSettlementIds || []);

  if (selectedEraSettlementIds.size > 0) {
    tradeRoutes = tradeRoutes.filter((route) => (
      selectedEraSettlementIds.has(route.from) || selectedEraSettlementIds.has(route.to)
    ));
  }
  if (selectedEra) {
    events = events.filter((event) => (
      (event.tick || 0) >= selectedEra.startTick &&
      (event.tick || 0) <= selectedEra.endTick
    ));
  }

  const civCards = activeCivs
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .slice(0, 8)
    .map((civ) => {
      const p = civ.policy || {};
      const d = civ.policyDrift || {};
      const rationing = Math.round((p.rationing ?? 0.5) * 100);
      const trade = Math.round((p.tradeOpenness ?? 0.5) * 100);
      const expansion = Math.round((p.expansionism ?? 0.5) * 100);
      const welfare = Math.round((p.welfare ?? 0.5) * 100);
      const dTrade = Math.round((d.trade ?? 0.5) * 100);
      const dWar = Math.round((d.wariness ?? 0.5) * 100);
      const dExplore = Math.round((d.explore ?? 0.5) * 100);
      const dStab = Math.round((d.stabilityFocus ?? 0.5) * 100);
      const lever = civ.institutionLevers || {};
      const factions = Array.isArray(civ.factions) ? civ.factions.length : 0;
      const factionTension = Math.round((civ.factionTension || 0) * 100);
      const conscription = Math.round((lever.conscription ?? 0.5) * 100);
      const tariff = Math.round((lever.tariffRate ?? 0.5) * 100);
      const border = Math.round((lever.borderOpenness ?? 0.5) * 100);
      const welfareSpend = Math.round((lever.welfareSpend ?? 0.5) * 100);
      const factionNames = Array.isArray(civ.factions)
        ? civ.factions
          .slice()
          .sort((a, b) => (b.powerShare || 0) - (a.powerShare || 0))
          .slice(0, 3)
          .map((faction) => `<span class="faction-tag">${escapeHtml(getFactionName(faction, civ.id))}</span>`)
          .join("")
        : "";
      return `
        <article class="matrix-card">
          <div class="matrix-card-title">${escapeHtml(civ.id)} Overview</div>
          <div class="matrix-grid">
            ${renderMatrixMetric("Rationing", `${rationing}%`)}
            ${renderMatrixMetric("Trade Openness", `${trade}%`)}
            ${renderMatrixMetric("Expansion", `${expansion}%`)}
            ${renderMatrixMetric("Welfare", `${welfare}%`)}
            ${renderMatrixMetric("Drift: Trade", `${dTrade}%`)}
            ${renderMatrixMetric("Drift: War", `${dWar}%`)}
            ${renderMatrixMetric("Drift: Explore", `${dExplore}%`)}
            ${renderMatrixMetric("Drift: Stability", `${dStab}%`)}
            ${renderMatrixMetric("Conscription", `${conscription}%`)}
            ${renderMatrixMetric("Tariff Rate", `${tariff}%`)}
            ${renderMatrixMetric("Border Openness", `${border}%`)}
            ${renderMatrixMetric("Welfare Spend", `${welfareSpend}%`)}
          </div>
          ${renderFactionSummaryRow(factions, factionTension, factionNames)}
        </article>`;
    });

  const diplomacyRows = diplomacyLines
    .slice()
    .sort((a, b) => Math.abs(b.relation) - Math.abs(a.relation))
    .slice(0, 12)
    .map((line) => {
      return `<div class="row"><span>${line.civA} vs ${line.civB}</span>${renderRelationBadge(line.relation)}</div>`;
    });

  if (!civCards.length && !diplomacyRows.length) {
    relationsListEl.innerHTML = '<div class="empty">No active civilization relations yet.</div>';
  } else {
    const sections = [];
    if (civCards.length) {
      sections.push(...civCards);
    }
    if (diplomacyRows.length) {
      sections.push('<div class="panel-subtitle">Global Diplomacy</div>');
      sections.push(...diplomacyRows);
    }
    relationsListEl.innerHTML = sections.join("");
  }

  const activeShocks = activeSettlements
    .filter((s) => s.shockState?.activeShock)
    .sort((a, b) => (b.shockState.activeShock.severity || 0) - (a.shockState.activeShock.severity || 0))
    .slice(0, 6);

  if (!tradeRoutes.length) {
    tradeSummaryEl.innerHTML = '<div class="empty">No settlement routes yet.</div>';
  } else {
    const routeRows = tradeRoutes
      .slice()
      .sort((a, b) => (b.tradeVolume || 0) - (a.tradeVolume || 0))
      .slice(0, 10)
      .map((route) => {
        const from = settlementById.get(route.from);
        const to = settlementById.get(route.to);
        const kFrom = settlementKnowledgeLevel(from);
        const kTo = settlementKnowledgeLevel(to);
        const diffusion = Math.abs(kFrom - kTo);
        return `
          <article class="route-card">
            <div class="route-title">${settlementLabel(route.from)} -> ${settlementLabel(route.to)}</div>
            <div class="matrix-grid">
              ${renderMatrixMetric("Trade Flow", toDecimal(route.tradeVolume || 0, 2))}
              ${renderMatrixMetric("Route Momentum", toAdaptiveDecimal(route.routeMomentum || 0, 4, 4))}
              ${renderMatrixMetric("Reliability", toDecimal(route.routeReliability || 0, 2))}
              ${renderMatrixMetric("Knowledge Gap", `${(diffusion * 100).toFixed(0)}%`)}
            </div>
          </article>`;
      });

    const shockRows = activeShocks.map((settlement) => {
      const shock = settlement.shockState.activeShock;
      const descriptor = getShockDescriptor(shock);
      const toneClass = shockToneClass(shock.type);
      return `<div class="row"><span>${settlement.id} ${descriptor.label}</span><span class="shock-severity ${toneClass}">${(shock.severity || 0).toFixed(2)} / ${shock.remainingTicks || 0}t</span></div>`;
    });

    const sections = [];
    sections.push(...routeRows);
    if (shockRows.length) {
      sections.push('<div class="panel-subtitle">Active Shocks</div>');
      sections.push(...shockRows);
    }
    tradeSummaryEl.innerHTML = sections.join("");
  }

  eventsListEl.innerHTML = events
    .slice(-14)
    .reverse()
    .map((event) => (
      `<div class="event ${event.type}">
         ${renderEventMeta(event)}
         ${event.message ? event.message : translateEvent(event)} 
       </div>`
    ))
    .join("");

}

function eraColor(eraType) {
  if (eraType === "Collapse") return "rgba(255, 99, 99, 0.95)";
  if (eraType === "Crisis") return "rgba(255, 163, 93, 0.95)";
  if (eraType === "Expansion") return "rgba(255, 223, 120, 0.95)";
  if (eraType === "Emergence") return "rgba(126, 238, 255, 0.95)";
  return "rgba(129, 232, 184, 0.95)";
}

function eraToneClass(era) {
  if (!era) return "era-stabilization";
  if (era.entryType === "milestone") return "era-milestone";
  const type = String(era.eraType || "Stabilization");
  if (type === "Collapse") return "era-collapse";
  if (type === "Crisis") return "era-crisis";
  if (type === "Expansion") return "era-expansion";
  if (type === "Emergence") return "era-emergence";
  return "era-stabilization";
}

function formatEraRange(era) {
  if (!era) return "";
  const start = era.startTick ?? 0;
  const end = era.endTick ?? start;
  if (end <= start) {
    return `T${start}`;
  }
  return `T${start} - T${end}`;
}

function readEraCardData(row) {
  if (!row || !row.dataset) {
    return null;
  }
  const startTickRaw = Number(row.dataset.startTick);
  const endTickRaw = Number(row.dataset.endTick);
  const startTick = Number.isFinite(startTickRaw) ? startTickRaw : 0;
  const endTick = Number.isFinite(endTickRaw) ? Math.max(startTick, endTickRaw) : startTick;
  const eraType = row.dataset.eraType || "Stabilization";
  const entryType = row.dataset.entryType || eraType;
  return {
    id: row.dataset.eraId || "",
    title: row.dataset.title || eraType || "State Shift",
    summary: row.dataset.summary || "",
    eraType,
    entryType,
    startTick,
    endTick
  };
}

function buildEraDetailData(snapshot) {
  const preferred = hoveredEraData || selectedEraData;
  if (preferred) {
    return preferred;
  }
  const currentEra = getCurrentEraFromSnapshot(snapshot);
  if (!currentEra) {
    return null;
  }
  const startTick = Number.isFinite(currentEra.startTick) ? currentEra.startTick : 0;
  const endTick = Number.isFinite(currentEra.endTick) ? Math.max(startTick, currentEra.endTick) : startTick;
  return {
    id: currentEra.id || "",
    title: currentEra.title || currentEra.eraType || "Stabilization Era",
    summary: currentEra.summary || "No era summary available.",
    eraType: currentEra.eraType || "Stabilization",
    entryType: currentEra.entryType === "milestone" ? "Milestone" : (currentEra.eraType || "Stabilization"),
    startTick,
    endTick
  };
}

function renderEraDetailPanel(snapshot) {
  if (!eraDetailPanelEl) {
    return;
  }
  const detail = buildEraDetailData(snapshot);
  if (!detail) {
    eraDetailPanelEl.innerHTML = '<div class="era-detail-empty">No era transitions detected yet.</div>';
    return;
  }

  const title = escapeHtml(detail.title || "State Shift");
  const entryType = escapeHtml(detail.entryType || detail.eraType || "Stabilization");
  const summary = escapeHtml(detail.summary || "No era summary available.");
  const range = escapeHtml(formatEraRange(detail));
  const toneClass = eraToneClass({
    entryType: String(detail.entryType || "").toLowerCase() === "milestone" ? "milestone" : "era",
    eraType: detail.eraType
  });
  const activeLabel = hoveredEraData ? "Previewing" : (selectedEraData ? "Selected" : "Current");

  eraDetailPanelEl.innerHTML = `
    <article class="era-detail-card ${toneClass}">
      <div class="era-detail-head">
        <span class="era-detail-state">${activeLabel}</span>
        <span class="era-detail-range">${range}</span>
      </div>
      <div class="era-detail-title">${title}</div>
      <div class="era-detail-meta">${entryType}</div>
      <div class="era-detail-summary">${summary}</div>
    </article>
  `;
}

function renderEraHistoryPanel(snapshot) {
  if (!eraHistoryListEl) {
    return;
  }
  /* Group consecutive identical eras */
  const eras = getEraHistory(snapshot)
    .slice()
    .sort((a, b) => (b.startTick || 0) - (a.startTick || 0))
    .slice(0, 36);

  if (!eras.length) {
    eraHistoryListEl.innerHTML = '<div class="empty">No era transitions detected yet.</div>';
    return;
  }

  const groupedEras = [];
  eras.forEach((era) => {
    const last = groupedEras[groupedEras.length - 1];
    if (last && last.title === era.title && last.entryType === era.entryType && era.entryType === 'milestone') {
      last.count = (last.count || 1) + 1;
      // Keep the range extending
      last.startTick = Math.min(last.startTick, era.startTick);
      last.endTick = Math.max(last.endTick || last.startTick, era.endTick || era.startTick);
    } else {
      groupedEras.push({ ...era, count: 1 });
    }
  });

  eraHistoryListEl.innerHTML = groupedEras.map((era) => {
    const active = selectedEraId === era.id ? "active" : "";
    const isMilestone = era.entryType === "milestone";
    const entryType = isMilestone ? "Milestone" : (era.eraType || "Stabilization");
    const title = escapeHtml(era.title || era.eraType || "State Shift");
    const summary = escapeHtml(era.summary || (isMilestone ? "System milestone recorded." : "Structural transition recorded."));
    const startTick = Number.isFinite(era.startTick) ? era.startTick : 0;
    const endTick = Math.max(startTick, Number.isFinite(era.endTick) ? era.endTick : startTick);
    const rangeLabel = formatEraRange({ startTick, endTick });
    const entryTypeSafe = escapeHtml(entryType);
    const toneClass = eraToneClass(era);
    const countBadge = era.count > 1 ? `<span class="era-count">x${era.count}</span>` : "";
    const hoverLabel = escapeHtml(
      `${era.title || era.eraType || "State Shift"} | ${entryType} | ${rangeLabel}${era.summary ? ` | ${era.summary}` : ""}`
    );

    return `
      <article
        class="era-item ${active} ${isMilestone ? "milestone" : ""} ${toneClass}"
        data-era-id="${escapeHtml(era.id)}"
        data-title="${title}"
        data-summary="${summary}"
        data-era-type="${escapeHtml(era.eraType || "Stabilization")}"
        data-entry-type="${entryTypeSafe}"
        data-start-tick="${startTick}"
        data-end-tick="${endTick}"
        title="${hoverLabel}"
      >
        <div class="era-title-row">
          <div class="era-title">${title}</div>
          ${countBadge}
        </div>
        <div class="era-meta"><span class="era-kind">${entryTypeSafe}</span><span>${rangeLabel}</span></div>
      </article>
    `;
  }).join("");
}

function renderTimelineEvents(snapshot) {
  if (!timelineEventsEl || !timelineSlider) {
    return;
  }
  const minTick = Number(timelineSlider.min || 0);
  const maxTick = Number(timelineSlider.max || 0);
  const span = Math.max(1, maxTick - minTick);
  const eras = getEraHistory(snapshot).slice(-16);
  const shockEvents = (snapshot.events || [])
    .filter((event) => event.type === "system" && String(event.message || "").toLowerCase().includes("shock"))
    .slice(-24);

  const markers = [];
  for (const era of eras) {
    const tick = era.startTick ?? era.tick ?? 0;
    const pct = ((tick - minTick) / span) * 100;
    markers.push(`<span class="timeline-marker era" style="left:${Math.max(0, Math.min(100, pct)).toFixed(2)}%"></span>`);
  }
  for (const event of shockEvents) {
    const tick = event.tick || 0;
    const pct = ((tick - minTick) / span) * 100;
    markers.push(`<span class="timeline-marker shock" style="left:${Math.max(0, Math.min(100, pct)).toFixed(2)}%"></span>`);
  }
  timelineEventsEl.innerHTML = markers.join("");
}

function getEraHighlightSettlementIds(snapshot) {
  const activeEra = getActiveEra(snapshot);
  if (!activeEra) {
    return new Set();
  }
  return new Set((activeEra.globalStateSnapshot?.affectedSettlementIds || []).map((id) => String(id)));
}

function updateCivSummary(snapshot) {
  const activeSettlements = (snapshot.settlements || []).filter(isSettlementActive);
  if (!activeSettlements.length) {
    civSummaryStrip.innerHTML = "";
    if (eraStatusEl) eraStatusEl.textContent = "No Active Era";
    if (worldSummaryEl) worldSummaryEl.textContent = "No active settlements detected.";
    return;
  }

  const totalPop = activeSettlements.reduce((acc, s) => acc + (s.population || 0), 0);
  const avgSat = activeSettlements.reduce((acc, s) => acc + (s.influenceSaturation?.saturationLevel || 0), 0) / activeSettlements.length;
  const avgKnowledge = activeSettlements.reduce((acc, s) => acc + settlementKnowledgeLevel(s), 0) / activeSettlements.length;
  const activeShocks = activeSettlements.filter((s) => s.shockState?.activeShock).length;
  const selectedSettlement = activeSettlements.find((settlement) => settlement.id === selectedSettlementId) || null;
  const currentEra = getCurrentEraFromSnapshot(snapshot);
  const mainState = currentEra?.title || currentEra?.eraType || "Stabilization Era";
  const stateColor = eraColor(currentEra?.eraType || "Stabilization");
  const activeCivs = new Set(activeSettlements.map(s => s.civId).filter(Boolean)).size;
  const avgConflict = activeSettlements.reduce((acc, s) => acc + (s.conflictRate || 0), 0) / activeSettlements.length;
  const avgPressure = activeSettlements.reduce((acc, s) => acc + (s.resourcePressure || 0), 0) / activeSettlements.length;
  if (eraStatusEl) {
    eraStatusEl.textContent = mainState;
    eraStatusEl.style.color = stateColor;
  }
  if (civSummaryStrip) {
    civSummaryStrip.style.setProperty("--era-color", stateColor);
  }
  if (worldSummaryEl) {
    let summaryText =
      `${activeSettlements.length} settlements, conflict ${(avgConflict * 100).toFixed(0)}%, pressure ${(avgPressure * 100).toFixed(0)}%, shocks ${activeShocks}`;
    if (selectedSettlement) {
      summaryText += ` | focus S${selectedSettlement.id} ${selectedSettlement.role || "General"} (${selectedSettlement.civId || "Wild"})`;
    }
    worldSummaryEl.textContent = summaryText;
  }

  civSummaryStrip.innerHTML = `
    <div class="summary-item">
      <span class="summary-value summary-value-era">${mainState}</span>
      <span class="summary-label">Era Status</span>
    </div>
    <div class="summary-item">
      <span class="summary-value">${totalPop}</span>
      <span class="summary-label">Global Pop</span>
    </div>
    <div class="summary-item">
      <span class="summary-value">${activeCivs}</span>
      <span class="summary-label">Civilizations</span>
    </div>
    <div class="summary-item">
      <span class="summary-value">${(avgSat * 100).toFixed(0)}%</span>
      <span class="summary-label">Avg Saturation</span>
    </div>
    <div class="summary-item">
      <span class="summary-value">${(avgKnowledge * 100).toFixed(0)}%</span>
      <span class="summary-label">Knowledge</span>
    </div>
    <div class="summary-item">
      <span class="summary-value">${activeShocks}</span>
      <span class="summary-label">Active Shocks</span>
    </div>
    <div class="summary-item">
      <span class="summary-value">${getLinkModeLabel()}</span>
      <span class="summary-label">Link View</span>
    </div>
  `;
}

function drawSnapshot(snapshot) {
  renderBackground();
  lineHoverTargets.length = 0;
  if (selectedEraId && !getEraById(snapshot, selectedEraId)) {
    selectedEraId = null;
    selectedEraData = null;
    eraTickFilter = null;
  }
  updateCivSummary(snapshot);
  renderEraHistoryPanel(snapshot);
  renderEraDetailPanel(snapshot);
  const highlightSettlementIds = getEraHighlightSettlementIds(snapshot);
  const activeSettlements = (snapshot.settlements || []).filter(isSettlementActive);
  const activeCivIds = new Set(activeSettlements.map((s) => s.civId).filter(Boolean));
  const activeCivs = (snapshot.civilizations || []).filter((c) => activeCivIds.has(c.id));
  const activeSettlementIds = new Set(activeSettlements.map((s) => s.id));
  let activeTradeRoutes = (snapshot.tradeRoutes || []).filter(
    (route) => activeSettlementIds.has(route.from) && activeSettlementIds.has(route.to)
  );
  const selectedEra = getEraById(snapshot, selectedEraId);
  const selectedEraSettlementIds = new Set(selectedEra?.globalStateSnapshot?.affectedSettlementIds || []);
  if (selectedEraSettlementIds.size > 0) {
    activeTradeRoutes = activeTradeRoutes.filter((route) => (
      selectedEraSettlementIds.has(route.from) || selectedEraSettlementIds.has(route.to)
    ));
  }
  const activeDiplomacyLines = (snapshot.diplomacyLines || []).filter(
    (line) => activeCivIds.has(line.civA) && activeCivIds.has(line.civB)
  );
  const selectionContext = buildSelectionContext(snapshot, activeTradeRoutes, activeDiplomacyLines);
  const showTradeLinks = linkMode === "all" || linkMode === "trade";
  const showDiplomacyLinks = linkMode === "all" || linkMode === "diplomacy";
  const showMigrationLinks = linkMode === "all" || linkMode === "migration";
  const showKnowledgeLinks = linkMode === "all" || linkMode === "knowledge";
  drawRegionalInfluenceHeatmap(snapshot.settlements, selectionContext);
  drawBeliefField(snapshot.settlements, selectionContext);
  drawPoliticsField(snapshot.settlements, snapshot.civilizations || [], selectionContext);
  drawEconomicStressField(snapshot.settlements, selectionContext);
  drawWarField(snapshot, selectionContext);
  drawShockRiskField(snapshot.settlements, snapshot.tick, selectionContext);
  if (showKnowledgeLinks) {
    drawKnowledgeDiffusion(activeTradeRoutes, snapshot.settlements, snapshot.tick, selectionContext);
  }

  drawInfluenceZones(activeCivs, selectionContext);
  drawInfluenceAuras(snapshot.settlements, snapshot.tick, selectionContext);
  if (showMigrationLinks) {
    drawMigrationStreams(snapshot.migrationStreams || [], snapshot.settlements, snapshot.tick, selectionContext);
  }
  if (showDiplomacyLinks) {
    drawDiplomacyLines(activeDiplomacyLines, snapshot.tick, selectionContext);
  }
  if (showTradeLinks) {
    drawTradeRoutes(activeTradeRoutes, snapshot.tick, selectionContext);
  }
  drawAgents(snapshot.agents, snapshot.tick, selectionContext);
  drawSettlements(snapshot.settlements, snapshot.tick, highlightSettlementIds, selectionContext);
  drawShockOverlays(snapshot.settlements, snapshot.tick, selectionContext);
  resolveHoveredLineTarget();
  drawHoveredLineOverlay();
  drawSelectionLegend(selectionContext);
  drawMapLegend();
  drawHoveredLineTooltip();

  tickBadge.textContent = `Tick ${snapshot.tick}`;
  timelineLabel.textContent = `Tick ${snapshot.tick}`;
  renderTimelineEvents(snapshot);

  renderSettlementPanel(snapshot);
  renderRelationsPanel(snapshot);
  renderGlobalCharts();
}

function renderLoop() {
  resizeCanvas();
  const snapshot = getSnapshotForView();
  if (snapshot) {
    drawSnapshot(snapshot);
  } else {
    renderBackground();
  }
  requestAnimationFrame(renderLoop);
}

function renderSparkline(ctx, data, color) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!data || data.length < 2) return;

  const minVal = Math.min(...data);
  const maxVal = Math.max(...data);
  const range = maxVal - minVal || 1;
  const pad = h * 0.2;

  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;

  data.forEach((val, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - pad - ((val - minVal) / range) * (h - 2 * pad);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Fill
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1.0;
}

function renderGlobalCharts() {
  if (!globalDashboardEl || globalDashboardEl.classList.contains("hidden")) return;

  // Aggregate data up to currentViewTick
  const allTicks = getVisibleTicks();
  const relevantTicks = allTicks.filter(t => t <= currentViewTick);

  // Gather last 200 points for performance
  const samples = relevantTicks.slice(-200).map(t => historyMap.get(t)).filter(Boolean);

  const popData = samples.map(s => (s.settlements || []).reduce((sum, set) => sum + (set.population || 0), 0));
  const conflictData = samples.map(s => {
    const sets = s.settlements || [];
    return sets.reduce((sum, set) => sum + (set.conflictRate || 0), 0) / (sets.length || 1);
  });
  const stabData = samples.map(s => {
    const sets = s.settlements || [];
    return sets.reduce((sum, set) => sum + (set.stability ?? set.stabilityScore ?? 0), 0) / (sets.length || 1);
  });
  const wealthData = samples.map(s => {
    const sets = s.settlements || [];
    return sets.reduce((sum, set) => {
      if (set?.resources && Number.isFinite(set.resources.wealth)) {
        return sum + set.resources.wealth;
      }
      return sum + (Number.isFinite(set?.wealth) ? set.wealth : 0);
    }, 0);
  });

  const dpr = window.devicePixelRatio || 1;
  [chartPop, chartStab, chartConflict, chartWealth].forEach(c => {
    const rect = c.parentElement.getBoundingClientRect();
    c.width = (rect.width - 34) * dpr; // padding
    c.height = 100 * dpr;
    c.style.width = "100%";
    c.style.height = "100px";
  });

  if (chartPop.getContext) renderSparkline(chartPop.getContext("2d"), popData, "#7ebf9e");
  if (chartStab.getContext) renderSparkline(chartStab.getContext("2d"), stabData, "#6f96bc");
  if (chartConflict.getContext) renderSparkline(chartConflict.getContext("2d"), conflictData, "#d17272");
  if (chartWealth.getContext) renderSparkline(chartWealth.getContext("2d"), wealthData, "#c8aa76");
}

async function fetchState() {
  if (fetchInFlight) {
    return;
  }
  fetchInFlight = true;
  const requestSince = lastFetchedTick;
  try {
    const query = requestSince == null ? "" : `?since=${requestSince}`;
    const res = await fetch(`/api/state${query}`);
    if (!res.ok) return;
    const data = await res.json();
    const snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
    snapshots.forEach((snapshot) => {
      world = snapshot.world || world;
      addSnapshot(snapshot);
    });
    if (snapshots.length) {
      const newest = snapshots[snapshots.length - 1];
      latestTick = Math.max(latestTick, newest.tick || 0);
      if (lastFetchedTick == null || newest.tick > lastFetchedTick) {
        lastFetchedTick = newest.tick;
      }
    } else {
      latestTick = Math.max(latestTick, data.latestTick || 0);
    }

    if (liveMode && ticks.length) {
      currentViewTick = ticks[ticks.length - 1];
    }
    updateTimelineBounds();
  } catch (err) {
    console.error("state fetch error", err);
  } finally {
    fetchInFlight = false;
  }
}

function nextTickAfter(tick) {
  const sourceTicks = getVisibleTicks();
  const boundedTicks = sourceTicks.length ? sourceTicks : ticks;
  for (let i = 0; i < boundedTicks.length; i += 1) {
    if (boundedTicks[i] > tick) return boundedTicks[i];
  }
  return null;
}

function stopReplay() {
  if (replayTimer) {
    window.clearInterval(replayTimer);
    replayTimer = null;
    if (replayBtn) replayBtn.textContent = "Replay";
  }
}

function setPaused(nextPaused) {
  isPaused = !!nextPaused;
  if (isPaused) {
    stopReplay();
    liveMode = false;
    const snapshot = getSnapshotForView();
    if (snapshot) {
      currentViewTick = snapshot.tick;
      if (timelineSlider) timelineSlider.value = String(currentViewTick);
    }
  } else {
    liveMode = true;
    const sourceTicks = getVisibleTicks();
    const boundedTicks = sourceTicks.length ? sourceTicks : ticks;
    if (boundedTicks.length) {
      currentViewTick = boundedTicks[boundedTicks.length - 1];
      if (timelineSlider) timelineSlider.value = String(currentViewTick);
    }
  }
  if (playPauseBtn) {
    playPauseBtn.textContent = isPaused ? "Play" : "Pause";
  }
}

if (timelineSlider) {
  timelineSlider.addEventListener("input", () => {
    stopReplay();
    liveMode = false;
    isPaused = true;
    if (playPauseBtn) playPauseBtn.textContent = "Play";
    currentViewTick = Number(timelineSlider.value);
  });
}

if (liveBtn) {
  liveBtn.addEventListener("click", () => {
    stopReplay();
    selectedEraId = null;
    hoveredEraId = null;
    eraTickFilter = null;
    liveMode = true;
    isPaused = false;
    if (playPauseBtn) playPauseBtn.textContent = "Pause";
    const sourceTicks = getVisibleTicks();
    const boundedTicks = sourceTicks.length ? sourceTicks : ticks;
    if (boundedTicks.length) {
      currentViewTick = boundedTicks[boundedTicks.length - 1];
      if (timelineSlider) timelineSlider.value = String(currentViewTick);
    }
    updateTimelineBounds();
  });
}

if (replayBtn) {
  replayBtn.addEventListener("click", () => {
    if (replayTimer) {
      stopReplay();
      return;
    }
    if (!ticks.length) {
      return;
    }
    liveMode = false;
    replayBtn.textContent = "Stop";
    if (currentViewTick >= ticks[ticks.length - 1]) {
      currentViewTick = ticks[0];
    }
    replayTimer = window.setInterval(() => {
      const next = nextTickAfter(currentViewTick);
      if (!next) {
        stopReplay();
        return;
      }
      currentViewTick = next;
      if (timelineSlider) timelineSlider.value = String(currentViewTick);
    }, 120);
  });
}

if (playPauseBtn) {
  playPauseBtn.addEventListener("click", () => {
    setPaused(!isPaused);
  });
}

if (linkModeBarEl) {
  linkModeBarEl.addEventListener("click", (event) => {
    const button = event.target.closest(".link-mode-btn");
    if (!button || !button.dataset.linkMode) {
      return;
    }
    setLinkMode(button.dataset.linkMode);
  });
  setLinkMode(linkMode);
}

if (inspectorCloseBtn) {
  inspectorCloseBtn.addEventListener("click", () => {
    selectedSettlementId = null;
    updateInspectorVisibility();
  });
}

if (matrixToggleBtn) {
  matrixToggleBtn.addEventListener("click", () => {
    matrixPanelEl.classList.toggle("collapsed");
    matrixToggleBtn.textContent = matrixPanelEl.classList.contains("collapsed") ? "+" : "-";
  });
}

if (globalDashBtn && globalDashboardEl && closeDashBtn) {
  globalDashBtn.addEventListener("click", () => {
    globalDashboardEl.classList.remove("hidden");
    renderGlobalCharts();
  });
  closeDashBtn.addEventListener("click", () => {
    globalDashboardEl.classList.add("hidden");
  });
}

if (eraHistoryListEl) {
  eraHistoryListEl.addEventListener("mousemove", (event) => {
    const row = event.target.closest(".era-item");
    hoveredEraId = row && row.dataset.eraId ? row.dataset.eraId : null;
    hoveredEraData = row ? readEraCardData(row) : null;
  });

  eraHistoryListEl.addEventListener("mouseleave", () => {
    hoveredEraId = null;
    hoveredEraData = null;
  });

  eraHistoryListEl.addEventListener("click", (event) => {
    const row = event.target.closest(".era-item");
    if (!row || !row.dataset.eraId) {
      return;
    }
    const rowData = readEraCardData(row);
    const eraId = row.dataset.eraId;
    if (selectedEraId === eraId) {
      selectedEraId = null;
      selectedEraData = null;
      eraTickFilter = null;
      liveMode = true;
    } else {
      let startTick = rowData ? rowData.startTick : null;
      let endTick = rowData ? rowData.endTick : null;
      if (startTick == null || endTick == null) {
        const snapshot = getSnapshotForView();
        const era = getEraById(snapshot, eraId);
        if (!era) {
          return;
        }
        startTick = era.startTick || 0;
        endTick = Math.max(era.startTick || 0, era.endTick || era.startTick || 0);
      }
      selectedEraId = eraId;
      selectedEraData = rowData;
      eraTickFilter = {
        startTick,
        endTick
      };
      liveMode = false;
      currentViewTick = eraTickFilter.startTick;
    }
    stopReplay();
    updateTimelineBounds();
  });
}

canvas.addEventListener("mousemove", (event) => {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  pointerCanvasPos = {
    x: (event.clientX - rect.left) * dpr,
    y: (event.clientY - rect.top) * dpr
  };
});

canvas.addEventListener("mouseleave", () => {
  pointerCanvasPos = null;
  hoveredLineTarget = null;
});

canvas.addEventListener("click", (event) => {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const x = (event.clientX - rect.left) * dpr;
  const y = (event.clientY - rect.top) * dpr;

  if (pointInRect(x, y, mapLegendToggleBounds)) {
    mapLegendOpen = !mapLegendOpen;
    return;
  }
  if (mapLegendOpen && pointInRect(x, y, mapLegendPanelBounds)) {
    return;
  }

  let selected = null;
  let bestDist = Infinity;
  settlementScreenCache.forEach((node) => {
    const dx = node.x - x;
    const dy = node.y - y;
    const d = Math.hypot(dx, dy);
    if (d <= node.r && d < bestDist) {
      bestDist = d;
      selected = node.id;
    }
  });
  selectedSettlementId = selected;
  updateInspectorVisibility();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "h" || event.key === "H") {
    showInfluenceHeatmap = !showInfluenceHeatmap;
  }
});

window.addEventListener("resize", resizeCanvas);
updateInspectorVisibility();
window.setInterval(fetchState, 250);
fetchState();
renderLoop();

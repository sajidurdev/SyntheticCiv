const http = require("http");
const fs = require("fs");
const path = require("path");
const Simulation = require("./src/core/simulation");
const {
  loadLatest,
  saveLatestAtomic,
  buildPersistencePayload
} = require("./src/core/persistence");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const SAVE_PATH = path.join(__dirname, "data", "latest.json");
const SIM_DEBUG = process.env.SIM_DEBUG === "1";
const SIM_DEBUG_VERBOSE = process.env.SIM_DEBUG_VERBOSE === "1";
const SIM_DEBUG_EVERY_RAW = Number(process.env.SIM_DEBUG_EVERY);
const SIM_DEBUG_EVERY = Number.isFinite(SIM_DEBUG_EVERY_RAW)
  ? Math.max(1, Math.floor(SIM_DEBUG_EVERY_RAW))
  : undefined;

const persistedRaw = loadLatest(SAVE_PATH);
const persisted = (
  persistedRaw &&
  persistedRaw.version === 2 &&
  persistedRaw.state?.schemaVersion === 2
) ? persistedRaw : null;
if (persistedRaw && !persisted) {
  console.warn("Ignoring persistence file: unsupported schema version (expected payload/state v2).");
}

const sim = new Simulation({
  width: 96,
  height: 96,
  agentCount: 200,
  saveEveryTicks: 500,
  debugMetricsEnabled: SIM_DEBUG,
  debugMetricsVerbose: SIM_DEBUG_VERBOSE,
  ...(SIM_DEBUG_EVERY ? { debugMetricsEvery: SIM_DEBUG_EVERY } : {})
}, persisted);

setInterval(() => {
  sim.step();
  if (sim.consumePendingSaveFlag()) {
    const payload = buildPersistencePayload(sim, {
      eventLimit: 500,
      keyframeLimit: 60,
      includeKeyframes: true
    });
    saveLatestAtomic(SAVE_PATH, payload);
  }
}, 50);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") {
    pathname = "/index.html";
  }

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/state") {
    const since = url.searchParams.get("since");
    const payload = sim.getStateSince(since);
    sendJson(res, 200, payload);
    return;
  }

  if (url.pathname === "/api/config") {
    sendJson(res, 200, {
      worldWidth: sim.width,
      worldHeight: sim.height,
      agentCount: sim.agentCount
    });
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Synthetic Civilization Simulator running at http://localhost:${PORT}`);
});

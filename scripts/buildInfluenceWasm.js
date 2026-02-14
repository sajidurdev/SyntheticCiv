const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "wasm", "influence_kernel", "Cargo.toml");
const sourcePath = path.join(
  root,
  "wasm",
  "influence_kernel",
  "target",
  "wasm32-unknown-unknown",
  "release",
  "influence_kernel.wasm"
);
const destinationPath = path.join(root, "src", "systems", "wasm", "influence_kernel.wasm");

function run() {
  const build = spawnSync(
    "cargo",
    ["build", "--manifest-path", manifestPath, "--target", "wasm32-unknown-unknown", "--release"],
    { stdio: "inherit", cwd: root }
  );

  if (build.status !== 0) {
    process.exit(build.status || 1);
  }
  if (!fs.existsSync(sourcePath)) {
    console.error(`WASM output not found: ${sourcePath}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
  const stat = fs.statSync(destinationPath);
  console.log(`Wrote ${destinationPath} (${stat.size} bytes)`);
}

run();

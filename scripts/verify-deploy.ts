import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const deployScriptPath = resolve(root, "scripts/deploy.sh");
const adrPath = resolve(root, "docs/adr/0006-fast-cutover-deployments-with-reverse-proxy-retry.md");

// 1. Check deploy.sh syntax using git bash on Windows if available, or bash
const gitBashPaths = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];
let bashCmd = "bash";
for (const p of gitBashPaths) {
  if (existsSync(p)) {
    bashCmd = p;
    break;
  }
}

const bashCheck = spawnSync(bashCmd, ["-n", deployScriptPath], { encoding: "utf8" });
if (bashCheck.status !== 0) {
  console.error("deploy.sh syntax error:", bashCheck.stderr || bashCheck.stdout);
  process.exit(1);
}

// 2. Check deploy.sh content
const deployContent = readFileSync(deployScriptPath, "utf8");

const requiredPatterns = [
  /migrations_changed=0/,
  /git diff --quiet.*migrations\//,
  /compose up -d --no-build/,
  /PRAGMA integrity_check/,
  /dist\/migrate\.js/,
];

for (const pattern of requiredPatterns) {
  if (!pattern.test(deployContent)) {
    console.error(`deploy.sh missing expected pattern: ${pattern}`);
    process.exit(1);
  }
}
if (!existsSync(adrPath)) {
  console.error("ADR 0006 file missing");
  process.exit(1);
}

const adrContent = readFileSync(adrPath, "utf8");
if (!/Status:\*{0,2}\s+Accepted/.test(adrContent)) {
  console.error("ADR 0006 must have 'Status: Accepted'");
  process.exit(1);
}
if (!adrContent.includes("lb_try_duration")) {
  console.error("ADR 0006 missing Caddy lb_try_duration reference");
  process.exit(1);
}

console.log("deploy verification passed");

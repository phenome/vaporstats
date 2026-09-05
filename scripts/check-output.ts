import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST_DIR = join(process.cwd(), "dist");
const CLIENT_DIR = join(DIST_DIR, "client");
const SERVER_ENTRY = join(DIST_DIR, "server", "server.js");
const MAX_THRESHOLD = 90_000;

if (!existsSync(DIST_DIR)) {
  console.error("ERROR: dist directory does not exist. Run production build first.");
  process.exit(1);
}

function countFiles(dir: string): number {
  let count = 0;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countFiles(fullPath);
    } else if (entry.isFile()) {
      count++;
    }
  }
  return count;
}

const totalFiles = countFiles(DIST_DIR);
console.log("Dist output file count: " + totalFiles + " (threshold: < " + MAX_THRESHOLD + ")");

if (totalFiles >= MAX_THRESHOLD) {
  console.error("ERROR: dist output count " + totalFiles + " reached or exceeded threshold " + MAX_THRESHOLD);
  process.exit(1);
}

if (!existsSync(CLIENT_DIR) || !statSync(CLIENT_DIR).isDirectory()) {
  console.error("ERROR: client output directory is missing.");
  process.exit(1);
}

const clientFiles = countFiles(CLIENT_DIR);
if (clientFiles === 0) {
  console.error("ERROR: client output directory is empty.");
  process.exit(1);
}

if (!existsSync(SERVER_ENTRY) || !statSync(SERVER_ENTRY).isFile() || statSync(SERVER_ENTRY).size === 0) {
  console.error("ERROR: SSR server entry is missing or empty: " + SERVER_ENTRY);
  process.exit(1);
}

console.log("Client output files: " + clientFiles);
console.log("SSR server entry: " + SERVER_ENTRY);
console.log("SSR/CLIENT OUTPUT OK");

console.log("OUTPUT COUNT OK");

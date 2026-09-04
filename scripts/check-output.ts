import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIST_DIR = join(process.cwd(), "dist");
const MAX_THRESHOLD = 90_000;
const FIXED_ROUTE_SHELLS = [
  "index.html",
  "games/index.html",
  "search/index.html",
  "rankings/index.html",
  "rankings/peak/index.html",
  "deals/index.html",
  "releases/index.html",
  "privacy/index.html",
];

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
console.log(`Dist output file count: ${totalFiles} (threshold: < ${MAX_THRESHOLD})`);

if (totalFiles >= MAX_THRESHOLD) {
  console.error(`ERROR: dist output count ${totalFiles} reached or exceeded threshold ${MAX_THRESHOLD}`);
  process.exit(1);
}

const missingShells = FIXED_ROUTE_SHELLS.filter(
  (path) => !existsSync(join(DIST_DIR, "client", path))
);
if (missingShells.length > 0) {
  console.error(`ERROR: missing fixed route shells: ${missingShells.join(", ")}`);
  process.exit(1);
}
console.log(`Static route shells: ${FIXED_ROUTE_SHELLS.length}`);
console.log("STATIC SHELLS OK");

console.log("OUTPUT COUNT OK");

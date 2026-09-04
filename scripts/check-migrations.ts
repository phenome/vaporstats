import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";

const EXPECTED_TABLES = [
  "apps",
  "checkpoints",
  "observations",
  "tracked_games",
  "player_daily_requests",
  "player_rollups",
  "app_relationships",
  "app_prices",
  "price_history",
  "release_facts",
];

function findSqliteFiles(dir: string): string[] {
  const sqliteFiles: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        sqliteFiles.push(...findSqliteFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".sqlite") && !entry.name.includes("metadata")) {
        sqliteFiles.push(fullPath);
      }
    }
  } catch {
    // Directory may not exist or be accessible
  }
  return sqliteFiles;
}

const tempDir = mkdtempSync(join(tmpdir(), "vaporstats-d1-check-"));

try {
  // 1. Run actual Wrangler local D1 migrations against wrangler.jsonc using current Bun executable without shell
  const applyProc = spawnSync(
    process.execPath,
    ["run", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--config", "wrangler.jsonc", "--persist-to", tempDir],
    {
      stdio: "pipe",
      encoding: "utf8",
    }
  );

  if (applyProc.status !== 0) {
    throw new Error(
      `Wrangler migrations apply failed with exit code ${applyProc.status}:\n${applyProc.stderr || applyProc.stdout}`
    );
  }

  // 2. Query schema to prove expected terminal tables exist
  let foundTables: string[] = [];

  // Strategy A: Wrangler d1 execute JSON output
  const execProc = spawnSync(
    process.execPath,
    [
      "run",
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      "--config",
      "wrangler.jsonc",
      "--persist-to",
      tempDir,
      "--command",
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%';",
      "--json",
    ],
    {
      stdio: "pipe",
      encoding: "utf8",
    }
  );

  if (execProc.status === 0 && execProc.stdout) {
    try {
      const jsonMatch = execProc.stdout.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed) && parsed[0]?.results) {
          foundTables = parsed[0].results.map((r: { name: string }) => r.name);
        }
      }
    } catch {
      // Fallback to Strategy B below
    }
  }

  // Strategy B (fallback/corroboration): Direct SQLite database inspection
  if (foundTables.length === 0) {
    const sqliteFiles = findSqliteFiles(tempDir);
    for (const sqlitePath of sqliteFiles) {
      try {
        const db = new Database(sqlitePath, { readonly: true });
        const rows = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'"
          )
          .all();
        db.close();
        if (rows.length > foundTables.length) {
          foundTables = rows.map((r) => r.name);
        }
      } catch {
        // Try next candidate
      }
    }
  }

  // Verify all expected terminal tables exist
  const missingTables = EXPECTED_TABLES.filter((t) => !foundTables.includes(t));
  if (missingTables.length > 0) {
    throw new Error(
      `Migration verification failed. Missing expected tables: ${missingTables.join(", ")}. Found tables: ${foundTables.join(", ")}`
    );
  }

  console.log("MIGRATIONS OK");
} finally {
  // 3. Strict, verified temp removal
  rmSync(tempDir, { recursive: true, force: true });
  if (existsSync(tempDir)) {
    throw new Error(`Failed to clean up temporary directory: ${tempDir}`);
  }
}

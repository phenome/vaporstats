import { join, resolve } from "node:path";
import { runSnapshotRetention } from "../src/lib/snapshot-storage";

const USAGE = "Usage: bun run snapshots:retention [--apply]\nDefaults to a read-only JSON plan. --apply deletes the selected files.";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(USAGE);
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--apply")) {
    throw new Error("Invalid arguments: " + args.join(" ") + "\n" + USAGE);
  }

  const mode = args.length === 1 ? "apply" : "plan";
  const directory = resolve(process.env.DATABASE_SNAPSHOT_DIR ?? join("data", "snapshots"));
  const activeDatabasePath = resolve(process.env.DATABASE_PATH ?? join("data", "vaporstats.sqlite"));
  const referenceDate = new Date();
  const result = await runSnapshotRetention({ directory, activeDatabasePath, referenceDate, mode });
  const removalNames = new Set(result.plan.remove);
  const estimatedRemoval = result.candidates.reduce(
    (total, entry) => {
      if (removalNames.has(entry.name)) {
        total.sizeBytes += entry.sizeBytes;
        total.allocatedBytes += entry.allocatedBytes;
      }
      return total;
    },
    { sizeBytes: 0, allocatedBytes: 0 },
  );

  console.log(JSON.stringify({
    mode,
    directory,
    activeDatabasePath,
    referenceDate: referenceDate.toISOString().slice(0, 10),
    candidates: result.candidates,
    keep: result.plan.keep,
    remove: result.plan.remove,
    ignored: result.plan.ignored,
    reasons: result.plan.reasons,
    estimatedRemoval,
    deleted: result.deleted,
  }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Snapshot retention failed");
  process.exitCode = 1;
});

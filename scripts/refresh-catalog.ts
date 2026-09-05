import { closeDb, getDb } from "../src/lib/db";
import {
  queueCatalogRefresh,
  refreshCatalogBatch,
} from "../workers/catalog-seed";

const USAGE = "Usage: bun scripts/refresh-catalog.ts (--all | --appid N [--appid N ...]) [--run-one-batch]";

class CliArgumentError extends Error {}

interface RefreshCatalogCliOptions {
  all: boolean;
  appIds: number[];
  runOneBatch: boolean;
}

function parseArgs(args: string[]): RefreshCatalogCliOptions | null {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(USAGE);
    return null;
  }

  let all = false;
  let runOneBatch = false;
  const appIds: number[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--all") {
      if (all) throw new CliArgumentError("--all may only be provided once");
      all = true;
      continue;
    }
    if (arg === "--run-one-batch") {
      if (runOneBatch) throw new CliArgumentError("--run-one-batch may only be provided once");
      runOneBatch = true;
      continue;
    }
    if (arg === "--appid") {
      const value = args[++index];
      if (!value || !/^[1-9]\d*$/.test(value)) {
        throw new CliArgumentError("--appid requires a positive integer");
      }
      const appid = Number(value);
      if (!Number.isSafeInteger(appid)) {
        throw new CliArgumentError("--appid is outside the supported integer range");
      }
      appIds.push(appid);
      continue;
    }
    throw new CliArgumentError("Unknown argument: " + arg);
  }

  if (all === (appIds.length > 0)) {
    throw new CliArgumentError(USAGE + "\nAn explicit --all or one or more --appid values is required.");
  }
  return { all, appIds, runOneBatch };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;

  const db = await getDb();
  try {
    const queued = await queueCatalogRefresh(
      db,
      options.all ? {} : { appIds: options.appIds },
    );
    const output: {
      selection: "all" | "appid";
      selectedCount: number | null;
      queued: number;
      alreadyQueued: boolean;
      batch?: {
        active: boolean;
        attempted: number;
        successful: number;
        failed: number;
        rateLimited: boolean;
        pending: number;
      };
    } = {
      selection: options.all ? "all" : "appid",
      selectedCount: options.all ? null : options.appIds.length,
      queued: queued.queued,
      alreadyQueued: queued.alreadyQueued,
    };

    if (options.runOneBatch) {
      const batch = await refreshCatalogBatch(db);
      output.batch = {
        active: batch.active,
        attempted: batch.attempted,
        successful: batch.successful,
        failed: batch.failed,
        rateLimited: batch.rateLimited,
        pending: batch.pending,
      };
    }
    console.log(JSON.stringify(output));
  } finally {
    await closeDb();
  }
}

void main().catch((error: unknown) => {
  if (error instanceof CliArgumentError) {
    console.error(error.message);
  } else {
    console.error("refresh-catalog failed");
  }
  process.exitCode = 1;
});

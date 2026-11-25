import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, realpathSync, statSync, unlinkSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { planSnapshotRetention, type SnapshotRetentionPlan } from "./snapshot-retention";

export interface SnapshotRetentionOptions {
  directory: string;
  activeDatabasePath: string;
  referenceDate: Date;
  mode: "plan" | "apply";
  preservePaths?: readonly string[];
}

export interface SnapshotInventoryEntry {
  name: string;
  path: string;
  sizeBytes: number;
  allocatedBytes: number;
}

export interface SnapshotDirectoryRetentionResult {
  plan: SnapshotRetentionPlan;
  candidates: SnapshotInventoryEntry[];
  deleted: string[];
}

export function optionalStat(path: string, follow = false): Stats | undefined {
  try {
    return follow ? statSync(path) : lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export class SnapshotDirectory {
  readonly path: string;
  readonly identity: Stats;
  readonly fd?: number;
  readonly accessPath: string;

  constructor(private readonly requestedPath: string) {
    this.path = realpathSync(requestedPath);
    this.identity = statSync(this.path);
    if (!this.identity.isDirectory()) throw new Error("Expected a snapshot directory");
    const proc = process.platform === "linux" && optionalStat("/proc/self/fd", true);
    this.fd = proc ? openSync(this.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) : undefined;
    this.accessPath = this.fd === undefined ? this.path : `/proc/self/fd/${this.fd}`;
    try {
      if (this.fd !== undefined && !sameIdentity(this.identity, fstatSync(this.fd))) {
        throw new Error("Snapshot directory changed while opening");
      }
      this.assertCurrent();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  assertCurrent(): void {
    const current = optionalStat(this.requestedPath, true);
    if (!current || !sameIdentity(this.identity, current) || realpathSync(this.requestedPath) !== this.path) {
      throw new Error("Snapshot directory changed");
    }
  }

  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
  }
}

function unchanged(left: Stats | undefined, right: Stats | undefined): boolean {
  if (!left || !right) return left === right;
  return sameIdentity(left, right) && left.mode === right.mode && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.nlink === right.nlink;
}

function hasPendingWal(path: string): boolean {
  const wal = optionalStat(path + "-wal");
  // Unusual sidecars are not safe evidence of a standalone database either.
  return wal !== undefined && (!wal.isFile() || wal.size > 0);
}

export async function runSnapshotRetention(
  options: SnapshotRetentionOptions,
  boundDirectory?: SnapshotDirectory,
): Promise<SnapshotDirectoryRetentionResult> {
  if (options.mode !== "plan" && options.mode !== "apply") {
    throw new Error("Snapshot retention mode must be plan or apply");
  }
  const handle = boundDirectory ?? new SnapshotDirectory(options.directory);
  try {
    return await retainSnapshots(options, handle);
  } finally {
    if (!boundDirectory) handle.close();
  }
}

async function retainSnapshots(
  options: SnapshotRetentionOptions,
  handle: SnapshotDirectory,
): Promise<SnapshotDirectoryRetentionResult> {
  handle.assertCurrent();
  const directory = handle.path;
  const access = handle.accessPath;
  const protectedPaths = [options.activeDatabasePath, ...(options.preservePaths ?? [])].map((path) => {
    const absolute = resolve(path);
    const identity = optionalStat(absolute, true);
    return { path: absolute, resolved: identity ? realpathSync(absolute) : absolute, identity };
  });
  const inventory = new Map<string, Stats>();
  for (const name of readdirSync(access).sort()) {
    inventory.set(name, lstatSync(join(access, name)));
  }
  const regularNames = [...inventory].filter(([, stat]) => stat.isFile()).map(([name]) => name);
  const plan = planSnapshotRetention(regularNames, options.referenceDate);
  // Include non-files in the report, but never offer them to the policy as recovery points.
  plan.ignored = [...plan.ignored, ...[...inventory].filter(([, stat]) => !stat.isFile()).map(([name]) => name)].sort();
  const eligibleNames = [...plan.keep, ...plan.remove].sort();
  const protectedNames = new Set(eligibleNames.filter((name) => {
    const path = join(directory, name);
    const identity = inventory.get(name)!;
    return hasPendingWal(join(access, name)) || protectedPaths.some((entry) =>
      entry.path === path || entry.resolved === path || (entry.identity && sameIdentity(entry.identity, identity))
    );
  }));
  plan.keep = [...new Set([...plan.keep, ...protectedNames])].sort();
  plan.remove = plan.remove.filter((name) => !protectedNames.has(name));
  const candidates = eligibleNames.map((name) => {
    const stat = inventory.get(name)!;
    return { name, path: join(directory, name), sizeBytes: stat.size, allocatedBytes: stat.blocks * 512 };
  });
  const result: SnapshotDirectoryRetentionResult = { plan, candidates, deleted: [] };
  if (options.mode === "plan" || plan.remove.length === 0) return result;

  // Allow pending in-process filesystem work to settle before the fail-closed preflight.
  // No asynchronous work occurs between that preflight and the final unlink.
  await Promise.resolve();
  const changed = () => new Error("Snapshot inventory changed during retention; refusing deletion");
  handle.assertCurrent();
  const currentNames = readdirSync(access).sort();
  const originalNames = [...inventory.keys()];
  if (currentNames.length !== inventory.size || currentNames.some((name, index) => name !== originalNames[index])) {
    throw changed();
  }
  for (const [name, identity] of inventory) {
    if (!unchanged(identity, optionalStat(join(access, name)))) throw changed();
  }
  for (const entry of protectedPaths) {
    if (!unchanged(entry.identity, optionalStat(entry.path, true))) throw changed();
  }
  for (const name of plan.remove) {
    handle.assertCurrent();
    // Recheck keepers and this candidate immediately before each unlink as well.
    for (const keeper of plan.keep) {
      if (!unchanged(inventory.get(keeper), optionalStat(join(access, keeper)))) throw changed();
    }
    const path = join(access, name);
    const deletedIdentity = inventory.get(name)!;
    if (!unchanged(deletedIdentity, optionalStat(path)) || hasPendingWal(path)) throw changed();
    unlinkSync(path);
    result.deleted.push(name);
    inventory.delete(name);
    if (deletedIdentity.nlink > 1) {
      // Unlink changes ctime and nlink on every surviving hardlink to this inode.
      // Account only for that exact change, retaining all other replacement checks.
      for (const [alias, before] of inventory) {
        if (!sameIdentity(deletedIdentity, before)) continue;
        const after = optionalStat(join(access, alias));
        if (!after || !sameIdentity(before, after) || before.mode !== after.mode ||
          before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
          after.nlink !== before.nlink - 1) {
          throw changed();
        }
        inventory.set(alias, after);
      }
    }
  }
  return result;
}

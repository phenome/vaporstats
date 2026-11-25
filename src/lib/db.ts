import fs, { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, type Stats } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { basename, dirname, join, resolve } from "node:path";
import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { applyMigrations } from "./migrations";
import { optionalStat, sameIdentity, runSnapshotRetention, SnapshotDirectory } from "./snapshot-storage";

interface SqliteSource {
  requestedPath: string;
  requestedParent: Stats;
  path: string;
  parent: Stats;
  identity: Stats;
}

export interface AppPreparedStatement {
  bind(...values: unknown[]): AppPreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<{ success: boolean; meta: { changes: number; duration: number } }>;
  all<T = unknown>(): Promise<{
    success: boolean;
    results: T[];
    meta: { changes: number; duration: number };
  }>;
  raw<T = unknown>(): Promise<T[]>;
}

export interface AppDatabase {
  prepare(query: string): AppPreparedStatement;
  batch<T = unknown>(
    statements: AppPreparedStatement[]
  ): Promise<{ success: boolean; results?: T[] }[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
  /** Serialized write transaction; see `writeTransaction` in ./db-transaction. */
  writeTransaction?<T>(work: () => Promise<T>): Promise<T>;
}

type Binding = SQLQueryBindings;
type RunMeta = { changes: number; duration: number };

class SqlitePreparedStatement implements AppPreparedStatement {
  readonly #statement: Statement<any, any[]>;
  readonly #database: SqliteAppDatabase;
  #values: Binding[] = [];

  constructor(database: SqliteAppDatabase, query: string) {
    this.#database = database;
    this.#statement = database.native.prepare(query);
  }

  bind(...values: unknown[]): AppPreparedStatement {
    this.#values = values as Binding[];
    return this;
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const row = await this.#database.whenFree(() => this.#statement.get(...this.#values));
    if (row == null) return null;
    return (colName ? row[colName] : row) as T;
  }

  async run<T = unknown>(): Promise<{
    success: boolean;
    meta: RunMeta;
  }> {
    return this.#database.whenFree(() => this.runSync<T>());
  }

  async all<T = unknown>(): Promise<{
    success: boolean;
    results: T[];
    meta: RunMeta;
  }> {
    return this.#database.whenFree(() => {
      const started = performance.now();
      const results = this.#statement.all(...this.#values) as T[];
      return {
        success: true,
        results,
        meta: { changes: 0, duration: performance.now() - started },
      };
    });
  }

  async raw<T = unknown>(): Promise<T[]> {
    return this.#database.whenFree(() => this.#statement.raw(...this.#values) as T[]);
  }

  runSync<T = unknown>(): { success: boolean; meta: RunMeta } {
    const started = performance.now();
    const result = this.#statement.run(...this.#values);
    return {
      success: true,
      meta: { changes: Number(result.changes), duration: performance.now() - started },
    };
  }

  allSync<T = unknown>(): T[] {
    return this.#statement.all(...this.#values) as T[];
  }

  isReadOnly(): boolean {
    return /^(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(this.#statement.toString().trim());
  }

  get database(): SqliteAppDatabase {
    return this.#database;
  }
}

class SqliteAppDatabase implements AppDatabase {
  readonly native: Database;
  readonly source?: SqliteSource;
  /** Identifies the async call chain that owns the open write transaction. */
  readonly #owner = new AsyncLocalStorage<symbol>();
  #active: symbol | undefined;
  #idle: Promise<void> = Promise.resolve();
  #queue: Promise<void> = Promise.resolve();

  constructor(native: Database, source?: SqliteSource) {
    this.native = native;
    this.source = source;
  }

  /**
   * Runs a synchronous database operation now, or once no other call chain's
   * write transaction is open. The final check and the operation run in one
   * synchronous step, so the operation never fails on a nested BEGIN or
   * joins, and possibly rolls back with, another chain's transaction.
   */
  whenFree<T>(operation: () => T): T | Promise<T> {
    const open = this.#active && this.#owner.getStore() !== this.#active ? this.#idle : undefined;
    return open ? open.then(() => this.whenFree(operation)) : operation();
  }

  /**
   * The single serialized write path for work that awaits between
   * statements: transactions run one at a time, in call order, as
   * BEGIN IMMEDIATE ... COMMIT, and roll back if the work throws.
   *
   * The work may await only its own database calls and plain computation.
   * Awaiting a promise that another call chain started (a shared cache
   * entry, another queue's job) deadlocks: that chain's database calls wait
   * for this transaction, which waits for them.
   */
  async writeTransaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.#active && this.#owner.getStore() === this.#active) {
      throw new Error("Nested write transactions are not supported");
    }
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise((resolve) => { release = resolve; });
    const token = Symbol("write-transaction");
    let markIdle: (() => void) | undefined;
    try {
      await previous;
      await this.whenFree(() => {
        this.native.exec("BEGIN IMMEDIATE");
        this.#idle = new Promise((resolve) => { markIdle = resolve; });
        this.#active = token;
      });
      return await this.#owner.run(token, async () => {
        try {
          const result = await work();
          this.native.exec("COMMIT");
          return result;
        } catch (error) {
          if (this.native.inTransaction) this.native.exec("ROLLBACK");
          throw error;
        }
      });
    } finally {
      if (this.#active === token) this.#active = undefined;
      markIdle?.();
      release();
    }
  }

  prepare(query: string): AppPreparedStatement {
    return new SqlitePreparedStatement(this, query);
  }

  async batch<T = unknown>(statements: AppPreparedStatement[]): Promise<
    { success: boolean; results?: T[] }[]
  > {
    const execute = this.native.transaction(() =>
      statements.map((statement) => {
        if (!(statement instanceof SqlitePreparedStatement) || statement.database !== this) {
          throw new Error("All batched statements must belong to the same AppDatabase");
        }
        if (statement.isReadOnly()) {
          return { success: true, results: statement.allSync<T>() };
        }
        return statement.runSync<T>();
      })
    );
    return this.whenFree(() => execute() as { success: boolean; results?: T[] }[]);
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    return this.whenFree(() => {
      const started = performance.now();
      const result = this.native.exec(query);
      return { count: Number(result?.changes ?? 0), duration: performance.now() - started };
    });
  }

  close(): void {
    this.native.close(true);
  }
}

let databasePromise: Promise<SqliteAppDatabase> | undefined;

function configureDatabase(database: Database): void {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
}

/**
 * Opens a Bun SQLite database exactly as the application does: production
 * pragmas, then the shared migration procedure. Tests use this so their
 * adapter and foreign-key state match production.
 */
export function openSqliteAppDatabase(databasePath: string, migrationsDirectory?: string): SqliteAppDatabase {
  const path = databasePath === ":memory:" ? databasePath : resolve(databasePath);
  const fileBacked = path !== ":memory:";
  if (fileBacked) mkdirSync(dirname(path), { recursive: true });
  const requestedParent = fileBacked ? statSync(dirname(path)) : undefined;
  const existing = fileBacked ? optionalStat(path, true) : undefined;
  const resolved = existing ? realpathSync(path) : undefined;
  const parent = resolved ? statSync(dirname(resolved)) : undefined;
  const native = new Database(resolved ?? path);
  try {
    // Ask the open connection which filename SQLite chose, including when it
    // created a new file through a symlink.
    let source: SqliteSource | undefined;
    if (requestedParent) {
      const { file } = native.query<{ file: string }, []>("PRAGMA database_list").get()!;
      const actualPath = realpathSync(file);
      if (resolved && actualPath !== resolved) throw new Error("Snapshot source database changed while opening");
      source = {
        requestedPath: path,
        requestedParent,
        path: actualPath,
        parent: parent ?? statSync(dirname(actualPath)),
        identity: existing ?? statSync(actualPath),
      };
      assertSnapshotSource(source);
    }
    configureDatabase(native);
    applyMigrations(native, migrationsDirectory);
    if (source) assertSnapshotSource(source);
    return new SqliteAppDatabase(native, source);
  } catch (error) {
    native.close(true);
    throw error;
  }
}

async function openDatabase(): Promise<SqliteAppDatabase> {
  return openSqliteAppDatabase(resolve(process.env.DATABASE_PATH ?? join("data", "vaporstats.sqlite")));
}

export async function getDb(explicitDb?: AppDatabase): Promise<AppDatabase> {
  if (explicitDb) return explicitDb;
  databasePromise ??= openDatabase();
  return databasePromise;
}

export async function closeDb(): Promise<void> {
  const current = databasePromise;
  databasePromise = undefined;
  if (current) (await current).close();
}

function utcDateKey(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"];

function assertSnapshotSource(source: SqliteSource): void {
  const file = optionalStat(source.requestedPath, true);
  const requestedParent = optionalStat(dirname(source.requestedPath), true);
  const parent = optionalStat(dirname(source.path), true);
  if (!file?.isFile() || !sameIdentity(source.identity, file) ||
      !parent || !sameIdentity(source.parent, parent) ||
      !requestedParent || !sameIdentity(source.requestedParent, requestedParent) ||
      realpathSync(source.requestedPath) !== source.path) {
    throw new Error("Snapshot source database changed");
  }
}

function checkSnapshotDestination(path: string, source: SqliteSource, resolved: string): void {
  const existing = optionalStat(path);
  if (resolved === source.path || SQLITE_SIDECARS.some((suffix) => resolved === source.path + suffix) ||
      (existing && sameIdentity(source.identity, existing))) {
    throw new Error("A snapshot cannot replace its source database or its sidecars");
  }
  if (existing && !existing.isFile()) {
    throw new Error("A snapshot destination must be a regular file");
  }
  if (SQLITE_SIDECARS.some((suffix) => optionalStat(path + suffix))) {
    throw new Error("A snapshot cannot replace a database with SQLite sidecars");
  }
}

async function copySnapshot(
  source: SqliteSource,
  sourceDirectory: SnapshotDirectory,
  staging: SnapshotDirectory,
  name: string,
  identity: Stats,
): Promise<void> {
  const descriptors: number[] = [];
  const childPath = (directory: SnapshotDirectory, filename: string) => {
    if (directory.fd === undefined) return join(directory.path, filename);
    return join("/proc/self/fd", String(descriptors.push(directory.fd) + 2), filename);
  };
  const paths = [
    childPath(sourceDirectory, basename(source.path)),
    childPath(staging, name),
  ];
  // Bun runs SQLite backup synchronously. Use a separate process so the server
  // can continue serving requests. The inline entry point also works in dist.
  const child = Bun.spawn([process.execPath, "-e", `
    import { lstatSync, statSync } from "node:fs";
    import { dirname } from "node:path";
    import { backup, DatabaseSync } from "node:sqlite";
    const [sourcePath, targetPath, identities, sidecars] = process.argv.slice(1);
    const [sourceIdentity, targetIdentity] = JSON.parse(identities);
    function verify(path, [dev, ino, parentDev, parentIno]) {
      const parent = statSync(dirname(path));
      const file = lstatSync(path);
      if (parent.dev !== parentDev || parent.ino !== parentIno ||
          !file.isFile() || file.dev !== dev || file.ino !== ino) {
        throw new Error("SQLite snapshot file changed: " + path);
      }
    }
    function verifyTarget() {
      verify(targetPath, targetIdentity);
      for (const suffix of JSON.parse(sidecars)) {
        try {
          lstatSync(targetPath + suffix);
          throw new Error("Unexpected staging sidecar");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    function verifySource() {
      verify(sourcePath, sourceIdentity);
    }
    verifySource();
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      verifySource();
      source.exec("PRAGMA busy_timeout = 5000; BEGIN");
      // Pin a read view so concurrent WAL commits cannot restart the backup.
      source.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
      verifySource();
      verifyTarget();
      await backup(source, targetPath);
    } finally {
      source.close();
    }
    verifyTarget();
    const target = new DatabaseSync(targetPath);
    try {
      verifyTarget();
      if (target.prepare("PRAGMA journal_mode = DELETE").get().journal_mode !== "delete") {
        throw new Error("Could not make snapshot standalone");
      }
    } finally {
      target.close();
    }
  `, "--", ...paths, JSON.stringify([
    [source.identity.dev, source.identity.ino, sourceDirectory.identity.dev, sourceDirectory.identity.ino],
    [identity.dev, identity.ino, staging.identity.dev, staging.identity.ino],
  ]), JSON.stringify(SQLITE_SIDECARS)], {
    stdio: ["ignore", "ignore", "pipe", ...descriptors],
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error("SQLite snapshot backup failed (" + exitCode + "): " + stderr.trim());
}

function findOwnedEntry(directory: string, name: string, identity: Stats): string | undefined {
  const preferred = join(directory, name);
  const current = optionalStat(preferred);
  if (current && sameIdentity(current, identity)) return preferred;
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const candidate = optionalStat(path);
    if (candidate && sameIdentity(candidate, identity)) return path;
  }
}

function cleanupSnapshotStaging(
  parent: SnapshotDirectory,
  staging: SnapshotDirectory,
  name: string,
  identity?: Stats,
): void {
  // A renamed staging directory can still be cleaned through its descriptor.
  // On the fallback path only inspect it after finding its original inode.
  if (parent.fd === undefined) {
    const current = optionalStat(parent.accessPath);
    if (!current?.isDirectory() || !sameIdentity(current, parent.identity)) return;
  }
  const entry = findOwnedEntry(parent.accessPath, basename(staging.path), staging.identity);
  const access = staging.fd === undefined ? entry : staging.accessPath;
  if (identity && access) {
    const file = findOwnedEntry(access, name, identity);
    const current = file && optionalStat(file);
    if (file && current && sameIdentity(current, identity)) unlinkSync(file);
  }
  const current = entry && optionalStat(entry);
  if (entry && current && sameIdentity(current, staging.identity)) {
    try {
      rmdirSync(entry);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
}

let snapshotQueue: Promise<unknown> = Promise.resolve();

export async function createDailySnapshot(
  db: AppDatabase,
  destinationOrDate?: string,
  snapshotDate: Date | string = new Date()
): Promise<string> {
  const operation = snapshotQueue.then(async () => {
    const managed = !destinationOrDate || /^\d{4}-\d{2}-\d{2}$/.test(destinationOrDate);
    const date = destinationOrDate && managed ? destinationOrDate : utcDateKey(snapshotDate);
    const destination = managed
      ? join(process.env.DATABASE_SNAPSHOT_DIR ?? join("data", "snapshots"), "vaporstats-" + date + ".sqlite")
      : destinationOrDate!;
    const outputPath = resolve(destination);
    if (!(db instanceof SqliteAppDatabase)) {
      throw new Error("Daily snapshots require the Bun SQLite AppDatabase");
    }
    // Wait for another call chain's open write transaction before taking the copy.
    await db.whenFree(() => {
      if (db.native.inTransaction) throw new Error("Cannot create a snapshot inside a write transaction");
    });
    const source = db.source;
    if (!source) throw new Error("Daily snapshots require a file-backed SQLite database");
    assertSnapshotSource(source);
    const outputDirectory = dirname(outputPath);
    mkdirSync(outputDirectory, { recursive: true });
    const parent = new SnapshotDirectory(outputDirectory);
    try {
      const sourceDirectory = new SnapshotDirectory(dirname(source.path));
      try {
        if (!sameIdentity(source.parent, sourceDirectory.identity)) throw new Error("Snapshot source directory changed");
        const destinationName = basename(outputPath);
        const resolvedOutput = join(parent.path, destinationName);
        const destination = join(parent.accessPath, destinationName);
        checkSnapshotDestination(destination, source, resolvedOutput);

        const staging = new SnapshotDirectory(mkdtempSync(join(parent.accessPath, ".snapshot-tmp-")));
        const name = "snapshot.sqlite";
        let file: number | undefined;
        let identity: Stats | undefined;
        let published = false;
        try {
          const path = join(staging.accessPath, name);
          file = openSync(path, "wx", 0o600);
          identity = fstatSync(file);
          await copySnapshot(source, sourceDirectory, staging, name, identity);
          parent.assertCurrent();
          staging.assertCurrent();
          assertSnapshotSource(source);
          const current = optionalStat(path);
          if (!current?.isFile() || !sameIdentity(current, identity) ||
              SQLITE_SIDECARS.some((suffix) => optionalStat(path + suffix))) {
            throw new Error("Snapshot staging file or its sidecars changed during backup");
          }
          checkSnapshotDestination(destination, source, resolvedOutput);
          fs.renameSync(path, destination);
          published = true;
        } finally {
          try {
            cleanupSnapshotStaging(parent, staging, name, published ? undefined : identity);
          } finally {
            if (file !== undefined) closeSync(file);
            staging.close();
          }
        }

        if (managed) {
          assertSnapshotSource(source);
          await runSnapshotRetention({
            directory: parent.path,
            activeDatabasePath: source.path,
            referenceDate: new Date(date + "T23:59:59.999Z"),
            mode: "apply",
            preservePaths: [resolvedOutput],
          }, parent);
        }
      } finally {
        sourceDirectory.close();
      }
    } finally {
      parent.close();
    }
    return outputPath;
  });
  snapshotQueue = operation.catch(() => undefined);
  return operation;
}

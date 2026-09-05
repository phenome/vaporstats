import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { applyMigrations } from "./migrations";

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
    const row = this.#statement.get(...this.#values);
    if (row == null) return null;
    return (colName ? row[colName] : row) as T;
  }

  async run<T = unknown>(): Promise<{
    success: boolean;
    meta: RunMeta;
  }> {
    return this.runSync<T>();
  }

  async all<T = unknown>(): Promise<{
    success: boolean;
    results: T[];
    meta: RunMeta;
  }> {
    const started = performance.now();
    const results = this.#statement.all(...this.#values) as T[];
    return {
      success: true,
      results,
      meta: { changes: 0, duration: performance.now() - started },
    };
  }

  async raw<T = unknown>(): Promise<T[]> {
    return this.#statement.raw(...this.#values) as T[];
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
  readonly path: string;

  constructor(native: Database, path: string) {
    this.native = native;
    this.path = path;
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
    return execute() as { success: boolean; results?: T[] }[];
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    const started = performance.now();
    const result = this.native.exec(query);
    return { count: Number(result?.changes ?? 0), duration: performance.now() - started };
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

async function openDatabase(): Promise<SqliteAppDatabase> {
  const databasePath = resolve(process.env.DATABASE_PATH ?? join("data", "vaporstats.sqlite"));
  mkdirSync(dirname(databasePath), { recursive: true });
  const native = new Database(databasePath);
  try {
    configureDatabase(native);
    applyMigrations(native);
    return new SqliteAppDatabase(native, databasePath);
  } catch (error) {
    native.close(true);
    throw error;
  }
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

export async function createDailySnapshot(
  db: AppDatabase,
  destinationOrDate?: string,
  snapshotDate: Date | string = new Date()
): Promise<string> {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(destinationOrDate ?? "")
    ? destinationOrDate!
    : utcDateKey(snapshotDate);
  const destination =
    destinationOrDate && !/^\d{4}-\d{2}-\d{2}$/.test(destinationOrDate)
      ? destinationOrDate
      : join(process.env.DATABASE_SNAPSHOT_DIR ?? join("data", "snapshots"), "vaporstats-" + date + ".sqlite");
  const outputPath = resolve(destination);
  const sqlite = db instanceof SqliteAppDatabase ? db.native : null;
  if (!sqlite) throw new Error("Daily snapshots require the Bun SQLite AppDatabase");
  mkdirSync(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, sqlite.serialize());
  return outputPath;
}

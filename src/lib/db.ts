import { createServerOnlyFn } from "@tanstack/react-start";

/**
 * Cloudflare D1 database interface and accessor.
 * Concurrent Worker requests obtain D1 from cloudflare:workers env.
 * Never uses ambient mutable DB state.
 */

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<{ success: boolean; meta: { changes: number; duration: number } }>;
  all<T = unknown>(): Promise<{ success: boolean; results: T[]; meta: { changes: number; duration: number } }>;
  raw<T = unknown>(): Promise<T[]>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<{ success: boolean; results?: T[] }[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

/**
 * Server-only helper to read D1 binding from Cloudflare Workers runtime environment.
 * Wrapped in createServerOnlyFn so bundlers eliminate cloudflare:workers from client builds.
 */
const getCloudflareEnvDb = createServerOnlyFn(async (): Promise<D1Database | null> => {
  try {
    // Platform-specific module: cloudflare:workers only exists in Cloudflare Workers runtime.
    const cf = await import("cloudflare:workers");
    const cfEnv = cf.env as { DB?: D1Database } | undefined;
    if (cfEnv?.DB) {
      return cfEnv.DB;
    }
  } catch {
    // Non-Cloudflare or test environment
  }
  return null;
});

/**
 * Obtains the D1 database instance.
 * In Cloudflare Workers runtime, reads cloudflare:workers env.DB via server-only boundary.
 * In test runners or direct callers, accepts an explicit D1Database instance.
 * Never shares ambient mutable state across concurrent requests.
 */
export async function getDb(explicitDb?: D1Database): Promise<D1Database> {
  if (explicitDb) {
    return explicitDb;
  }

  const cloudflareDb = await getCloudflareEnvDb();
  if (cloudflareDb) {
    return cloudflareDb;
  }

  throw new Error("D1 database binding 'DB' is required and missing from environment");
}

export async function applyMigration(db: D1Database, sql: string): Promise<void> {
  await db.exec(sql);
}

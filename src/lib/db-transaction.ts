import type { AppDatabase } from "./db";

/**
 * Runs `work` as one write transaction that may await between statements.
 * Adapters that provide a serialized write path (the application's SQLite
 * database) use it; other adapters get a plain BEGIN IMMEDIATE ... COMMIT.
 */
export async function writeTransaction<T>(db: AppDatabase, work: () => Promise<T>): Promise<T> {
  if (db.writeTransaction) return db.writeTransaction(work);
  await db.exec("BEGIN IMMEDIATE");
  try {
    const result = await work();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    try { await db.exec("ROLLBACK"); } catch { /* preserve the original error */ }
    throw error;
  }
}

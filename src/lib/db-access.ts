import { createServerOnlyFn } from "@tanstack/react-start";
import type { AppDatabase } from "./db";

export const getDb = createServerOnlyFn(
  async (explicitDb?: AppDatabase): Promise<AppDatabase> =>
    (await import("./db")).getDb(explicitDb)
);

import { getDb, closeDb } from "../src/lib/db";

async function main(): Promise<void> {
  const db = await getDb();

  const eventsResult = await db.prepare(
    `UPDATE steam_events
     SET url = 'https://store.steampowered.com/news/app/' || appid || '/view/' || event_id
     WHERE url IS NULL`,
  ).run();

  const checkpointsResult = await db.prepare(
    "DELETE FROM checkpoints WHERE key LIKE 'reception:next:%'",
  ).run();

  console.log(
    `Backfill completed: ${eventsResult.meta.changes} events updated with canonical URLs, ${checkpointsResult.meta.changes} reception checkpoints reset for cron backfill.`,
  );

  closeDb();
}

main().catch((error) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});

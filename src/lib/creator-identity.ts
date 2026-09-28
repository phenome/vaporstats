// Only these Steam names have a verified shared Creator Homepage group.
const CAPCOM_NAMES: Record<string, true> = {
  "CAPCOM Co., Ltd.": true,
  "CAPCOM CO., LTD": true,
  "CAPCOM CO., LTD.": true,
};
const CAPCOM_GROUP_ID = 33273264;
const CAPCOM_DISPLAY_NAME = "CAPCOM Co., Ltd.";

type CreatorWrite = { sql: string; params: (string | number)[] };

/** Returns writes to refresh one app's creator links inside its app-write transaction. */
export function creatorSyncWrites(
  appid: number,
  developers: readonly string[],
  publishers: readonly string[],
): CreatorWrite[] {
  const names = new Set<string>();
  const links: { name: string; role: "developer" | "publisher"; sortOrder: number }[] = [];
  let hasCapcom = false;

  for (const [role, labels] of [["developer", developers], ["publisher", publishers]] as const) {
    const linked = new Set<string | number>();
    for (const [sortOrder, raw] of labels.entries()) {
      const name = typeof raw === "string" ? raw.trim() : "";
      if (!name) continue;
      names.add(name);
      const isCapcom = Object.hasOwn(CAPCOM_NAMES, name);
      hasCapcom ||= isCapcom;
      const identity = isCapcom ? CAPCOM_GROUP_ID : name;
      if (linked.has(identity)) continue;
      linked.add(identity);
      links.push({ name, role, sortOrder });
    }
  }

  const writes: CreatorWrite[] = [
    { sql: "DELETE FROM app_creators WHERE appid = ?", params: [appid] },
  ];
  if (hasCapcom) {
    writes.push({
      sql: "INSERT INTO creators (display_name, steam_group_id) VALUES (?, ?) ON CONFLICT(steam_group_id) DO NOTHING",
      params: [CAPCOM_DISPLAY_NAME, CAPCOM_GROUP_ID],
    });
  }
  for (const name of names) {
    if (Object.hasOwn(CAPCOM_NAMES, name)) {
      writes.push({
        sql: "INSERT OR IGNORE INTO creator_aliases (name, creator_id) SELECT ?, id FROM creators WHERE steam_group_id = ?",
        params: [name, CAPCOM_GROUP_ID],
      });
    } else {
      writes.push({
        sql: "INSERT INTO creators (display_name) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM creator_aliases WHERE name = ?)",
        params: [name, name],
      });
      writes.push({
        sql: "INSERT OR IGNORE INTO creator_aliases (name, creator_id) SELECT ?, id FROM creators WHERE display_name = ? AND steam_group_id IS NULL ORDER BY id LIMIT 1",
        params: [name, name],
      });
    }
  }
  for (const { name, role, sortOrder } of links) {
    writes.push({
      sql: `INSERT INTO app_creators (appid, creator_id, role, sort_order)
            SELECT ?, creator_id, ?, ? FROM creator_aliases WHERE name = ?
            ON CONFLICT(appid, creator_id, role) DO NOTHING`,
      params: [appid, role, sortOrder, name],
    });
  }
  return writes;
}

import { getDb, type D1Database } from "../src/lib/db";
import { upsertApp, setCheckpoint } from "../src/lib/catalog";
import { toSlug } from "../src/lib/slug";
import { upsertAppRelationship } from "../src/lib/related";

export interface SeedAppInput {
  appid: number;
  name: string;
  slug?: string;
  type?: string;
  is_eligible?: boolean;
  is_playable?: boolean;
  parent_appid?: number | null;
  release_date?: string | null;
  release_status?: string;
  description?: string;
  header_image?: string;
  developer?: string;
  publisher?: string;
}

export interface CuratedChildSeed {
  appid: number;
  parentAppId: number;
  name: string;
  relationshipType: "server" | "expansion" | "dlc";
  prominence: number;
  release_date?: string | null;
}

export const CURATED_SEED_CHILDREN: CuratedChildSeed[] = [
  {
    appid: 740, // Counter-Strike Dedicated Server under 730
    parentAppId: 730,
    name: "Counter-Strike Dedicated Server",
    relationshipType: "server",
    prominence: 0,
    release_date: "2004-10-07",
  },
  {
    appid: 2138330, // Cyberpunk 2077: Phantom Liberty under 1091500
    parentAppId: 1091500,
    name: "Cyberpunk 2077: Phantom Liberty",
    relationshipType: "expansion",
    prominence: 1,
    release_date: "2023-09-26",
  },
];

export interface SeedOptions {
  limit?: number;
  checkpointKey?: string;
  apps?: SeedAppInput[];
  appIds?: number[];
  children?: CuratedChildSeed[];
  fetchFn?: typeof fetch;
}

export interface SeedResult {
  seededCount: number;
  playableCount: number;
  accessoryCount: number;
  lastAppId: number | null;
  checkpointKey: string;
  records: SeedAppInput[];
  importedAppIds: number[];
}

export const DEFAULT_SEED_LIMIT = 50;

/**
 * Curated bounded AppID list for initial seed discovery.
 * Bounds initial seed to high-value titles without unbounded catalog scanning.
 * Curated parents (730 and 1091500) lead the list so children can attach within small budgets.
 */
export const INITIAL_SEED_APP_IDS: number[] = [
  730,     // Counter-Strike 2 (parent of 740)
  1091500, // Cyberpunk 2077 (parent of 2138330)
  570,     // Dota 2
  440,     // Team Fortress 2
  1086940, // Baldur's Gate 3
  1245620, // ELDEN RING
  252490,  // Rust
  271590,  // Grand Theft Auto V
  1172470, // Apex Legends
  550,     // Left 4 Dead 2
];

interface SteamAppDetailsResponse {
  [appid: string]: {
    success: boolean;
    data?: {
      type: string;
      name: string;
      steam_appid: number;
      is_free?: boolean;
      short_description?: string;
      header_image?: string;
      developers?: string[];
      publishers?: string[];
      release_date?: {
        coming_soon: boolean;
        date: string;
      };
    };
  };
}

/**
 * Obtains the storefront's displayed original release date.
 * Steam's appdetails endpoint can expose a later re-release date instead.
 */
function parseStorefrontReleaseDate(html: string): string | null {
  const match = html.match(
    /<div class="subtitle column">\s*Release Date:\s*<\/div>\s*<div class="date">\s*([^<]+?)\s*<\/div>/i
  );
  return match?.[1]?.trim() || null;
}

/**
 * Obtains Steam-derived app record for a specific AppID via Steam store API.
 * Supports injectable fetchFn for tests and worker runtime.
 */
export async function fetchSteamAppDetails(
  appid: number,
  customFetch: typeof fetch = fetch
): Promise<SeedAppInput | null> {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=en`;
  const response = await customFetch(url);
  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as SteamAppDetailsResponse;
  const appData = data[appid.toString()];

  if (!appData || !appData.success || !appData.data) {
    return null;
  }

  const details = appData.data;
  const releaseStatus = details.release_date?.coming_soon ? "upcoming" : "released";
  let releaseDate = details.release_date?.date ?? null;

  try {
    const storefrontResponse = await customFetch(
      `https://store.steampowered.com/app/${appid}/?cc=us&l=english`
    );
    if (storefrontResponse.ok) {
      releaseDate = parseStorefrontReleaseDate(await storefrontResponse.text()) ?? releaseDate;
    }
  } catch {
    // Keep the API date when the storefront request is unavailable.
  }

  return {
    appid: details.steam_appid,
    name: details.name,
    type: details.type,
    is_eligible: true,
    is_playable: details.type === "game",
    parent_appid: null,
    release_date: releaseDate,
    release_status: releaseStatus,
    description: details.short_description ?? "",
    header_image: details.header_image ?? "",
    developer: details.developers?.[0] ?? "",
    publisher: details.publishers?.[0] ?? "",
  };
}

/**
 * Runs bounded initial catalog seeding with Steam-derived records.
 * Hard-clamped to a finite integer in range 1..50 (sanitizes NaN, negative, fractional, huge values).
 * Total imported roots + curated children strictly never exceeds limit.
 * Curated children are only imported if their parent was imported in this run.
 */
export async function runBoundedCatalogImport(
  db: D1Database,
  options: SeedOptions = {}
): Promise<SeedResult> {
  // Sanitize limit to finite integer in range 1..50
  let limit = DEFAULT_SEED_LIMIT;
  if (typeof options.limit === "number") {
    if (isNaN(options.limit) || !Number.isFinite(options.limit)) {
      limit = DEFAULT_SEED_LIMIT;
    } else {
      limit = Math.min(50, Math.max(1, Math.floor(options.limit)));
    }
  }

  const checkpointKey = options.checkpointKey ?? "initial_catalog_seed";
  const fetchFn = options.fetchFn ?? fetch;

  // Curated children to consider (only if not restricted by explicit appIds)
  const candidateChildren = options.children ?? (options.appIds ? [] : CURATED_SEED_CHILDREN);

  let recordsToImport: SeedAppInput[] = [];

  if (options.apps) {
    // Directly provided records (slice against limit)
    recordsToImport = options.apps.slice(0, limit);
  } else {
    // Budget root slots so total (roots + children) never exceeds limit
    const maxChildrenBudget = options.appIds ? 0 : Math.min(candidateChildren.length, Math.floor(limit / 2));
    const rootLimit = Math.max(1, limit - maxChildrenBudget);
    const sourceIds = (options.appIds ?? INITIAL_SEED_APP_IDS).slice(0, rootLimit);

    for (const appid of sourceIds) {
      const record = await fetchSteamAppDetails(appid, fetchFn);
      if (record) {
        recordsToImport.push(record);
      }
    }
  }

  let seededCount = 0;
  let playableCount = 0;
  let accessoryCount = 0;
  let lastAppId: number | null = null;
  const allImportedRecords: SeedAppInput[] = [];
  const importedAppIdSet = new Set<number>();

  // 1. Upsert root records
  for (const app of recordsToImport) {
    const isPlayable = app.is_playable ?? (app.type === "game" && !app.parent_appid);
    const isEligible = app.is_eligible ?? true;
    const type = app.type ?? (isPlayable ? "game" : "accessory");

    const record: SeedAppInput = {
      appid: app.appid,
      name: app.name,
      slug: toSlug(app.name),
      type,
      is_eligible: isEligible,
      is_playable: isPlayable,
      parent_appid: app.parent_appid ?? null,
      release_date: app.release_date ?? null,
      release_status: app.release_status ?? "released",
      description: app.description ?? "",
      header_image:
        app.header_image ||
        `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${app.appid}/header.jpg`,
      developer: app.developer ?? "",
      publisher: app.publisher ?? "",
    };

    await upsertApp(db, record);

    seededCount++;
    if (isPlayable && isEligible && !app.parent_appid) {
      playableCount++;
    } else {
      accessoryCount++;
    }
    lastAppId = app.appid;
    allImportedRecords.push(record);
    importedAppIdSet.add(app.appid);
  }

  // 2. Curated children are only imported if their parent was imported in this run
  // Slice eligible children against remaining capacity to strictly respect limit
  const remainingCapacity = Math.max(0, limit - allImportedRecords.length);
  const eligibleChildren = candidateChildren.filter((child) => importedAppIdSet.has(child.parentAppId));
  const childrenToImport = eligibleChildren.slice(0, remainingCapacity);

  for (const child of childrenToImport) {
    let childRecord: SeedAppInput | null = null;
    if (!options.apps) {
      childRecord = await fetchSteamAppDetails(child.appid, fetchFn);
    }

    const childInput: SeedAppInput = {
      appid: child.appid,
      name: childRecord?.name || child.name || `App ${child.appid}`,
      slug: toSlug(childRecord?.name || child.name || `App ${child.appid}`),
      type: child.relationshipType,
      is_eligible: true,
      is_playable: false, // Force children non-playable
      parent_appid: child.parentAppId,
      release_date: childRecord?.release_date || child.release_date || null,
      release_status: childRecord?.release_status || "released",
      description: childRecord?.description || "",
      header_image:
        childRecord?.header_image ||
        `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${child.appid}/header.jpg`,
      developer: childRecord?.developer || "",
      publisher: childRecord?.publisher || "",
    };

    // Upsert child app row
    await upsertApp(db, childInput);

    // Upsert relationship between parent and child
    await upsertAppRelationship(db, {
      parent_appid: child.parentAppId,
      child_appid: child.appid,
      relationship_type: child.relationshipType,
      prominence: child.prominence,
    });

    seededCount++;
    accessoryCount++;
    lastAppId = child.appid;
    allImportedRecords.push(childInput);
    importedAppIdSet.add(child.appid);
  }

  // Record checkpoint to persist seeding progress
  await setCheckpoint(db, checkpointKey, `seeded:${seededCount}`, lastAppId);

  return {
    seededCount,
    playableCount,
    accessoryCount,
    lastAppId,
    checkpointKey,
    records: allImportedRecords,
    importedAppIds: Array.from(importedAppIdSet),
  };
}

export const runCatalogSeed = runBoundedCatalogImport;

import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { getMediaSources } from "../src/lib/media-discovery";
import { encodeVector, GEMINI_EMBEDDING_DIMENSIONS } from "../src/lib/media-embedding-vector";
import { getMediaOverview } from "../src/lib/media-overview";
import { getMediaGameMatches, MEDIA_MATCH_EMBEDDING } from "../src/lib/media-similarity";
import { handleGameDetailRequest, type GameDetailResponseData } from "../src/routes/api.games.$appid.detail";
import { handleGameHttpRequest } from "../src/routes/games.$game";
import { handleChildHttpRequest } from "../src/routes/games.$game_.$child";
import { openMemoryDatabase } from "./support/db";

const CYBERPUNK = 1091500;
const BALDURS_GATE = 1086940;
const HADES_II = 1145350;
const PHANTOM_LIBERTY = 2138330;
const OTHER_GAME = 99001;
const NO_LAW = 2161710;
const WARLOCK = 3714800;
const PUBLIC_ROOTS = [CYBERPUNK, BALDURS_GATE, HADES_II, NO_LAW, WARLOCK];
const PRIVATE_ENTITIES = [PHANTOM_LIBERTY, OTHER_GAME];
const DETAIL_MATCHES_PER_DIMENSION = 3;

function seedCoverage(native: Database) {
  native.run(`INSERT INTO apps (appid, name, slug, type, is_eligible, is_playable, parent_appid) VALUES
    (${CYBERPUNK}, 'Cyberpunk 2077', 'cyberpunk-2077', 'game', 1, 1, NULL),
    (${BALDURS_GATE}, 'Baldur''s Gate 3', 'baldurs-gate-3', 'game', 1, 1, NULL),
    (${HADES_II}, 'Hades II', 'hades-ii', 'game', 1, 1, NULL),
    (${NO_LAW}, 'NO LAW', 'no-law', 'game', 1, 1, NULL),
    (${WARLOCK}, 'Warlock: Dungeons & Dragons', 'warlock-dungeons-dragons', 'game', 1, 1, NULL),
    (${PHANTOM_LIBERTY}, 'Phantom Liberty', 'phantom-liberty', 'expansion', 1, 0, ${CYBERPUNK}),
    (${OTHER_GAME}, 'Another Game', 'another-game', 'game', 1, 1, NULL)`);

  for (const appid of [...PUBLIC_ROOTS, ...PRIVATE_ENTITIES]) {
    const url = `https://www.ign.com/articles/review-${appid}`;
    const identity = `overview-${appid}`;
    native.run(
      "INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type) VALUES (?, 'initial', ?, ?, 'IGN', '2026-11-25', 'review')",
      [appid, url, `Review for ${appid}`],
    );
    native.run(
      `INSERT INTO media_article_extractions (source_id,input_identity,content_hash,cleanup_version,model,config_version,output_json)
       SELECT id, ?, ?, 'test', 'model', 'config', '{}' FROM media_sources WHERE original_url = ?`,
      [identity, identity, url],
    );
    native.run(
      "INSERT INTO media_game_overviews (appid, input_identity, model, config_version, output_json) VALUES (?, ?, 'model', 'config', ?)",
      [appid, identity, JSON.stringify({
        statements: [{ text: `Overview for ${appid}`, sourceUrls: [url] }],
        tags: [{ label: "Joy-Con aiming (Switch 2)", sourceUrls: [url] }],
      })],
    );
    const values = Array<number>(GEMINI_EMBEDDING_DIMENSIONS).fill(0);
    // Unpublished candidates rank ahead of the other public roots for Cyberpunk.
    values[0] = 1;
    values[1] = appid === BALDURS_GATE || appid === HADES_II || appid === NO_LAW || appid === WARLOCK ? 1 : 0;
    for (const dimension of ["gameplay", "story_world"]) {
      native.run(
        `INSERT INTO media_game_embeddings
          (appid, dimension, input_identity, overview_input_identity, model, dimensions, config_version, vector)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [appid, dimension, `${identity}-${dimension}`, identity, MEDIA_MATCH_EMBEDDING.model,
          MEDIA_MATCH_EMBEDDING.dimensions, MEDIA_MATCH_EMBEDDING.configVersion, encodeVector(values)!],
      );
    }
  }
}

test("publishes generated media and matches for the approved roots through public readers, API and SSR", async () => {
  const { db, native } = openMemoryDatabase();
  const previous = process.env.MEDIA_OVERVIEW_PUBLIC;
  try {
    seedCoverage(native);
    const detail = async (appid: number): Promise<GameDetailResponseData> => {
      const response = await handleGameDetailRequest(
        new Request(`https://vaporstats.test/api/games/${appid}/detail`), db,
      );
      expect(response.status).toBe(200);
      return (await response.json() as { data: GameDetailResponseData }).data;
    };

    delete process.env.MEDIA_OVERVIEW_PUBLIC;
    const disabled = await detail(CYBERPUNK);
    expect(disabled.mediaOverview).toBeNull();
    expect(disabled.mediaMatches).toEqual([]);
    expect(disabled.sources.map(({ appid }) => appid)).toEqual([CYBERPUNK]);
    expect((await detail(PHANTOM_LIBERTY)).sources).toEqual([]);
    expect(await getMediaOverview(db, CYBERPUNK, { includeUnpublished: true })).not.toBeNull();

    process.env.MEDIA_OVERVIEW_PUBLIC = "true";
    for (const appid of PUBLIC_ROOTS) {
      const result = await detail(appid);
      expect(result.mediaOverview?.statements[0]?.text).toBe(`Overview for ${appid}`);
      expect(result.mediaOverview?.tags[0]).toEqual({ label: "Joy-Con aiming (Switch 2)", slug: "joy-con-aiming-switch-2" });
      expect(result.sources.map((source) => source.appid)).toEqual([appid]);
      const candidates = PUBLIC_ROOTS.filter((candidate) => candidate !== appid);
      // Every other public root ties, and the detail page shows three matches per dimension.
      const shown = Math.min(DETAIL_MATCHES_PER_DIMENSION, candidates.length);
      const matched = new Set<number>();
      for (const dimension of ["gameplay", "story_world"]) {
        const appids = result.mediaMatches.filter((match) => match.dimension === dimension).map((match) => match.matchedGame.appid);
        expect(new Set(appids).size).toBe(shown);
        expect(appids.every((candidate) => candidates.includes(candidate))).toBe(true);
        for (const candidate of appids) matched.add(candidate);
      }
      expect(Object.keys(result.mediaMatchPaths).map(Number).sort((a, b) => a - b)).toEqual([...matched].sort((a, b) => a - b));
    }
    for (const appid of PRIVATE_ENTITIES) {
      const result = await detail(appid);
      expect(result.mediaOverview).toBeNull();
      expect(result.mediaMatches).toEqual([]);
      expect(result.sources).toEqual([]);
      expect(await getMediaOverview(db, appid, { includeUnpublished: true })).not.toBeNull();
      expect(await getMediaGameMatches(db, appid, { includeUnpublished: true })).not.toEqual([]);
      expect(await getMediaSources(db, appid, { includeUnpublished: true })).toHaveLength(1);
    }
    const publicTop = await getMediaGameMatches(db, CYBERPUNK, { limit: 1 });
    const internalTop = await getMediaGameMatches(db, CYBERPUNK, { limit: 1, includeUnpublished: true });
    expect(publicTop).toHaveLength(2);
    expect(publicTop.every((match) => PUBLIC_ROOTS.includes(match.matchedGame.appid))).toBe(true);
    expect(internalTop).toHaveLength(2);
    expect(internalTop.every((match) => PRIVATE_ENTITIES.includes(match.matchedGame.appid))).toBe(true);

    const rootResponse = await handleGameHttpRequest(
      new Request("https://vaporstats.test/games/1091500-cyberpunk-2077"), db,
    );
    expect(rootResponse.status).toBe(200);
    const rootHtml = await rootResponse.text();
    for (const id of ["media-overview", "media-sources", "media-matches"]) {
      expect(rootHtml).toContain(`id="${id}"`);
    }
    const childResponse = await handleChildHttpRequest(
      new Request("https://vaporstats.test/games/1091500-cyberpunk-2077/2138330-phantom-liberty"), db,
    );
    expect(childResponse.status).toBe(200);
    const childHtml = await childResponse.text();
    for (const id of ["media-overview", "media-sources", "media-matches"]) {
      expect(childHtml).not.toContain(`id="${id}"`);
    }
  } finally {
    if (previous === undefined) delete process.env.MEDIA_OVERVIEW_PUBLIC;
    else process.env.MEDIA_OVERVIEW_PUBLIC = previous;
    native.close(true);
  }
});

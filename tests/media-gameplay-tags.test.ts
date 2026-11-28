import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type CommunityTagMembership,
  GAMEPLAY_MATCH_BAR,
  GAMEPLAY_SHARED_TAG_LIMIT,
  gameplayTagScore,
  gameplayTagVector,
  meetsGameplayMatchBar,
  sharedGameplayTagLabels,
} from "../src/lib/media-gameplay-tags";
import { getMediaGameMatches } from "../src/lib/media-similarity";
import { STEAM_GAMEPLAY_TAGS, STEAM_GAMES_TOTAL } from "../src/lib/steam-gameplay-tags";
import { openMemoryDatabase } from "./support/db";

type RecordedGame = { appid: number; name: string; tags: Array<{ tagid: number; name: string; weight: number | null }> };
const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/recorded-community-tags.json", import.meta.url), "utf8"),
) as { recordedOn: string; games: RecordedGame[] };
const tagNames = new Map(recorded.games.flatMap((game) => game.tags.map((tag) => [String(tag.tagid), tag.name] as const)));

/** `appid_a appid_b score listed shared_tags # names`, one pair per line. */
const expectedPairs = readFileSync(new URL("./fixtures/gameplay-tag-expected-scores.txt", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.trim() && !line.startsWith("#"))
  .map((line) => {
    const match = /^(\d+) (\d+) ([\d.]+) (yes|no) \[([^\]]*)\]/.exec(line);
    if (!match) throw new Error(`Unparsed expected score line: ${line}`);
    return {
      left: Number(match[1]),
      right: Number(match[2]),
      score: Number(match[3]),
      listed: match[4] === "yes",
      shared: match[5] ? match[5].split(", ") : [],
    };
  });

function memberships(game: RecordedGame): CommunityTagMembership[] {
  return game.tags.map((tag) => ({ sourceId: String(tag.tagid), weight: tag.weight }));
}

const BALDURS_GATE = 1086940;
const WARLOCK = 3714800;
const HADES_II = 1145350;
const CYBERPUNK = 1091500;
const NO_LAW = 2161710;
const PUBLISHED = [BALDURS_GATE, WARLOCK, HADES_II, CYBERPUNK, NO_LAW];

describe("gameplay tag scoring", () => {
  const table = {
    totalGames: 1000,
    tags: {
      "1": { name: "Common", facet: "genre", steamGames: 500 },
      "2": { name: "Rare", facet: "mechanics", steamGames: 10 },
      "3": { name: "Viewpoint", facet: "viewpoint", steamGames: 100 },
    },
  } as const;

  test("weighs a gameplay tag by its share of the top vote count of any community tag times its rarity", () => {
    const vector = gameplayTagVector([
      { sourceId: "1", weight: 50 },
      { sourceId: "2", weight: 25 },
      { sourceId: "99", weight: 100 }, // not a gameplay tag, but sets the top vote count
    ], table);
    expect([...vector.keys()]).toEqual(["1", "2"]);
    expect(vector.get("1")).toBeCloseTo((50 / 100) * Math.log(1000 / 500), 12);
    expect(vector.get("2")).toBeCloseTo((25 / 100) * Math.log(1000 / 10), 12);
  });

  test("uses the checked-in table and its Steam-wide total by default", () => {
    const vector = gameplayTagVector([{ sourceId: "1695", weight: 10 }, { sourceId: "19", weight: 20 }]);
    expect(vector.get("1695")).toBeCloseTo(0.5 * Math.log(STEAM_GAMES_TOTAL / STEAM_GAMEPLAY_TAGS["1695"]!.steamGames), 12);
    expect(vector.get("19")).toBeCloseTo(Math.log(STEAM_GAMES_TOTAL / STEAM_GAMEPLAY_TAGS["19"]!.steamGames), 12);
  });

  test("ignores memberships with no vote count and tags outside the gameplay table", () => {
    const vector = gameplayTagVector([
      { sourceId: "1", weight: null },
      { sourceId: "2", weight: 40 },
      { sourceId: "3", weight: 0 },
      { sourceId: "99", weight: 80 },
      { sourceId: "toString", weight: 80 },
    ], table);
    expect([...vector.keys()]).toEqual(["2"]);
    expect(vector.get("2")).toBeCloseTo(0.5 * Math.log(100), 12);
  });

  test("a game with no weighted gameplay tag scores 0 against every game", () => {
    const empty = gameplayTagVector([{ sourceId: "1", weight: null }, { sourceId: "99", weight: 10 }], table);
    expect(empty.size).toBe(0);
    expect(gameplayTagVector([], table).size).toBe(0);
    const other = gameplayTagVector([{ sourceId: "1", weight: 10 }], table);
    expect(gameplayTagScore(empty, other)).toBe(0);
    expect(gameplayTagScore(other, empty)).toBe(0);
    expect(gameplayTagScore(empty, empty)).toBe(0);
    expect(meetsGameplayMatchBar(gameplayTagScore(empty, other))).toBe(false);
  });

  test("scores the cosine of the two weighted tag sets", () => {
    const left = new Map([["1", 3], ["2", 4]]);
    const right = new Map([["2", 1], ["3", 1]]);
    expect(gameplayTagScore(left, right)).toBeCloseTo(4 / (5 * Math.SQRT2), 12);
    expect(gameplayTagScore(right, left)).toBe(gameplayTagScore(left, right));
    expect(gameplayTagScore(left, new Map([["1", 6], ["2", 8]]))).toBeCloseTo(1, 12);
  });

  test("the bar admits a score at or above 0.30 only", () => {
    expect(GAMEPLAY_MATCH_BAR).toBe(0.3);
    expect(meetsGameplayMatchBar(0.3)).toBe(true);
    expect(meetsGameplayMatchBar(0.30001)).toBe(true);
    expect(meetsGameplayMatchBar(0.29999)).toBe(false);
  });

  test("orders shared tags by the product of their two values, at most three, leaving out unnamed tags", () => {
    expect(GAMEPLAY_SHARED_TAG_LIMIT).toBe(3);
    const left = new Map([["10", 1], ["20", 2], ["30", 3], ["40", 4], ["50", 5], ["60", 1]]);
    const right = new Map([["10", 9], ["20", 1], ["30", 1], ["40", 1], ["50", 0.1], ["70", 9]]);
    const names: Record<string, string | null> = { "10": "Ten", "20": "Twenty", "30": "Thirty", "40": "Forty", "50": "Fifty" };
    // Products: 10 → 9, 40 → 4, 30 → 3, 20 → 2, 50 → 0.5; 60 and 70 are not shared.
    expect(sharedGameplayTagLabels(left, right, (id) => names[id])).toEqual(["Ten", "Forty", "Thirty"]);
    names["40"] = null;
    expect(sharedGameplayTagLabels(left, right, (id) => names[id])).toEqual(["Ten", "Thirty", "Twenty"]);
    expect(sharedGameplayTagLabels(left, new Map([["70", 1]]), (id) => names[id])).toEqual([]);
    // Equal contributions are ordered by tag ID.
    expect(sharedGameplayTagLabels(new Map([["30", 1], ["20", 1]]), new Map([["20", 1], ["30", 1]]), (id) => names[id]))
      .toEqual(["Twenty", "Thirty"]);
  });
});

describe("recorded community tags of 2026-11-28", () => {
  test("reproduce the expected score, listing and shared tags of every pair", () => {
    expect(recorded.recordedOn).toBe("2026-11-28");
    expect(expectedPairs).toHaveLength((recorded.games.length * (recorded.games.length - 1)) / 2);
    const vectors = new Map(recorded.games.map((game) => [game.appid, gameplayTagVector(memberships(game))]));
    for (const pair of expectedPairs) {
      const left = vectors.get(pair.left)!;
      const right = vectors.get(pair.right)!;
      const score = gameplayTagScore(left, right);
      expect({ pair: [pair.left, pair.right], score: Number(score.toFixed(3)) })
        .toEqual({ pair: [pair.left, pair.right], score: Number(pair.score.toFixed(3)) });
      expect(meetsGameplayMatchBar(score)).toBe(pair.listed);
      expect(sharedGameplayTagLabels(left, right, (id) => tagNames.get(id))).toEqual(pair.shared);
    }
  });

  describe("through the reader for the five published games", () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });
    const previous = process.env.MEDIA_OVERVIEW_PUBLIC;
    afterEach(() => {
      if (previous === undefined) delete process.env.MEDIA_OVERVIEW_PUBLIC;
      else process.env.MEDIA_OVERVIEW_PUBLIC = previous;
    });

    function seed() {
      const database = openMemoryDatabase();
      cleanups.push(database.close);
      const { native } = database;
      for (const game of recorded.games) {
        native.prepare(
          "INSERT INTO apps (appid, name, slug, type, is_eligible, is_playable, parent_appid) VALUES (?, ?, ?, 'game', 1, 1, NULL)",
        ).run(game.appid, game.name, `game-${game.appid}`);
        native.prepare(
          "INSERT INTO media_game_overviews (appid, input_identity, model, config_version, output_json) VALUES (?, ?, 'model', 'config', '{}')",
        ).run(game.appid, `overview-${game.appid}`);
        for (const [order, tag] of game.tags.entries()) {
          native.prepare(
            "INSERT OR IGNORE INTO app_facets (facet_group, source_id, name) VALUES ('community_tag', ?, ?)",
          ).run(String(tag.tagid), tag.name);
          native.prepare(
            "INSERT INTO app_facet_memberships (appid, facet_group, source_id, source_order, weight) VALUES (?, 'community_tag', ?, ?, ?)",
          ).run(game.appid, String(tag.tagid), order, tag.weight);
        }
      }
      return database;
    }

    test("Hades II and Baldur's Gate 3 list no gameplay match; Warlock lists Cyberpunk 2077 then NO LAW; Cyberpunk 2077 lists NO LAW first", async () => {
      const { db } = seed();
      process.env.MEDIA_OVERVIEW_PUBLIC = "true";
      const gameplay = async (appid: number) =>
        (await getMediaGameMatches(db, appid, { limit: 100 })).filter((match) => match.dimension === "gameplay");

      expect(await gameplay(HADES_II)).toEqual([]);
      expect(await gameplay(BALDURS_GATE)).toEqual([]);

      const warlock = await gameplay(WARLOCK);
      expect(warlock.map((match) => match.matchedGame.appid)).toEqual([CYBERPUNK, NO_LAW]);
      expect(warlock.some((match) => match.matchedGame.appid === HADES_II)).toBe(false);
      expect(warlock.map((match) => match.sharedTags)).toEqual([
        ["Open World", "Exploration", "Action"],
        ["Open World", "Exploration", "Action"],
      ]);
      expect(warlock.map((match) => Number(match.similarity.toFixed(3)))).toEqual([0.489, 0.326]);

      const cyberpunk = await gameplay(CYBERPUNK);
      expect(cyberpunk[0]?.matchedGame.appid).toBe(NO_LAW);
      expect(cyberpunk[0]?.sharedTags).toEqual(["Open World", "FPS", "RPG"]);
      expect(cyberpunk.map((match) => match.matchedGame.appid)).toEqual([NO_LAW, WARLOCK]);

      // The reference games are not published, so they never appear publicly.
      for (const appid of PUBLISHED) {
        for (const match of await gameplay(appid)) expect(PUBLISHED).toContain(match.matchedGame.appid);
      }
      const internal = (await getMediaGameMatches(db, HADES_II, { includeUnpublished: true }))
        .filter((match) => match.dimension === "gameplay");
      expect(internal.map((match) => [match.matchedGame.appid, match.sharedTags])).toEqual([
        [588650, ["Hack and Slash", "Action Roguelike", "Roguelike"]],
      ]);
    });
  });
});

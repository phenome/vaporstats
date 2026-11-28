// PROTOTYPE — throwaway. Not production code, not imported anywhere.
//
// Question: if the "Gameplay & systems" match is grounded on Steam community
// tags, does the pool come out in an order a player would agree with, and is
// there a bar below which a game should simply not be listed?
//
// Run: bun scripts/prototypes/gameplay-tag-match/prototype.ts
// Reads pool.json beside this file, sends a few short embedding requests to
// Gemini (cached in vectors.cache.json), prints every score matrix and writes
// report.html.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Tag = { name: string; weight: number; catalogCount: number | null };
type Game = { appid: number; name: string; short: string; inPool: boolean; tags: Tag[]; coverage: string };
type Pool = { catalogGames: number; games: Game[]; live: Record<string, { gameplay: number | null; story: number | null }> };

const dir = import.meta.dir;
const pool: Pool = JSON.parse(readFileSync(join(dir, "pool.json"), "utf8"));

// ---------------------------------------------------------------------------
// Tag facets. Hand-assigned for the tags that occur in this pool; production
// would need the same table for the whole Steam tag dictionary (446 tags).
// ---------------------------------------------------------------------------
const FACETS: Record<string, string[]> = {
  genre: ["Action", "Action RPG", "Action Roguelike", "Action-Adventure", "Adventure", "CRPG", "Dungeon Crawler", "FPS", "Hack and Slash", "Immersive Sim", "Interactive Fiction", "Metroidvania", "Platformer", "RPG", "Roguelike", "Roguelite", "Shooter", "Souls-like", "Stealth", "Strategy", "Visual Novel", "Choose Your Own Adventure"],
  viewpoint: ["2D", "First-Person", "Third Person", "Isometric"],
  mechanics: ["Character Customization", "Choices Matter", "Class-Based", "Combat", "Difficult", "Exploration", "Investigation", "Multiple Endings", "Nonlinear", "Open World", "Perma Death", "Procedural Generation", "Replay Value", "Swordplay", "Turn-Based Combat", "Music"],
  players: ["Singleplayer", "Multiplayer", "Online Co-Op", "Co-op Campaign"],
  theme: ["Assassins", "Atmospheric", "Cyberpunk", "Dark Fantasy", "Detective", "Emotional", "Fantasy", "Female Protagonist", "Futuristic", "LGBTQ+", "Magic", "Medieval", "Mythology", "Romance", "Sci-fi", "Story Rich", "Comedy", "Funny"],
  other: ["Gore", "Violent", "Nudity", "Sexual Content", "Great Soundtrack", "Indie", "Cinematic", "Comic Book", "Stylized", "Hand-drawn", "Pixel Graphics"],
};
const facetOf = new Map<string, string>();
for (const [facet, names] of Object.entries(FACETS)) for (const name of names) facetOf.set(name, facet);
const GAMEPLAY_FACETS = new Set(["genre", "viewpoint", "mechanics"]);

for (const game of pool.games) for (const tag of game.tags) if (!facetOf.has(tag.name)) throw new Error(`unclassified tag: ${tag.name}`);

// ---------------------------------------------------------------------------
// The liftable part: pure scoring over plain data.
// ---------------------------------------------------------------------------

/** How much a tag tells games apart: rare tags count for more than "Action". */
function rarity(tag: Tag, catalogGames: number): number {
  return tag.catalogCount ? Math.log(catalogGames / tag.catalogCount) : 0;
}

/** A game's tags in the wanted facets, each scaled by its share of the game's top vote count and by rarity. */
function tagVector(game: Game, facets: ReadonlySet<string>, catalogGames: number, useRarity: boolean): Map<string, number> {
  const top = Math.max(...game.tags.map((tag) => tag.weight));
  const vector = new Map<string, number>();
  for (const tag of game.tags) {
    if (!facets.has(facetOf.get(tag.name)!)) continue;
    vector.set(tag.name, (tag.weight / top) * (useRarity ? rarity(tag, catalogGames) : 1));
  }
  return vector;
}

function sparseCosine(left: Map<string, number>, right: Map<string, number>): number {
  let dot = 0, l = 0, r = 0;
  for (const [name, value] of left) { l += value * value; dot += value * (right.get(name) ?? 0); }
  for (const value of right.values()) r += value * value;
  return l === 0 || r === 0 ? 0 : dot / Math.sqrt(l * r);
}

function denseCosine(left: number[], right: number[]): number {
  let dot = 0, l = 0, r = 0;
  for (let i = 0; i < left.length; i += 1) { dot += left[i]! * right[i]!; l += left[i]! ** 2; r += right[i]! ** 2; }
  return dot / Math.sqrt(l * r);
}

/** The tags two games share, strongest contribution first. */
function sharedTags(left: Map<string, number>, right: Map<string, number>): string[] {
  return [...left.keys()].filter((name) => right.has(name))
    .sort((a, b) => left.get(b)! * right.get(b)! - left.get(a)! * right.get(a)!);
}

/** The tag-grounded text a profile embedding would be built from. */
function tagProfile(game: Game): string {
  const line = (label: string, facet: string) => {
    const names = game.tags.filter((tag) => facetOf.get(tag.name) === facet).map((tag) => tag.name);
    return names.length > 0 ? `${label}: ${names.join(", ")}` : null;
  };
  return [line("Genres", "genre"), line("Viewpoint", "viewpoint"), line("Mechanics and structure", "mechanics")].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Embeddings (same model and size as production), cached on disk.
// ---------------------------------------------------------------------------
const cachePath = join(dir, "vectors.cache.json");
const cache: Record<string, number[]> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
let embeddingRequests = 0;
let embeddingTokens = 0;

async function embed(text: string): Promise<number[]> {
  if (cache[text]) return cache[text]!;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ model: "models/gemini-embedding-2", content: { parts: [{ text }] }, embedContentConfig: { outputDimensionality: 3072 } }),
  });
  const body = await response.json() as { embedding?: { values: number[] }; usageMetadata?: { promptTokenCount?: number }; error?: { message: string } };
  if (!response.ok || !body.embedding) throw new Error(`Gemini ${response.status}: ${body.error?.message}`);
  embeddingRequests += 1;
  embeddingTokens += body.usageMetadata?.promptTokenCount ?? 0;
  cache[text] = body.embedding.values;
  writeFileSync(cachePath, JSON.stringify(cache));
  return cache[text]!;
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------
type Variant = { id: string; label: string; note: string; defaultBar: number; scores: Record<string, number | null>; shared?: Record<string, string[]> };
const games = pool.games;
const pairKey = (a: Game, b: Game) => [a.appid, b.appid].sort((x, y) => x - y).join("-");
const pairs: Array<[Game, Game]> = [];
for (let i = 0; i < games.length; i += 1) for (let j = i + 1; j < games.length; j += 1) pairs.push([games[i]!, games[j]!]);

const variants: Variant[] = [];

variants.push({
  id: "live",
  label: "Live today",
  note: "Production scores: embedding of the coverage sentences. Reference games use the scores from the 2026-11-25 fixed ranking evaluation; pairs with no recorded score are blank.",
  defaultBar: 0.75,
  scores: Object.fromEntries(pairs.map(([a, b]) => [pairKey(a, b), pool.live[pairKey(a, b)]?.gameplay ?? null])),
});

for (const useRarity of [false, true]) {
  const vectors = new Map(games.map((game) => [game.appid, tagVector(game, GAMEPLAY_FACETS, pool.catalogGames, useRarity)]));
  variants.push({
    id: useRarity ? "tags-rarity" : "tags-plain",
    label: useRarity ? "Steam tags, rarity-weighted" : "Steam tags, vote share only",
    note: useRarity
      ? "Overlap of genre, viewpoint and mechanics tags. Each tag counts by its share of the game's votes and by how rare it is across Steam, so 'Roguelike' outweighs 'Action'. No provider cost."
      : "Overlap of genre, viewpoint and mechanics tags, each counted by its share of the game's votes. No provider cost.",
    defaultBar: useRarity ? 0.3 : 0.45,
    scores: Object.fromEntries(pairs.map(([a, b]) => [pairKey(a, b), sparseCosine(vectors.get(a.appid)!, vectors.get(b.appid)!)])),
    shared: Object.fromEntries(pairs.map(([a, b]) => [pairKey(a, b), sharedTags(vectors.get(a.appid)!, vectors.get(b.appid)!)])),
  });
}

// A game without published coverage gets no score in the variants that read coverage.
const textVariants: Array<{ id: string; label: string; note: string; defaultBar: number; text: (game: Game) => string | null }> = [
  { id: "embed-coverage", label: "Embedding: public coverage text", note: "Stand-in for today's approach, using the published Overview text because the production inputs are private.", defaultBar: 0.75, text: (game) => game.coverage || null },
  { id: "embed-tags", label: "Embedding: tag profile", note: "Embedding of a three-line profile built only from the game's genre, viewpoint and mechanics tags.", defaultBar: 0.8, text: tagProfile },
  { id: "embed-both", label: "Embedding: tag profile + coverage", note: "The tag profile followed by the published Overview text, as a stand-in for a tag-grounded synthesis.", defaultBar: 0.78, text: (game) => game.coverage ? `${tagProfile(game)}\n${game.coverage}` : null },
];
for (const variant of textVariants) {
  const vectors = new Map<number, number[]>();
  for (const game of games) {
    const text = variant.text(game);
    if (text) vectors.set(game.appid, await embed(text));
  }
  variants.push({
    id: variant.id, label: variant.label, note: variant.note, defaultBar: variant.defaultBar,
    scores: Object.fromEntries(pairs.map(([a, b]) => {
      const left = vectors.get(a.appid), right = vectors.get(b.appid);
      return [pairKey(a, b), left && right ? denseCosine(left, right) : null];
    })),
  });
}

// ---------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------
for (const variant of variants) {
  console.log(`\n## ${variant.label}`);
  console.log(["".padEnd(10), ...games.map((game) => game.short.padStart(9))].join(""));
  for (const row of games) {
    console.log([row.short.padEnd(10), ...games.map((column) => {
      if (row === column) return "—".padStart(9);
      const score = variant.scores[pairKey(row, column)];
      return (score === null || score === undefined ? "?" : score.toFixed(3)).padStart(9);
    })].join(""));
  }
}
console.log("\n## Tag profiles");
for (const game of games) console.log(`\n${game.name}\n${tagProfile(game)}`);
console.log(`\nEmbedding requests sent this run: ${embeddingRequests} (${embeddingTokens} input tokens)`);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const data = {
  games: games.map((game) => ({ appid: game.appid, name: game.name, short: game.short, inPool: game.inPool, profile: tagProfile(game) })),
  variants,
};
const template = readFileSync(join(dir, "report.template.html"), "utf8");
writeFileSync(join(dir, "report.html"), template.replace("/*DATA*/null", JSON.stringify(data)));
console.log(`Wrote ${join(dir, "report.html")}`);

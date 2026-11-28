import { STEAM_GAMEPLAY_TAGS, STEAM_GAMES_TOTAL, type GameplayTag } from "./steam-gameplay-tags";

/**
 * Gameplay & systems matches compare the overlap of two games' Steam community
 * tags that describe genre, viewpoint or mechanics (ADR 0023). Pure functions
 * over plain data, so the scoring can be tested without a database.
 */

/** A candidate is listed when its gameplay tag score is at least this bar. Chosen on seven games. */
export const GAMEPLAY_MATCH_BAR = 0.3;
/** A gameplay match names at most this many tags that both games share. */
export const GAMEPLAY_SHARED_TAG_LIMIT = 3;

/** One `community_tag` Catalog Facet membership of a game. */
export interface CommunityTagMembership {
  /** Steam tag ID: the membership's `source_id`. */
  sourceId: string;
  /** Recorded vote count, or null when Steam returned none. */
  weight: number | null;
}

/** A game's weighted gameplay tags, keyed by Steam tag ID. Only positive values are kept. */
export type GameplayTagVector = ReadonlyMap<string, number>;

export interface GameplayTagTable {
  tags: Readonly<Record<string, GameplayTag>>;
  totalGames: number;
}

const DEFAULT_TABLE: GameplayTagTable = { tags: STEAM_GAMEPLAY_TAGS, totalGames: STEAM_GAMES_TOTAL };

function positiveWeight(weight: number | null): weight is number {
  return typeof weight === "number" && Number.isFinite(weight) && weight > 0;
}

/**
 * Weighs each gameplay tag by `(votes ÷ the game's highest community tag vote count)
 * × ln(total games ÷ games with the tag)`. Every community tag sets the top vote count;
 * only tags in the gameplay table are kept, and a membership with no vote count is ignored.
 */
export function gameplayTagVector(
  memberships: readonly CommunityTagMembership[],
  table: GameplayTagTable = DEFAULT_TABLE,
): Map<string, number> {
  let top = 0;
  for (const membership of memberships) {
    if (positiveWeight(membership.weight) && membership.weight > top) top = membership.weight;
  }
  const vector = new Map<string, number>();
  if (top <= 0) return vector;
  for (const membership of memberships) {
    if (!positiveWeight(membership.weight)) continue;
    if (!Object.prototype.hasOwnProperty.call(table.tags, membership.sourceId)) continue;
    const tag = table.tags[membership.sourceId]!;
    if (!(tag.steamGames > 0)) continue;
    const value = (membership.weight / top) * Math.log(table.totalGames / tag.steamGames);
    if (Number.isFinite(value) && value > 0) vector.set(membership.sourceId, value);
  }
  return vector;
}

/** The cosine of two weighted gameplay tag sets; 0 when either has no weighted gameplay tag. */
export function gameplayTagScore(left: GameplayTagVector, right: GameplayTagVector): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (const [id, value] of left) {
    leftMagnitude += value * value;
    const other = right.get(id);
    if (other !== undefined) dot += value * other;
  }
  for (const value of right.values()) rightMagnitude += value * value;
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  const score = dot / Math.sqrt(leftMagnitude * rightMagnitude);
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
}

/** Whether a gameplay score is high enough for the candidate to be listed. */
export function meetsGameplayMatchBar(score: number): boolean {
  return score >= GAMEPLAY_MATCH_BAR;
}

/**
 * Labels for the tags both games have, strongest contribution (the product of the two
 * values) first, ties by tag ID. A shared tag with no dictionary name still counts in the
 * score but gets no label; the limit applies to the labelled tags.
 */
export function sharedGameplayTagLabels(
  left: GameplayTagVector,
  right: GameplayTagVector,
  nameOf: (sourceId: string) => string | null | undefined,
): string[] {
  const shared: Array<{ id: string; contribution: number }> = [];
  for (const [id, value] of left) {
    const other = right.get(id);
    if (other !== undefined) shared.push({ id, contribution: value * other });
  }
  shared.sort((a, b) => b.contribution - a.contribution || compareTagIds(a.id, b.id));
  const labels: string[] = [];
  for (const { id } of shared) {
    if (labels.length >= GAMEPLAY_SHARED_TAG_LIMIT) break;
    const name = nameOf(id)?.trim();
    if (name) labels.push(name);
  }
  return labels;
}

function compareTagIds(left: string, right: string): number {
  return Number(left) - Number(right) || (left < right ? -1 : left > right ? 1 : 0);
}

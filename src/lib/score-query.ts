import { keepPreviousData } from "@tanstack/react-query";
import type { GameScoreHistory, GameScoreSummary } from "./score";
import type { HistoryRange } from "./player-history";
export const SCORE_STALE_TIME = 5 * 60 * 1000;

type ScoreResponse<T> = {
  status?: "data" | "empty" | "error";
  data?: T | null;
  source_timestamp?: string | null;
};

async function readScoreResponse<T>(response: Response, message: string): Promise<T | null> {
  if (!response.ok) {
    throw new Error(`${message}: ${response.status}`);
  }
  const payload = (await response.json()) as ScoreResponse<T>;
  if (payload.status === "error") {
    throw new Error(message);
  }
  return payload.data ?? null;
}

export async function fetchGameScoreSummary(
  appid: number,
  customFetch?: typeof fetch,
): Promise<GameScoreSummary | null> {
  const fetchFn = customFetch ?? fetch;
  const response = await fetchFn(`/api/games/${appid}/score`);
  return readScoreResponse(response, `Failed to load game score for ${appid}`);
}

export async function fetchGameScoreHistory(
  appid: number,
  range: HistoryRange,
  customFetch?: typeof fetch,
): Promise<GameScoreHistory | null> {
  const fetchFn = customFetch ?? fetch;
  const response = await fetchFn(`/api/games/${appid}/score?view=history&range=${range}`);
  return readScoreResponse(response, `Failed to load game score history for ${appid}`);
}

export function gameScoreSummaryQueryOptions(
  appid: number,
  options?: { customFetch?: typeof fetch },
) {
  return {
    queryKey: ["game-score", appid] as const,
    queryFn: () => fetchGameScoreSummary(appid, options?.customFetch),
    staleTime: SCORE_STALE_TIME,
  };
}

export function gameScoreHistoryQueryOptions(
  appid: number,
  range: HistoryRange,
  options?: { customFetch?: typeof fetch },
) {
  return {
    queryKey: ["game-score-history", appid, range] as const,
    queryFn: () => fetchGameScoreHistory(appid, range, options?.customFetch),
    placeholderData: keepPreviousData,
    staleTime: SCORE_STALE_TIME,
  };
}

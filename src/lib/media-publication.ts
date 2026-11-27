export const MEDIA_EXPERIMENT_GAMES = [
  { choice: "cyberpunk-2077", appid: 1091500, name: "Cyberpunk 2077", aliases: ["cyberpunk 2077"] },
  { choice: "baldurs-gate-3", appid: 1086940, name: "Baldur's Gate 3", aliases: ["baldur's gate 3", "baldurs gate 3"] },
  { choice: "hades-ii", appid: 1145350, name: "Hades II", aliases: ["hades ii", "hades 2"] },
] as const;

export type MediaGameChoice = (typeof MEDIA_EXPERIMENT_GAMES)[number]["choice"];

export const MEDIA_GAME_CHOICES = Object.fromEntries(
  MEDIA_EXPERIMENT_GAMES.map(({ choice, appid }) => [choice, appid]),
) as Record<MediaGameChoice, number>;

export function isMediaOverviewPublic(): boolean {
  return typeof process !== "undefined" && process.env?.MEDIA_OVERVIEW_PUBLIC === "true";
}

// Publication is an editorial decision independent of experiment enrollment or watch state.
const publishedRootAppids = [1091500, 1086940, 1145350, 2161710, 3714800] as const;
export const PUBLIC_MEDIA_ROOT_SQL = `(
  app.appid IN (${publishedRootAppids.join(", ")})
  AND app.type = 'game'
  AND app.is_playable = 1
  AND app.parent_appid IS NULL
)`;

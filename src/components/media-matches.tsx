import type { MediaGameMatch, MediaMatchDimension } from "../lib/media-similarity";
import { AppLink } from "./app-link";

const DIMENSIONS = [
  { id: "gameplay", label: "Gameplay & systems" },
  { id: "story_world", label: "Story & world" },
] as const satisfies readonly { id: MediaMatchDimension; label: string }[];

function matchGroups(matches: readonly MediaGameMatch[]) {
  const groups = DIMENSIONS.map(({ id, label }) => ({
    id,
    label,
    matches: matches.filter((match) => match.dimension === id),
  }));
  const [gameplay, story] = groups;
  if (
    gameplay.matches.length > 0 &&
    gameplay.matches.length === story.matches.length &&
    gameplay.matches.every((match, index) => match.matchedGame.appid === story.matches[index]?.matchedGame.appid)
  ) {
    return [{
      id: "both",
      label: `${gameplay.label} and ${story.label}`,
      matches: gameplay.matches,
    }];
  }
  return groups.filter((group) => group.matches.length > 0);
}

function MatchIcon({ appid, name }: MediaGameMatch["matchedGame"]) {
  return (
    <span
      aria-hidden="true"
      className="relative grid size-[22px] shrink-0 place-items-center overflow-hidden rounded-sm bg-zinc-800 text-[10px] font-semibold text-zinc-400"
    >
      {Array.from(name.trim())[0]?.toUpperCase() || "?"}
      <img
        src={`https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/capsule_184x69.jpg`}
        className="absolute inset-0 size-full object-cover"
        alt=""
        width={22}
        height={22}
        loading="lazy"
        onError={(event) => { event.currentTarget.hidden = true; }}
      />
    </span>
  );
}

function MatchLink({ match, paths }: { match: MediaGameMatch; paths: Readonly<Record<number, string>> }) {
  const game = match.matchedGame;
  const path = paths[game.appid];
  const className = "inline-flex min-w-0 max-w-full items-center gap-1.5 text-[13px] text-zinc-200";
  const content = (
    <>
      <MatchIcon {...game} />
      <span className="min-w-0 wrap-anywhere">{game.name}</span>
    </>
  );
  return (
    <li className="min-w-0 max-w-full">
      {path ? (
        <AppLink
          href={path}
          className={`${className} rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500`}
        >
          {content}
        </AppLink>
      ) : (
        <span className={className}>{content}</span>
      )}
    </li>
  );
}

export function MediaMatchesSection({
  matches,
  paths = {},
}: {
  matches: MediaGameMatch[];
  paths?: Readonly<Record<number, string>>;
}) {
  const groups = matchGroups(matches);
  if (groups.length === 0) return null;

  return (
    <section id="media-matches" aria-labelledby="media-matches-title" className="min-w-0 space-y-2 font-sans">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="media-matches-title" className="text-base font-semibold text-zinc-100">
          Similar Games
        </h2>
        <AppLink
          href="/methodology"
          className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        >
          How this works
        </AppLink>
      </div>
      {groups.map(({ id, label, matches: groupMatches }) => (
        <section key={id} aria-labelledby={`media-matches-${id}`} className="min-w-0 space-y-1">
          <h3 id={`media-matches-${id}`} className="text-xs text-zinc-400">{label}</h3>
          <ul className="flex min-w-0 flex-wrap gap-x-4 gap-y-2">
            {groupMatches.map((match) => (
              <MatchLink key={match.matchedGame.appid} match={match} paths={paths} />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}


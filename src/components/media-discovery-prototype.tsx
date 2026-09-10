import React, { useEffect, useMemo, useState } from "react";

// Three source-forward media discovery layouts on the existing game route,
// switchable with ?variant=A|B|C for the disposable prototype exercise.
export type MediaVariant = "A" | "B" | "C";
export type MediaScenario = "one-source" | "announced" | "richer" | "cited-similarity";

export const MEDIA_VARIANTS: readonly MediaVariant[] = ["A", "B", "C"];
export const MEDIA_SCENARIOS: readonly MediaScenario[] = [
  "one-source",
  "announced",
  "richer",
  "cited-similarity",
];

export function parseMediaVariant(value: unknown): MediaVariant | undefined {
  return value === "A" || value === "B" || value === "C" ? value : undefined;
}

export function parseMediaScenario(value: unknown): MediaScenario | undefined {
  return value === "one-source" || value === "announced" || value === "richer" || value === "cited-similarity"
    ? value
    : undefined;
}

type MediaArticle = {
  id: string;
  outlet: string;
  title: string;
  publishedAt: string;
  type: "Preview" | "Review" | "Announcement" | "Comparison";
  handsOn: "Hands-on" | "Not hands-on";
  platform: string;
  build: string;
  gameLabel: string;
  tags: string[];
};

type Evidence = {
  id: string;
  text: string;
  articles: string[];
  tags: string[];
  tone: "positive" | "negative" | "mixed" | "observation";
  opposing?: { text: string; articles: string[] };
  context?: string;
  disputed?: boolean;
};

type MediaCategory = {
  key: string;
  label: string;
  summary: string;
  evidence: Evidence[];
};

type SimilarityTrait = {
  dimension: "Gameplay & systems" | "Story & world";
  label: string;
  text: string;
  articles: string[];
};

type MediaFixture = {
  label: string;
  description: string;
  articles: MediaArticle[];
  categories: MediaCategory[];
  pros: Evidence[];
  cons: Evidence[];
  similarity?: {
    generated: SimilarityTrait[];
    outletExplicit: SimilarityTrait[];
  };
};

const categoryNames = [
  "Gameplay & systems",
  "Story & world",
  "Visuals & audio",
  "Social play",
  "Technical experience & accessibility",
];

function article(
  gameLabel: string,
  id: string,
  outlet: string,
  title: string,
  type: MediaArticle["type"],
  handsOn: MediaArticle["handsOn"],
  platform: string,
  build: string,
  tags: string[],
): MediaArticle {
  return { id, outlet, title, type, handsOn, platform, build, gameLabel, tags, publishedAt: type === "Preview" ? "2026-08-12" : type === "Announcement" ? "2026-08-05" : "2026-08-20" };
}

function createFixture(gameName: string, scenario: MediaScenario): MediaFixture {
  const current = gameName + " (example game)";
  const comparison = "Example comparison title (sample only)";
  const one = article(
    current,
    "sample-alpha-brief",
    "Sample outlet Alpha",
    "Sample field brief — example fixture",
    "Preview",
    "Hands-on",
    "PC",
    "Pre-release sample build",
    ["Action Platformer", "Sci-Fi", "Stylized Animation"],
  );

  if (scenario === "one-source") {
    return {
      label: "One source",
      description: "A narrow starting point: one clearly marked sample source, with only the facets it describes.",
      articles: [one],
      categories: [
        {
          key: categoryNames[0],
          label: categoryNames[0],
          summary: "A single hands-on note sketches the central loop.",
          evidence: [
            {
              id: "one-loop",
              text: "The first hands-on brief describes short expeditions that return to a persistent hub. This establishes the shape of the central loop, but the account is too early to judge how its progression holds up across the whole game.",
              articles: [one.id],
              tags: ["Action Platformer", "Expedition Loop", "Roguelite"],
              tone: "observation",
            },
          ],
        },
        {
          key: categoryNames[1],
          label: categoryNames[1],
          summary: "Only one world-building observation is supported in this fixture.",
          evidence: [
            {
              id: "one-world",
              text: "Environmental clues suggest a layered setting that rewards attention to the places being explored. The preview finds that sense of place promising, while leaving the full narrative and its eventual payoff unassessed.",
              articles: [one.id],
              tags: ["Sci-Fi", "Surreal Mystery", "Environmental Storytelling"],
              tone: "positive",
            },
          ],
        },
        {
          key: categoryNames[2],
          label: categoryNames[2],
          summary: "A visual direction is noted; no audio judgment is inferred.",
          evidence: [
            {
              id: "one-visuals",
              text: "High-contrast silhouettes stand out as a practical visual cue in the hands-on session. That is an observation about readability during play, not yet a verdict on the complete art direction, audio, or range of access options.",
              articles: [one.id],
              tags: ["Stylized Animation", "High-Contrast Visuals"],
              tone: "observation",
            },
          ],
        },
      ],
      pros: [],
      cons: [],
    };
  }

  const announcement = article(
    current,
    "sample-announcement-note",
    "Sample outlet Alpha",
    "Sample announcement note — example fixture",
    "Announcement",
    "Not hands-on",
    "Not specified",
    "Announced",
    ["Sci-Fi", "Surreal Mystery", "Psychological Thriller"],
  );

  if (scenario === "announced") {
    return {
      label: "Announced / non-hands-on",
      description: "Unsupported gameplay, systems, and pros stay out until a hands-on source exists.",
      articles: [announcement],
      categories: [
        {
          key: categoryNames[1],
          label: categoryNames[1],
          summary: "The announcement supports premise and setting only.",
          evidence: [
            {
              id: "announced-world",
              text: "The announcement introduces a layered setting intended to unfold through exploration and environmental clues. Those are announced characteristics, not observations from play. The available coverage gives a sense of the premise without establishing how convincingly the world or narrative will deliver on it.",
              articles: [announcement.id],
              tags: ["Sci-Fi", "Surreal Mystery", "Psychological Thriller"],
              tone: "observation",
            },
          ],
        },
      ],
      pros: [],
      cons: [],
    };
  }

  const preview = article(
    current,
    "sample-alpha-preview",
    "Sample outlet Alpha",
    "Sample hands-on preview — example fixture",
    "Preview",
    "Hands-on",
    "PC",
    "Prepatch sample build",
    ["Action Platformer", "Expedition Loop", "Roguelite"],
  );
  const secondPreview = article(
    current,
    "sample-alpha-world",
    "Sample outlet Alpha",
    "Sample world notes — example fixture",
    "Preview",
    "Hands-on",
    "PC",
    "Prepatch sample build",
    ["Sci-Fi", "Environmental Storytelling", "Revisited Spaces"],
  );
  const review = article(
    current,
    "sample-beta-review",
    "Sample outlet Beta",
    "Sample review notes — example fixture",
    "Review",
    "Hands-on",
    "PC",
    "Launch sample build",
    ["Roguelite", "Satirical Narrative", "Frame-rate Sensitive"],
  );
  const platformNote = article(
    current,
    "sample-gamma-platform",
    "Sample outlet Gamma",
    "Sample platform notes — example fixture",
    "Preview",
    "Hands-on",
    "Console",
    "Launch sample build",
    ["3D Platforming", "Asymmetric Co-op", "Class-based Roles"],
  );
  const audioNote = article(
    current,
    "sample-delta-audio",
    "Sample outlet Delta",
    "Sample audio and access notes — example fixture",
    "Review",
    "Hands-on",
    "PC",
    "Launch sample build",
    ["Stylized Animation", "Directional Audio", "Remappable Controls"],
  );

  const richerArticles = [preview, secondPreview, review, platformNote, audioNote];
  const richerCategories: MediaCategory[] = [
    {
      key: categoryNames[0],
      label: categoryNames[0],
      summary: "Repeated loop observations appear before isolated reactions.",
      evidence: [
        {
          id: "rich-loop",
          text: "Expeditions revolve around the tension between pushing for another reward and returning safely to a persistent hub. The preview and review both find that rhythm approachable: the immediate objective is clear, while the decision to stay out gives each run a sense of risk.",
          articles: [preview.id, review.id],
          tags: ["Action Platformer", "Expedition Loop", "Roguelite"],
          tone: "positive",
        },
        {
          id: "rich-traversal",
          text: "Traversal is a point of disagreement rather than a shared strength. The preview finds its deliberate pace gives exploration room to breathe.",
          articles: [preview.id],
          tags: ["3D Platforming", "Traversal"],
          tone: "mixed",
          disputed: true,
          opposing: {
            text: "The console account instead describes stop-start movement during combat transitions, where that same pace can interrupt the flow.",
            articles: [platformNote.id],
          },
        },
      ],
    },
    {
      key: categoryNames[1],
      label: categoryNames[1],
      summary: "World observations are kept separate from the gameplay loop.",
      evidence: [
        {
          id: "rich-world",
          text: "The world reveals itself through environmental clues rather than relying entirely on exposition. Both accounts describe familiar spaces taking on new significance when revisited, making discovery part of the appeal rather than simply a route to the next objective.",
          articles: [secondPreview.id, review.id],
          tags: ["Sci-Fi", "Environmental Storytelling", "Revisited Spaces"],
          tone: "positive",
        },
        {
          id: "rich-characters",
          text: "The review also finds the central cast’s motives easy to follow. That clarity gives the main arc a useful anchor even as the setting asks the player to piece together its wider history.",
          articles: [review.id],
          tags: ["Satirical Narrative", "Character-driven"],
          tone: "observation",
        },
      ],
    },
    {
      key: categoryNames[2],
      label: categoryNames[2],
      summary: "Presentation notes cover both readability and sound design.",
      evidence: [
        {
          id: "rich-visuals",
          text: "In the prepatch build, strong silhouettes help characters remain distinct in crowded scenes. The coverage treats this as more than an attractive style: readable shapes make busy encounters easier to follow.",
          articles: [secondPreview.id, audioNote.id],
          tags: ["Stylized Animation", "High-Contrast Visuals"],
          tone: "positive",
          context: "Prepatch / early-access context",
        },
        {
          id: "rich-audio",
          text: "The audio account describes directional cues that remain distinguishable in a stereo mix, complementing the visual clarity without overwhelming it.",
          articles: [audioNote.id],
          tags: ["Directional Audio", "Stereo Soundscape"],
          tone: "observation",
        },
      ],
    },
    {
      key: categoryNames[3],
      label: categoryNames[3],
      summary: "Social observations remain distinct from solo-system notes.",
      evidence: [
        {
          id: "rich-social",
          text: "The console preview describes cooperation through distinct roles and shared resource decisions. What one player spends or saves is visible to the group, giving teammates a concrete reason to coordinate rather than simply occupy the same space. This is one account of co-op play, not evidence that every platform or mode offers the same experience.",
          articles: [platformNote.id],
          tags: ["Asymmetric Co-op", "Class-based Roles"],
          tone: "observation",
        },
      ],
    },
    {
      key: categoryNames[4],
      label: categoryNames[4],
      summary: "Performance and access notes are attributed rather than averaged into a score.",
      evidence: [
        {
          id: "rich-performance",
          text: "Launch coverage raises a consistent reservation about frame-time spikes when several effects overlap. These reports qualify the otherwise favorable impression of busy encounters, but they describe the builds tested rather than establishing the state of every later update.",
          articles: [review.id, audioNote.id],
          tags: ["Frame-rate Sensitive", "Particle Effects"],
          tone: "negative",
        },
        {
          id: "rich-access",
          text: "The access notes are more encouraging, highlighting remappable controls and readable subtitles. Those specific options are useful evidence, not a comprehensive accessibility assessment.",
          articles: [audioNote.id],
          tags: ["Remappable Controls", "Subtitles & Captions"],
          tone: "positive",
        },
      ],
    },
  ];

  const similarityArticles = [
    ...richerArticles,
    article(
      comparison,
      "sample-comparison-loop",
      "Sample outlet Gamma",
      "Sample comparison loop note — example fixture",
      "Comparison",
      "Hands-on",
      "PC",
      "Launch sample build",
      ["Roguelite", "Expedition Loop"],
    ),
    article(
      comparison,
      "sample-comparison-world",
      "Sample outlet Delta",
      "Sample comparison world note — example fixture",
      "Comparison",
      "Hands-on",
      "PC",
      "Launch sample build",
      ["Sci-Fi", "Environmental Storytelling"],
    ),
  ];

  return {
    label: scenario === "cited-similarity" ? "Cited similarity" : "Richer opposing evidence",
    description:
      scenario === "cited-similarity"
        ? "Shared traits are separated into generated suggestions and outlet-explicit comparisons, with citations for both example games."
        : "Repeated findings, independent observations, and disagreement remain visible without a quality ranking.",
    articles: scenario === "cited-similarity" ? similarityArticles : richerArticles,
    categories: richerCategories,
    pros: [
      {
        id: "rapid-loop",
        text: "The expedition loop balances immediate reward with safe returns to the hub.",
        articles: [preview.id, review.id],
        tags: ["Expedition Loop", "Action Platformer"],
        tone: "positive",
      },
      {
        id: "rapid-readability",
        text: "Strong silhouettes keep characters readable during crowded encounters.",
        articles: [secondPreview.id, audioNote.id],
        tags: ["High-Contrast Visuals", "Stylized Animation"],
        tone: "positive",
      },
    ],
    cons: [
      {
        id: "rapid-performance",
        text: "Frame-time spikes appear when several visual effects overlap.",
        articles: [review.id, audioNote.id],
        tags: ["Frame-rate Sensitive"],
        tone: "negative",
      },
    ],
    similarity:
      scenario === "cited-similarity"
        ? {
            generated: [
              {
                label: "Shared expedition loop",
                dimension: "Gameplay & systems",
                text: "Generated suggestion: both example games appear to pair risk-taking runs with a persistent return point.",
                articles: [preview.id, "sample-comparison-loop"],
              },
              {
                label: "Environmental discovery",
                dimension: "Story & world",
                text: "Generated suggestion: both example games use revisited spaces to surface world detail.",
                articles: [secondPreview.id, "sample-comparison-world"],
              },
            ],
            outletExplicit: [
              {
                label: "Sample comparison wording",
                dimension: "Gameplay & systems",
                text: "An example comparison note explicitly places the two sample games beside one another around expedition pacing.",
                articles: [platformNote.id, "sample-comparison-loop"],
              },
              {
                label: "Sample world comparison",
                dimension: "Story & world",
                text: "A separate example comparison note explicitly links their environmental storytelling approaches.",
                articles: [audioNote.id, "sample-comparison-world"],
              },
            ],
          }
        : undefined,
  };
}

function articleById(articles: MediaArticle[], id: string) {
  return articles.find((item) => item.id === id);
}

function evidenceSourceIds(evidence: Evidence) {
  return evidence.opposing ? [...evidence.articles, ...evidence.opposing.articles] : evidence.articles;
}

function sortEvidenceByOutlets(fixture: MediaFixture, evidence: Evidence[]) {
  return [...evidence].sort(
    (left, right) =>
      distinctOutlets(fixture.articles, evidenceSourceIds(right)) -
      distinctOutlets(fixture.articles, evidenceSourceIds(left)),
  );
}
function distinctOutlets(articles: MediaArticle[], ids: string[]) {
  return new Set(ids.map((id) => articleById(articles, id)?.outlet).filter(Boolean)).size;
}

function ArticleLinks({ articles, ids }: { articles: MediaArticle[]; ids: string[] }) {
  return (
    <span className="inline-flex gap-1 align-baseline font-mono text-[11px] select-none">
      {[...new Set(ids)].map((id) => {
        const index = articles.findIndex((item) => item.id === id);
        const source = articles[index];
        if (!source) return null;
        const description = `${source.outlet} · ${source.title} · ${source.publishedAt}`;
        return (
          <a
            key={id}
            href={`#media-sample-article-${source.id}`}
            title={description}
            aria-label={`Source ${index + 1}: ${description}`}
            className="text-violet-300/80 hover:text-violet-100 hover:underline underline-offset-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-violet-300"
          >
            [{index + 1}]
          </a>
        );
      })}
    </span>
  );
}

function getGameSummary(scenario: MediaScenario) {
  if (scenario === "announced") {
    return {
      tagline: "Overview",
      title: "Surreal world exploration and psychological themes",
      text: "An imaginative narrative adventure set in an eccentric world explored through environmental discovery and puzzle-solving. Early announcements outline a distinctive stylized art direction and psychological themes, though playable combat balance and performance remain to be verified in upcoming hands-on builds.",
    };
  }
  if (scenario === "one-source") {
    return {
      tagline: "Overview",
      title: "Risk-reward expedition loop with distinct visual style",
      text: "A fast-paced platformer blending short expeditions with a persistent home base, emphasizing readable silhouettes and layered environmental storytelling. Initial impressions highlight the approachable risk-reward loop of each run, while noting that wider mission variety and progression depth will need verification in final builds.",
    };
  }
  return {
    tagline: "Overview",
    title: "Inventive mental worlds, sharp writing, and an engaging hub loop",
    text: "A story-driven action platformer built around imaginative expeditions, sharp environmental storytelling, and expressive visual direction. Outlets praise its approachable risk-reward hub loop and creative spaces, while noting debate over traversal momentum and occasional frame drops during busy effect-heavy encounters.",
  };
}

function TopSummary({
  scenario,
  articles,
  allTags,
  activeTag,
  onTag,
}: {
  scenario: MediaScenario;
  articles: MediaArticle[];
  allTags: string[];
  activeTag: string | null;
  onTag: (tag: string | null) => void;
}) {
  const summary = getGameSummary(scenario);
  const sourceIds = articles
    .filter((source) => source.gameLabel === articles[0]?.gameLabel)
    .map((source) => source.id);

  return (
    <header className="border border-zinc-800 bg-zinc-950/70 p-5 sm:p-6">
      <p className="mb-2 font-mono text-xs uppercase tracking-wider text-violet-300">
        {summary.tagline}
      </p>
      <h2 className="mb-3 text-xl font-semibold text-zinc-100">{summary.title}</h2>
      <p className="w-full text-sm leading-7 text-zinc-200">
        {summary.text} <ArticleLinks articles={articles} ids={sourceIds} />
      </p>
      {allTags.length > 0 && (
        <div className="mt-5 border-t border-zinc-800/80 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                aria-pressed={activeTag === tag}
                onClick={() => onTag(activeTag === tag ? null : tag)}
                className={`border px-2 py-0.5 font-mono text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-300 ${
                  activeTag === tag
                    ? "border-violet-300 bg-violet-300 text-zinc-950 font-semibold shadow-sm"
                    : "border-violet-400/40 bg-violet-400/10 text-violet-200 hover:border-violet-300 hover:bg-violet-400/20 hover:text-white"
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}

function renderEvidenceParagraphs(findings: Evidence[], articles: MediaArticle[]) {
  return (
    <div className="space-y-3">
      {findings.map((evidence) => {
        if (evidence.disputed && evidence.opposing) {
          return (
            <div key={evidence.id} className="space-y-1 text-sm leading-relaxed text-zinc-200">
              <p>
                <mark className="border-b border-amber-500/40 bg-amber-500/[0.05] px-1 py-0.5 font-normal text-zinc-200">
                  {evidence.text}
                </mark>{" "}
                <ArticleLinks articles={articles} ids={evidence.articles} />
              </p>
              <p>
                <mark className="border-b border-amber-500/40 bg-amber-500/[0.05] px-1 py-0.5 font-normal text-zinc-200">
                  {evidence.opposing.text}
                </mark>{" "}
                <ArticleLinks articles={articles} ids={evidence.opposing.articles} />
              </p>
            </div>
          );
        }
        return (
          <p key={evidence.id} className="text-sm leading-relaxed text-zinc-200">
            {evidence.text}{" "}
            {evidence.opposing ? `${evidence.opposing.text} ` : ""}
            <ArticleLinks articles={articles} ids={evidenceSourceIds(evidence)} />
          </p>
        );
      })}
    </div>
  );
}

function ContestedBadge({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono text-[10px] tracking-wide transition-colors ${
        active
          ? "border-amber-400/70 bg-amber-400/20 text-amber-200 font-semibold"
          : "border-amber-500/25 bg-amber-500/[0.04] text-amber-300/70 hover:border-amber-500/40 hover:text-amber-200"
      }`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-amber-400/60" />
      Contested
    </button>
  );
}

function EvidenceBullet({
  evidence,
  fixture,
}: {
  evidence: Evidence;
  fixture: MediaFixture;
}) {
  return (
    <li
      className={`border-l-2 pl-3 ${
        evidence.tone === "negative"
          ? "border-red-400/70"
          : evidence.tone === "positive"
            ? "border-emerald-400/70"
            : "border-zinc-700"
      }`}
    >
      <div className="text-xs leading-relaxed text-zinc-200">
        {evidence.text}{" "}
        <ArticleLinks articles={fixture.articles} ids={evidence.articles} />
      </div>
    </li>
  );
}

function RapidFire({ fixture }: { fixture: MediaFixture }) {
  const pros = sortEvidenceByOutlets(fixture, fixture.pros);
  const cons = sortEvidenceByOutlets(fixture, fixture.cons);
  if (pros.length === 0 && cons.length === 0) {
    return (
      <p className="border border-dashed border-zinc-800 p-4 text-xs leading-relaxed text-zinc-400">
        Highlights and reservations will appear as hands-on reviews are cataloged.
      </p>
    );
  }
  return (
    <section className="border border-zinc-800 bg-zinc-950/70 p-5 sm:p-6">
      <div className="mb-4 border-b border-zinc-800 pb-3">
        <h3 className="font-mono text-xs uppercase tracking-wider text-zinc-200">Key takeaways</h3>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <h4 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wider text-emerald-300">Pros</h4>
          <ul className="space-y-3">{pros.map((item) => <EvidenceBullet key={item.id} evidence={item} fixture={fixture} />)}</ul>
        </div>
        <div>
          <h4 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wider text-red-300">Cons</h4>
          <ul className="space-y-3">{cons.map((item) => <EvidenceBullet key={item.id} evidence={item} fixture={fixture} />)}</ul>
        </div>
      </div>
    </section>
  );
}

function filteredFixture(fixture: MediaFixture, activeTag: string | null): MediaFixture {
  if (!activeTag) return fixture;
  const keep = (evidence: Evidence) =>
    activeTag === "disputed" ? !!evidence.disputed : evidence.tags.includes(activeTag);
  return {
    ...fixture,
    categories: fixture.categories
      .map((category) => ({ ...category, evidence: category.evidence.filter(keep) }))
      .filter((category) => category.evidence.length > 0),
    pros: fixture.pros.filter(keep),
    cons: fixture.cons.filter(keep),
  };
}

function SourceRail({ fixture, activeTag, onTag }: { fixture: MediaFixture; activeTag: string | null; onTag: (tag: string | null) => void }) {
  const references = new Map<string, { articleCount: number; references: number; articles: MediaArticle[] }>();
  const allEvidence = fixture.categories.flatMap((category) => category.evidence).concat(fixture.pros, fixture.cons);
  for (const evidence of allEvidence) {
    for (const id of [...evidence.articles, ...(evidence.opposing?.articles ?? [])]) {
      const source = articleById(fixture.articles, id);
      if (!source) continue;
      const current = references.get(source.outlet) ?? { articleCount: 0, references: 0, articles: [] };
      current.references += 1;
      if (!current.articles.some((item) => item.id === source.id)) current.articles.push(source);
      current.articleCount = current.articles.length;
      references.set(source.outlet, current);
    }
  }
  const rows = [...references.entries()].sort((a, b) => b[1].references - a[1].references || a[0].localeCompare(b[0]));
  const tags = [...new Set(fixture.articles.flatMap((item) => item.tags))].sort();
  return (
    <aside className="border border-zinc-800 bg-zinc-950/70 p-4 xl:sticky xl:top-24 xl:self-start">
      <div className="mb-4 border-b border-zinc-800 pb-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-violet-300">Source rail</p>
        <h3 className="mt-1 text-sm font-semibold text-zinc-100">Coverage map</h3>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500">Ordered by distinct references, not by outlet quality or rank.</p>
      </div>
      {activeTag && (
        <button type="button" onClick={() => onTag(null)} className="mb-3 inline-flex items-center gap-2 border border-violet-400/50 bg-violet-400/10 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-violet-200 hover:bg-violet-400/20">
          Showing #{activeTag} · clear
        </button>
      )}
      <ul className="space-y-3">
        {rows.map(([outlet, data]) => (
          <li key={outlet} className="border-b border-zinc-900 pb-3 last:border-b-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-semibold text-zinc-200">{outlet}</span>
              <span className="font-mono text-[10px] text-zinc-600">{data.articleCount} article{data.articleCount === 1 ? "" : "s"}</span>
            </div>
            <div className="mt-2">
              {data.articles.map((source) => <ArticleLinks key={source.id} articles={fixture.articles} ids={[source.id]} />)}
            </div>
            <p className="mt-1 font-mono text-[10px] text-zinc-600">{data.references} supported reference{data.references === 1 ? "" : "s"}</p>
          </li>
        ))}
      </ul>
      <div className="mt-5 border-t border-zinc-800 pt-4">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-600">Filter sample discovery</p>
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => <button key={tag} type="button" onClick={() => onTag(tag)} className="border border-zinc-800 px-1.5 py-1 font-mono text-[9px] uppercase text-zinc-500 hover:border-violet-400/60 hover:text-violet-200">#{tag}</button>)}
        </div>
      </div>
    </aside>
  );
}

function CoverageList({ fixture }: { fixture: MediaFixture }) {
  return (
    <section aria-label="Articles" className="border border-zinc-800 bg-zinc-950/70">
      <h3 className="border-b border-zinc-800 px-4 py-3 font-mono text-xs uppercase tracking-wider text-zinc-200">Articles · {fixture.articles.length}</h3>
      <ol className="divide-y divide-zinc-800">
        {fixture.articles.map((source, index) => {
          const destination = `/media-discovery-sample.html?${new URLSearchParams({ outlet: source.outlet, title: source.title, date: source.publishedAt })}`;
          return (
            <li key={source.id} id={`media-sample-article-${source.id}`} style={{ scrollMarginTop: 160 }}
              className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 px-4 py-3 text-sm target:bg-violet-400/10 md:grid-cols-[1.5rem_10rem_minmax(0,1fr)_7rem_auto]">
              <span className="font-mono text-xs text-violet-300">[{index + 1}]</span>
              <span className="font-medium text-zinc-200">{source.outlet}</span>
              <span className="col-start-2 row-start-2 text-zinc-300 md:col-auto md:row-auto">{source.title}</span>
              <time dateTime={source.publishedAt} className="col-start-2 row-start-3 font-mono text-xs text-zinc-400 md:col-auto md:row-auto">{source.publishedAt}</time>
              <a href={destination} target="_blank" rel="noopener noreferrer"
                aria-label={`Open ${source.title} in a new tab or window`}
                className="col-start-3 row-start-1 text-violet-300 underline-offset-4 hover:text-white hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-300 md:col-auto md:row-auto">Read ↗</a>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function SimilarityPanel({ fixture }: { fixture: MediaFixture }) {
  if (!fixture.similarity) return null;
  const column = (title: string, text: string, items: SimilarityTrait[]) => (
    <div className="border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="mb-3 border-b border-zinc-800 pb-3">
        <p className="font-mono text-[10px] uppercase tracking-wider text-violet-300">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">{text}</p>
      </div>
      <ul className="space-y-4">
        {items.map((item) => (
          <li key={item.label} className="border-l-2 border-violet-400/60 pl-3">
            <p className="text-xs font-semibold text-zinc-100">{item.label}</p>
            <p className="font-mono text-[9px] uppercase tracking-wider text-violet-300">{item.dimension}</p>
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">{item.text}</p>
            <div className="mt-2"><ArticleLinks articles={fixture.articles} ids={item.articles} /></div>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <section className="border border-violet-400/30 bg-violet-400/[0.03] p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-violet-300">Similarity · gameplay and story only</p>
          <h3 className="mt-1 text-base font-semibold text-zinc-100">Shared traits for two example games</h3>
        </div>
        <span className="font-mono text-[10px] uppercase text-zinc-600">not a ranking</span>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {column("Generated suggestions", "Derived discovery prompts; not outlet-authored comparisons.", fixture.similarity.generated)}
        {column("Outlet-explicit comparisons", "Only the sample comparison notes that explicitly connect both games.", fixture.similarity.outletExplicit)}
      </div>
    </section>
  );
}

function VariantA({ fixture, activeTag, onTag }: { fixture: MediaFixture; activeTag: string | null; onTag: (tag: string | null) => void }) {
  const allTags = [...new Set(fixture.categories.flatMap((cat) => cat.evidence.flatMap((e) => e.tags)))];

  return (
    <div className="space-y-5">
      <TopSummary
        scenario={fixture.label === "Announced / non-hands-on" ? "announced" : fixture.label === "One source" ? "one-source" : "richer"}
        articles={fixture.articles}
        allTags={allTags}
        activeTag={activeTag}
        onTag={onTag}
      />
      <section className="divide-y divide-zinc-800 border border-zinc-800 bg-zinc-950/70" aria-label="Editorial coverage stream">
        {fixture.categories.map((category) => {
          const findings = sortEvidenceByOutlets(fixture, category.evidence);
          const hasDisputed = findings.some((e) => e.disputed);
          return (
            <article key={category.key} className="p-5 sm:p-6">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-base font-semibold text-violet-200">{category.label}</h3>
                {hasDisputed && (
                  <ContestedBadge
                    active={activeTag === "disputed"}
                    onClick={() => onTag(activeTag === "disputed" ? null : "disputed")}
                  />
                )}
              </div>
              {renderEvidenceParagraphs(findings, fixture.articles)}
            </article>
          );
        })}
      </section>
      {activeTag && (
        <button type="button" onClick={() => onTag(null)} className="border border-violet-400/50 bg-violet-400/10 px-3 py-2 text-sm text-violet-200">
          Showing {activeTag} · clear filter
        </button>
      )}
      <RapidFire fixture={fixture} />
      <SimilarityPanel fixture={fixture} />
      <CoverageList fixture={fixture} />
    </div>
  );
}

function VariantB({ fixture, activeTag, onTag }: { fixture: MediaFixture; activeTag: string | null; onTag: (tag: string | null) => void }) {
  const allTags = [...new Set(fixture.categories.flatMap((cat) => cat.evidence.flatMap((e) => e.tags)))];

  return (
    <div className="space-y-5">
      <TopSummary
        scenario={fixture.label === "Announced / non-hands-on" ? "announced" : fixture.label === "One source" ? "one-source" : "richer"}
        articles={fixture.articles}
        allTags={allTags}
        activeTag={activeTag}
        onTag={onTag}
      />
      <section className="divide-y divide-zinc-800 border border-zinc-800 bg-zinc-950/70" aria-label="Coverage by category">
        {fixture.categories.map((category) => {
          const findings = sortEvidenceByOutlets(fixture, category.evidence);
          const hasDisputed = findings.some((e) => e.disputed);
          return (
            <section key={category.key} className="grid gap-3 p-5 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-6 sm:p-6">
              <div>
                <h3 className="text-sm font-semibold text-violet-200">{category.label}</h3>
                {hasDisputed && (
                  <div className="mt-2">
                    <ContestedBadge
                      active={activeTag === "disputed"}
                      onClick={() => onTag(activeTag === "disputed" ? null : "disputed")}
                    />
                  </div>
                )}
              </div>
              <div>
                {renderEvidenceParagraphs(findings, fixture.articles)}
              </div>
            </section>
          );
        })}
      </section>
      {activeTag && (
        <button type="button" onClick={() => onTag(null)} className="border border-violet-400/50 bg-violet-400/10 px-3 py-2 text-sm text-violet-200">
          Showing {activeTag} · clear filter
        </button>
      )}
      <RapidFire fixture={fixture} />
      <SimilarityPanel fixture={fixture} />
      <CoverageList fixture={fixture} />
    </div>
  );
}

function VariantC({ fixture, activeTag, onTag }: { fixture: MediaFixture; activeTag: string | null; onTag: (tag: string | null) => void }) {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const allTags = [...new Set(fixture.categories.flatMap((cat) => cat.evidence.flatMap((e) => e.tags)))];
  const displayedCategories = selectedCategory
    ? fixture.categories.filter((cat) => cat.key === selectedCategory)
    : fixture.categories;

  return (
    <div className="space-y-5">
      <TopSummary
        scenario={fixture.label === "Announced / non-hands-on" ? "announced" : fixture.label === "One source" ? "one-source" : "richer"}
        articles={fixture.articles}
        allTags={allTags}
        activeTag={activeTag}
        onTag={onTag}
      />
      <div className="flex flex-wrap items-center gap-2 border border-zinc-800 bg-zinc-950/70 p-3">
        <button
          type="button"
          onClick={() => setSelectedCategory(null)}
          className={`px-3 py-1.5 font-mono text-xs transition-colors ${
            selectedCategory === null
              ? "border border-violet-300 bg-violet-300 font-semibold text-zinc-950 shadow-sm"
              : "border border-zinc-800 text-zinc-300 hover:border-zinc-700 hover:text-white"
          }`}
        >
          All Categories ({fixture.categories.length})
        </button>
        {fixture.categories.map((cat) => (
          <button
            key={cat.key}
            type="button"
            onClick={() => setSelectedCategory(selectedCategory === cat.key ? null : cat.key)}
            className={`px-3 py-1.5 font-mono text-xs transition-colors ${
              selectedCategory === cat.key
                ? "border border-violet-300 bg-violet-300 font-semibold text-zinc-950 shadow-sm"
                : "border border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>
      <div className="space-y-4">
        {displayedCategories.map((category) => {
          const findings = sortEvidenceByOutlets(fixture, category.evidence);
          const hasDisputed = findings.some((e) => e.disputed);
          return (
            <section key={category.key} className="border border-zinc-800 bg-zinc-950/70 p-5 sm:p-6">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-3">
                <h3 className="text-base font-semibold text-violet-200">{category.label}</h3>
                {hasDisputed && (
                  <ContestedBadge
                    active={activeTag === "disputed"}
                    onClick={() => onTag(activeTag === "disputed" ? null : "disputed")}
                  />
                )}
              </div>
              {renderEvidenceParagraphs(findings, fixture.articles)}
            </section>
          );
        })}
      </div>
      {activeTag && (
        <button type="button" onClick={() => onTag(null)} className="border border-violet-400/50 bg-violet-400/10 px-3 py-2 text-sm text-violet-200">
          Showing {activeTag} · clear filter
        </button>
      )}
      <RapidFire fixture={fixture} />
      <SimilarityPanel fixture={fixture} />
      <CoverageList fixture={fixture} />
    </div>
  );
}

function PrototypeSwitcher({
  variant,
  scenario,
  onVariantChange,
  onScenarioChange,
}: {
  variant: MediaVariant;
  scenario: MediaScenario;
  onVariantChange: (variant: MediaVariant) => void;
  onScenarioChange: (scenario: MediaScenario) => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const currentIndex = MEDIA_VARIANTS.indexOf(variant);
      const nextIndex = event.key === "ArrowRight"
        ? (currentIndex + 1) % MEDIA_VARIANTS.length
        : (currentIndex - 1 + MEDIA_VARIANTS.length) % MEDIA_VARIANTS.length;
      onVariantChange(MEDIA_VARIANTS[nextIndex]);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onVariantChange, variant]);

  const currentName = variant === "A" ? "Editorial Stream" : variant === "B" ? "Category Dossier" : "Interactive Navigator";
  return (
    <div className="fixed inset-x-3 bottom-3 z-[70] mx-auto max-w-4xl border border-violet-300/40 bg-zinc-950/95 p-2 shadow-2xl shadow-black/50 backdrop-blur-md">
      <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
        <button type="button" aria-label="Previous media discovery layout" onClick={() => onVariantChange(MEDIA_VARIANTS[(MEDIA_VARIANTS.indexOf(variant) - 1 + MEDIA_VARIANTS.length) % MEDIA_VARIANTS.length])} className="inline-flex h-9 w-9 items-center justify-center border border-zinc-700 font-mono text-lg text-zinc-200 hover:border-violet-300 hover:text-violet-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">←</button>
        <div className="min-w-[9rem] text-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-violet-300">Variant {variant} · {currentName}</p>
          <p className="mt-0.5 font-mono text-[9px] uppercase text-zinc-500">← / → to switch</p>
        </div>
        <button type="button" aria-label="Next media discovery layout" onClick={() => onVariantChange(MEDIA_VARIANTS[(MEDIA_VARIANTS.indexOf(variant) + 1) % MEDIA_VARIANTS.length])} className="inline-flex h-9 w-9 items-center justify-center border border-zinc-700 font-mono text-lg text-zinc-200 hover:border-violet-300 hover:text-violet-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">→</button>
        <label className="flex min-h-9 items-center gap-2 border border-zinc-700 px-2 font-mono text-[10px] uppercase tracking-wide text-zinc-400">
          <span>Scenario</span>
          <select value={scenario} onChange={(event) => onScenarioChange(event.target.value as MediaScenario)} className="min-h-7 bg-zinc-950 text-zinc-100 outline-none">
            <option value="one-source">One source</option>
            <option value="announced">Announced / non-hands-on</option>
            <option value="richer">Richer opposing evidence</option>
            <option value="cited-similarity">Cited similarity</option>
          </select>
        </label>
        <span className="basis-full text-center font-mono text-[9px] uppercase tracking-wide text-amber-200/80">Illustrative evidence — not published outlet assessments</span>
      </div>
    </div>
  );
}

export interface MediaDiscoveryPrototypeProps {
  game: { appid: number; name: string };
  variant: MediaVariant;
  scenario: MediaScenario;
  onVariantChange: (variant: MediaVariant) => void;
  onScenarioChange: (scenario: MediaScenario) => void;
}

export function MediaDiscoveryPrototype({ game, variant, scenario, onVariantChange, onScenarioChange }: MediaDiscoveryPrototypeProps) {
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const fixture = useMemo(() => createFixture(game.name, scenario), [game.name, scenario]);
  const visibleFixture = useMemo(() => filteredFixture(fixture, activeTag), [fixture, activeTag]);

  return (
    <section id="media-discovery" className="relative space-y-5 border-t border-zinc-900 pt-6 pb-28" aria-label={`Media discovery prototype for ${game.name}`}>
      {variant === "A" && <VariantA fixture={visibleFixture} activeTag={activeTag} onTag={setActiveTag} />}
      {variant === "B" && <VariantB fixture={visibleFixture} activeTag={activeTag} onTag={setActiveTag} />}
      {variant === "C" && <VariantC fixture={visibleFixture} activeTag={activeTag} onTag={setActiveTag} />}
      <PrototypeSwitcher variant={variant} scenario={scenario} onVariantChange={onVariantChange} onScenarioChange={(nextScenario) => { setActiveTag(null); onScenarioChange(nextScenario); }} />
      <p className="sr-only">Current scenario: {fixture.label}. Current layout: Variant {variant}.</p>
    </section>
  );
}

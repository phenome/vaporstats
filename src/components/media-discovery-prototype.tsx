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
  return { id, outlet, title, type, handsOn, platform, build, gameLabel, tags };
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
    ["gameplay", "story", "visuals"],
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
              text: "The sample brief describes a short expedition loop that returns to a persistent hub.",
              articles: [one.id],
              tags: ["gameplay", "systems"],
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
              text: "The sample brief points to a layered setting revealed through environmental clues.",
              articles: [one.id],
              tags: ["story", "world"],
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
              text: "The sample brief calls out high-contrast silhouettes as a useful visual cue during play.",
              articles: [one.id],
              tags: ["visuals", "accessibility"],
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
    ["story", "world", "announcement"],
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
              text: "The sample announcement introduces a setting premise without making a hands-on claim.",
              articles: [announcement.id],
              tags: ["story", "world", "announcement"],
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
    ["gameplay", "systems", "technical"],
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
    ["story", "world", "visuals"],
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
    ["gameplay", "technical", "accessibility"],
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
    ["gameplay", "social", "platform"],
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
    ["visuals", "audio", "accessibility"],
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
          text: "Sample hands-on notes describe expeditions that trade immediate rewards against a safer return to the hub.",
          articles: [preview.id, review.id],
          tags: ["gameplay", "systems"],
          tone: "positive",
        },
        {
          id: "rich-traversal",
          text: "The sample coverage agrees that traversal is deliberate, but the stated reason differs by source.",
          articles: [preview.id],
          tags: ["gameplay", "traversal", "disputed"],
          tone: "mixed",
          opposing: {
            text: "A separate sample note describes the same traversal as stop-start during combat transitions.",
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
          text: "Sample world notes emphasize environmental clues that reward returning to earlier spaces.",
          articles: [secondPreview.id, review.id],
          tags: ["story", "world"],
          tone: "positive",
        },
        {
          id: "rich-characters",
          text: "A sample review observes that character motives remain legible during the central arc.",
          articles: [review.id],
          tags: ["story", "characters"],
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
          text: "In the prepatch sample build, the notes call out strong silhouette contrast in crowded scenes.",
          articles: [secondPreview.id, audioNote.id],
          tags: ["visuals", "readability"],
          tone: "positive",
          context: "Prepatch / early-access context",
        },
        {
          id: "rich-audio",
          text: "A sample audio note describes directional cues as easy to distinguish in a stereo mix.",
          articles: [audioNote.id],
          tags: ["audio", "accessibility"],
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
          text: "The sample platform note describes co-op roles that make resource decisions visible to the group.",
          articles: [platformNote.id],
          tags: ["social", "co-op", "platform"],
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
          text: "Sample launch notes mention occasional frame-time spikes when several effects overlap.",
          articles: [review.id, audioNote.id],
          tags: ["technical", "performance"],
          tone: "negative",
        },
        {
          id: "rich-access",
          text: "A sample access note highlights remappable controls and readable subtitle treatment.",
          articles: [audioNote.id],
          tags: ["accessibility", "controls"],
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
      ["gameplay", "systems"],
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
      ["story", "world"],
    ),
  ];

  return {
    label: scenario === "cited-similarity" ? "Cited similarity" : "Richer opposing evidence",
    description:
      scenario === "cited-similarity"
        ? "Shared traits are separated into generated suggestions and outlet-explicit comparisons, with citations for both example games."
        : "Repeated findings, independent observations, and disagreement remain visible without a quality ranking.",
    articles: similarityArticles,
    categories: richerCategories,
    pros: [
      {
        id: "rapid-loop",
        text: "The sample coverage repeatedly finds the expedition loop easy to parse.",
        articles: [preview.id, review.id],
        tags: ["gameplay", "systems"],
        tone: "positive",
      },
      {
        id: "rapid-readability",
        text: "Multiple sample notes mention readable silhouettes during busy encounters.",
        articles: [secondPreview.id, audioNote.id],
        tags: ["visuals", "readability"],
        tone: "positive",
      },
    ],
    cons: [
      {
        id: "rapid-performance",
        text: "Two sample launch notes mention frame-time spikes in effect-heavy scenes.",
        articles: [review.id, audioNote.id],
        tags: ["technical", "performance"],
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
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px]">
      {ids.map((id) => {
        const source = articleById(articles, id);
        if (!source) return null;
        return (
          <a
            key={id}
            href={`#media-sample-article-${source.id}`}
            aria-label={`${source.outlet}: ${source.title}`}
            className="text-violet-300 underline decoration-violet-500/40 underline-offset-2 hover:text-violet-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
          >
            {source.outlet}: {source.title} [{source.gameLabel}] ↗
          </a>
        );
      })}
    </span>
  );
}



function EvidenceBullet({
  evidence,
  fixture,
  compact = false,
  onTag,
}: {
  evidence: Evidence;
  fixture: MediaFixture;
  compact?: boolean;
  onTag: (tag: string) => void;
}) {
  const allArticleIds = evidence.opposing ? [...evidence.articles, ...evidence.opposing.articles] : evidence.articles;
  return (
    <li className={`border-l-2 pl-3 ${evidence.tone === "negative" ? "border-red-400/70" : evidence.tone === "positive" ? "border-emerald-400/70" : "border-zinc-700"}`}>
      <div className={`${compact ? "text-xs" : "text-sm"} leading-relaxed text-zinc-200`}>
        {evidence.text}
        {evidence.opposing && (
          <span className="mt-1 block text-zinc-400">
            Opposing note: {evidence.opposing.text}
          </span>
        )}
      </div>
      {evidence.context && (
        <span className="mt-2 inline-flex border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-zinc-400">
          {evidence.context}
        </span>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <ArticleLinks articles={fixture.articles} ids={evidence.articles} />
        {evidence.opposing && (
          <span className="text-[10px] text-zinc-600">opposing</span>
        )}
        {evidence.opposing && <ArticleLinks articles={fixture.articles} ids={evidence.opposing.articles} />}
        <span className="font-mono text-[10px] text-zinc-600">
          {distinctOutlets(fixture.articles, allArticleIds)} {distinctOutlets(fixture.articles, allArticleIds) === 1 ? "outlet" : "outlets"}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {evidence.tags.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() => onTag(tag)}
            className="border border-zinc-800 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-zinc-500 hover:border-violet-400/60 hover:text-violet-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-400"
          >
            {tag === "disputed" ? "Disputed" : `#${tag}`}
          </button>
        ))}
      </div>
    </li>
  );
}

function CategoryReadingSection({ category, fixture, onTag }: { category: MediaCategory; fixture: MediaFixture; onTag: (tag: string) => void }) {
  const evidence = sortEvidenceByOutlets(fixture, category.evidence);
  return (
    <section className="border border-zinc-800 bg-zinc-950/70 p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-800 pb-3">
        <h3 className="font-mono text-sm font-bold uppercase tracking-wide text-zinc-100">{category.label}</h3>
        <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-600">{evidence.length} supported finding{evidence.length === 1 ? "" : "s"}</span>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-zinc-500">{category.summary}</p>
      <ul className="space-y-4">
        {evidence.map((item) => <EvidenceBullet key={item.id} evidence={item} fixture={fixture} onTag={onTag} />)}
      </ul>
    </section>
  );
}


function RapidFire({ fixture, onTag }: { fixture: MediaFixture; onTag: (tag: string) => void }) {
  const pros = sortEvidenceByOutlets(fixture, fixture.pros);
  const cons = sortEvidenceByOutlets(fixture, fixture.cons);
  if (pros.length === 0 && cons.length === 0) {
    return <p className="border border-dashed border-zinc-800 p-4 text-xs leading-relaxed text-zinc-500">No rapid-fire pros or cons yet: this scenario has no hands-on evidence to support them.</p>;
  }
  return (
    <section className="border border-zinc-800 bg-zinc-950/70 p-4 sm:p-5">
      <div className="mb-4 flex items-baseline justify-between gap-2 border-b border-zinc-800 pb-3">
        <h3 className="font-mono text-sm font-bold uppercase tracking-wide text-zinc-100">Rapid-fire signal</h3>
        <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-600">one overall list</span>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <h4 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-emerald-300">Pros</h4>
          <ul className="space-y-3">{pros.map((item) => <EvidenceBullet key={item.id} evidence={item} fixture={fixture} compact onTag={onTag} />)}</ul>
        </div>
        <div>
          <h4 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-red-300">Cons</h4>
          <ul className="space-y-3">{cons.map((item) => <EvidenceBullet key={item.id} evidence={item} fixture={fixture} compact onTag={onTag} />)}</ul>
        </div>
      </div>
    </section>
  );
}

function filteredFixture(fixture: MediaFixture, activeTag: string | null): MediaFixture {
  if (!activeTag) return fixture;
  const keep = (evidence: Evidence) => evidence.tags.includes(activeTag);
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

function CoverageList({ fixture, onTag }: { fixture: MediaFixture; onTag: (tag: string) => void }) {
  return (
    <details className="group border border-zinc-800 bg-zinc-950/70" open>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 font-mono text-xs uppercase tracking-wider text-zinc-200 marker:hidden">
        <span>Coverage list · {fixture.articles.length} sample articles</span>
        <span className="text-zinc-600 group-open:rotate-180">⌄</span>
      </summary>
      <div className="grid gap-2 border-t border-zinc-800 p-4 md:grid-cols-2">
        {fixture.articles.map((source) => (
          <article key={source.id} className="border border-zinc-900 bg-zinc-900/40 p-3" id={`media-sample-article-${source.id}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-wide text-violet-300">{source.outlet}</p>
                <h4 className="mt-1 text-xs font-semibold leading-relaxed text-zinc-100">{source.title}</h4>
                <p className="mt-1 text-[10px] text-zinc-500">{source.gameLabel}</p>
              </div>
              <a href={`#media-sample-article-${source.id}`} className="font-mono text-[10px] text-zinc-500 underline underline-offset-2 hover:text-zinc-200">sample ↗</a>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5 font-mono text-[9px] uppercase tracking-wide text-zinc-500">
              <span className="border border-zinc-800 px-1.5 py-0.5">{source.type}</span>
              <span className="border border-zinc-800 px-1.5 py-0.5">{source.handsOn}</span>
              <span className="border border-zinc-800 px-1.5 py-0.5">{source.platform}</span>
              <span className="border border-zinc-800 px-1.5 py-0.5">{source.build}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-1">
              {source.tags.map((tag) => <button key={tag} type="button" onClick={() => onTag(tag)} className="text-[9px] text-zinc-600 hover:text-violet-200">#{tag}</button>)}
            </div>
            <p className="mt-3 border-t border-zinc-900 pt-2 text-[10px] leading-relaxed text-zinc-600">Sample article detail for this design exercise; not a published outlet assessment.</p>
          </article>
        ))}
      </div>
    </details>
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
  return (
    <div className="space-y-5">
      <header className="border-l-4 border-violet-400 bg-zinc-950/60 px-4 py-1">
        <h2 className="mt-1 text-xl font-semibold text-zinc-100">Media coverage</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">{fixture.description}</p>
      </header>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <main className="space-y-5">
          {fixture.categories.map((category) => <CategoryReadingSection key={category.key} category={category} fixture={fixture} onTag={(tag) => onTag(activeTag === tag ? null : tag)} />)}
          <RapidFire fixture={fixture} onTag={(tag) => onTag(activeTag === tag ? null : tag)} />
          <SimilarityPanel fixture={fixture} />
        </main>
        <SourceRail fixture={fixture} activeTag={activeTag} onTag={onTag} />
      </div>
      <CoverageList fixture={fixture} onTag={(tag) => onTag(activeTag === tag ? null : tag)} />
    </div>
  );
}

function VariantB({ fixture, activeTag, onTag }: { fixture: MediaFixture; activeTag: string | null; onTag: (tag: string | null) => void }) {
  const rows = fixture.categories
    .flatMap((category) => category.evidence.map((evidence) => ({ category, evidence })))
    .sort(
      (left, right) =>
        distinctOutlets(fixture.articles, evidenceSourceIds(right.evidence)) -
        distinctOutlets(fixture.articles, evidenceSourceIds(left.evidence)),
    );
  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 border border-zinc-800 bg-zinc-950/70 p-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="mt-1 text-xl font-semibold text-zinc-100">Media coverage</h2>
        </div>
        <p className="max-w-xl text-xs leading-relaxed text-zinc-500">{fixture.description}</p>
      </header>
      <section className="border border-zinc-800 bg-zinc-950/70">
        <div className="hidden border-b border-zinc-800 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-zinc-600 md:grid md:grid-cols-[11rem_minmax(0,1fr)_8rem] md:gap-4">
          <span>Facet</span><span>Evidence / opposing read</span><span>Source signal</span>
        </div>
        <div className="divide-y divide-zinc-900">
          {rows.map(({ category, evidence }) => {
            const count = distinctOutlets(fixture.articles, [...evidence.articles, ...(evidence.opposing?.articles ?? [])]);
            return (
              <div key={evidence.id} className="grid gap-3 px-4 py-4 md:grid-cols-[11rem_minmax(0,1fr)_8rem] md:gap-4">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-wide text-violet-300">{category.label}</p>
                  <p className="mt-1 text-xs text-zinc-500">{evidence.tone === "mixed" ? "Disputed" : evidence.tone === "observation" ? "Observation" : evidence.tone === "positive" ? "Favorable read" : "Unfavorable read"}</p>
                </div>
                <div>
                  <p className="text-sm leading-relaxed text-zinc-200">{evidence.text}</p>
                  {evidence.opposing && <p className="mt-2 border-l border-zinc-700 pl-3 text-xs leading-relaxed text-zinc-400"><span className="font-mono text-[10px] uppercase text-zinc-600">Opposite judgment · </span>{evidence.opposing.text}</p>}
                  {evidence.context && <span className="mt-2 inline-flex border border-zinc-700 px-1.5 py-0.5 font-mono text-[9px] uppercase text-zinc-500">{evidence.context}</span>}
                  <div className="mt-2 flex flex-wrap gap-2"><ArticleLinks articles={fixture.articles} ids={evidence.articles} />{evidence.opposing && <ArticleLinks articles={fixture.articles} ids={evidence.opposing.articles} />}</div>
                  <div className="mt-2 flex flex-wrap gap-1">{evidence.tags.map((tag) => <button key={tag} type="button" onClick={() => onTag(activeTag === tag ? null : tag)} className="border border-zinc-800 px-1.5 py-0.5 font-mono text-[9px] uppercase text-zinc-600 hover:border-violet-400/60 hover:text-violet-200">{tag === "disputed" ? "Disputed" : `#${tag}`}</button>)}</div>
                </div>
                <div className="font-mono text-[10px] uppercase text-zinc-600 md:text-right">{count} distinct {count === 1 ? "outlet" : "outlets"}</div>
              </div>
            );
          })}
        </div>
      </section>
      {activeTag && <button type="button" onClick={() => onTag(null)} className="border border-violet-400/50 bg-violet-400/10 px-2 py-1 font-mono text-[10px] uppercase text-violet-200">Showing #{activeTag} · clear filter</button>}
      <RapidFire fixture={fixture} onTag={(tag) => onTag(activeTag === tag ? null : tag)} />
      <CoverageList fixture={fixture} onTag={(tag) => onTag(activeTag === tag ? null : tag)} />
      <SimilarityPanel fixture={fixture} />
    </div>
  );
}

function VariantC({ fixture, activeTag, onTag }: { fixture: MediaFixture; activeTag: string | null; onTag: (tag: string | null) => void }) {
  const tags = [...new Set(fixture.articles.flatMap((item) => item.tags))].sort();
  return (
    <div className="space-y-5">
      <header className="border border-zinc-800 bg-zinc-950/70 p-4">
        <h2 className="mt-1 text-xl font-semibold text-zinc-100">Media coverage</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">{fixture.description}</p>
      </header>
      <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="border border-zinc-800 bg-zinc-950/70 p-4 lg:sticky lg:top-24 lg:self-start">
          <p className="font-mono text-[10px] uppercase tracking-wider text-violet-300">Discovery filters</p>
          <p className="mt-2 text-xs leading-relaxed text-zinc-500">Tags reveal matching sample evidence without changing the underlying game page.</p>
          <div className="mt-4 space-y-1">
            <button type="button" onClick={() => onTag(null)} className={`w-full border px-2 py-2 text-left font-mono text-[10px] uppercase ${activeTag === null ? "border-violet-400/60 bg-violet-400/10 text-violet-100" : "border-zinc-800 text-zinc-500 hover:text-zinc-200"}`}>All supported evidence</button>
            {tags.map((tag) => <button key={tag} type="button" onClick={() => onTag(activeTag === tag ? null : tag)} className={`w-full border px-2 py-2 text-left font-mono text-[10px] uppercase ${activeTag === tag ? "border-violet-400/60 bg-violet-400/10 text-violet-100" : "border-zinc-800 text-zinc-500 hover:text-zinc-200"}`}>#{tag}</button>)}
          </div>
          <div className="mt-5 border-t border-zinc-800 pt-4">
            <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-600">Current result</p>
            <p className="mt-1 text-sm text-zinc-200">{fixture.categories.reduce((total, category) => total + category.evidence.length, 0)} supported findings</p>
            {activeTag && <p className="mt-1 font-mono text-[10px] text-violet-300">filtered to #{activeTag}</p>}
          </div>
        </aside>
        <main className="space-y-3">
          {fixture.categories.map((category, index) => (
            <details key={category.key} className="group border border-zinc-800 bg-zinc-950/70" open={index === 0}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 marker:hidden">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-wider text-violet-300">0{index + 1}</p>
                  <h3 className="mt-1 text-sm font-semibold text-zinc-100">{category.label}</h3>
                  <p className="mt-1 text-xs text-zinc-500">{category.summary}</p>
                </div>
                <span className="font-mono text-lg text-zinc-600 group-open:rotate-180">⌄</span>
              </summary>
              <div className="border-t border-zinc-800 p-4">
                <ul className="space-y-4">{sortEvidenceByOutlets(fixture, category.evidence).map((evidence) => <EvidenceBullet key={evidence.id} evidence={evidence} fixture={fixture} onTag={(tag) => onTag(activeTag === tag ? null : tag)} />)}</ul>
              </div>
            </details>
          ))}
          <RapidFire fixture={fixture} onTag={(tag) => onTag(activeTag === tag ? null : tag)} />
          <CoverageList fixture={fixture} onTag={(tag) => onTag(activeTag === tag ? null : tag)} />
          <SimilarityPanel fixture={fixture} />
        </main>
      </div>
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

  const currentName = variant === "A" ? "Reading-first" : variant === "B" ? "Comparative rows" : "Discovery split";
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

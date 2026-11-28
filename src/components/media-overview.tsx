import type { MediaFinding, MediaOverview } from "../lib/media-overview";
import type { MediaSource } from "../lib/media-discovery";
import { presentMediaFindingText } from "../lib/media-finding-presentation";
import { AppLink } from "./app-link";
import { getMediaSourceReferences, type MediaSourceReference } from "./media-source-references";

type SourceReferences = ReadonlyMap<string, MediaSourceReference>;

function CitationNotes({
  sourceUrls,
  references,
}: {
  sourceUrls: string[];
  references: SourceReferences;
}) {
  const notes = [...new Set(sourceUrls)].map((url) => {
    const item = references.get(url);
    if (!item) return null;
    const { source, id, number, suffix } = item;
    const label = suffix ? `${number}.${suffix}` : number;
    return (
      <a
        key={id}
        href={`#${id}`}
        title={`${source.outlet}: ${source.title}`}
        aria-label={`Source ${label}: ${source.title} on ${source.outlet}`}
        className="ml-1 inline-block whitespace-nowrap rounded-sm bg-orange-950/50 px-1 font-mono text-[11px] leading-none font-semibold text-orange-300 hover:underline focus-visible:outline focus-visible:outline-orange-500"
      >
        {number}{suffix && <sub>{suffix}</sub>}
      </a>
    );
  });

  return notes;
}

function CitedFindings({
  appid,
  findings,
  references,
  composedLead = false,
}: {
  appid: number;
  findings: MediaFinding[];
  references: SourceReferences;
  composedLead?: boolean;
}) {
  return findings.map((finding, index) => {
    const wording = composedLead ? finding.text : presentMediaFindingText(finding.text, appid);
    return (
      <span key={`${finding.text}-${index}`}>
        {index > 0 && " "}
        {finding.contested && (
          <span
            data-contested
            className="mr-2 inline-flex border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-zinc-400"
          >
            Contested
          </span>
        )}
        {wording}
        <CitationNotes sourceUrls={finding.sourceUrls} references={references} />
        {(!composedLead || index === findings.length - 1) && !(composedLead ? /[,;:.!?]$/ : /[.!?]$/).test(wording) && "."}
      </span>
    );
  });
}

function findingTextKey(text: string): string {
  return text.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
}

function mergeRepeatedLeadFindings(overview: MediaOverview) {
  const statements = overview.statements.map((finding) => ({ ...finding }));
  const categories = overview.categories.map((category) => ({
    ...category,
    findings: category.findings.filter((finding) => {
      const lead = statements.find((statement) =>
        statement.edition === finding.edition
        && !!statement.contested === !!finding.contested
        && findingTextKey(statement.text) === findingTextKey(finding.text)
      );
      if (!lead) return true;
      lead.sourceUrls = [...new Set([...lead.sourceUrls, ...finding.sourceUrls])];
      return false;
    }),
  })).filter((category) => category.findings.length > 0);

  return { statements, categories };
}

function getEditionChapters(categories: MediaOverview["categories"], references: SourceReferences) {
  const editions = new Set(categories.flatMap(({ findings }) =>
    findings.map(({ edition }) => edition).filter((edition): edition is string => Boolean(edition)),
  ));
  if (editions.size < 2) return [];
  const chapters = [...editions].map((edition) => {
    const topics = categories.map((category) => ({
      ...category,
      findings: category.findings.filter((finding) => finding.edition === edition),
    })).filter((category) => category.findings.length > 0);
    const dates = topics.flatMap(({ findings }) => findings.flatMap(({ sourceUrls }) =>
      sourceUrls.map((url) => references.get(url)?.source.publishedAt?.slice(0, 7) ?? ""),
    )).filter((date) => /^\d{4}-(?:0[1-9]|1[0-2])$/.test(date)).sort();
    return { edition, categories: topics, date: dates[0] };
  });
  return chapters.sort((left, right) => {
    if (!left.date) return right.date ? 1 : 0;
    if (!right.date) return -1;
    return left.date.localeCompare(right.date);
  });
}

function Topics({
  appid,
  categories,
  references,
  heading: Heading = "h3",
}: {
  appid: number;
  categories: MediaOverview["categories"];
  references: SourceReferences;
  heading?: "h3" | "h4";
}) {
  return categories.map((category) => (
    <div key={category.name} className={Heading === "h3" ? "space-y-1 border-t border-[#424047] pt-3" : "space-y-1"}>
      <Heading className="text-xs font-semibold uppercase tracking-wider text-[#dec79f]">
        {category.name}
      </Heading>
      <p className="max-w-[70ch] text-[15px] leading-relaxed text-zinc-300">
        <CitedFindings appid={appid} findings={category.findings} references={references} />
      </p>
    </div>
  ));
}

const editionMonth = new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" });

export function MediaOverviewSection({
  overview,
  sources,
}: {
  overview: MediaOverview;
  sources: MediaSource[];
}) {
  const references = new Map(getMediaSourceReferences(sources).flatMap(({ items }) =>
    items.map((item) => [item.source.originalUrl, item] as const),
  ));
  const { statements, categories } = overview.composedLead ? overview : mergeRepeatedLeadFindings(overview);
  const chapters = getEditionChapters(categories, references);
  const generalTopics = chapters.length === 0 ? categories : categories.map((category) => ({
    ...category,
    findings: category.findings.filter((finding) => !finding.edition),
  })).filter((category) => category.findings.length > 0);

  return (
    <section id="media-overview" aria-labelledby="media-overview-title" className="min-w-0 space-y-4 rounded-lg border border-[#323339] bg-[#1c1d22] p-4 sm:p-7">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="media-overview-title" className="font-mono text-3xl font-semibold tracking-tight text-zinc-100">
          Overview
        </h2>
        <AppLink
          href="/methodology"
          className="font-mono text-[10px] uppercase tracking-wider text-zinc-400 hover:text-zinc-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        >
          How this works
        </AppLink>
      </div>
      <p className="max-w-[68ch] text-base leading-relaxed text-zinc-100">
        <CitedFindings appid={overview.appid} findings={statements} references={references} composedLead={overview.composedLead} />
      </p>
      <Topics appid={overview.appid} categories={generalTopics} references={references} />
      {chapters.map(({ edition, date, categories: topics }) => (
        <section key={edition} className="grid gap-3 border-t border-zinc-700 pt-3 sm:grid-cols-[minmax(7rem,24%)_1fr]">
          <div className="border-l-2 border-[#d6b071] pl-3">
            {date && (
              <time dateTime={date} className="font-mono text-[11px] uppercase text-zinc-400">
                {editionMonth.format(new Date(`${date}-01T00:00:00Z`))}
              </time>
            )}
            <h3 className="font-semibold text-zinc-100">{edition}</h3>
          </div>
          <div className="min-w-0 space-y-4">
            <Topics appid={overview.appid} categories={topics} references={references} heading="h4" />
          </div>
        </section>
      ))}
      {overview.prosCons && (
        <section aria-labelledby="media-pros-cons-title" className="space-y-2 border-t border-zinc-800 pt-3">
          <h3 id="media-pros-cons-title" className="text-xs font-semibold uppercase tracking-wider text-[#dec79f]">
            Pros &amp; cons
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {overview.prosCons.pros.length > 0 && (
              <div className="space-y-2 border-l-2 border-emerald-900/70 pl-3 text-sm leading-6 text-zinc-300">
                <h4 className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">Pros</h4>
                <CitedFindings appid={overview.appid} findings={overview.prosCons.pros} references={references} />
              </div>
            )}
            {overview.prosCons.cons.length > 0 && (
              <div className="space-y-2 border-l-2 border-red-950 pl-3 text-sm leading-6 text-zinc-300">
                <h4 className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">Cons</h4>
                <CitedFindings appid={overview.appid} findings={overview.prosCons.cons} references={references} />
              </div>
            )}
          </div>
        </section>
      )}
      {overview.tags.length > 0 && (
        <nav aria-label="Media tags" className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-zinc-700 pt-3 text-xs" data-media-tags>
          <span className="text-zinc-400">tags:</span>
          {overview.tags.map((tag) => (
            <AppLink
              key={tag.slug}
              href={`/games/?mediaTag=${encodeURIComponent(tag.label)}`}
              aria-label={`Browse games tagged ${tag.label}`}
              className="text-zinc-300 underline decoration-zinc-600 underline-offset-2 hover:text-amber-200"
            >
              {tag.label.replace(/^Supports (?=\S)/, "")}
            </AppLink>
          ))}
        </nav>
      )}
    </section>
  );
}

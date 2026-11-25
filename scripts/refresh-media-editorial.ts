import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mediaEditorialKey } from "../src/lib/media-amendments";
import { readArticleObservations, type EditorialOmission } from "../src/lib/media-observations";

type StoredOmission = EditorialOmission & { wording?: unknown };

function parseEditorialOmissions(output: string): StoredOmission[] {
  let decoded: { editorialOmissions?: unknown } | null;
  try {
    decoded = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(decoded?.editorialOmissions)) return [];
  return decoded.editorialOmissions.filter((item): item is StoredOmission =>
    item && typeof item.sourceIdentity === "string" && item.sourceIdentity.trim() &&
    typeof item.observationId === "string" && item.observationId.trim() &&
    typeof item.question === "string" && item.question.trim());
}

function markdownText(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g, "\\$&");
}

function sourceLink(url: string, title: string | null): string {
  const parsed = URL.parse(url);
  if (!parsed || !["http:", "https:"].includes(parsed.protocol)) return markdownText(title || url);
  const href = parsed.href.replaceAll("<", "%3C").replaceAll(">", "%3E").replaceAll("&", "&amp;");
  return `[${markdownText(title || url)}](<${href}>)`;
}

function documentedKeys(markdown: string, marker: "follow-up" | "amendment"): Set<string> {
  const pattern = new RegExp(`^<!-- media-${marker} ([a-f0-9]{64}) -->\\r?$`, "gm");
  return new Set(Array.from(markdown.matchAll(pattern), ([, key]) => key));
}

function missingFollowUps(markdown: string, databasePath: string): string[] {
  const questions = documentedKeys(markdown, "follow-up");
  const amendmentBlocks = documentedKeys(markdown, "amendment");
  const pending = new Map<string, {
    omission: EditorialOmission;
    game: string;
    source?: string;
    wording: string;
  }>();
  const db = new Database(databasePath, { readonly: true });
  try {
    const outputs = db.query<{ appid: number; output_json: string }, []>(`
      SELECT appid, output_json FROM media_game_overviews
      UNION
      SELECT source.appid, extraction.output_json FROM media_article_extractions AS extraction
      JOIN media_sources AS source ON source.id = extraction.source_id
      UNION
      SELECT appid, output_json FROM media_processing_jobs
      WHERE stage IN ('extraction', 'synthesis') AND status IN ('succeeded', 'refused') AND output_json IS NOT NULL
      ORDER BY appid, output_json
    `);
    const findSource = db.query<{ original_url: string; title: string | null; output_json: string | null }, [number, string]>(`
      SELECT source.original_url, source.title, extraction.output_json FROM media_sources AS source
      LEFT JOIN media_article_extractions AS extraction
        ON extraction.source_id = source.id AND extraction.input_identity = ?2
      WHERE source.appid = ?1 AND (
        extraction.id IS NOT NULL OR EXISTS (
          SELECT 1 FROM media_processing_jobs AS job
          WHERE job.source_id = source.id AND job.stage = 'extraction' AND job.input_identity = ?2
        )
      )
      ORDER BY extraction.id IS NULL, source.id LIMIT 1
    `);
    const findGame = db.query<{ name: string }, [number]>("SELECT name FROM apps WHERE appid = ?");
    for (const { appid, output_json } of outputs.iterate()) {
      for (const omission of parseEditorialOmissions(output_json)) {
        const { sourceIdentity, observationId, question } = omission;
        const questionKey = mediaEditorialKey(sourceIdentity, observationId, question.trim());
        if (questions.has(questionKey)) continue;
        const source = findSource.get(appid, sourceIdentity);
        const game = findGame.get(appid)?.name || `Steam app ${appid}`;
        const observation = readArticleObservations(source?.output_json, appid).find(({ id }) => id === observationId)
          ?? readArticleObservations(output_json, appid).find(({ id }) => id === observationId);
        const disputedWording = typeof omission.wording === "string" ? omission.wording.trim() : "";
        const recordedWording = observation ? [observation.text, ...observation.qualifiers].join(" · ") : "";
        const previous = pending.get(questionKey);
        if (!previous || disputedWording || (!previous.wording && recordedWording)) {
          pending.set(questionKey, {
            omission,
            game,
            source: source ? sourceLink(source.original_url, source.title) : undefined,
            wording: disputedWording || recordedWording,
          });
        }
      }
    }
  } finally {
    db.close();
  }
  const additions: string[] = [];
  for (const [questionKey, { omission: { sourceIdentity, observationId, question }, game, source, wording }] of pending) {
    additions.push([
      `<!-- media-follow-up ${questionKey} -->`,
      `- **${markdownText(game)}** — ${markdownText(question)}`,
      ...(source ? [`  - Source: ${source}`] : []),
      ...(wording ? [`  - Recorded wording: ${markdownText(wording)}`] : []),
      `  - Source version: ${markdownText(sourceIdentity)}`,
      `  - Observation: ${markdownText(observationId)}`,
    ].join("\n"));
    const amendmentKey = mediaEditorialKey(sourceIdentity, observationId);
    if (!amendmentBlocks.has(amendmentKey)) {
      amendmentBlocks.add(amendmentKey);
      additions.push(`<!-- media-amendment ${amendmentKey} -->\n<!-- /media-amendment -->`);
    }
  }
  return additions;
}

export function refreshMediaEditorial(databasePath: string, documentPath: string): number {
  const markdown = readFileSync(documentPath, "utf8");
  const additions = missingFollowUps(markdown, databasePath);
  if (additions.length === 0) return 0;

  const lineEnding = markdown.includes("\r\n") ? "\r\n" : "\n";
  const separator = markdown.endsWith(lineEnding + lineEnding) ? "" : markdown.endsWith(lineEnding) ? lineEnding : lineEnding + lineEnding;
  const updated = markdown + separator + additions.join("\n\n").replaceAll("\n", lineEnding) + lineEnding;
  const scratch = mkdtempSync(join(dirname(documentPath), ".media-editorial-"));
  const replacement = join(scratch, "document.md");
  try {
    writeFileSync(replacement, updated, { mode: statSync(documentPath).mode });
    if (readFileSync(documentPath, "utf8") !== markdown) {
      throw new Error("The editorial document changed during refresh. Run the refresh again.");
    }
    renameSync(replacement, documentPath);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return additions.filter((entry) => entry.startsWith("<!-- media-follow-up ")).length;
}

if (import.meta.main) {
  const [databasePath, documentPath = "docs/evaluations/media-unsure-entries.md", ...extra] = Bun.argv.slice(2);
  if (!databasePath || databasePath.startsWith("-") || extra.length) {
    console.error("Usage: bun scripts/refresh-media-editorial.ts <private-sqlite-path> [markdown-path]");
    process.exitCode = 1;
  } else {
    console.log(`Added ${refreshMediaEditorial(databasePath, documentPath)} editorial follow-up entries.`);
  }
}

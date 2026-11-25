import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { refreshMediaEditorial } from "../scripts/refresh-media-editorial";
import { isOmissionAmendment, mediaEditorialKey } from "../src/lib/media-amendments";
import { openTestDatabase } from "./support/db";

test("refresh adds stored omissions once and preserves edited wording and amendments", () => {
  const fixture = openTestDatabase();
  try {
    const markdown = join(fixture.directory, "editorial.md");
    writeFileSync(markdown, "# Manual notes\r\n\r\nExisting question.\r\n");
    const { native } = fixture;
    native.run("INSERT INTO apps (appid, name, slug) VALUES (1, 'Test Game', 'test-game')");
    const run = native.query<{ id: number }, []>(`
      INSERT INTO media_discovery_runs (pass, identity_key, selected_games, status)
      VALUES ('initial', 'editorial-test', '[1]', 'completed')
      RETURNING id
    `).get()!.id;
    const overview = native.prepare(`
      INSERT INTO media_game_overviews (appid, input_identity, model, config_version, output_json)
      VALUES (1, ?, 'test', 'test', ?)
    `);
    const job = native.prepare(`
      INSERT INTO media_processing_jobs (
        run_id, stage, appid, request_key, input_identity, model, config_version, status, provider,
        enqueued_at, max_input_tokens, max_output_tokens, reserved_microusd, reservation_active, output_json
      )
      VALUES (?, 'synthesis', 1, ?, ?, 'test', 'test', ?, 'openrouter', CURRENT_TIMESTAMP, 100, 100, 0, 0, ?)
    `);
    const omission = { sourceIdentity: "version1", observationId: "observation1", question: "Which platform was played" };
    const output = (editorialOmissions: unknown[]) => JSON.stringify({ editorialOmissions });
    const source = native.query<{ id: number }, []>(`
      INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type)
      VALUES (1, 'initial', 'https://example.com/review?edition=pc&version=1', 'Launch review', 'IGN', CURRENT_TIMESTAMP, 'review')
      RETURNING id
    `).get()!;
    native.run(`
      INSERT INTO media_article_extractions (source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json)
      VALUES (?, 'version1', 'hash', 'test', 'test', 'test', ?)
    `, [source.id, JSON.stringify({
      observations: [{ id: "observation1", appid: 1, kind: "pro", category: "", text: "The launch has low latency", qualifiers: ["PC"] }],
      editorialOmissions: [{ ...omission, question: "Was latency measured" }],
    })]);
    overview.run("overview1", output([omission, null, { question: "incomplete entry" }]));
    overview.run("legacy", "{");
    job.run(run, "success", "overview1", "succeeded", output([omission]));
    job.run(run, "refused", "refused", "refused", output([
      { ...omission, question: "Which build was played", wording: "Latency stays low after launch" },
    ]));

    expect(refreshMediaEditorial(fixture.databasePath, markdown)).toBe(3);
    const generated = readFileSync(markdown, "utf8");
    expect(generated.match(/<!-- media-amendment /g)).toHaveLength(1);
    expect(generated).toContain("**Test Game** — Was latency measured");
    expect(generated).toContain("[Launch review](<https://example.com/review?edition=pc&amp;version=1>)");
    expect(generated).toContain("Recorded wording: The launch has low latency · PC");
    expect(generated).toContain("Recorded wording: Latency stays low after launch");
    const edited = generated
      .replace("Which platform was played", "Which console did the author identify?")
      .replace("<!-- /media-amendment -->", "The author documents the console launch.\r\n<!-- /media-amendment -->");
    writeFileSync(markdown, edited);
    expect(refreshMediaEditorial(fixture.databasePath, markdown)).toBe(0);
    expect(readFileSync(markdown, "utf8")).toBe(edited);

    overview.run("overview2", output([{ ...omission, sourceIdentity: "version2" }]));
    expect(refreshMediaEditorial(fixture.databasePath, markdown)).toBe(1);
    const updated = readFileSync(markdown, "utf8");
    expect(updated.startsWith(edited)).toBe(true);
    expect(updated.slice(edited.length)).toContain("Source version: version2");
    expect(updated.slice(edited.length)).toContain("<!-- media-amendment " + mediaEditorialKey("version2", "observation1"));
    expect(refreshMediaEditorial(fixture.databasePath, markdown)).toBe(0);
    expect(native.query("SELECT count(*) AS count FROM media_processing_jobs").get()).toEqual({ count: 2 });
  } finally {
    fixture.cleanup();
  }
});

test("built amendment reader uses the embedded document and scopes correction identity to exact evidence", async () => {
  const fixture = openTestDatabase();
  try {
    const library = join(fixture.directory, "src/lib");
    const docs = join(fixture.directory, "docs/evaluations");
    mkdirSync(library, { recursive: true });
    mkdirSync(docs, { recursive: true });
    const source = join(library, "media-amendments.ts");
    const markdown = join(docs, "media-unsure-entries.md");
    copyFileSync(new URL("../src/lib/media-amendments.ts", import.meta.url), source);
    const block = (version: string, observation: string, text: string) =>
      `<!-- media-amendment ${mediaEditorialKey(version, observation)} -->\r\n${text}\r\n<!-- /media-amendment -->\r\n`;
    const text = "Supported at PC launch.";
    const variants = [
      { text, document: block("v1", "observation", text) },
      { text, document: block("v1", "observation", "  " + text + "  ") + block("v1", "unrelated", "Different interpretation.") },
      ...["Supported after the first patch.", "Omit: Solo play only.", "omit: No evidence for multiplayer."].map((text) => ({
        text,
        document: block("v1", "observation", text),
      })),
    ];
    const identities: Array<string | undefined> = [];
    for (const [index, variant] of variants.entries()) {
      writeFileSync(markdown, variant.document);
      const outDir = join(fixture.directory, `build-${index}`);
      await build({
        configFile: false,
        logLevel: "silent",
        build: { ssr: source, outDir },
      });
      writeFileSync(markdown, "");
      const reader: typeof import("../src/lib/media-amendments") = await import(pathToFileURL(join(outDir, "media-amendments.js")).href);
      expect(reader.mediaAmendment("v2", "observation")).toBeUndefined();
      expect(reader.mediaAmendmentIdentity("v1", "missing")).toBeUndefined();
      expect(reader.mediaAmendment("v1", "observation")).toBe(variant.text);
      identities.push(reader.mediaAmendmentIdentity("v1", "observation"));
    }
    expect(identities[0]).toBeDefined();
    expect(identities[1]).toBe(identities[0]);
    expect(identities[2]).not.toBe(identities[0]);
    expect(identities[3]).not.toBe(identities[2]);
    expect(identities[4]).toBe(identities[3]);
  } finally {
    fixture.cleanup();
  }
});

test("recognizes an Omit directive with a case-insensitive prefix and optional reason", () => {
  expect(isOmissionAmendment("Omit: The author only played solo.")).toBe(true);
  expect(isOmissionAmendment("  oMiT:")).toBe(true);
  expect(isOmissionAmendment("The author only played solo.")).toBe(false);
  expect(isOmissionAmendment("The article says omit: a tag.")).toBe(false);
  expect(isOmissionAmendment(undefined)).toBe(false);
});

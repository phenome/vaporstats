import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MIN_USABLE_ARTICLE_CHARS } from "../src/lib/article-document";
import * as outletAccess from "../src/lib/media-outlet-access";
import * as ledger from "../src/lib/media-paid-ledger";

const root = join(import.meta.dir, "..");
const sourceFiles = [...new Set(
  ["lib/**/*.ts", "**/media-*.{ts,tsx}"].flatMap((pattern) => [...new Bun.Glob(pattern).scanSync(join(root, "src"))]),
)].sort();

function boundaryViolations(file: string, source: string): string[] {
  const violations: string[] = [];
  const responseProperty = String.raw`(?:\??\.\s*(?:ok|status)\b|\[\s*["'](?:ok|status)["']\s*\])`;
  const tavilyResponse = new RegExp(String.raw`\b(?:tavily|search)\w*(?:response|reply)\s*${responseProperty}`, "i");
  if (file !== "lib/media-tavily.ts" && (
    /api\.tavily\.com|tavily_search_http_\$\{|\b(?:tavilyFetch|searchFetch)\s*\(/i.test(source) || tavilyResponse.test(source)
  )) {
    violations.push(`${file}: use createTavilyTransport for Tavily requests and classifyTavilySearchOutcome for its response`);
  }
  const outletResponse = new RegExp(String.raw`\b(?:(?:article|outlet)\w*(?:response|reply)|answered)\s*${responseProperty}`, "i");
  const mediaArticleCaller = /^lib\/(?:article-document|media-[^/]+)\.ts$/.test(file);
  const mediaTransportModule = new Set([
    "lib/media-outlet-access.ts",
    "lib/media-tavily.ts",
    "lib/media-gemini.ts",
    "lib/media-openrouter.ts",
    "lib/media-paid-providers.ts",
  ]);
  const rawOutletContact = /\bredirect\s*:\s*["']manual["']|\b(?:fetch|fetchFn)\s*\(|\b(?:status|statusCode)\s*===?\s*(?:401|403|429)\b/;
  if (file !== "lib/media-outlet-access.ts" && (
    /["\x27]text\/html,application\/xhtml\+xml["\x27]|fetch_http_\$\{|\b(?:finishAnsweredAttempt|articleFetch|outletFetch)\s*\(/.test(source) || outletResponse.test(source)
    || (mediaArticleCaller && !mediaTransportModule.has(file) && rawOutletContact.test(source))
  )) {
    violations.push(`${file}: use fetchOutletArticle to contact an Outlet and classify its response`);
  }

  if (file !== "lib/media-gemini.ts" && /generativelanguage\.googleapis\.com|:asyncBatchEmbedContent/.test(source)) {
    violations.push(`${file}: use createGeminiBatchTransport for Gemini Batch requests`);
  }
  if (file !== "lib/media-embedding-vector.ts" && /\b(?:function\s+(?:decodeVector|encodeVector)\s*\(|(?:const|let)\s+(?:decodeVector|encodeVector)\s*(?:=|:)|GEMINI_EMBEDDING_DIMENSIONS\s*\*\s*Float32Array\.BYTES_PER_ELEMENT)/.test(source)) {
    violations.push(`${file}: use encodeVector and decodeVector for stored embedding vectors`);
  }

  return violations;
}

test("production media callers use the Outlet, provider and embedding vector interfaces", async () => {
  expect(sourceFiles).toContain("lib/article-document.ts");
  expect(sourceFiles).toContain("lib/media-discovery.ts");
  expect(sourceFiles).toContain("lib/media-processing.ts");
  const violations = await Promise.all(sourceFiles.map(async (file) =>
    boundaryViolations(file, await Bun.file(join(root, "src", file)).text())));
  expect(violations.flat()).toEqual([]);
});

test.each([
  ["lib/article-document.ts", "await outletFetch(url)", "fetchOutletArticle"],
  ["lib/media-processing.ts", "await advance.articleFetch(url)", "fetchOutletArticle"],
  ["lib/media-processing.ts", "const response = await fetch(source.original_url); if (response.status === 403) return null;", "fetchOutletArticle"],
  ["lib/media-discovery.ts", "if (answered.status === 403) return null", "fetchOutletArticle"],
  ["lib/media-discovery.ts", 'await request("https://api.tavily.com/search")', "createTavilyTransport"],
  ["lib/media-discovery.ts", "if (searchResponse.status === 432) return", "classifyTavilySearchOutcome"],
  ["lib/media-processing.ts", 'await request("https://generativelanguage.googleapis.com/v1beta")', "createGeminiBatchTransport"],
  ["lib/media-similarity.ts", "function decodeVector(bytes: Uint8Array) {}", "decodeVector"],
  ["lib/article-document.ts", "const bytes = GEMINI_EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT", "decodeVector"],
])("reports the supported interface for %s containing %s", (file, source, supported) => {
  expect(boundaryViolations(file, source).join("\n")).toContain(supported);
});

test.each([
  "if (!response.ok) return null",
  "const samples = new Float32Array(buffer)",
])("allows unrelated HTTP handling or typed arrays in article-document.ts: %s", (source) => {
  expect(boundaryViolations("lib/article-document.ts", source)).toEqual([]);
});

test("Outlet callers cannot finalize raw article responses", () => {
  expect(outletAccess.fetchOutletArticle).toBeFunction();
  expect(outletAccess).not.toHaveProperty("finishAnsweredAttempt");
});

test("callers record provider charges through ledger transitions", () => {
  expect(ledger).not.toHaveProperty("recordOpenRouterAnswer");
  expect(ledger).not.toHaveProperty("recordGeminiBatchCharge");
});

test("discovery and processing share the 120-character article minimum", async () => {
  expect(MIN_USABLE_ARTICLE_CHARS).toBe(120);
  for (const file of ["media-discovery.ts", "media-processing.ts"]) {
    const source = await Bun.file(join(root, "src/lib", file)).text();
    expect(source).toMatch(/\.length\s*[<>]=?\s*MIN_USABLE_ARTICLE_CHARS/);
    expect(source).not.toMatch(/\.length\s*[<>]=?\s*120\b/);
  }
});

test("the media glossary records the Provider stop and links to its contract probes", async () => {
  expect(existsSync(join(root, ["CONTEXT", "md"].join(".")))).toBe(false);
  const glossary = await Bun.file(join(root, "GLOSSARY.md")).text();
  expect(glossary).toMatch(/\*\*Provider stop\*\*:\n[^\n]*non-2xx[^\n]*432/);
  const probes = await Bun.file(join(root, "docs/agents/media-probes.md")).text();
  expect(probes).toContain("media-outlet-contract.test.ts");
  expect(probes).toContain("media-provider-contract.test.ts");
  expect(probes).toContain("MIN_USABLE_ARTICLE_CHARS");
});

const paidWorkLedger = "src/lib/media-paid-ledger.ts";

function paidWorkWriteViolations(file: string, source: string): string[] {
  if (file === paidWorkLedger) return [];
  const sql = source
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\(["'`])/g, "$1")
    .replace(/(["'`])\s*\+\s*\1/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\r\n]*/g, " ");
  const mutation = /\b(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+(?:(?:[\w"'`\[\]]+)\s*\.\s*)?["'`\[]?media_processing_(?:jobs|attempts)\b/i;
  const drizzleMutation = /\.\s*(?:insert|update|delete)\s*\(\s*(?:\w+\s*\.\s*)?mediaProcessing(?:Jobs|Attempts)\b/;
  return mutation.test(sql) || drizzleMutation.test(source)
    ? [`${file}: use the Paid-work ledger interface in ${paidWorkLedger} for job and attempt transitions`]
    : [];
}

test("production writes Paid-work jobs and attempts through src/lib/media-paid-ledger.ts", async () => {
  const productionFiles = [...new Bun.Glob("{src,workers,scripts}/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}").scanSync(root)]
    // The migration check seeds historical schemas in temporary databases.
    .filter((file) => file !== "scripts/check-migrations.ts")
    .sort();
  expect(productionFiles).toContain("src/lib/article-document.ts");
  const violations = await Promise.all(productionFiles.map(async (file) =>
    paidWorkWriteViolations(file, await Bun.file(join(root, file)).text())));
  expect(violations.flat()).toEqual([]);
});

test.each([
  ['db.exec("INSERT OR IGNORE INTO media_processing_jobs VALUES (?)")'],
  ['db.prepare(`update /* reason */ main."media_processing_jobs" SET status = ?`)'],
  ['db.exec(`WITH old AS (SELECT 1) DELETE\nFROM [media_processing_attempts] WHERE id = 1`)'],
  ['db.insert(schema.mediaProcessingAttempts).values(attempt)'],
  ['db.exec("UPDATE " + "media_processing_attempts SET error = NULL")'],
  ["db.exec(`UPDATE 'media_processing_jobs' SET error = NULL`)"],
  [String.raw`db.exec("DELETE -- remove abandoned work\nFROM media_processing_jobs")`],
])("reports the Paid-work ledger for a forbidden write in %s", (source) => {
  expect(paidWorkWriteViolations("src/lib/article-document.ts", source).join("\n")).toContain(paidWorkLedger);
  expect(paidWorkWriteViolations(paidWorkLedger, source)).toEqual([]);
});

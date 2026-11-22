import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MIN_USABLE_ARTICLE_CHARS } from "../src/lib/article-document";

const root = join(import.meta.dir, "..");
const mediaFiles = [...new Bun.Glob("**/media-*.{ts,tsx}").scanSync(join(root, "src"))].sort();
const adapters = ["lib/media-outlet-access.ts", "lib/media-tavily.ts"];

function boundaryViolations(file: string, source: string): string[] {
  if (adapters.includes(file)) return [];
  const violations: string[] = [];
  const sourceWithoutTavilyImport = source.replaceAll(/from ["'][^"']*\/media-tavily["']/g, "");
  if (/api\.tavily\.com|tavily_search_http_\$\{|\b(?:tavily|search)\w*(?:response|reply)\s*(?:\??\.\s*(?:ok|status)|\[\s*["'](?:ok|status)["']\s*\])/i.test(sourceWithoutTavilyImport)) {
    violations.push(`${file}: use createTavilyTransport for Tavily requests and classifyTavilySearchOutcome for its response`);
  }
  if (/\bredirect\s*:\s*["']manual["']|text\/html,application\/xhtml\+xml|\bfinishAnsweredAttempt\s*\(|\b(?:articleFetch|outletFetch)\s*\(/.test(source)) {
    violations.push(`${file}: use fetchOutletArticle to contact an Outlet and classify its response`);
  }

  // OpenRouter and paid-provider classifiers have their own HTTP contracts.
  const paidAdapter = ["lib/media-openrouter.ts", "lib/media-paid-providers.ts", "lib/media-gemini.ts"].includes(file);
  if (paidAdapter) return violations;
  // Until the Gemini adapter moves, permit its existing provider transport.
  const callers = file === "lib/media-processing.ts"
    ? source.replace(/^function providerError\([\s\S]*?(?=^function normalizeUsage\()/m, "")
    : source;
  const rawFetch = /\b(?:fetch|fetchFn|mediaFetch|searchFetch|tavilyFetch)\s*\(/i;
  const inlineStatus = /(?:\??\.\s*ok\b|\[\s*["']ok["']\s*\])|\bstatus(?:Code|_code)?\s*[=!<>]=?=?\s*[1-5]\d\d\b|\b[1-5]\d\d\s*[=!<>]=?=?\s*(?:\w+\.)?status\b|\bcase\s+[1-5]\d\d\s*:/;
  if (rawFetch.test(callers) || inlineStatus.test(callers)) {
    violations.push(`${file}: use fetchOutletArticle for Outlet HTTP handling or createTavilyTransport / classifyTavilySearchOutcome for Tavily HTTP handling`);
  }
  return violations;
}

test("production media callers use the Outlet and Tavily interfaces", async () => {
  expect(mediaFiles).toContain("lib/media-discovery.ts");
  expect(mediaFiles).toContain("lib/media-processing.ts");
  const violations = await Promise.all(mediaFiles.map(async (file) =>
    boundaryViolations(file, await Bun.file(join(root, "src", file)).text())));
  expect(violations.flat()).toEqual([]);
});

test.each([
  ["lib/media-extra.ts", "await fetch(url)", "fetchOutletArticle"],
  ["lib/media-processing.ts", "await advance.articleFetch(url)", "fetchOutletArticle"],
  ["lib/media-discovery.ts", "if (answered.status === 403) return null", "fetchOutletArticle"],
  ["lib/media-discovery.ts", 'await request("https://api.tavily.com/search")', "createTavilyTransport"],
  ["lib/media-discovery.ts", "if (searchResponse.status === 432) return", "classifyTavilySearchOutcome"],
])("reports the supported interface for %s containing %s", (file, source, supported) => {
  expect(boundaryViolations(file, source).join("\n")).toContain(supported);
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

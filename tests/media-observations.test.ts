import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { extractionReviewIssues, parseArticleObservations, synthesisSelections, validateSynthesisClauses, validateSynthesisSelections, validateObservationSynthesis, type ObservationSource } from "../src/lib/media-observations";
import { createMediaEvidenceSource, parseMediaOverview } from "../src/lib/media-overview";
import { advanceMediaProcessing, authorizeMediaProcessing, OPENROUTER_TEXT_MODEL } from "../src/lib/media-processing";
import type { OpenRouterTransport } from "../src/lib/media-openrouter";
import { openTestDatabase } from "./support/db";
import { CYBERPUNK, emptySynthesisSelection, insertCompletedRun, insertSources, seedApps, stableJson, synthesisEvidence, synthesisSelectionId } from "./support/media";

const category = "Gameplay & systems";
const quote = "At PC launch, flexible builds made its combat approachable and I finished the campaign solo.";
const patchQuote = "In Early Access, the skill tree was capped at six tiers.";
const settingQuote = "Night City is a dense metropolis shaped by corporate power.";
const article = `${quote} ${patchQuote} ${settingQuote}`;
const finding = { id: "launch-combat", appid: CYBERPUNK, kind: "finding" as const, category, text: "Flexible builds make combat approachable.", qualifiers: ["At PC launch"], quote };
const setting = { id: "setting", appid: CYBERPUNK, kind: "finding", category: "Story & world", text: "Corporate power shapes Night City.", qualifiers: [], quote: settingQuote };
const patchTag = { id: "skill-tiers", appid: CYBERPUNK, kind: "tag", category: "", text: "Six skill tiers", qualifiers: ["Early Access"], quote: patchQuote };
const soloTag = { id: "solo", appid: CYBERPUNK, kind: "tag", category: "", text: "Single-player", qualifiers: [], quote };

test("canonical decimal AppIDs retain source identity and diagnostics", () => {
  const rows = { observations: [
    { ...finding, appid: String(CYBERPUNK) },
    { ...finding, id: "wrong", appid: String(CYBERPUNK + 1) },
    { ...finding, id: "padded", appid: "0" + CYBERPUNK },
    { ...finding, id: "unsupported", appid: String(CYBERPUNK), quote: "This excerpt is absent" },
  ] };
  const accepted = parseArticleObservations(rows, CYBERPUNK, article);
  expect(accepted.map(item => [item.id, item.appid])).toEqual([[finding.id, CYBERPUNK]]);
  expect(extractionReviewIssues(rows, CYBERPUNK, "version", accepted, article, []).map(item => item.observationId)).toEqual(["unsupported"]);
});

test("each synthesis section offers only eligible IDs and resolves selections to their evidence", () => {
  const observations = parseArticleObservations({ observations: [
    finding, setting, patchTag, { ...finding, id: "matching-only", kind: "gameplay", category: "" },
  ] }, CYBERPUNK, article);
  const source = { sourceIdentity: "article-version", sourceUrl: "https://example.test/review", observations };
  const selections = synthesisSelections([source]);
  expect(selections.choices.get("statements")).toEqual(["o1", "o2"]);
  expect(selections.choices.get(category)).toEqual(["o1"]);
  expect(selections.choices.get("tags")).toEqual(["o3"]);
  expect(selections.observationsById.size).toBe(3);
  const result = validateSynthesisSelections({ statements: [["o1"], ["o3"], ["unknown"]] }, CYBERPUNK, [source], selections);
  expect(result.overview.statements).toHaveLength(1);
  expect(result.overview.statements[0]).toMatchObject({
    observationRefs: [{ sourceIdentity: source.sourceIdentity, observationId: finding.id }],
    sourceUrls: [source.sourceUrl],
  });
});

test("v13 shares compatible PC evidence, keeps patch details separate, and retains distinct detail sharing a citation", () => {
  function source(id: string, text: string, qualifiers: string[] = [], platform: string | null = null): ObservationSource {
    return {
      sourceIdentity: id,
      sourceUrl: `https://${id}.test/review`,
      observations: [{ ...finding, text, qualifiers }],
      editionContext: { platform, build: null },
    };
  }
  const sources = [
    source("eurogamer", "Dialogue overlapped in the reviewed PC version."),
    source("ign", "Conversations interrupted each other.", ["PC"], "PC"),
    source("pcgamer", "Vehicles spawned inside each other.", ["Day 0 patch"], "PC"),
    source("switch", "On the Switch 2 port, lighting is soft but street decorations remain visible.", [], "Switch"),
  ];
  const evidence = synthesisSelections(sources, { clauses: "v13" });
  expect(evidence.evidence.map(({ observations }) => observations.map((item) => "scopeGroup" in item ? item.scopeGroup : null))).toEqual([["s1"], ["s1"], ["s2"], ["s3"]]);
  const lead = { text: "Dialogue can overlap.", observationIds: ["o1", "o2"] };
  const checked = validateSynthesisClauses({
    statements: [
      lead,
      { text: "Bugs interrupt play.", observationIds: ["o1", "o2", "o3"] },
      { text: "Lighting looks soft.", observationIds: ["o4"] },
      { text: "The reviewer described soft lighting.", observationIds: ["o4"] },
    ],
    categories: { [category]: [
      lead,
      { text: "Vehicles can spawn inside each other.", observationIds: ["o3"] },
      { text: "Street decorations remain visible.", observationIds: ["o4"] },
    ] },
  }, CYBERPUNK, sources, evidence);
  expect(checked.overview.statements).toMatchObject([
    { edition: "PC", sourceUrls: [sources[0]!.sourceUrl, sources[1]!.sourceUrl] },
    { edition: "Switch 2", sourceUrls: [sources[3]!.sourceUrl] },
  ]);
  expect(checked.overview.statements[0]?.text).not.toContain("Day 0");
  expect(checked.overview.categories[0]?.findings).toMatchObject([
    { text: "Vehicles can spawn inside each other (Day 0 patch, PC)", sourceUrls: [sources[2]!.sourceUrl] },
    { text: "Street decorations remain visible (On the Switch 2 port)", edition: "Switch 2" },
  ]);
  expect(checked.diagnostics).toMatchObject([
    { reason: "claim combines different evidence scopes" },
    { trigger: "reviewer" },
  ]);
  const citationSources = new Map(sources.map(({ sourceIdentity, sourceUrl }) =>
    [sourceUrl, createMediaEvidenceSource({ outlet: sourceIdentity, url: sourceUrl })]));
  expect(parseMediaOverview(checked.overview, CYBERPUNK, citationSources)?.categories[0]?.findings)
    .toContainEqual({ text: "Street decorations remain visible (On the Switch 2 port)", edition: "Switch 2", sourceUrls: [sources[3]!.sourceUrl] });
});

test("v13 distinguishes explicit 1.0 observations from observations about both 1.0 and Early Access", () => {
  const source: ObservationSource = {
    sourceIdentity: "test",
    sourceUrl: "https://example.test",
    observations: [
      { ...finding, text: "The opening moves slowly in both early access and 1.0.", qualifiers: [] },
      { ...finding, id: "release", text: "PC 1.0 unlocks the next region earlier.", qualifiers: [] },
    ],
  };
  const reply = { statements: [
    { text: source.observations[0]!.text, observationIds: ["o1"] },
    { text: source.observations[1]!.text, observationIds: ["o2"] },
  ] };
  const checkout = (version: "v12" | "v13") => validateSynthesisClauses(reply, CYBERPUNK, [source], synthesisSelections([source], { clauses: version }), version);
  expect(checkout("v12").overview.statements.map(({ edition }) => edition)).toEqual(["Early Access", undefined]);
  expect(checkout("v13").overview.statements.map(({ edition }) => edition)).toEqual([undefined, "PC 1.0"]);
});

test("keeps single-reviewer Hades II findings through selection, settlement and the Overview reader", () => {
  const appid = 1145350;
  const sourceUrl = "https://www.pcgamer.com/games/action/hades-2-review/";
  const observations = [
    {
      ...finding, appid, id: "legacy-1", qualifiers: [],
      text: "Describes Melinoë's magic-infused normal attacks, weapon and power combinations, and the flexible build options that the reviewer says rarely punish experimentation, based on the 1.0 version played on PC.",
    },
    {
      ...finding, appid, id: "legacy-2", qualifiers: [],
      text: "Describes a crafting-heavy opening in which progression depends on gathering reagents and brewing Incantations in the Crossroads hub, and says the reviewer found this slow in both early access and 1.0.",
    },
  ];
  const source = { sourceIdentity: "pc-gamer", sourceUrl, observations };
  const selections = synthesisSelections([source]);
  expect(selections.choices.get("statements")).toEqual(["o1", "o2"]);
  const checked = validateSynthesisSelections({ statements: [["o1"], ["o2"]] }, appid, [source], selections);
  expect(checked.diagnostics).toEqual([]);
  const citations = new Map([[sourceUrl, createMediaEvidenceSource({ outlet: "PC Gamer", url: sourceUrl })]]);
  expect(parseMediaOverview(checked.overview, appid, citations)?.statements).toEqual(
    observations.map(({ text }) => ({ text, sourceUrls: [sourceUrl] })),
  );
  expect(parseMediaOverview(checked.overview, appid, new Map())).toBeNull();
});

test("reports the matched collective wording and source counts separately from display length", () => {
  const observations = [
    { ...finding, id: "critic", text: "The critic found combat approachable." },
    { ...finding, id: "collective", text: "Critics describe combat as approachable." },
    { ...finding, id: "count", text: "One Review describes combat as approachable." },
    { ...finding, id: "plural-count", text: "2 reviews describe combat as approachable." },
    { ...finding, id: "long", text: "Flexible builds make combat approachable ".repeat(40).trim() },
  ];
  const sourceIdentity = "original";
  const sourceUrl = "https://example.test/review";
  const source = { sourceIdentity, sourceUrl, observations };
  const selections = synthesisSelections([source]);
  const diagnostics = [
    { section: "statements", reason: "claim uses source-support language", trigger: "Critics" },
    { section: "statements", reason: "claim uses source-support language", trigger: "One Review" },
    { section: "statements", reason: "claim uses source-support language", trigger: "2 reviews" },
    { section: "statements", reason: "claim exceeds the display limit" },
  ];
  expect(selections.choices.get("statements")).toEqual(["o1"]);
  expect(selections.diagnostics).toEqual(diagnostics);
  expect(selections.editorialOmissions[0]?.question).toContain('"Critics"');

  const checked = validateObservationSynthesis({
    statements: observations.map(({ id, text }) => ({ text, observationRefs: [{ sourceIdentity, observationId: id }] })),
  }, CYBERPUNK, [source]);
  expect(checked.diagnostics).toEqual(diagnostics);
  expect(checked.overview.statements.map(({ observationRefs }) => observationRefs[0]?.observationId)).toEqual(["critic"]);

  const citations = new Map([
    [sourceUrl, createMediaEvidenceSource({ outlet: "Outlet A", url: sourceUrl })],
    ["https://example.test/other", createMediaEvidenceSource({ outlet: "Outlet B", url: "https://example.test/other" })],
  ]);
  const stored = { statements: observations.slice(0, -1).map(({ text }) => ({ text, sourceUrls: [...citations.keys()] })) };
  expect(parseMediaOverview(stored, CYBERPUNK, citations)?.statements.map(({ text }) => text)).toEqual([observations[0]!.text]);
});

test("v10 settlement resolves the original aliases after singular attribution becomes eligible", () => {
  const attributed = { ...finding, id: "attributed", text: "The reviewer found combat approachable." };
  const count = { ...finding, id: "article-count", text: "One article describes approachable combat." };
  const earlier = { sourceIdentity: "a", sourceUrl: "https://example.test/earlier", observations: [attributed, count] };
  const later = { sourceIdentity: "b", sourceUrl: "https://example.test/later", observations: [finding] };
  const sources = [later, earlier];
  const current = synthesisSelections(sources);
  const legacy = synthesisSelections(sources, { legacyV10: true });
  expect(current.observationsById.get("o1")?.observation.id).toBe(attributed.id);
  expect(legacy.observationsById.get("o1")?.observation.id).toBe(count.id);
  expect(legacy.observationsById.get("o2")?.observation.id).toBe(finding.id);
  const settled = validateSynthesisSelections({ statements: [["o1"], ["o2"]] }, CYBERPUNK, sources, legacy);
  expect(settled.overview.statements.map(({ sourceUrls }) => sourceUrls)).toEqual([[later.sourceUrl]]);
  expect(settled.diagnostics).toEqual([
    { section: "statements", reason: "claim uses source-support language", trigger: "One article" },
  ]);
});

test("validates the game, evidence excerpt and scope without giving unrelated observations the whole article's context", () => {
  const observations = parseArticleObservations({ observations: [
    finding, setting, patchTag, soloTag,
    { ...finding, id: "wrong-game", appid: CYBERPUNK + 1 },
    { ...finding, id: "bad-quote", quote: "A snippet that is absent from the article." },
    { ...patchTag, id: "historic-generalization", qualifiers: [] },
    { ...finding, id: "body-date-inference", qualifiers: ["launch on November 12"] },
    { ...finding, id: "launch-as-current", qualifiers: [] },
  ] }, CYBERPUNK, article, ["PC", "Early Access"]);
  expect(observations.map(({ id, qualifiers }) => ({ id, qualifiers }))).toEqual([
    { id: finding.id, qualifiers: ["At PC launch"] },
    { id: setting.id, qualifiers: [] },
    { id: patchTag.id, qualifiers: ["Early Access"] },
  ]);
  expect(observations[0]).not.toHaveProperty("quote");
});

test("retains independently cited clauses, appends scope and refuses unsupported additions", () => {
  const observations = parseArticleObservations({ observations: [finding, setting, patchTag] }, CYBERPUNK, article);
  const sourceIdentity = "current-content-version";
  const sourceUrl = "https://example.test/review";
  const ref = (observationId: string) => ({ sourceIdentity, observationId });
  const checked = validateObservationSynthesis({
    statements: [
      { text: finding.text, observationRefs: [ref(finding.id)], sourceUrls: ["https://untrusted.test/"] },
      { text: setting.text, observationRefs: [ref(setting.id)] },
      { text: `${finding.text} The enemies scale to the player's level.`, observationRefs: [ref(finding.id)] },
      { text: setting.text, observationRefs: [{ ...ref(setting.id), sourceIdentity: "old-content-version" }] },
    ],
    categories: [{ name: "Story & world", findings: [{ text: finding.text, observationRefs: [ref(finding.id)] }] }],
    tags: [
      { label: patchTag.text, observationRefs: [ref(patchTag.id)] },
      { label: "Current skill tiers", observationRefs: [ref(patchTag.id)] },
      { label: "Flexible builds", observationRefs: [ref(finding.id)] },
    ],
  }, CYBERPUNK, [{ sourceIdentity, sourceUrl, observations }]);
  expect(checked.overview.statements).toEqual([
    { text: "Flexible builds make combat approachable (At PC launch)", sourceUrls: [sourceUrl], observationRefs: [ref(finding.id)] },
    { text: setting.text, sourceUrls: [sourceUrl], observationRefs: [ref(setting.id)] },
  ]);
  expect(checked.overview.categories).toEqual([]);
  expect(checked.overview.tags).toEqual([{ label: "Six skill tiers (Early Access)", sourceUrls: [sourceUrl], observationRefs: [ref(patchTag.id)] }]);
  expect(checked.diagnostics).toHaveLength(5);
  expect(checked.editorialOmissions).toContainEqual(expect.objectContaining(ref(finding.id)));
});

test("two outlets can support distinct wording and version differences cannot be presented as disagreements", () => {
  const laterQuote = "At release, combat was approachable only after switching weapons.";
  const laterFinding = { ...finding, id: "release-combat", quote: laterQuote,
    text: "Switching weapons makes combat approachable.", qualifiers: ["At release"] };
  const original = { sourceIdentity: "original-v1", observationId: finding.id };
  const later = { sourceIdentity: "later-v1", observationId: laterFinding.id };
  const originalUrl = "https://example.test/original";
  const laterUrl = "https://example.test/later";
  const checked = validateObservationSynthesis({
    statements: [{ text: finding.text, observationRefs: [original] }, { text: laterFinding.text, observationRefs: [later] }],
    categories: [{ name: category, findings: [{
      text: `${finding.text} / ${laterFinding.text}`, observationRefs: [original, later], contested: true,
    }] }],
  }, CYBERPUNK, [
    { sourceIdentity: original.sourceIdentity, sourceUrl: originalUrl, observations: parseArticleObservations({ observations: [finding] }, CYBERPUNK, article) },
    { sourceIdentity: later.sourceIdentity, sourceUrl: laterUrl, observations: parseArticleObservations({ observations: [laterFinding] }, CYBERPUNK, laterQuote) },
  ]);
  expect(checked.overview.statements.map(({ sourceUrls }) => sourceUrls)).toEqual([[originalUrl], [laterUrl]]);
  expect(checked.overview.categories).toEqual([]);
  expect(checked.editorialOmissions).toEqual(expect.arrayContaining([
    expect.objectContaining(original), expect.objectContaining(later),
  ]));
});

for (const mode of ["mixed", "refused", "pending", "malformed"] as const) {
  test(`normal queue stores ${mode} observation evidence and editorial issues with injected OpenRouter replies`, async () => {
    const database = openTestDatabase("vaporstats-observations-");
    try {
      seedApps(database.native, [CYBERPUNK]);
      insertSources(database.native, CYBERPUNK, "initial", 1);
      const runId = insertCompletedRun(database.native, `initial:observations:${mode}`, [CYBERPUNK]);
      await authorizeMediaProcessing(database.db, runId);
      const requests: string[] = [];
      let observationRefs: Array<{ sourceIdentity: string; observationId: string }> = [];
      const openRouter: OpenRouterTransport = {
        currentKey: async () => ({ limit: null, limit_remaining: null }),
        async complete(request) {
          const extraction = request.response_format.type === "json_object";
          requests.push(extraction ? "extraction" : "synthesis");
          const pending = { ...finding, reviewQuestion: "Which launch build was played?" };
          let content = JSON.stringify({ observations: mode === "pending" ? [pending] : [finding, patchTag, soloTag] });
          if (!extraction) {
            const sources = synthesisEvidence(request);
            const [source] = sources;
            observationRefs = [{ sourceIdentity: source!.sourceIdentity, observationId: finding.id }];
            const tagId = synthesisSelectionId(source!, patchTag.id);
            expect(source!.extraction.observations.find(({ id }) => id === finding.id)).toMatchObject({
              qualifiers: [],
              versionEvidence: { observed: ["PC launch"], distinctions: [], technical: false },
            });
            expect(request.messages[0]?.content).toContain("Treat the source platform, review date and build as review context.");
            content = mode === "malformed" ? "not JSON" : JSON.stringify({
              ...emptySynthesisSelection(sources),
              statements: [
                ...(mode === "mixed" ? [{ text: finding.text, observationIds: [synthesisSelectionId(source!, finding.id)] }] : []),
                { text: patchTag.text, observationIds: [tagId] },
              ],
              tags: [[tagId]],
            });
          }
          return { generationId: "observation-fixture", model: request.model, provider: null, content, finishReason: "stop", nativeFinishReason: null,
            usage: { promptTokens: 100, completionTokens: 40, reasoningTokens: 0, cost: 0.00015 } };
        },
      };
      const options = { runId, openRouter, now: new Date("2026-11-25T03:00:00Z"),
        articleFetch: async () => `<!doctype html><article><h1>Cyberpunk 2077</h1><p>${article}</p></article>` };
      await advanceMediaProcessing(database.db, options);
      await advanceMediaProcessing(database.db, options);
      const jobs = database.native.query<{ stage: string; status: string; error: string | null; output_json: string }, []>(
        "SELECT stage, status, error, output_json FROM media_processing_jobs ORDER BY id",
      ).all();
      expect(requests).toEqual(mode === "pending" ? ["extraction"] : ["extraction", "synthesis"]);
      expect(jobs.map(({ stage, status }) => [stage, status])).toEqual([
        ["extraction", "succeeded"], ["synthesis", mode === "mixed" ? "succeeded" : "refused"],
      ]);
      expect(jobs[0]!.output_json).not.toContain(quote);
      const synthesis = JSON.parse(jobs[1]!.output_json);
      expect(synthesis.editorialOmissions).toEqual(expect.arrayContaining([
        expect.objectContaining({ observationId: mode === "pending" ? finding.id : soloTag.id }),
      ]));
      if (mode === "mixed") {
        expect(JSON.parse(database.native.query<{ output_json: string }, []>("SELECT output_json FROM media_game_overviews WHERE active = 1").get()!.output_json)).toMatchObject({
          statements: [{ text: "Flexible builds make combat approachable.", observationRefs }],
          tags: [{ label: "Six skill tiers (Early Access)", slug: "six-skill-tiers-early-access" }],
        });
        expect(database.native.query("SELECT tag_slug FROM media_tag_memberships").all()).toEqual([{ tag_slug: "six-skill-tiers-early-access" }]);
      } else {
        expect(jobs[1]!.error).toBe(mode === "malformed" ? "invalid_output: malformed JSON" : "invalid_output: no cited statements");
        expect(database.native.query("SELECT id FROM media_game_overviews").all()).toEqual([]);
      }
      if (mode === "refused" || mode === "pending") {
        const source = database.native.query<{ id: number }, []>("SELECT id FROM media_sources").get()!;
        const retryRun = insertCompletedRun(database.native, `later:observations:${mode}`, [CYBERPUNK]);
        await authorizeMediaProcessing(database.db, retryRun, { affectedSourceIds: [source.id] });
        await advanceMediaProcessing(database.db, { ...options, runId: retryRun });
        expect(requests).toEqual(mode === "pending" ? ["extraction"] : ["extraction", "synthesis"]);
      }
    } finally {
      database.cleanup();
    }
  });
}

test("drops paraphrases that turn two locations into a sequence or a possible outcome into a certainty", () => {
  const source = { sourceIdentity: "version", sourceUrl: "https://example.test/pc-review", observations: [
    { ...finding, id: "locations", text: "Runs take place on the surface and in the underworld.", qualifiers: [] },
    { ...finding, id: "ending", text: "Character quests can change the ending.", qualifiers: [] },
  ] };
  const result = validateSynthesisClauses({ statements: [
    { text: "Runs alternate between the surface and the underworld.", observationIds: ["o1"] },
    { text: "Completing a quest changes the ending.", observationIds: ["o2"] },
    { text: "Quests can change how the story ends.", observationIds: ["o2"] },
  ] }, CYBERPUNK, [source], synthesisSelections([source], { clauses: "v13" }));
  expect(result.overview.statements.map(s => s.text)).toEqual(["Quests can change how the story ends."]);
  expect(result.diagnostics).toHaveLength(2);
});

test("v14 combines general cross-platform evidence and keeps explicit version details and technical limits", () => {
  function source(id: string, platform: string, build: string | null, text: string, quote: string): ObservationSource {
    const observations = parseArticleObservations({ observations: [
      { ...finding, text, quote, qualifiers: [
        ...quote.match(/Switch 2 port|Early Access/g) ?? [],
      ] },
    ] }, CYBERPUNK, quote, [platform, build], false, true);
    expect(observations).toHaveLength(1);
    return { sourceIdentity: id, sourceUrl: `https://${id}.test/review`, editionContext: { platform, build }, observations };
  }
  const sources = [
    source("a", "PC", "PC 1.0", "Build choices reward experimentation.", "Build choices reward experimentation."),
    source("b", "Switch 2", null, "Build choices reward experimentation.", "Build choices reward experimentation."),
    source("c", "Switch 2", null, "Docked output reaches 1080p.", "On the Switch 2 port, docked output reaches 1080p."),
    source("d", "PC", "50GB Day 0 patch", "Animation glitches interrupted scenes.", "Animation glitches interrupted scenes."),
    source("e", "PC", "1.0", "The next area unlocks sooner.", "Version 1.0 unlocks the next area earlier than Early Access."),
    source("f", "PC", "Technical Test", "The dodge has a cooldown.", "The dodge has a cooldown."),
  ];
  const selections = synthesisSelections(sources, { clauses: "v14" });
  const [pc, port, docked, glitches, release, preview] = selections.evidence.flatMap(({ observations }) => observations);
  expect(pc).toMatchObject({ qualifiers: [], scopeGroup: "s1" });
  expect(port).toMatchObject({ qualifiers: [], scopeGroup: "s1" });
  expect(docked).toMatchObject({ qualifiers: ["Switch 2 port"], edition: "Switch 2 port" });
  expect(glitches).toMatchObject({ qualifiers: ["50GB Day 0 patch", "PC"] });
  expect(glitches).not.toHaveProperty("edition");
  expect(release).toMatchObject({ qualifiers: ["Version 1.0", "Early Access"] });
  expect(release).not.toHaveProperty("edition");
  expect(preview).toMatchObject({ qualifiers: ["Technical Test"] });
  const result = validateSynthesisClauses({ statements: [
    { text: "Build choices reward experimentation.", observationIds: ["o1", "o2"] },
    { text: "On Switch 2, build choices reward experimentation.", observationIds: ["o2"] },
    { text: "Docked output reaches 1080p on Switch 2.", observationIds: ["o3"] },
    { text: "Animation glitches interrupted scenes.", observationIds: ["o4"] },
    { text: "Version 1.0 unlocks the next area earlier than Early Access.", observationIds: ["o5"] },
    { text: "The dodge has a cooldown.", observationIds: ["o6"] },
  ] }, CYBERPUNK, sources, selections, "v14");
  expect(result.overview.statements).toMatchObject([
    { text: "Build choices reward experimentation.", sourceUrls: [sources[0]!.sourceUrl, sources[1]!.sourceUrl] },
    { edition: "Switch 2 port", sourceUrls: [sources[2]!.sourceUrl] },
    { text: "Animation glitches interrupted scenes (50GB Day 0 patch, PC)" },
    { text: "Version 1.0 unlocks the next area earlier than Early Access." },
    { text: "The dodge has a cooldown (Technical Test)" },
  ]);
  expect(result.diagnostics).toEqual([{ reason: "claim introduces a version distinction absent from its evidence", section: "statements", trigger: "Switch 2" }]);
});


test("a waiting v13 synthesis keeps its request identity, prompt and settlement", async () => {
  const database = openTestDatabase("vaporstats-v13-synthesis-");
  try {
    seedApps(database.native, [CYBERPUNK]);
    insertSources(database.native, CYBERPUNK, "initial", 1);
    const runId = insertCompletedRun(database.native, "initial:observations:v13", [CYBERPUNK]);
    await authorizeMediaProcessing(database.db, runId);
    const promptEvidence: unknown[] = [];
    const openRouter: OpenRouterTransport = {
      currentKey: async () => ({ limit: null, limit_remaining: null }),
      async complete(request) {
        const extraction = request.response_format.type === "json_object";
        const sources = extraction ? [] : synthesisEvidence(request);
        if (!extraction) promptEvidence.push(sources[0]?.extraction.observations[0]);
        const content = extraction ? { observations: [finding] } : {
          ...emptySynthesisSelection(sources),
          statements: [{ text: finding.text, observationIds: ["o1"] }],
        };
        return { generationId: "v13-fixture", model: request.model, provider: null, content: JSON.stringify(content),
          finishReason: "stop", nativeFinishReason: null, usage: { promptTokens: 100, completionTokens: 40, reasoningTokens: 0, cost: 0.00015 } };
      },
    };
    const options = { runId, openRouter, articleFetch: async () => `<article><p>${article}</p></article>` };
    await advanceMediaProcessing(database.db, { ...options, submissionsPerTick: 1, now: new Date("2026-11-25T03:00:00Z") });
    const configVersion = "media-synthesis-2026-11-25-v13";
    const extractions = database.native.query("SELECT source_id AS sourceId, input_identity AS inputIdentity FROM media_article_extractions").all();
    const identity = createHash("sha256").update(stableJson({ stage: "synthesis", appid: CYBERPUNK, model: OPENROUTER_TEXT_MODEL, configVersion, extractions })).digest("hex");
    const key = `synthesis:${CYBERPUNK}:${identity}`;
    expect(database.native.prepare("UPDATE media_processing_jobs SET config_version = ?, input_identity = ?, request_key = ? WHERE stage = 'synthesis' AND status = 'queued'")
      .run(configVersion, identity, key).changes).toBe(1);

    await advanceMediaProcessing(database.db, { ...options, now: new Date("2026-11-25T04:00:00Z") });
    expect(promptEvidence).toHaveLength(1);
    expect(promptEvidence[0]).toMatchObject({ qualifiers: ["At PC launch"], edition: "PC launch" });
    expect(promptEvidence[0]).not.toHaveProperty("versionEvidence");
    expect(database.native.query("SELECT config_version, input_identity, request_key, status FROM media_processing_jobs WHERE stage = 'synthesis'").all())
      .toEqual([{ config_version: configVersion, input_identity: identity, request_key: key, status: "succeeded" }]);
    const overview = database.native.query<{ output_json: string }, []>("SELECT output_json FROM media_game_overviews").get()!;
    expect(JSON.parse(overview.output_json).statements).toMatchObject([
      { text: "Flexible builds make combat approachable (At PC launch)", edition: "PC launch" },
    ]);
  } finally {
    database.cleanup();
  }
});

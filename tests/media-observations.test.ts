import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MediaOverviewSection } from "../src/components/media-overview";
import { createHash } from "node:crypto";
import { extractionReviewIssues, parseArticleObservations, readArticleObservations, synthesisSelections, validateSynthesisClauses, validateSynthesisSelections, validateObservationSynthesis, type ObservationSource } from "../src/lib/media-observations";
import { createMediaEvidenceSource, getMediaOverview, parseMediaOverview, PREMISE_FIRST_SYNTHESIS_VERSION, PREVIEW_SCOPE_SYNTHESIS_VERSION } from "../src/lib/media-overview";
import { advanceMediaProcessing, authorizeMediaProcessing, OPENROUTER_TEXT_MODEL } from "../src/lib/media-processing";
import { legacyObservationEvidence } from "../src/lib/media-legacy-observations";
import { MEDIA_OUTLETS } from "../src/lib/media-outlet-access";
import type { OpenRouterTransport } from "../src/lib/media-openrouter";
import { openTestDatabase } from "./support/db";
import { CYBERPUNK, HADES_II, emptySynthesisSelection, insertCompletedRun, insertSources, seedApps, stableJson, synthesisEvidence, synthesisSelectionId } from "./support/media";

const category = "Gameplay & systems";
const quote = "At PC launch, flexible builds made its combat approachable and I finished the campaign solo.";
const patchQuote = "In Early Access, the skill tree was capped at six tiers.";
const settingQuote = "Night City is a dense metropolis shaped by corporate power.";
const article = `${quote} ${patchQuote} ${settingQuote}`;
const finding = { id: "launch-combat", appid: CYBERPUNK, kind: "finding" as const, category, text: "Flexible builds make combat approachable.", qualifiers: ["At PC launch"], quote };
const setting = { id: "setting", appid: CYBERPUNK, kind: "finding", category: "Story & world", text: "Corporate power shapes Night City.", qualifiers: [], quote: settingQuote };
const patchTag = { id: "skill-tiers", appid: CYBERPUNK, kind: "tag" as const, category: "", text: "Six skill tiers", qualifiers: ["Early Access"], quote: patchQuote };
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

test("v19 projects new and stored evidence to concise, scoped discovery tags", () => {
  const tags = [
    { ...soloTag, id: "map", text: "The game has a single, unrestricted open urban map." },
    { ...soloTag, id: "camera", text: "The game uses a first-person perspective." },
    { ...soloTag, id: "paths", text: "The player chooses one of three life paths at the start that set background and early events." },
    { ...soloTag, id: "joy", text: "Supports Joy-Con mouse-style aiming on Switch 2" },
    { ...soloTag, id: "narrow", text: "Manual driving avoids load screens." },
    { ...soloTag, id: "rate", text: "60 FPS" },
  ];
  const observations = readArticleObservations(JSON.stringify({ observations: tags }), CYBERPUNK);
  const newerTag = (id: string, text: string, qualifiers: string[] = []) => ({ ...soloTag, id, text, qualifiers, quote: text });
  const newTags = [
    newerTag("shooter", "The game is a first-person shooter."),
    newerTag("seamless", "There are no loading screens."),
    newerTag("choices", "Choices affect the endings."),
    newerTag("controller", "Supports DualSense on PS5."),
    newerTag("triggers", "Supports adaptive triggers on PS5."),
    { ...newerTag("scoped", "Open world", ["Early Access"]), quote: "Early Access offers a large open world." },
    newerTag("another-map", "Open world game."),
  ];
  const newObservations = parseArticleObservations({ observations: newTags }, CYBERPUNK, newTags.map(({ quote }) => quote).join(" "));
  const sources = [
    { sourceIdentity: "a", sourceUrl: "https://example.test/stored", observations },
    { sourceIdentity: "b", sourceUrl: "https://example.test/new", observations: newObservations },
  ];
  const selections = synthesisSelections(sources, { clauses: "v19" });
  const alias = (id: string) => selections.evidence.flatMap(({ observations }) => observations)
    .find((observation) => observation.id === id)?.selectionId;
  const result = validateSynthesisClauses({ tags: [
    ["map", "another-map"], ["camera"], ["paths"], ["joy"], ["shooter"],
    ["seamless"], ["choices"], ["controller"], ["triggers"], ["scoped"], ["map", "scoped"], ["camera", "shooter"],
  ].map((ids) => ids.map(alias)) }, CYBERPUNK, sources, selections, "v19");
  expect(result.overview.tags.map(({ label }) => label)).toEqual([
    "Open world", "First-person perspective", "Selectable backgrounds", "Joy-Con support (Switch 2)",
    "FPS", "No load screens", "Choices matter",
    "DualSense support (PS5)", "Adaptive triggers (PS5)", "Open world (Early Access)",
  ]);
  expect(result.overview.tags[0]).toEqual({
    label: "Open world",
    sourceUrls: sources.map(({ sourceUrl }) => sourceUrl),
    observationRefs: [{ sourceIdentity: "a", observationId: "map" }, { sourceIdentity: "b", observationId: "another-map" }],
  });
  expect(result.diagnostics.filter(({ reason }) => reason === "claim wording or scope differs from its observations")).toHaveLength(2);
  expect(alias("rate")).toBeUndefined();
  expect(alias("narrow")).toBeUndefined();

  const historical = synthesisSelections(sources, { clauses: "v18" });
  const replay = validateSynthesisClauses({ tags: [["o1"], ["o2"], ["o3"], ["o4"]] }, CYBERPUNK, sources, historical, "v18");
  expect(replay.overview.tags.map(({ label }) => label)).toEqual(tags.slice(0, 4).map(({ text }) => text));
  expect(historical.evidence[0]?.observations[0]).not.toHaveProperty("discoveryLabel");
});

test("v20 accepts authored discovery phrases with exact tag citations and preserves their limits", () => {
  const tag = (id: string, text: string, qualifiers: string[] = []) => ({
    ...soloTag, id, text, qualifiers,
  });
  const sources = [
    { sourceIdentity: "stored", sourceUrl: "https://example.test/stored", observations: readArticleObservations({ observations: [
      tag("paths", "The player chooses one of three life paths at the start that set background and early events."),
      tag("port", "Supports Joy-Con mouse-style aiming on Nintendo Switch 2", ["Nintendo Switch 2"]),
      tag("restricted", "Manual driving avoids load screens", ["while driving manually"]),
      { ...finding, id: "prose" },
    ] }, CYBERPUNK) },
    { sourceIdentity: "new", sourceUrl: "https://example.test/new", observations: readArticleObservations({ observations: [
      tag("origins", "Choose a starting background to change the opening mission."),
      tag("preview", "Choose a starting background to change the opening mission.", ["Early Access"]),
      tag("foreign", "Choose a starting background to change the opening mission."),
    ] }, CYBERPUNK).map((item) => item.id === "foreign" ? { ...item, appid: CYBERPUNK + 1 } : item) },
  ];
  const selections = synthesisSelections(sources, { clauses: "v20" });
  const evidence = selections.evidence.flatMap(({ observations }) => observations);
  expect(evidence.find(({ id }) => id === "paths")?.text).toContain("three life paths");
  expect(evidence.some((item) => "discoveryLabel" in item)).toBe(false);
  const id = (observationId: string) => evidence.find(({ id }) => id === observationId)?.selectionId ?? observationId;
  const choice = (label: unknown, ...observationIds: string[]) => ({ label, observationIds: observationIds.map(id) });
  const result = validateSynthesisClauses({ tags: [
    choice("Selectable character backgrounds", "paths", "origins", "paths"),
    choice("Joy-Con mouse aiming on Switch 2", "port"),
    choice("Joy-Con mouse-style aiming", "port"),
    choice("Seamless traversal", "restricted"),
    choice("Starting backgrounds", "paths", "preview"),
    choice("Starting backgrounds on PS5", "port"),
    choice("Starting backgrounds after launch", "origins"),
    choice("Starting backgrounds", "paths", "prose"),
    choice("Starting backgrounds", "paths", "unknown"),
    choice("Starting backgrounds", "foreign"),
    choice("Starting backgrounds"),
    choice("The player chooses a life path.", "paths"),
    choice("Combat can reward experimentation", "paths"),
    choice("60 FPS", "paths"),
    choice(["Starting backgrounds"], "paths"),
    [id("paths")],
  ] }, CYBERPUNK, sources, selections, "v20");
  expect(result.overview.tags.map(({ label }) => label)).toEqual([
    "Selectable character backgrounds", "Joy-Con mouse aiming on Switch 2", "Joy-Con mouse-style aiming (Nintendo Switch 2)",
    "Seamless traversal (while driving manually)",
  ]);
  expect(result.overview.tags[0]).toEqual({
    label: "Selectable character backgrounds",
    sourceUrls: sources.map(({ sourceUrl }) => sourceUrl),
    observationRefs: [{ sourceIdentity: "stored", observationId: "paths" }, { sourceIdentity: "new", observationId: "origins" }],
  });
  expect(result.diagnostics.filter(({ section }) => section === "tags").map(({ reason }) => reason)).toEqual([
    "claim combines different evidence scopes",
    "claim introduces a version distinction absent from its evidence",
    "tag introduces timing absent from its evidence",
    "referenced observation has a different evidence category",
    ...Array(3).fill("missing or unknown observation reference"),
    ...Array(4).fill("tag label must be a concise discovery phrase"),
    "missing or unknown observation reference",
  ]);
});

test("v21 controller tags keep source scope and references while omitting implied native platforms", () => {
  const source: ObservationSource = {
    sourceIdentity: "controller-evidence",
    sourceUrl: "https://example.test/controls",
    observations: [
      { ...soloTag, kind: "tag", id: "aim", text: "Supports Joy-Con mouse-style aiming on Nintendo Switch 2", qualifiers: ["Nintendo Switch 2"] },
      { ...soloTag, kind: "tag", id: "compatibility", text: "Supports Joy-Con controllers on Nintendo Switch", qualifiers: ["Nintendo Switch"] },
      { ...soloTag, kind: "tag", id: "pc", text: "Supports DualSense adaptive triggers on PC", qualifiers: ["PC"] },
      { ...soloTag, kind: "tag", id: "demo", text: "Supports Joy-Con aiming on Switch 2 in the preview build", qualifiers: ["Switch 2", "preview build"] },
    ],
  };
  const selections = synthesisSelections([source], { clauses: "v21" });
  const evidence = selections.evidence.flatMap(({ observations }) => observations);
  expect(evidence.find(({ id }) => id === "aim")).toMatchObject({
    text: source.observations[0]!.text,
    qualifiers: ["Nintendo Switch 2"],
  });
  const choice = (label: string, ...refs: string[]) => ({
    label,
    observationIds: refs.map((ref) => evidence.find(({ id }) => id === ref)!.selectionId),
  });
  const result = validateSynthesisClauses({ tags: [
    choice("Joy-Con aiming on Switch 2", "aim"),
    choice("Joy-Con support", "compatibility"),
    choice("DualSense adaptive triggers on PC", "pc"),
    choice("Joy-Con aiming (Switch 2)", "demo"),
    choice("Joy-Con aiming", "aim", "demo"),
    choice("Joy-Con aiming on PS5", "aim"),
  ] }, CYBERPUNK, [source], selections, "v21");
  expect(result.overview.tags.map(({ label }) => label)).toEqual([
    "Joy-Con aiming", "Joy-Con support", "DualSense adaptive triggers on PC", "Joy-Con aiming (preview build)",
  ]);
  expect(result.overview.tags[0]).toEqual({
    label: "Joy-Con aiming",
    edition: "Nintendo Switch 2",
    sourceUrls: [source.sourceUrl],
    observationRefs: [{ sourceIdentity: source.sourceIdentity, observationId: "aim" }],
  });
  expect(result.diagnostics.filter(({ section }) => section === "tags").map(({ reason }) => reason)).toEqual([
    "claim combines different evidence scopes",
    "claim introduces a version distinction absent from its evidence",
  ]);
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
      const cameraText = "The game uses a first-person perspective.";
      const cameraTag = { ...soloTag, id: "camera", text: cameraText, quote: cameraText };
      const openRouter: OpenRouterTransport = {
        currentKey: async () => ({ limit: null, limit_remaining: null }),
        async complete(request) {
          const extraction = request.response_format.type === "json_object";
          requests.push(extraction ? "extraction" : "synthesis");
          const pending = { ...finding, reviewQuestion: "Which launch build was played?" };
          let content = JSON.stringify({ observations: mode === "pending" ? [pending] : [finding, patchTag, soloTag, cameraTag] });
          if (!extraction) {
            const sources = synthesisEvidence(request);
            const [source] = sources;
            observationRefs = [{ sourceIdentity: source!.sourceIdentity, observationId: finding.id }];
            const tagId = synthesisSelectionId(source!, patchTag.id);
            const cameraId = synthesisSelectionId(source!, cameraTag.id);
            expect(source!.extraction.observations.find(({ id }) => id === cameraTag.id)).toMatchObject({
              text: cameraText, qualifiers: [],
            });
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
              tags: [
                { label: "Tiered skills", observationIds: [tagId] },
                { label: "First-person perspective", observationIds: [cameraId] },
              ],
            });
          }
          return { generationId: "observation-fixture", model: request.model, provider: null, content, finishReason: "stop", nativeFinishReason: null,
            usage: { promptTokens: 100, completionTokens: 40, reasoningTokens: 0, cost: 0.00015 } };
        },
      };
      const options = { runId, openRouter, now: new Date("2026-11-25T03:00:00Z"),
        articleFetch: async () => `<!doctype html><article><h1>Cyberpunk 2077</h1><p>${article} ${cameraText}</p></article>` };
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
          tags: [
            { label: "Tiered skills", slug: "tiered-skills" },
            { label: "First-person perspective", slug: "first-person-perspective",
              observationRefs: [{ sourceIdentity: observationRefs[0]!.sourceIdentity, observationId: cameraTag.id }] },
          ],
        });
        expect(database.native.query("SELECT tag_slug FROM media_tag_memberships ORDER BY tag_slug").all()).toEqual([
          { tag_slug: "first-person-perspective" }, { tag_slug: "tiered-skills" },
        ]);
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


test.each(["v13", "v14", "v15", "v16", "v17", "v18", "v20", "v21", "v22", "v23", "v24", "v25"] as const)("a waiting %s synthesis keeps its request identity, prompt and settlement", async (version) => {
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
        if (!extraction) {
          const prompt = request.messages[0]!.content;
          expect(prompt.includes("first draft two or three sentences")).toBe(version === "v17" || version === "v18" || version === "v20" || version === "v21" || version === "v22" || version === "v23" || version === "v24" || version === "v25");
          expect(prompt.includes('say "during review" explicitly')).toBe(version === "v18" || version === "v20" || version === "v21" || version === "v22" || version === "v23" || version === "v24" || version === "v25");
          expect(prompt.includes("effect of a tested patch")).toBe(version === "v20" || version === "v21" || version === "v22" || version === "v23" || version === "v24" || version === "v25");
          expect(prompt.includes("Author a short, standalone noun phrase in label")).toBe(version === "v20" || version === "v21" || version === "v22");
          expect(prompt.includes("‘Joy-Con aiming’")).toBe(version === "v21" || version === "v22" || version === "v23" || version === "v24" || version === "v25");
          expect(prompt.includes("Room reward previews")).toBe(version === "v22" || version === "v23" || version === "v24" || version === "v25");
          expect(prompt.includes("Actions have consequences")).toBe(version === "v23" || version === "v24" || version === "v25");
          expect(prompt.includes("Review the tag candidates from every eligible article")).toBe(version === "v24" || version === "v25");
          expect(prompt.includes("Tag evidence index.")).toBe(version === "v25");
          if (request.response_format.type === "json_schema") {
            expect(request.response_format.json_schema.schema.required).toEqual(version === "v25" ? ["tags", "statements", "categories", "prosCons"] : ["statements", "categories", "prosCons", "tags"]);
          }
          promptEvidence.push(sources[0]?.extraction.observations[0]);
        }
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
    const date = version === "v13" || version === "v14" ? "2026-11-25" : "2026-11-26";
    const configVersion = `media-synthesis-${date}-${version}`;
    const extractions = database.native.query("SELECT source_id AS sourceId, input_identity AS inputIdentity FROM media_article_extractions").all();
    const identity = createHash("sha256").update(stableJson({ stage: "synthesis", appid: CYBERPUNK, model: OPENROUTER_TEXT_MODEL, configVersion, extractions })).digest("hex");
    const key = `synthesis:${CYBERPUNK}:${identity}`;
    expect(database.native.prepare("UPDATE media_processing_jobs SET config_version = ?, input_identity = ?, request_key = ? WHERE stage = 'synthesis' AND status = 'queued'")
      .run(configVersion, identity, key).changes).toBe(1);

    await advanceMediaProcessing(database.db, { ...options, now: new Date("2026-11-25T04:00:00Z") });
    expect(promptEvidence).toHaveLength(1);
    if (version === "v13") {
      expect(promptEvidence[0]).toMatchObject({ qualifiers: ["At PC launch"], edition: "PC launch" });
      expect(promptEvidence[0]).not.toHaveProperty("versionEvidence");
    } else {
      expect(promptEvidence[0]).toMatchObject({ qualifiers: [], versionEvidence: { technical: false } });
    }
    expect(database.native.query("SELECT config_version, input_identity, request_key, status FROM media_processing_jobs WHERE stage = 'synthesis'").all())
      .toEqual([{ config_version: configVersion, input_identity: identity, request_key: key, status: "succeeded" }]);
    const overview = database.native.query<{ output_json: string }, []>("SELECT output_json FROM media_game_overviews").get()!;
    expect(JSON.parse(overview.output_json).statements).toMatchObject([
      version === "v13"
        ? { text: "Flexible builds make combat approachable (At PC launch)", edition: "PC launch" }
        : { text: finding.text },
    ]);
  } finally {
    database.cleanup();
  }
});


test("a new synthesis queues typed premise and play evidence for the lead, then serves citation spans in composed order", async () => {
  const database = openTestDatabase("vaporstats-v16-synthesis-");
  try {
    seedApps(database.native, [CYBERPUNK]);
    insertSources(database.native, CYBERPUNK, "initial", 1, MEDIA_OUTLETS[0]);
    insertSources(database.native, CYBERPUNK, "initial", 1, MEDIA_OUTLETS[1]);
    const runId = insertCompletedRun(database.native, "initial:observations:v16", [CYBERPUNK]);
    await authorizeMediaProcessing(database.db, runId);
    const premise = { ...setting, id: "premise", kind: "storyWorld", category: "" };
    const playQuote = "Players experiment with different skill builds in combat.";
    const play = { ...finding, id: "play", kind: "gameplay", category: "", text: playQuote, quote: playQuote, qualifiers: [] };
    const lead = [
      "In Cyberpunk 2077, corporate power shapes Night City,",
      "where you can experiment with different skill builds in combat.",
    ];
    const openRouter: OpenRouterTransport = {
      currentKey: async () => ({ limit: null, limit_remaining: null }),
      async complete(request) {
        const prompt = request.messages[0]!.content;
        let content: unknown;
        if (request.response_format.type === "json_object") {
          const first = request.messages[1]!.content.includes(settingQuote);
          content = { observations: first ? [premise, play] : [
            { ...play, kind: "finding", category },
            { ...premise, id: "invented", quote: "This supporting passage is absent from the article." },
          ] };
        } else {
          expect(prompt).toContain("first draft two or three sentences");
          expect(prompt).toContain("Open with the game's name and its premise");
          expect(prompt).toContain("only when it materially affects the experience");
          expect(prompt).toContain("Include every independent article that supports the exact shared claim and scope");
          expect(prompt).toContain("When release evidence fully supports the claim, use the release group alone and leave out preview IDs");
          const sources = synthesisEvidence(request);
          const story = sources.find(({ extraction }) => extraction.observations.some(({ id }) => id === "premise"))!;
          const premiseId = synthesisSelectionId(story, "premise");
          const playIds = sources.map((source) => synthesisSelectionId(source, "play"));
          expect(sources.flatMap(({ extraction }) => extraction.observations.map(({ id }) => id))).not.toContain("invented");
          content = {
            ...emptySynthesisSelection(sources),
            statements: [
              { text: lead[0], observationIds: [premiseId] },
              { text: lead[1], observationIds: playIds },
            ],
            categories: {
              [category]: [{ text: "Gameplay premise", observationIds: [premiseId] }],
            },
          };
        }
        return { generationId: "v16-fixture", model: request.model, provider: null, content: JSON.stringify(content),
          finishReason: "stop", nativeFinishReason: null, usage: { promptTokens: 100, completionTokens: 40, reasoningTokens: 0, cost: 0.00015 } };
      },
    };
    await advanceMediaProcessing(database.db, {
      runId, openRouter,
      articleFetch: async (url) => `<article><p>${String(url).includes(MEDIA_OUTLETS[0].domain) ? article : quote} ${playQuote}</p></article>`,
      now: new Date("2026-11-26T03:00:00Z"),
    });
    const saved = database.native.query<{ config_version: string; output_json: string }, []>("SELECT config_version, output_json FROM media_game_overviews").get()!;
    expect(saved.config_version).toBe(PREVIEW_SCOPE_SYNTHESIS_VERSION);
    expect(JSON.parse(saved.output_json).statements.map(({ observationRefs }: { observationRefs: Array<{ observationId: string }> }) =>
      observationRefs.map(({ observationId }) => observationId))).toEqual([["premise"], ["play", "play"]]);
    const overview = await getMediaOverview(database.db, CYBERPUNK, { includeUnpublished: true });
    expect(overview?.composedLead).toBe(true);
    expect(overview?.statements.map(({ text }) => text)).toEqual(lead);
    expect(overview?.statements.map(({ sourceUrls }) => sourceUrls.length)).toEqual([1, 2]);
    expect(overview?.categories).toEqual([]);
    database.native.prepare("UPDATE media_game_overviews SET config_version = ?").run(PREMISE_FIRST_SYNTHESIS_VERSION);
    expect((await getMediaOverview(database.db, CYBERPUNK, { includeUnpublished: true }))?.statements.map(({ text }) => text))
      .toEqual(lead);
    database.native.prepare("UPDATE media_game_overviews SET config_version = ?").run("media-synthesis-2026-11-25-v14");
    const legacyOverview = await getMediaOverview(database.db, CYBERPUNK, { includeUnpublished: true });
    expect(legacyOverview?.composedLead).toBeUndefined();
    expect(legacyOverview?.statements.map(({ text }) => text)).toEqual([...lead].reverse());
  } finally {
    database.cleanup();
  }
});


test("v16 projects known incidental review wording without changing references or material scopes", () => {
  const source: ObservationSource = {
    sourceIdentity: "retained-extraction",
    sourceUrl: "https://example.test/review",
    editionContext: { platform: "PC", build: null },
    observations: [
      { ...finding, id: "context-prefix", text: "In the reviewed PC version, the city has multiple districts.", qualifiers: [] },
      { ...finding, id: "context-suffix", text: "Side quests can affect the ending (50GB Day 0 patch, PC).", qualifiers: [] },
      { ...finding, id: "comparison", text: "In the reviewed PC version, the game ran faster than on Switch 2.", qualifiers: [] },
      { ...finding, id: "qualified", text: "Vehicles can spawn inside one another in the reviewed PC version.", qualifiers: [] },
      { ...finding, id: "history", kind: "gameplay", category: "", text: "Side quests can affect the ending.", qualifiers: ["Early Access"] },
    ],
  };
  const v15 = synthesisSelections([source], { clauses: "v15" });
  const v16 = synthesisSelections([source], { clauses: "v16" });
  expect(v16.evidence[0]?.observations.map(({ text }) => text)).toEqual([
    "The city has multiple districts.",
    "Side quests can affect the ending.",
    ...source.observations.slice(2).map(({ text }) => text),
  ]);
  expect(v15.evidence[0]?.observations.map(({ text }) => text)).toEqual(source.observations.map(({ text }) => text));
  expect(v16.observationsById).toEqual(v15.observationsById);
  const checked = validateSynthesisClauses({ statements: [
    { text: "Side quests can affect the ending.", observationIds: ["o2", "o5"] },
    { text: "Side quests can affect the ending.", observationIds: ["o2"] },
  ] }, CYBERPUNK, [source], v16, "v16");
  expect(checked.diagnostics).toEqual([{ section: "statements", reason: "claim combines different evidence scopes" }]);
  expect(checked.overview.statements[0]?.observationRefs).toEqual([
    { sourceIdentity: source.sourceIdentity, observationId: "context-suffix" },
  ]);
});

const animationIssue = {
  ...finding,
  id: "animation",
  category: "Technical experience & accessibility",
  text: "Animation glitches interrupted scenes.",
  qualifiers: [],
};

test.each([
  ["At launch, animation glitches interrupted scenes.", "At launch"],
  ["Before the day-one patch, animation glitches interrupted scenes.", "Before the day-one patch"],
  ["After a patch, animation glitches interrupted fewer scenes.", "After a patch"],
  ["On December 10, 2020, animation glitches interrupted scenes.", "On December 10, 2020"],
  ["Frame rates dropped in the preview build.", "in the preview build"],
  ["Animation glitches interrupted scenes. A day-one patch will address these problems.", "during review"],
  ["Animation glitches interrupted scenes, but the studio plans a day-one patch.", "during review"],
  ["Animation glitches interrupted scenes and the studio announced a launch date.", "during review"],
  ["Animation glitches interrupted scenes, though not at launch.", "during review"],
  ["Animation glitches interrupted scenes.", "during review"],
])("v9 derives technical timing from the issue's excerpt: %s", (quote, expected) => {
  const text = quote.startsWith("Frame rates") ? "Frame rates dropped." : animationIssue.text;
  const output = { observations: [{ ...animationIssue, text, quote, technicalTiming: ["After launch"] }] };
  const observations = parseArticleObservations(output, CYBERPUNK, quote, ["PC", "At launch"], false, true, true);
  expect(observations).toMatchObject([{ technicalTiming: [expected] }]);
  const stored = JSON.stringify({ observations });
  expect(observations[0]).not.toHaveProperty("quote");
  expect(readArticleObservations(stored, CYBERPUNK, true, true)).toEqual(observations);
  expect(readArticleObservations(stored, CYBERPUNK, true)[0]).not.toHaveProperty("technicalTiming");
});

test.each([
  ["Opening the inventory crashed the game on day one.", "on day one"],
  ["Characters got stuck in idle animations.", "during review"],
  ["Bugs were slightly reduced after a patch.", "after a patch"],
  ["The reviewer experienced frequent bugs including missing models.", "during review"],
  ["Performance was acceptable, with framerate dropping noticeably while driving.", "during review"],
])("v9 recognizes observed technical failures: %s", (quote, expected) => {
  const value = { observations: [{ ...animationIssue, text: quote, quote }] };
  expect(parseArticleObservations(value, CYBERPUNK, quote, [], false, true, true))
    .toMatchObject([{ technicalTiming: [expected] }]);
});

test("v9 rejects technical timing taken from source metadata or reversed from the excerpt", () => {
  const quote = "Before the day-one patch, animation glitches interrupted scenes.";
  const output = { observations: [
    { ...animationIssue, id: "metadata", text: "At launch, animation glitches interrupted scenes.", quote },
    { ...animationIssue, id: "reversed", text: "After the day-one patch, animation glitches interrupted scenes.", quote },
    { ...animationIssue, id: "day-one", text: "Animation glitches interrupted scenes on day one.", quote },
    { ...animationIssue, id: "qualifier", qualifiers: ["At launch"], quote },
  ] };
  const context = ["At launch", "After the day-one patch"];
  const observations = parseArticleObservations(output, CYBERPUNK, quote, context, false, true, true);
  expect(observations).toEqual([]);
  expect(extractionReviewIssues(output, CYBERPUNK, "test", observations, quote, context, true)
    .map(({ question }) => question)).toEqual(Array(4).fill(
      "What wording and scope does the article support? technical timing is absent from the supporting excerpt.",
    ));
});

test("v18 supplies missing timing, refuses inventions and incompatible references, and leaves gameplay unlabelled", () => {
  const quotes = [
    "At launch, animation glitches interrupted scenes.",
    "Animation glitches interrupted scenes.",
    "Before the day-one patch, animation glitches interrupted scenes.",
    "After the day-one patch, animation glitches interrupted scenes.",
    "Players catch bugs with a net in the orchard and freeze enemies with spells.",
  ];
  const sources = quotes.map((quote, index): ObservationSource => ({
    sourceIdentity: String(index),
    sourceUrl: `https://example.test/review/${index}`,
    editionContext: { platform: null, build: "Launch build" },
    observations: parseArticleObservations({ observations: [
      { ...(index === 4 ? finding : animationIssue),
        text: index === 4 ? quote : animationIssue.text, qualifiers: [], quote },
    ] }, CYBERPUNK, quote, ["Launch build"], false, true, true),
  }));
  const selections = synthesisSelections(sources, { clauses: "v18" });
  const evidence = selections.evidence.flatMap(({ observations }) => observations);
  expect(new Set(evidence.map((obs) => "scopeGroup" in obs ? obs.scopeGroup : undefined)).size).toBe(5);
  expect(evidence[4]).not.toHaveProperty("technicalTiming");
  const result = validateSynthesisClauses({ statements: [
    { text: "Animation glitches interrupted scenes.", observationIds: ["o1"] },
    { text: "Animation glitches interrupted other scenes.", observationIds: ["o2"] },
    { text: "Animation glitches plagued scenes at launch.", observationIds: ["o2"] },
    { text: "Animation glitches plagued scenes after the day-one patch.", observationIds: ["o3"] },
    { text: "Animation glitches plagued scenes.", observationIds: ["o3", "o4"] },
    { text: "Animation glitches plagued scenes.", observationIds: ["o1", "o2"] },
    { text: "Animation glitches plagued scenes after the day 1 patch.", observationIds: ["o4"] },
    { text: quotes[4], observationIds: ["o5"] },
  ] }, CYBERPUNK, sources, selections, "v18");
  expect(result.overview.statements.map(({ text }) => text)).toEqual([
    "Animation glitches interrupted scenes (At launch).",
    "Animation glitches interrupted other scenes during review.",
    "Animation glitches plagued scenes after the day 1 patch.",
    quotes[4],
  ]);
  expect(result.diagnostics.map(({ reason }) => reason)).toEqual([
    "claim introduces technical timing absent from its evidence",
    "claim introduces technical timing absent from its evidence",
    "claim combines different evidence scopes",
    "claim combines different evidence scopes",
  ]);
  const legacy = validateSynthesisClauses({ statements: [
    { text: "Animation glitches interrupted scenes.", observationIds: ["o1"] },
  ] }, CYBERPUNK, [sources[1]!], synthesisSelections([sources[1]!], { clauses: "v16" }), "v16");
  expect(legacy.overview.statements[0]?.text).not.toContain("during review");
});

test("v19 displays a reviewed hardware configuration once and preserves an omitted GPU", () => {
  const qualifier = "on a PC with a GeForce RTX 3080 GPU";
  const source: ObservationSource = {
    sourceIdentity: "hardware", sourceUrl: "https://example.test/review",
    observations: [{ ...animationIssue, kind: "finding", qualifiers: [qualifier] }],
  };
  const selections = synthesisSelections([source], { clauses: "v19" });
  for (const wording of [
    "On PC with a GeForce RTX 3080, animation glitches interrupted scenes during review.",
    "Animation glitches interrupted scenes during review.",
  ]) {
    const result = validateSynthesisClauses({ statements: [{ text: wording, observationIds: ["o1"] }] },
      CYBERPUNK, [source], selections, "v19");
    expect(result.overview.statements[0]?.text.match(/RTX 3080/g)).toHaveLength(1);
  }
});


test("current synthesis uses a retained article without refetch and serves distinct labels from the same evidence", async () => {
  const database = openTestDatabase("vaporstats-article-tags-");
  const routes = "Rooms are cleared of enemies, then the next room is chosen from doors whose icons indicate a God's gift or a resource reward.";
  const traits = ["2D action game", "Exploration choices change later events", "Mouse aiming on Switch 2",
    "Photo mode exclusive to the preview build", "Single-player", "Early Access", "60 FPS", "Animation glitches"];
  const identity = "legacy-hades-review";
  try {
    seedApps(database.native, [HADES_II]);
    insertSources(database.native, HADES_II, "initial", 1, MEDIA_OUTLETS.find(({ name }) => name === "Eurogamer")!);
    const runId = insertCompletedRun(database.native, "initial:article-tags", [HADES_II]);
    database.native.prepare("UPDATE media_sources SET build_context = 'Early Access', platform = 'PC', processing_run_id = ?, contribution_run_id = ?")
      .run(runId, runId);
    database.native.prepare(`INSERT INTO media_article_extractions
      (source_id, input_identity, content_hash, cleanup_version, model, config_version, output_json)
      SELECT id, ?, 'legacy-review-hash', 'legacy-cleanup', 'legacy-model', 'legacy-extraction', ? FROM media_sources`)
      .run(identity, JSON.stringify({
        traits,
        qualifications: ["Early Access", "PC platform"],
        contributions: [{ text: routes, category, sourceIdentity: identity }],
      }));
    await authorizeMediaProcessing(database.db, runId);
    let completions = 0;
    const openRouter: OpenRouterTransport = {
      currentKey: async () => ({ limit: null, limit_remaining: null }),
      async complete(request) {
        completions++;
        const prompt = request.messages[0]!.content;
        for (const phrase of [
          "usually one to four words", "Omit redundant words, one-off examples", "Open world", "D&D 5th Edition",
          "Faerûn", "Non-combat spells", "Actions have consequences", "Split independent dimensions",
          "Early Access or preview context alone is not a tag qualifier",
          "Review the tag candidates from every eligible article", "Character conversations",
          "Pre-run loadouts", "Tarot-card upgrades", "include both “Branching routes” and “Room reward previews”",
          "Select and write tags first", "Physical paths and room choices establish route branching only",
          "Use the setting name alone",
        ]) expect(prompt).toContain(phrase);
        expect(prompt).not.toContain("Favor precise descriptions over terse labels");
        const sources = synthesisEvidence(request);
        const [source] = sources;
        const candidates = source!.extraction.observations;
        expect(candidates.map(({ text }) => text)).toEqual([routes, ...traits.slice(0, 3)]);
        const routeCandidate = candidates[0]!;
        expect(routeCandidate).toMatchObject({ id: "legacy-1", qualifiers: ["Early Access"], tagQualifiers: [] });
        const routeId = routeCandidate.selectionId;
        if (request.response_format.type !== "json_schema") throw new Error("Expected a synthesis schema");
        const schema = request.response_format.json_schema.schema;
        expect(schema.required).toEqual(["tags", "statements", "categories", "prosCons"]);
        expect(Object.keys(schema.properties as object)).toEqual(schema.required as string[]);
        const [, indexLine] = prompt.split("\n").slice(-3);
        const index = JSON.parse(indexLine!);
        expect(index.rows).toEqual(candidates.map((candidate) => [
          candidate.selectionId, candidate.tagScopeGroup ?? candidate.scopeGroup, candidate.text,
        ]));
        expect(index.scopes).toEqual(Object.fromEntries(candidates.map((candidate) => [
          candidate.tagScopeGroup ?? candidate.scopeGroup, candidate.tagQualifiers ?? candidate.qualifiers,
        ])));
        expect(index.scopes[routeCandidate.tagScopeGroup!]).toEqual([]);
        expect(candidates[1]).toMatchObject({ text: traits[0], qualifiers: [] });
        const tags = [
          { label: "Branching routes", observationIds: [routeId] },
          { label: "Room reward previews", observationIds: [routeId] },
          { label: "Branching routes", observationIds: [routeId, routeId] },
          { label: "2D", observationIds: [candidates[1]!.selectionId] },
          { label: "Action", observationIds: [candidates[1]!.selectionId] },
          { label: "Actions have consequences", observationIds: [candidates[2]!.selectionId] },
          { label: "Mouse aiming", observationIds: [candidates[3]!.selectionId] },
          { label: "Isometric", observationIds: [candidates[1]!.selectionId] },
          { label: "Single-player", observationIds: [routeId] },
        ];
        return { generationId: "v25-fixture", model: request.model, provider: null, finishReason: "stop", nativeFinishReason: null,
          content: JSON.stringify({ ...emptySynthesisSelection(sources), statements: [{ text: routes, observationIds: [routeId] }], tags }),
          usage: { promptTokens: 100, completionTokens: 40, reasoningTokens: 0, cost: 0.00015 } };
      },
    };
    await advanceMediaProcessing(database.db, {
      runId, openRouter, now: new Date("2026-11-26T03:00:00Z"),
      articleFetch: async () => { throw new Error("Retained evidence must not refetch articles"); },
    });
    expect(completions).toBe(1);
    expect(database.native.query("SELECT stage, status FROM media_processing_jobs").all())
      .toEqual([{ stage: "synthesis", status: "succeeded" }]);
    const saved = database.native.query<{ config_version: string; output_json: string }, []>("SELECT config_version, output_json FROM media_game_overviews WHERE active = 1").get()!;
    expect(saved.config_version).toBe(PREVIEW_SCOPE_SYNTHESIS_VERSION);
    const stored = JSON.parse(saved.output_json);
    const labels = ["Branching routes", "Room reward previews", "2D", "Action", "Actions have consequences", "Mouse aiming (Switch 2)"];
    const observationIds = ["legacy-1", "legacy-1", "legacy-tag-1", "legacy-tag-1", "legacy-tag-2", "legacy-tag-3"];
    expect(stored.tags.map(({ label, observationRefs }: { label: string; observationRefs: unknown[] }) => [label, observationRefs]))
      .toEqual(labels.map((label, index) => [label, [{ sourceIdentity: identity, observationId: observationIds[index] }]]));
    expect(stored.observationOmissions).toContainEqual({ section: "tags", reason: "evidence does not identify a single-player mode" });
    expect(database.native.query("SELECT tag_label, extraction_input_identity FROM media_tag_memberships ORDER BY tag_slug").all())
      .toEqual([...labels].sort().map((tag_label) => ({ tag_label, extraction_input_identity: identity })));
    expect(stored.observationOmissions).toContainEqual({ section: "tags", reason: "evidence does not establish an isometric view" });
    expect(stored.statements[0].text).toContain("(Early Access)");
    const overview = await getMediaOverview(database.db, HADES_II, { includeUnpublished: true });
    expect(overview?.tags.map(({ label }) => label)).toEqual(labels);
    const markup = renderToStaticMarkup(createElement(MediaOverviewSection, { overview: overview!, sources: [] }));
    expect([...markup.matchAll(/mediaTag=([^"&]+)/g)].map(([, label]) => decodeURIComponent(label!))).toEqual(labels);
  } finally {
    database.cleanup();
  }
});

test("v22 settlement rejects technical complaints and benchmark-derived tags without changing their aliases", () => {
  const source: ObservationSource = {
    sourceIdentity: "port",
    sourceUrl: "https://example.test/port",
    observations: [
      { ...patchTag, id: "port-bug", text: "Bug-ridden at launch", qualifiers: [] },
      { ...patchTag, id: "port-benchmark", text: "Switch 2 version renders at 1080p docked and 1080p or 720p in handheld", qualifiers: [] },
      { ...patchTag, id: "port-aiming", text: "Joy-Con mouse-style aiming on Switch 2", qualifiers: [] },
    ],
  };
  const selections = synthesisSelections([source], { clauses: "v22" });
  expect(selections.choices.get("tags")).toEqual(["o1", "o2", "o3"]);
  const reply = { tags: [
    { label: "Bug-ridden at launch", observationIds: ["o1"] },
    { label: "Switch 2 docked and handheld rendering", observationIds: ["o2"] },
    { label: "Joy-Con mouse-style aiming on Switch 2", observationIds: ["o3"] },
  ] };
  const checked = validateSynthesisClauses(reply, CYBERPUNK, [source], selections, "v22");
  expect(checked.overview.tags.map(({ label }) => label)).toEqual(["Joy-Con mouse-style aiming"]);
  expect(checked.diagnostics.filter(({ section }) => section === "tags")).toEqual(Array.from({ length: 2 }, () => ({
    section: "tags", reason: "tag describes or relies on a technical complaint or benchmark",
  })));
  expect(validateSynthesisClauses(reply, CYBERPUNK, [source], synthesisSelections([source], { clauses: "v21" }), "v21")
    .overview.tags).toHaveLength(3);
});


test("v22 keeps legacy amendments and only uses article platform where the observation supports it", () => {
  const sourceIdentity = "0c4b2cdec69d22d81113f11643d013b5171c862f0006aef1c511eb3adb2da60f";
  const legacy = { contributions: [{ text: "Side quests always change the ending.", category }],
    traits: ["Turn-based combat", "Motion aiming on Switch 2"], qualifications: ["PC platform"] };
  const v21 = legacyObservationEvidence(legacy, CYBERPUNK, null, sourceIdentity);
  expect(v21.observations.map(({ id }) => id)).toEqual(["legacy-1"]);
  const v22 = legacyObservationEvidence(legacy, CYBERPUNK, null, sourceIdentity, true);
  const source: ObservationSource = { sourceIdentity, sourceUrl: "https://example.test/review",
    editionContext: { platform: "PC", build: null }, observations: v22.observations };
  const selections = synthesisSelections([source], { clauses: "v22" });
  expect(selections.evidence[0]?.observations).toMatchObject([
    { id: "legacy-1", text: "Optional quests could influence the ending.", tagQualifiers: ["PC"] },
    { id: "legacy-tag-1", qualifiers: [] },
    { id: "legacy-tag-2", qualifiers: ["Switch 2"] },
  ]);
  const checked = validateSynthesisClauses({ tags: [
    { label: "Turn-based combat", observationIds: ["o2"] },
    { label: "Motion aiming", observationIds: ["o3"] },
    { label: "Motion aiming", observationIds: ["o2", "o3"] },
  ] }, CYBERPUNK, [source], selections, "v22");
  expect(checked.overview.tags.map(({ label }) => label)).toEqual(["Turn-based combat", "Motion aiming (Switch 2)"]);
  expect(checked.diagnostics).toContainEqual({ section: "tags", reason: "claim combines different evidence scopes" });
});

test("v25 shortens the authored D&D ruleset label while preserving scope, edition and provenance", () => {
  const source: ObservationSource = {
    sourceIdentity: "rules-review",
    sourceUrl: "https://example.test/rules",
    editionContext: { platform: null, build: "Early Access" },
    observations: [{
      ...patchTag, id: "rules", text: "The campaign uses Dungeons & Dragons 5th Edition rules.",
      qualifiers: ["Custom campaign"],
    }],
  };
  const reply = { tags: [{ label: "Dungeons & Dragons 5th Edition rules", observationIds: ["o1"] }] };
  const current = validateSynthesisClauses(reply, CYBERPUNK, [source], synthesisSelections([source], { clauses: "v25" }), "v25");
  expect(current.overview.tags).toEqual([{
    label: "D&D 5th Edition (Custom campaign)",
    sourceUrls: [source.sourceUrl], observationRefs: [{ sourceIdentity: source.sourceIdentity, observationId: "rules" }],
  }]);
  const previous = validateSynthesisClauses(reply, CYBERPUNK, [source], synthesisSelections([source], { clauses: "v24" }), "v24");
  expect(previous.overview.tags[0]?.label).toBe("Dungeons & Dragons 5th Edition rules (Custom campaign)");
});

test("v25 requires each branching story citation to establish plot branching or story consequences", () => {
  const source: ObservationSource = {
    sourceIdentity: "branching-review",
    sourceUrl: "https://example.test/branches",
    observations: [
      { ...patchTag, id: "routes", text: "The game has two distinct paths, each with its own bosses, enemies, storylines and, in some cases, boons.", qualifiers: [] },
      { ...patchTag, id: "plot", text: "The main story has branching narrative that lets players zig-zag across its main thread.", qualifiers: [] },
      { ...patchTag, id: "decisions", text: "Player decisions change the plot and determine its ending.", qualifiers: [] },
    ],
  };
  const reply = { tags: [
    { label: "Branching main story", observationIds: ["o1"] },
    { label: "Branching main story", observationIds: ["o1", "o2"] },
    { label: "Branching main story", observationIds: ["o2", "o3"] },
    { label: "Branching routes", observationIds: ["o1"] },
  ] };
  const current = validateSynthesisClauses(reply, CYBERPUNK, [source], synthesisSelections([source], { clauses: "v25" }), "v25");
  expect(current.overview.tags.map(({ label, observationRefs }) => [label, observationRefs?.map(({ observationId }) => observationId)]))
    .toEqual([["Branching main story", ["plot", "decisions"]], ["Branching routes", ["routes"]]]);
  expect(current.diagnostics.filter(({ section }) => section === "tags")).toEqual(Array.from({ length: 2 }, () => ({
    section: "tags", reason: "evidence does not establish story branching",
  })));
  const previous = validateSynthesisClauses({ tags: [reply.tags[0]] }, CYBERPUNK, [source], synthesisSelections([source], { clauses: "v24" }), "v24");
  expect(previous.overview.tags[0]?.observationRefs).toEqual([{ sourceIdentity: source.sourceIdentity, observationId: "routes" }]);
});


test("preview scope follows cited spans and preserves material qualifiers", () => {
  const demo: ObservationSource = {
    sourceIdentity: "demo", sourceUrl: "https://example.test/demo", previewScope: "non-hands-on preview",
    editionContext: { platform: null, build: "preview" },
    observations: [
      { ...finding, id: "stealth", text: "You slip through empty streets.", qualifiers: ["non-hands-on preview"] },
      { ...finding, id: "routes", text: "You choose a route in the test district.", qualifiers: ["non-hands-on preview", "test district only"] },
      { ...finding, id: "plans", text: "The town will have a ferry.", qualifiers: ["announcement", "non-hands-on preview"] },
    ],
  };
  const playable: ObservationSource = {
    sourceIdentity: "playable", sourceUrl: "https://example.test/playable", previewScope: "hands-on preview",
    editionContext: { platform: null, build: "preview" },
    observations: [{ ...finding, id: "routes", text: "You choose a route.", qualifiers: ["hands-on preview"] }],
  };
  const sources = [demo, playable];
  const selection = synthesisSelections(sources, { clauses: "v26" });
  const id = (source: ObservationSource, id: string) => selection.evidence
    .find(({ sourceIdentity }) => sourceIdentity === source.sourceIdentity)!.observations.find((item) => item.id === id)!.selectionId;
  const clause = (text: string, source: ObservationSource, observation: string) => ({ text, observationIds: [id(source, observation)] });
  const input = {
    statements: [
      clause("A hands-off demo showed how you slip through empty streets", demo, "stealth"),
      clause("and choose a route.", demo, "routes"),
      clause("A ferry is planned.", demo, "plans"),
      clause("You choose a route.", playable, "routes"),
      clause("The empty streets offer ways to move unseen.", demo, "stealth"),
      { text: "You choose a route.", observationIds: [id(demo, "routes"), id(playable, "routes")] },
    ],
  };
  const { overview, diagnostics } = validateSynthesisClauses(input, CYBERPUNK, sources, selection, "v26");
  expect(overview.statements.map(({ text }) => text)).toEqual([
    "A hands-off demo showed how you slip through empty streets",
    "and choose a route (test district only).",
    "A ferry is planned (announcement).",
    "You choose a route (hands-on preview).",
    "The empty streets offer ways to move unseen (hands-off preview).",
  ]);
  expect(overview.statements[1]?.observationRefs).toEqual([{ sourceIdentity: "demo", observationId: "routes" }]);
  expect(diagnostics).toContainEqual({ section: "statements", reason: "claim combines different evidence scopes" });
});

/** Run with Bun from the repository root. Always operates on a disposable backup. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { openSqliteAppDatabase } from "../../src/lib/db";
import { GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_CONFIG_VERSION, getMediaGameMatches } from "../../src/lib/media-similarity";
import { getMediaOverview, normalizeMediaTag } from "../../src/lib/media-overview";
import { advanceMediaProcessing } from "../../src/lib/media-processing";
import { legacyObservationEvidence } from "../../src/lib/media-legacy-observations";
import { readArticleObservations } from "../../src/lib/media-observations";
import { controlledOpenRouterApi } from "../../tests/support/media";

const source = process.argv[2];
if (!source) throw Error("Pass the private run 24 SQLite file as the first argument");
const dir = mkdtempSync(join(tmpdir(), "media-fixed-"));
try {
  const path = join(dir, "replay.sqlite");
  const copy = spawnSync("python3", ["-c", [
    "import sqlite3,sys",
    "with sqlite3.connect(sys.argv[1],uri=True) as source, sqlite3.connect(sys.argv[2]) as dest: source.backup(dest)",
  ].join("\n"), pathToFileURL(resolve(source)).href + "?mode=ro", path], { stdio: "inherit" });
  assert.equal(copy.status, 0, "read-only source backup");
  const db = openSqliteAppDatabase(path);
  try {
    await run();
  } finally {
    db.native.close();
  }

  async function run() {
    const bg = 1086940, cp = 1091500, h2 = 1145350, child = 2138330;
    const roots = [bg, cp, h2];
    const internal = { includeUnpublished: true, limit: 100 };
    const matches = (id: number) => getMediaGameMatches(db, id, internal);
    const overview = (id: number) => getMediaOverview(db, id, internal);
    if (process.argv[3] === "editions") {
      // The edition Overviews are real. These vectors test entity routing only.
      const editions = [72850, 489830];
      for (const [index, appid] of editions.entries()) {
        assert.ok(await overview(appid));
        const vector = new Float32Array(3072);
        vector[index] = 1;
        db.native.run(`INSERT INTO media_game_embeddings
          (appid, dimension, input_identity, overview_input_identity, model, dimensions, config_version, vector)
          SELECT appid, 'story_world', 'controlled-routing', input_identity, ?, 3072, ?, ?
          FROM media_game_overviews WHERE appid=? AND active=1`,
          [GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_CONFIG_VERSION, new Uint8Array(vector.buffer), appid]);
      }
      for (const appid of editions) {
        const sibling = editions.find(id => id !== appid)!;
        const ranked = await matches(appid);
        assert.ok(!ranked.some(m => m.matchedGame.appid === appid));
        const pair = ranked.filter(m => m.matchedGame.appid === sibling);
        assert.equal(pair.length, 1);
        assert.equal(pair[0]!.dimension, "story_world");
        assert.equal(pair[0]!.similarity, 0);
        assert.deepEqual(await getMediaGameMatches(db, appid), []);
      }
      console.log("R09 edition routing passed with controlled orthogonal vectors");
      return;
    }
    if (process.argv[3] === "pairs") {
      process.env.MEDIA_OVERVIEW_PUBLIC = "false";
      for (const [appid, dimension] of [[1920780, "story_world"]] as const) {
        const forward = (await matches(h2)).filter(m => m.matchedGame.appid === appid && m.dimension === dimension);
        const reverse = (await matches(appid)).filter(m => m.matchedGame.appid === h2 && m.dimension === dimension);
        assert.equal(forward.length, 1, `Missing Hades II / ${appid} ${dimension} match`);
        assert.equal(reverse.length, 1);
        assert.equal(forward[0]!.similarity, reverse[0]!.similarity);
        assert.deepEqual(await getMediaGameMatches(db, appid), []);
        for (const id of [h2, appid]) {
          const row = db.native.query<{output_json: string}, [number]>(
            "SELECT output_json FROM media_game_overviews WHERE appid=? AND active=1").get(id)!;
          const inputs = JSON.parse(row.output_json).similarityInputs[dimension === "gameplay" ? "gameplay" : "storyWorld"];
          assert.ok(Array.isArray(inputs) && inputs.length);
          console.log(id, dimension, inputs);
        }
        console.log("Reciprocal pair", h2, appid, dimension, forward[0]!.similarity);
      }
      return;
    }
    assert.equal(process.argv[3], undefined, "Unknown evaluation mode");
    for (const id of [...roots, child]) assert.ok(await overview(id));
    let checked = 0;
    for (const appid of roots) {
      const row = db.native.query<{output_json: string}, [number]>(
        "SELECT output_json FROM media_game_overviews WHERE active=1 AND appid=?").get(appid)!;
      type Entry = { text: string; sourceUrls: string[]; observationRefs: { sourceIdentity: string; observationId: string }[] };
      type Stored = { statements: Entry[]; categories: { findings: Entry[] }[] };
      const saved: Stored = JSON.parse(row.output_json);
      for (const entry of [...saved.statements, ...saved.categories.flatMap(c => c.findings)]) {
        assert.ok(entry.observationRefs.length);
        const urls = new Set<string>();
        for (const ref of entry.observationRefs) {
          const extraction = db.native.query<{output_json: string; original_url: string; build_context: string | null}, [number,string]>(
            `SELECT e.output_json, s.original_url, s.build_context FROM media_article_extractions e
             JOIN media_sources s ON s.id=e.source_id WHERE s.appid=? AND e.input_identity=? AND e.active=1`).get(appid,ref.sourceIdentity);
          assert.ok(extraction);
          const current = readArticleObservations(extraction.output_json, appid);
          const observations = current.length ? current : legacyObservationEvidence(
            extraction.output_json, appid, extraction.build_context, ref.sourceIdentity).observations;
          const evidence = observations.find(o => o.id === ref.observationId);
          assert.ok(evidence && entry.text.includes(evidence.text.replace(/[.!?]$/, "")), ref.observationId);
          urls.add(extraction.original_url);
        }
        assert.deepEqual(urls, new Set(entry.sourceUrls));
        checked++;
      }
    }
    console.log("C12 resolved current article identities, wording and citations for", checked, "display entries");
    const bgOverview = (await overview(bg))!;
    const cyber = (await overview(cp))!;
    const hades = (await overview(h2))!;
    assert.equal(bgOverview.statements.length, 6);
    assert.equal(new Set(bgOverview.statements.flatMap(f => f.sourceUrls)).size, 1);
    assert.ok(bgOverview.statements.every(f => /early access/i.test(f.text)));
    assert.ok(!bgOverview.categories.some(c => c.name === "Social play"));
    assert.ok(bgOverview.categories.find(c => c.name === "Gameplay & systems")?.findings.some(f => /classes/i.test(f.text)));
    const ea = hades.statements.filter(f => /early access/i.test(f.text));
    const release = hades.statements.filter(f => /1\.0/i.test(f.text));
    assert.ok(ea.length > 0 && release.length === 2);
    const exp = (await overview(child))!;
    const childUrls = new Set(exp.statements.flatMap(f => f.sourceUrls));
    assert.ok(cyber.statements.every(f => f.sourceUrls.every(url => !childUrls.has(url))));
    const amended = cyber.statements.filter(f => /optional character stories/i.test(f.text));
    assert.equal(amended.length, 1);
    assert.deepEqual(amended[0]!.sourceUrls, ["https://www.pcgamer.com/cyberpunk-2077-review/"]);
    assert.ok(!JSON.stringify(cyber).includes("resplendent"));
    assert.deepEqual(normalizeMediaTag("  Motion aiming (Switch 2)! "), normalizeMediaTag("Motion aiming (Switch 2)"));
    assert.ok(!hades.tags.some(t => /multiplayer/i.test(t.label)));
    console.log("C01, C05, C06, C09–C12 baseline reader and normalization checks passed");

    process.env.MEDIA_OVERVIEW_PUBLIC = "false";
    for (const id of roots) assert.deepEqual(await getMediaGameMatches(db, id), []);
    process.env.MEDIA_OVERVIEW_PUBLIC = "true";
    for (const id of roots) {
      const result = await getMediaGameMatches(db, id);
      assert.equal(result.length, 4);
      assert.ok(result.every(m => roots.includes(m.matchedGame.appid) && m.matchedGame.appid !== id));
      for (const m of result) {
        assert.deepEqual(Object.keys(m).sort(), ["dimension", "matchedGame", "similarity"]);
        assert.deepEqual(Object.keys(m.matchedGame).sort(), ["appid", "name", "slug"]);
        const query = db.native.query<{ vector: Uint8Array }, [number,string]>(
          "SELECT vector FROM media_game_embeddings WHERE active=1 AND appid=? AND dimension=?",
        );
        const vector = (appid: number) => new Float32Array(Uint8Array.from(query.get(appid,m.dimension)!.vector).buffer);
        const a = vector(id), b = vector(m.matchedGame.appid);
        assert.equal(a.length, 3072);
        const dot = a.reduce((sum,x,i) => sum+x*b[i]!,0);
        assert.ok(Math.abs(dot / (Math.hypot(...a)*Math.hypot(...b))-m.similarity) < 1e-12);
      }
      const best = await getMediaGameMatches(db, id, { limit: 1 });
      for (const dimension of ["gameplay","story_world"]) {
        const ranked = result.filter(m => m.dimension === dimension);
        assert.equal(ranked.length, 2);
        assert.equal(best.find(m => m.dimension === dimension)?.similarity, Math.max(...ranked.map(m => m.similarity)));
      }
      assert.deepEqual(await getMediaGameMatches(db, id, { limit: 0 }), []);
      assert.ok((await matches(id)).some(m => m.matchedGame.appid === child));
    }
    assert.deepEqual(await getMediaGameMatches(db, child), []);
    assert.ok((await matches(child)).some(m => m.matchedGame.appid === cp));
    console.log("R03, R07, R09 (expansion), R11, R12 passed on current provider vectors");

    async function excluded(sql: string, ...bindings: (number|string)[]) {
      db.native.run("SAVEPOINT fixed_exclusion");
      try {
        db.native.run(sql, bindings);
        assert.ok(!(await matches(bg)).some(m => m.matchedGame.appid === cp));
        assert.deepEqual(await matches(cp), []);
        assert.ok((await matches(bg)).some(m => m.matchedGame.appid === h2));
      } finally {
        db.native.run("ROLLBACK TO fixed_exclusion");
        db.native.run("RELEASE fixed_exclusion");
      }
    }
    for (const [column,value] of [["model","archived"],["config_version","archived"],["overview_input_identity","obsolete"]] as const) {
      await excluded(`UPDATE media_game_embeddings SET ${column}=? WHERE appid=? AND active=1`, value, cp);
    }
    assert.throws(() => db.native.run("UPDATE media_game_embeddings SET dimensions=1536 WHERE appid=? AND active=1",[cp]), /dimensions_check/);
    await excluded("UPDATE apps SET is_playable=0 WHERE appid=?",cp);
    await excluded("INSERT INTO app_relationships(parent_appid,child_appid,relationship_type) VALUES(?,?,'tool')",bg,cp);
    console.log("R08 and R10 passed under controlled eligibility changes to real vectors");

    // Exercise a misclassified extraction all the way through settlement and both sides of the reader.
    const api = controlledOpenRouterApi();
    for (const [id, text] of [
      ["R04", "The quality of the writing is excellent."],
      ["R05", "The game is popular with a large audience."],
      ["R06", "The game suffers from frequent crashes and framerate problems."],
    ]) {
      const run = db.native.query<{id:number}, [string,string]>(
        "INSERT INTO media_discovery_runs(pass,identity_key,selected_games,status,finished_at) VALUES('initial',?,?,'completed',CURRENT_TIMESTAMP) RETURNING id",
      ).get("control:"+id, JSON.stringify([cp]))!;
      db.native.run("UPDATE media_article_extractions SET active=0 WHERE source_id IN (SELECT id FROM media_sources WHERE appid=?)", [cp]);
      const observations = ["finding", "gameplay", "storyWorld"].map(kind => ({
        id: kind, appid: cp, kind, text, qualifiers: [], category: kind === "finding" ? "Gameplay & systems" : "",
      }));
      db.native.run(`INSERT INTO media_article_extractions(source_id,input_identity,content_hash,cleanup_version,model,config_version,output_json,active)
        SELECT source_id,?,content_hash,cleanup_version,'controlled-test','media-extraction-2026-11-25-v5',?,1
        FROM media_article_extractions WHERE source_id=6 ORDER BY id LIMIT 1`, ["control:"+id, JSON.stringify({ observations })]);
      await advanceMediaProcessing(db, { automaticRunId: run.id, providerFetch: api.fetchFn, openRouterApiKey: "fixture",
        articleFetch: async () => { throw Error("Unexpected article fetch"); } });
      const result = await overview(cp);
      assert.equal(result?.statements[0]?.text, text);
      assert.deepEqual(await matches(cp), []);
      assert.ok(!(await matches(h2)).some(m => m.matchedGame.appid === cp));
      assert.ok((await matches(h2)).some(m => m.matchedGame.appid === bg));
      assert.equal(db.native.query("SELECT id FROM media_processing_jobs WHERE run_id=? AND stage='embedding'").get(run.id), null);
      console.log(id, "passed controlled replacement, both reader directions, zero new vector jobs");
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

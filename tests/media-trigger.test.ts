import { describe, expect, it } from "bun:test";
import { handleRequest, sanitizeMediaProcessingSummary } from "../src/server";
import { closeDb, getDb } from "../src/lib/db";
import { PAID_PROVIDERS, PROCESSING_STOP_REASONS, PROVIDER_PAUSE_REASONS } from "../src/lib/media-paid-providers";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openTestDatabase } from "./support/db";

const root = dirname(import.meta.dir);
const wrapperPath = join(root, "scripts", "remote-command.sh");
const workflowPath = join(root, ".github", "workflows", "media-discovery.yml");
const shell = process.platform === "win32" ? process.env.GIT_BASH_PATH ?? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
async function makeHarness() {
  const directory = await mkdtemp(join(tmpdir(), "vaporstats-media-trigger-"));
  const tracePath = join(directory, "children.log");
  const wrapperCopy = join(directory, "remote-command.sh");
  await copyFile(wrapperPath, wrapperCopy);
  await writeFile(
    join(directory, "deploy.sh"),
    "#!/bin/sh\nprintf 'deploy:%s\\n' \"$1\" >> \"$TRACE_FILE\"\n",
  );
  await writeFile(
    join(directory, "docker"),
    "#!/bin/sh\nfor arg do last2=$last; last=$arg; done\nprintf 'docker:%s|%s|%s|%s|%s|%s\\n' \"$1\" \"$2\" \"$3\" \"$4\" \"$last2\" \"$last\" >> \"$TRACE_FILE\"\nprintf '{\"accepted\":true}\\n'\n",
  );
  await chmod(wrapperCopy, 0o755);
  await chmod(join(directory, "deploy.sh"), 0o755);
  await chmod(join(directory, "docker"), 0o755);
  await writeFile(tracePath, "");
  return { directory, tracePath };
}
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runWrapper(
  directory: string,
  tracePath: string,
  originalCommand?: string,
) {
  await writeFile(tracePath, "");
  const stdoutPath = join(directory, "stdout.log");
  const stderrPath = join(directory, "stderr.log");
  const invokePath = join(directory, "invoke.sh");
  await writeFile(stdoutPath, "");
  await writeFile(stderrPath, "");
  await writeFile(
    invokePath,
    [
      "#!/bin/sh",
      'export PATH="$(pwd):$PATH"',
      'export TRACE_FILE="$(pwd)/children.log"',
      originalCommand === undefined
        ? "unset SSH_ORIGINAL_COMMAND"
        : `export SSH_ORIGINAL_COMMAND=${shellQuote(originalCommand)}`,
      "exec ./remote-command.sh",
      "",
    ].join("\n"),
  );
  await chmod(invokePath, 0o755);

  const child = Bun.spawn([shell, "./invoke.sh"], {
    cwd: directory,
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
  });
  const exitCode = await child.exited;
  const [stdout, stderr] = await Promise.all([
    readFile(stdoutPath, "utf8"),
    readFile(stderrPath, "utf8"),
  ]);
  return { exitCode, stdout, stderr, trace: await readFile(tracePath, "utf8") };
}

// The manual `media initial` and `media later` triggers are retired: media
// discovery and paid work run only in the ingestion tick. The dispatch
// workflow, the restricted remote command, and the server keep their
// validated boundary for later media forms, and each rejects the retired
// forms on its own; none reaches a shell or starts media work.

const GAMES = ["all", "cyberpunk-2077", "baldurs-gate-3", "hades-ii"];
const RETIRED_MEDIA_FORMS = ["initial", "later"].flatMap((pass) => GAMES.map((game) => `media ${pass} ${game}`));

describe("restricted remote command", () => {
  it("executes only the exact deploy form", async () => {
    const harness = await makeHarness();
    try {
      const commit = "0123456789abcdef0123456789abcdef01234567";
      const deploy = await runWrapper(harness.directory, harness.tracePath, `deploy ${commit}`);
      expect(deploy.exitCode).toBe(0);
      expect(deploy.trace).toBe(`deploy:${commit}\n`);
    } finally {
      await rm(harness.directory, { recursive: true, force: true });
    }
  });

  it("rejects the retired media forms as retired before spawning children", async () => {
    const harness = await makeHarness();
    try {
      for (const command of RETIRED_MEDIA_FORMS) {
        const result = await runWrapper(harness.directory, harness.tracePath, command);
        expect(result.exitCode).toBe(64);
        expect(result.stderr).toBe("retired media form: media discovery runs in the daily media run\n");
        expect(result.trace).toBe("");
      }
    } finally {
      await rm(harness.directory, { recursive: true, force: true });
    }
  });

  it("rejects missing, malformed, unsupported, and shell-like commands before spawning children", async () => {
    const harness = await makeHarness();
    try {
      const commit = "0123456789abcdef0123456789abcdef01234567";
      const sentinelPath = join(harness.directory, "should-not-exist");
      const invalidCommands = [
        undefined,
        "deploy",
        `deploy ${commit.slice(0, 39)}`,
        `deploy ${commit}\n`,
        `deploy ${commit} `,
        `deploy ${commit};touch ${sentinelPath}`,
        `deploy ${commit.toUpperCase()}; echo nope`,
        "media",
        "media status",
        "media initial",
        "media initial all ",
        "media initial initial",
        "media initial cyberpunk",
        "media initial all; echo nope",
        `media initial all;touch ${sentinelPath}`,
        "media initial all\n",
        " MEDIA initial all",
      ];

      for (const command of invalidCommands) {
        const result = await runWrapper(harness.directory, harness.tracePath, command);
        expect(result.exitCode).toBe(64);
        expect(result.stderr).toBe("invalid remote command\n");
        expect(result.trace).toBe("");
      }
      expect(await Bun.file(sentinelPath).exists()).toBe(false);
    } finally {
      await rm(harness.directory, { recursive: true, force: true });
    }
  });

  it("executes watch and unwatch with literal arguments", async () => {
    const harness = await makeHarness();
    try {
      for (const [action, game] of [["watch", "no-law"], ["unwatch", "2161710"]]) {
        const result = await runWrapper(harness.directory, harness.tracePath, `media ${action} ${game}`);
        expect(result.exitCode).toBe(0);
        expect(result.trace).toBe(`docker:container|exec|vaporstats|bun|${action}|${game}\n`);
      }
      for (const game of ["0", "0123", "no--law", "no-law; exit", "12345678901", "a".repeat(129), "NO-LAW"]) {
        expect(await runWrapper(harness.directory, harness.tracePath, `media watch ${game}`)).toMatchObject({ exitCode: 64, trace: "" });
      }
    } finally {
      await rm(harness.directory, { recursive: true, force: true });
    }
  });

  it("keeps the wrapper free of shell evaluation", async () => {
    const wrapper = await readFile(wrapperPath, "utf8");
    expect(wrapper).not.toContain("eval ");
    expect(wrapper).not.toContain("2>/dev/null");
    expect(wrapper).toContain("SSH_ORIGINAL_COMMAND");
    expect(wrapper).not.toContain("docker exec");
  });
});

type WorkflowStep = { name?: string; run?: string; env?: Record<string, string> };
type Workflow = {
  on: { workflow_dispatch: { inputs: Record<string, { type: string; options?: string[] }> } };
  jobs: { trigger: { steps: WorkflowStep[] } };
};

async function readWorkflow(): Promise<{ text: string; workflow: Workflow }> {
  const text = await readFile(workflowPath, "utf8");
  return { text, workflow: Bun.YAML.parse(text) as Workflow };
}

describe("media dispatch workflow", () => {
  it("offers the exact watch actions and a text game identifier", async () => {
    const { workflow } = await readWorkflow();
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs.pass).toBeUndefined();
    expect(inputs.action).toMatchObject({ type: "choice", options: ["watch", "unwatch"] });
    expect(inputs.game).toMatchObject({ type: "string" });
  });

  it("sends exact watch commands and rejects malformed forms before SSH", async () => {
    const { workflow } = await readWorkflow();
    const trigger = workflow.jobs.trigger.steps.find((step) => step.name === "Trigger media discovery");
    expect(trigger?.run).toBeString();
    const directory = await mkdtemp(join(tmpdir(), "vaporstats-media-workflow-"));
    try {
      const tracePath = join(directory, "ssh.log");
      await writeFile(join(directory, "ssh"), "#!/bin/sh\nprintf 'ssh:%s\\n' \"$*\" >> \"$TRACE_FILE\"\n");
      await chmod(join(directory, "ssh"), 0o755);
      await writeFile(join(directory, "step.sh"), trigger!.run!);
      for (const [action, game, allowed] of [
        ["watch", "no-law", true], ["unwatch", "2161710", true],
        ["initial", "no-law", false], ["later", "no-law", false], ["status", "no-law", false],
        ["watch", "no-law; exit", false], ["unwatch", "no-law\n", false], ["watch", "0", false], ["watch", "0123", false],
        ["watch", "12345678901", false], ["watch", "a".repeat(129), false], ["watch", "No-Law", false],
      ] as const) {
        await writeFile(tracePath, "");
        const child = Bun.spawn([shell, "./step.sh"], {
          cwd: directory,
          env: {
            PATH: `${directory}:${process.env.PATH}`,
            HOME: directory,
            TRACE_FILE: tracePath,
            INPUT_ACTION: action,
            INPUT_GAME: game,
            TARGET_HOST: "203.0.113.9",
            GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(await child.exited).toBe(allowed ? 0 : 1);
        const trace = await readFile(tracePath, "utf8");
        if (allowed) expect(trace).toEndWith(` media ${action} ${game}\n`);
        else expect(trace).toBe("");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the SSH boundary free of shell evaluation and free-text commands", async () => {
    const { text } = await readWorkflow();
    expect(text).toContain("workflow_dispatch:");
    expect(text).not.toMatch(/remote_pass=(initial|later)/);
    expect(text).toContain("BatchMode=yes");
    expect(text).toContain("IdentitiesOnly=yes");
    expect(text).toContain("StrictHostKeyChecking=yes");
    expect(text).toContain("GlobalKnownHostsFile=/dev/null");
    expect(text).toContain("DEPLOY_KEY");
    expect(text).toContain("GITHUB_STEP_SUMMARY");
    expect(text).toContain("media discovery result:");
    expect(text).toContain("stderr_file");
    expect(text).toContain("[redacted host]");
    expect(text).not.toContain("2>/dev/null");
    expect(text).not.toContain("eval ");
  });
});

const TOKEN = "test-trigger-token";
const AUTHORIZED = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

function mediaRequest(headers: Record<string, string>, body = "{\"pass\":\"later\",\"game\":\"unknown\"}", url = "http://127.0.0.1/internal/media-discovery") {
  return new Request(url, { method: "POST", headers, body });
}

/**
 * Runs `work` with the trigger token set and every database statement and
 * provider request recorded and refused, and returns what was attempted.
 */
async function withoutMediaWork(work: () => Promise<void>): Promise<string[]> {
  const previousToken = process.env.MEDIA_TRIGGER_TOKEN;
  process.env.MEDIA_TRIGGER_TOKEN = TOKEN;
  const db = await getDb();
  const originalPrepare = db.prepare;
  const originalFetch = globalThis.fetch;
  const attempted: string[] = [];
  db.prepare = ((query: string) => {
    attempted.push(query);
    throw new Error(`unexpected database work: ${query}`);
  }) as typeof db.prepare;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    attempted.push(String(input));
    throw new Error(`unexpected provider request: ${String(input)}`);
  }) as unknown as typeof fetch;
  try {
    await work();
  } finally {
    db.prepare = originalPrepare;
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.MEDIA_TRIGGER_TOKEN;
    else process.env.MEDIA_TRIGGER_TOKEN = previousToken;
  }
  return attempted;
}

describe("server media endpoint", () => {
  it("requires a verified loopback peer instead of trusting Host", async () => {
    await withoutMediaWork(async () => {
      expect((await handleRequest(mediaRequest(AUTHORIZED), "127.0.0.1")).status).toBe(400);
      expect((await handleRequest(mediaRequest(AUTHORIZED), "::1")).status).toBe(400);
      expect((await handleRequest(mediaRequest(AUTHORIZED), "::ffff:127.0.0.1")).status).toBe(400);
      expect((await handleRequest(mediaRequest({ ...AUTHORIZED, Host: "127.0.0.1" }), "203.0.113.7")).status).toBe(404);
      expect((await handleRequest(mediaRequest({ ...AUTHORIZED, Host: "127.0.0.1" }))).status).toBe(404);
      expect((await handleRequest(mediaRequest(AUTHORIZED, undefined, "https://public.example/internal/media-discovery"), "203.0.113.7")).status).toBe(404);
    });
  });

  it("keeps method, bearer, content-type, body, and input validation behind the peer guard", async () => {
    await withoutMediaWork(async () => {
      const peer = "127.0.0.1";
      expect((await handleRequest(new Request("http://127.0.0.1/internal/media-discovery", { method: "GET", headers: AUTHORIZED }), peer)).status).toBe(405);
      expect((await handleRequest(mediaRequest({ "Content-Type": "application/json" }), peer)).status).toBe(401);
      expect((await handleRequest(mediaRequest({ ...AUTHORIZED, Authorization: "Bearer wrong" }), peer)).status).toBe(401);
      expect((await handleRequest(mediaRequest({ ...AUTHORIZED, "Content-Type": "text/plain" }), peer)).status).toBe(415);
      expect((await handleRequest(mediaRequest({ ...AUTHORIZED, "Content-Length": "4097" }, "x".repeat(4097)), peer)).status).toBe(413);
      expect((await handleRequest(mediaRequest(AUTHORIZED, "{"), peer)).status).toBe(400);
      for (const body of [
        "[]",
        "{\"pass\":\"initial\"}",
        "{\"pass\":\"initial\",\"game\":\"all\",\"extra\":1}",
        "{\"pass\":\"initial\",\"game\":\"not-a-game\"}",
        "{\"pass\":\"status\",\"game\":\"all\"}",
      ]) {
        const response = await handleRequest(mediaRequest(AUTHORIZED, body), peer);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "Invalid request" });
      }
    });
  });

  it("rejects the retired media forms as retired before any database or provider work", async () => {
    const attempted = await withoutMediaWork(async () => {
      for (const pass of ["initial", "later"]) {
        for (const game of GAMES) {
          const response = await handleRequest(mediaRequest(AUTHORIZED, JSON.stringify({ pass, game })), "127.0.0.1");
          expect(response.status).toBe(410);
          expect(response.headers.get("cache-control")).toBe("no-store, no-cache, must-revalidate");
          expect(await response.json()).toEqual({ error: "Retired media form: media discovery runs in the daily media run" });
        }
      }
    });
    expect(attempted).toEqual([]);
  });

  it("resolves NO LAW by slug and AppID, reports children, and rejects invalid catalog targets", async () => {
    const fixture = openTestDatabase("vaporstats-watch-trigger-");
    const previousPath = process.env.DATABASE_PATH;
    const previousToken = process.env.MEDIA_TRIGGER_TOKEN;
    await closeDb();
    process.env.DATABASE_PATH = fixture.databasePath;
    process.env.MEDIA_TRIGGER_TOKEN = TOKEN;
    try {
      fixture.native.exec(`INSERT INTO apps (appid, name, slug, release_status, type, parent_appid, is_playable) VALUES
        (2161710, 'NO LAW', 'no-law', 'upcoming', 'game', NULL, 1),
        (2161711, 'Night Shift', 'night-shift', 'upcoming', 'dlc', 2161710, 0),
        (2161712, 'Bonus Tracks', 'soundtrack', 'released', 'music', NULL, 0),
        (2161713, 'Same Name', 'duplicate', 'released', 'game', NULL, 1),
        (2161714, 'Same Name', 'duplicate', 'released', 'game', NULL, 1),
        (2161715, 'Numeric Slug', '777', 'released', 'game', NULL, 1)`);
      const trigger = (action: unknown, game: unknown) =>
        handleRequest(mediaRequest(AUTHORIZED, JSON.stringify({ action, game })), "127.0.0.1");
      const first = await trigger("watch", "no-law");
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        appid: 2161710, name: "NO LAW", releaseStatus: "upcoming", watched: true, changed: true,
        entities: [{ appid: 2161710, next: { pass: "preview" } }, { appid: 2161711, next: { pass: "preview" } }],
      });
      expect(await (await trigger("watch", "2161710")).json()).toMatchObject({ watched: true, changed: false });
      expect(await (await trigger("unwatch", "no-law")).json()).toMatchObject({ watched: false, changed: true });
      expect(await (await trigger("unwatch", "2161710")).json()).toMatchObject({ watched: false, changed: false });
      expect((await trigger("watch", "unknown")).status).toBe(404);
      expect((await trigger("watch", "777")).status).toBe(404);
      expect(await (await trigger("watch", "duplicate")).text()).toContain("2161713, 2161714");
      expect(await (await trigger("watch", "night-shift")).text()).toContain("NO LAW (AppID 2161710)");
      expect(await (await trigger("watch", "soundtrack")).text()).toContain("ineligible");
      for (const game of [2161710, "0", "02161710", "21617102020", "no-law\n", "NO-LAW", "a".repeat(129)]) {
        expect((await trigger("watch", game)).status).toBe(400);
      }
      expect(fixture.native.query("SELECT appid FROM media_watches").all()).toEqual([{ appid: 2161710 }]);
    } finally {
      await closeDb();
      fixture.cleanup();
      if (previousPath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previousPath;
      if (previousToken === undefined) delete process.env.MEDIA_TRIGGER_TOKEN;
      else process.env.MEDIA_TRIGGER_TOKEN = previousToken;
    }
  });

  it("answers every other internal path with 404 before any database or provider work", async () => {
    const attempted = await withoutMediaWork(async () => {
      for (const path of ["/internal", "/internal/", "/internal/media-status", "/internal/media-discovery/"]) {
        expect((await handleRequest(new Request(`http://127.0.0.1${path}`, { method: "POST", headers: AUTHORIZED, body: "{}" }), "127.0.0.1")).status).toBe(404);
      }
    });
    expect(attempted).toEqual([]);
  });
});

describe("media processing summary stop reasons", () => {
  function sanitizedStopReasons(stopReasons: string[]): string[] {
    const costs = { monthToDateMicrousd: 0, allTimeMicrousd: 0 };
    return sanitizeMediaProcessingSummary({
      runId: 1, status: "waiting", submitted: 0, completed: 0, failed: 0, uncertain: 0,
      outputs: { new: 0, reused: 0, replaced: 0, invalidated: 0, skipped: 0 },
      overviewAppids: [],
      stopReasons,
      queued: { gemini: 0, openrouter: 0 },
      providers: {
        gemini: { provider: "gemini", paused: false, reason: null, pausedAt: null, checkedAt: null, checkOutcome: null },
        openrouter: { provider: "openrouter", paused: false, reason: null, pausedAt: null, checkedAt: null, checkOutcome: null },
      },
      cost: { reportingOnly: true, month: "2026-11", providers: { gemini: costs, openrouter: costs }, uncertain: 0 },
    }).stopReasons;
  }

  it("preserves every paid-provider pause and processing stop reason", () => {
    const reasons = [
      ...Object.values(PROCESSING_STOP_REASONS),
      ...PAID_PROVIDERS.flatMap((provider) => PROVIDER_PAUSE_REASONS.map((reason) => `provider_paused:${provider}:${reason}`)),
    ];
    expect(sanitizedStopReasons(["item_error"])).toEqual(["item_error"]);
    expect(sanitizedStopReasons(reasons)).toEqual(reasons);
  });

  it("preserves bounded stop reasons for each supported Outlet", () => {
    const reasons = ["IGN", "Eurogamer", "GameSpot", "PC Gamer", "Kotaku", "GamesRadar+"].flatMap((outlet) =>
      ["fetch_http_401", "fetch_http_403", "fetch_http_429", "daily_attempt_cap", "article_unreachable", "article_unusable"]
        .map((reason) => `${outlet}:${reason}`));
    expect(sanitizedStopReasons(reasons)).toEqual(reasons);
  });

  it("reports unknown and unbounded stop reasons as provider_failure", () => {
    for (const reason of [
      "unknown_reason", "__proto__", "Unknown:article_unusable", "IGN:fetch_http_500", "provider_paused:unknown:missing_key",
      "provider_paused:gemini:arbitrary error detail", "item_error:exception detail", `count_tokens:${"x".repeat(4_096)}`,
    ]) {
      expect(sanitizedStopReasons([reason])).toEqual(["provider_failure"]);
    }
  });
});

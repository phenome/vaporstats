import { describe, expect, it } from "bun:test";
import { handleRequest } from "../src/server";
import { getDb } from "../src/lib/db";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
    "#!/bin/sh\nprintf 'docker:%s|%s|%s|%s|%s|%s\\n' \"$1\" \"$2\" \"$3\" \"$4\" \"$5\" \"$6\" >> \"$TRACE_FILE\"\nprintf '{\"accepted\":true}\\n'\n",
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
  it("offers no discovery pass, and keeps the game choice", async () => {
    const { workflow } = await readWorkflow();
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs.pass).toMatchObject({ type: "choice", options: ["none"] });
    expect(inputs.game).toMatchObject({ type: "choice", options: GAMES });
  });

  it("stops every pass, including the retired initial and later passes, before any SSH connection", async () => {
    const { workflow } = await readWorkflow();
    const trigger = workflow.jobs.trigger.steps.find((step) => step.name === "Trigger media discovery");
    expect(trigger?.run).toBeString();
    const directory = await mkdtemp(join(tmpdir(), "vaporstats-media-workflow-"));
    try {
      const tracePath = join(directory, "ssh.log");
      await writeFile(join(directory, "ssh"), "#!/bin/sh\nprintf 'ssh:%s\\n' \"$*\" >> \"$TRACE_FILE\"\n");
      await chmod(join(directory, "ssh"), 0o755);
      await writeFile(join(directory, "step.sh"), trigger!.run!);
      for (const pass of ["none", "initial", "later", "status"]) {
        await writeFile(tracePath, "");
        const child = Bun.spawn([shell, "./step.sh"], {
          cwd: directory,
          env: {
            PATH: `${directory}:${process.env.PATH}`,
            HOME: directory,
            TRACE_FILE: tracePath,
            INPUT_PASS: pass,
            INPUT_GAME: "all",
            TARGET_HOST: "203.0.113.9",
            GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(await child.exited).toBe(1);
        expect(await new Response(child.stderr).text()).toBe("unsupported discovery pass: media discovery runs in the daily media run\n");
        expect(await readFile(tracePath, "utf8")).toBe("");
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

  it("answers every other internal path with 404 before any database or provider work", async () => {
    const attempted = await withoutMediaWork(async () => {
      for (const path of ["/internal", "/internal/", "/internal/media-status", "/internal/media-discovery/"]) {
        expect((await handleRequest(new Request(`http://127.0.0.1${path}`, { method: "POST", headers: AUTHORIZED, body: "{}" }), "127.0.0.1")).status).toBe(404);
      }
    });
    expect(attempted).toEqual([]);
  });
});

import { describe, expect, it } from "bun:test";
import { handleRequest } from "../src/server";
import { closeDb, getDb } from "../src/lib/db";
import {
  GEMINI_BATCH_CAPABILITY_VERSION,
  GEMINI_BATCH_PRICING_VERSION,
} from "../src/lib/media-processing";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const wrapperPath = join(root, "scripts", "remote-command.sh");
const workflowPath = join(root, ".github", "workflows", "media-discovery.yml");
const shell = process.platform === "win32" ? process.env.GIT_BASH_PATH ?? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
async function withIsolatedTriggerDb<T>(work: (discoveryCalls: string[]) => Promise<T>): Promise<T> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousFetch = globalThis.fetch;
  await closeDb();
  const directory = await mkdtemp(join(tmpdir(), "vaporstats-media-trigger-db-"));
  process.env.DATABASE_PATH = join(directory, "trigger.sqlite");
  const discoveryCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    discoveryCalls.push(url);
    if (url.endsWith("/usage")) {
      return Response.json({
        account: { current_plan: "free" },
        plan_usage: 0,
        plan_limit: 100,
        paygo_usage: 0,
        paygo_limit: 0,
      });
    }
    if (url.endsWith("/search")) {
      return Response.json({ results: [], usage: { credits_used: 0 } });
    }
    throw new Error(`unexpected provider request: ${url}`);
  }) as typeof fetch;
  try {
    return await work(discoveryCalls);
  } finally {
    await closeDb();
    globalThis.fetch = previousFetch;
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
}

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

describe("forced media/deploy remote command", () => {
  it("executes only the exact deploy and media command forms", async () => {
    const harness = await makeHarness();
    try {
      const commit = "0123456789abcdef0123456789abcdef01234567";
      const deploy = await runWrapper(
        harness.directory,
        harness.tracePath,
        `deploy ${commit}`,
      );
      expect(deploy.exitCode).toBe(0);
      expect(deploy.trace).toBe(`deploy:${commit}\n`);

      for (const game of ["all", "cyberpunk-2077", "baldurs-gate-3", "hades-ii"]) {
        const media = await runWrapper(
          harness.directory,
          harness.tracePath,
          `media initial ${game}`,
        );
        expect(media.exitCode).toBe(0);
        expect(media.stdout).toBe('{"accepted":true}\n');
        expect(media.trace).toContain(`docker:exec|vaporstats|bun|-e|`);
        expect(media.trace.endsWith(`|${game}\n`)).toBe(true);
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
        "media initial",
        "media initial all ",
        "media initial initial",
        "media initial cyberpunk",
        "media initial all; echo nope",
        "media initial all\n",
        " MEDIA initial all",
      ];

      for (const command of invalidCommands) {
        const result = await runWrapper(
          harness.directory,
          harness.tracePath,
          command,
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.trace).toBe("");
      }
      expect(await Bun.file(sentinelPath).exists()).toBe(false);
    } finally {
      await rm(harness.directory, { recursive: true, force: true });
    }
  });

  it("keeps the wrapper and dispatch workflow free of shell evaluation and free-text commands", async () => {
    const wrapper = await readFile(wrapperPath, "utf8");
    const workflow = await readFile(workflowPath, "utf8");
    expect(wrapper).not.toContain("eval ");
    expect(wrapper).not.toContain("2>/dev/null");
    expect(wrapper).toContain("SSH_ORIGINAL_COMMAND");
    expect(wrapper).toContain("exec docker exec vaporstats");
    expect(wrapper).toContain("http://127.0.0.1:3000/internal/media-discovery");
    expect(wrapper).toContain("MEDIA_TRIGGER_TOKEN");
    expect(wrapper).toContain('Authorization: `Bearer ${token}`');
    expect(wrapper).toContain('"Content-Type": "application/json"');
    expect(wrapper).toContain("if (!response.ok) process.exitCode = 1;");
    for (const game of ["all", "cyberpunk-2077", "baldurs-gate-3", "hades-ii"]) {
      expect(wrapper).toContain(`"media initial ${game}"`);
    }

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("options: [initial]");
    for (const game of ["all", "cyberpunk-2077", "baldurs-gate-3", "hades-ii"]) {
      expect(workflow).toContain(game);
    }
    expect(workflow).toContain("BatchMode=yes");
    expect(workflow).toContain("IdentitiesOnly=yes");
    expect(workflow).toContain("StrictHostKeyChecking=yes");
    expect(workflow).toContain("GlobalKnownHostsFile=/dev/null");
    expect(workflow).toContain("DEPLOY_KEY");
    expect(workflow).toContain("GITHUB_STEP_SUMMARY");
    expect(workflow).toContain("media discovery result:");
    expect(workflow).toContain("stderr_file");
    expect(workflow).toContain("[redacted host]");
    expect(workflow).not.toContain("2>/dev/null");
  });
});

describe("media trigger network origin", () => {
  const request = (
    headers: Record<string, string>,
    body = "{\"pass\":\"later\",\"game\":\"unknown\"}",
  ) =>
    new Request("http://127.0.0.1/internal/media-discovery", {
      method: "POST",
      headers,
      body,
    });

  it("requires a verified loopback peer instead of trusting Host", async () => {
    const previousToken = process.env.MEDIA_TRIGGER_TOKEN;
    process.env.MEDIA_TRIGGER_TOKEN = "test-trigger-token";
    try {
      expect(
        (
          await handleRequest(
            request({
              Authorization: "Bearer test-trigger-token",
              "Content-Type": "application/json",
            }),
            "127.0.0.1",
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await handleRequest(
            request({
              Authorization: "Bearer test-trigger-token",
              "Content-Type": "application/json",
            }),
            "::1",
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await handleRequest(
            request({
              Authorization: "Bearer test-trigger-token",
              "Content-Type": "application/json",
              Host: "127.0.0.1",
            }),
            "203.0.113.7",
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await handleRequest(
            request({
              Authorization: "Bearer test-trigger-token",
              "Content-Type": "application/json",
              Host: "127.0.0.1",
            }),
          )
        ).status,
      ).toBe(404);
    } finally {
      if (previousToken === undefined) delete process.env.MEDIA_TRIGGER_TOKEN;
      else process.env.MEDIA_TRIGGER_TOKEN = previousToken;
    }
  });

  it("keeps bearer, content-type, body, and input validation behind the peer guard", async () => {
    const previousToken = process.env.MEDIA_TRIGGER_TOKEN;
    process.env.MEDIA_TRIGGER_TOKEN = "test-trigger-token";
    try {
      const peer = "127.0.0.1";
      expect(
        (
          await handleRequest(
            request({ "Content-Type": "application/json" }),
            peer,
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await handleRequest(
            request({
              Authorization: "Bearer wrong",
              "Content-Type": "application/json",
            }),
            peer,
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await handleRequest(
            request({
              Authorization: "Bearer test-trigger-token",
              "Content-Type": "text/plain",
            }),
            peer,
          )
        ).status,
      ).toBe(415);
      expect(
        (
          await handleRequest(
            request(
              {
                Authorization: "Bearer test-trigger-token",
                "Content-Type": "application/json",
                "Content-Length": "4097",
              },
              "x".repeat(4097),
            ),
            peer,
          )
        ).status,
      ).toBe(413);
      expect(
        (
          await handleRequest(
            request({
              Authorization: "Bearer test-trigger-token",
              "Content-Type": "application/json",
            }, "{"),
            peer,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await handleRequest(
            request({
              Authorization: "Bearer test-trigger-token",
              "Content-Type": "application/json",
            }, "{\"pass\":\"later\",\"game\":\"unknown\"}"),
            peer,
          )
        ).status,
      ).toBe(400);
    } finally {
      if (previousToken === undefined) delete process.env.MEDIA_TRIGGER_TOKEN;
      else process.env.MEDIA_TRIGGER_TOKEN = previousToken;
    }
  });

  it("rejects invalid requests before any database processing", async () => {
    const previousToken = process.env.MEDIA_TRIGGER_TOKEN;
    process.env.MEDIA_TRIGGER_TOKEN = "test-trigger-token";
    const db = await getDb();
    const originalPrepare = db.prepare;
    let prepareCalls = 0;
    db.prepare = ((query: string) => {
      prepareCalls += 1;
      throw new Error(`unexpected database work: ${query}`);
    }) as typeof db.prepare;
    try {
      const response = await handleRequest(
        request({
          Authorization: "Bearer test-trigger-token",
          "Content-Type": "application/json",
        }, "{\"pass\":\"initial\",\"game\":\"not-a-game\"}"),
        "127.0.0.1",
      );
      expect(response.status).toBe(400);
      expect(prepareCalls).toBe(0);
    } finally {
      db.prepare = originalPrepare;
      if (previousToken === undefined) delete process.env.MEDIA_TRIGGER_TOKEN;
      else process.env.MEDIA_TRIGGER_TOKEN = previousToken;
    }
  });

  it("returns only sanitized processing budget state when provider configuration is missing", async () => {
    await withIsolatedTriggerDb(async (discoveryCalls) => {
      const previousToken = process.env.MEDIA_TRIGGER_TOKEN;
      const previousTavilyKey = process.env.TAVILY_API_KEY;
      const previousGeminiKey = process.env.GEMINI_API_KEY;
      const previousPricingVersion = process.env.GEMINI_BATCH_PRICING_VERSION;
      const previousCapabilityVersion = process.env.GEMINI_BATCH_CAPABILITY_VERSION;
      process.env.MEDIA_TRIGGER_TOKEN = "test-trigger-token";
      process.env.TAVILY_API_KEY = "tavily-provider-secret";
      delete process.env.GEMINI_API_KEY;
      process.env.GEMINI_BATCH_PRICING_VERSION = GEMINI_BATCH_PRICING_VERSION;
      process.env.GEMINI_BATCH_CAPABILITY_VERSION = GEMINI_BATCH_CAPABILITY_VERSION;
      try {
        const response = await handleRequest(
          request({
            Authorization: "Bearer test-trigger-token",
            "Content-Type": "application/json",
          }, "{\"pass\":\"initial\",\"game\":\"cyberpunk-2077\"}"),
          "127.0.0.1",
        );
        const body = await response.json() as {
          runId: number;
          processing?: Record<string, unknown>;
        };
        expect(response.status).toBe(200);
        expect(body.processing).toEqual({
          runId: body.runId,
          status: "waiting",
          submitted: 0,
          completed: 0,
          reused: 0,
          chargedMicrousd: 0,
          outstandingReservedMicrousd: 0,
          stopReasons: ["missing_gemini_batch_transport"],
        });
        expect(discoveryCalls.length).toBeGreaterThan(0);
        expect(discoveryCalls.every((url) => url.startsWith("https://api.tavily.com/"))).toBe(true);
        expect(discoveryCalls.some((url) => url.includes("generativelanguage.googleapis.com"))).toBe(false);
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain("test-trigger-token");
        expect(serialized).not.toContain("tavily-provider-secret");
      } finally {
        if (previousToken === undefined) delete process.env.MEDIA_TRIGGER_TOKEN;
        else process.env.MEDIA_TRIGGER_TOKEN = previousToken;
        if (previousTavilyKey === undefined) delete process.env.TAVILY_API_KEY;
        else process.env.TAVILY_API_KEY = previousTavilyKey;
        if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previousGeminiKey;
        if (previousPricingVersion === undefined) delete process.env.GEMINI_BATCH_PRICING_VERSION;
        else process.env.GEMINI_BATCH_PRICING_VERSION = previousPricingVersion;
        if (previousCapabilityVersion === undefined) delete process.env.GEMINI_BATCH_CAPABILITY_VERSION;
        else process.env.GEMINI_BATCH_CAPABILITY_VERSION = previousCapabilityVersion;
      }
    });
  });

  it("refuses paid processing without a confirmed capability and sanitizes provider state", async () => {
    await withIsolatedTriggerDb(async (discoveryCalls) => {
      const previousToken = process.env.MEDIA_TRIGGER_TOKEN;
      const previousTavilyKey = process.env.TAVILY_API_KEY;
      const previousGeminiKey = process.env.GEMINI_API_KEY;
      const previousPricingVersion = process.env.GEMINI_BATCH_PRICING_VERSION;
      const previousCapabilityVersion = process.env.GEMINI_BATCH_CAPABILITY_VERSION;
      process.env.MEDIA_TRIGGER_TOKEN = "test-trigger-token";
      process.env.TAVILY_API_KEY = "tavily-provider-secret";
      process.env.GEMINI_API_KEY = "gemini-provider-secret";
      process.env.GEMINI_BATCH_PRICING_VERSION = GEMINI_BATCH_PRICING_VERSION;
      delete process.env.GEMINI_BATCH_CAPABILITY_VERSION;
      try {
        const response = await handleRequest(
          request({
            Authorization: "Bearer test-trigger-token",
            "Content-Type": "application/json",
          }, "{\"pass\":\"initial\",\"game\":\"cyberpunk-2077\"}"),
          "127.0.0.1",
        );
        const body = await response.json() as {
          runId: number;
          processing?: Record<string, unknown>;
        };
        expect(response.status).toBe(200);
        expect(body.processing).toMatchObject({
          status: "waiting",
          submitted: 0,
          stopReasons: ["capability_unconfirmed"],
        });
        const db = await getDb();
        const jobs = await db
          .prepare("SELECT COUNT(*) AS count FROM media_processing_jobs WHERE run_id = ?")
          .bind(body.runId)
          .first<{ count: number }>();
        expect(jobs?.count).toBe(0);
        expect(discoveryCalls.length).toBeGreaterThan(0);
        expect(discoveryCalls.every((url) => url.startsWith("https://api.tavily.com/"))).toBe(true);
        expect(discoveryCalls.some((url) => url.includes("generativelanguage.googleapis.com"))).toBe(false);
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain("gemini-provider-secret");
        expect(serialized).not.toContain("tavily-provider-secret");
        expect(serialized).not.toContain("test-trigger-token");
      } finally {
        if (previousToken === undefined) delete process.env.MEDIA_TRIGGER_TOKEN;
        else process.env.MEDIA_TRIGGER_TOKEN = previousToken;
        if (previousTavilyKey === undefined) delete process.env.TAVILY_API_KEY;
        else process.env.TAVILY_API_KEY = previousTavilyKey;
        if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previousGeminiKey;
        if (previousPricingVersion === undefined) delete process.env.GEMINI_BATCH_PRICING_VERSION;
        else process.env.GEMINI_BATCH_PRICING_VERSION = previousPricingVersion;
        if (previousCapabilityVersion === undefined) delete process.env.GEMINI_BATCH_CAPABILITY_VERSION;
        else process.env.GEMINI_BATCH_CAPABILITY_VERSION = previousCapabilityVersion;
      }
    });
  });

  it("does not expose endpoint exceptions in the response body", async () => {
    const previousToken = process.env.MEDIA_TRIGGER_TOKEN;
    process.env.MEDIA_TRIGGER_TOKEN = "test-trigger-token";
    const db = await getDb();
    const originalPrepare = db.prepare;
    db.prepare = (() => {
      throw new Error("Bearer endpoint-secret https://private.example/request");
    }) as typeof db.prepare;
    try {
      const response = await handleRequest(
        request(
          {
            Authorization: "Bearer test-trigger-token",
            "Content-Type": "application/json",
          },
          "{\"pass\":\"initial\",\"game\":\"cyberpunk-2077\"}",
        ),
        "127.0.0.1",
      );
      const body = await response.text();
      expect(response.status).toBe(500);
      expect(body).toBe('{"error":"Media discovery failed"}');
      expect(body).not.toContain("endpoint-secret");
      expect(body).not.toContain("private.example");
    } finally {
      db.prepare = originalPrepare;
      if (previousToken === undefined) delete process.env.MEDIA_TRIGGER_TOKEN;
      else process.env.MEDIA_TRIGGER_TOKEN = previousToken;
    }
  });
});

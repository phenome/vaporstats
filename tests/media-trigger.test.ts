import { describe, expect, it } from "bun:test";
import { handleRequest } from "../src/server";
import { getDb } from "../src/lib/db";
import { chmod, copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const wrapperPath = join(root, "scripts", "remote-command.sh");
const workflowDirectory = join(root, ".github", "workflows");
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

// The manual `media initial` and `media later` triggers are retired: daily
// media discovery and paid work run only in the ingestion tick. No layer
// (the dispatch workflow, the restricted remote command, or the server)
// accepts a media form, and none reaches a shell or starts media work.

const RETIRED_MEDIA_FORMS = [
  "media initial all",
  "media initial cyberpunk-2077",
  "media initial baldurs-gate-3",
  "media initial hades-ii",
  "media later all",
  "media later cyberpunk-2077",
  "media status",
  "media",
];

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

  it("rejects every media form, and missing, malformed, unsupported, and shell-like commands, before spawning children", async () => {
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
        ...RETIRED_MEDIA_FORMS,
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

  it("keeps the wrapper free of shell evaluation and of any media command", async () => {
    const wrapper = await readFile(wrapperPath, "utf8");
    expect(wrapper).not.toContain("eval ");
    expect(wrapper).not.toContain("2>/dev/null");
    expect(wrapper).toContain("SSH_ORIGINAL_COMMAND");
    expect(wrapper).not.toMatch(/"media |media_game|MEDIA_DISCOVERY_SCRIPT|internal\/media-discovery/);
    expect(wrapper).not.toContain("docker exec");
    expect(wrapper).not.toContain("MEDIA_TRIGGER_TOKEN");
  });
});

describe("dispatch workflows", () => {
  it("offer no media form", async () => {
    const workflows = await readdir(workflowDirectory);
    expect(workflows).not.toContain("media-discovery.yml");
    for (const name of workflows) {
      const workflow = await readFile(join(workflowDirectory, name), "utf8");
      expect(workflow).not.toMatch(/media (initial|later)/);
      expect(workflow).not.toContain("remote_pass");
      expect(workflow).not.toContain("internal/media-discovery");
    }
  });
});

describe("server", () => {
  it("rejects the retired media trigger's requests before any database or provider work, whatever their origin and credentials", async () => {
    const previousToken = process.env.MEDIA_TRIGGER_TOKEN;
    process.env.MEDIA_TRIGGER_TOKEN = "test-trigger-token";
    const db = await getDb();
    const originalPrepare = db.prepare;
    const originalFetch = globalThis.fetch;
    const work: string[] = [];
    db.prepare = ((query: string) => {
      work.push(query);
      throw new Error(`unexpected database work: ${query}`);
    }) as typeof db.prepare;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      work.push(String(input));
      throw new Error(`unexpected provider request: ${String(input)}`);
    }) as unknown as typeof fetch;
    try {
      const bodies = [
        { pass: "initial", game: "all" },
        { pass: "initial", game: "cyberpunk-2077" },
        { pass: "later", game: "all" },
        { pass: "later", game: "hades-ii" },
      ];
      for (const body of bodies) {
        for (const origin of ["http://127.0.0.1", "http://[::1]", "https://vaporstats.com"]) {
          const response = await handleRequest(new Request(`${origin}/internal/media-discovery`, {
            method: "POST",
            headers: { Authorization: "Bearer test-trigger-token", "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }));
          expect(response.status).toBe(404);
          expect(await response.text()).toBe("Not Found");
        }
      }
      for (const path of ["/internal", "/internal/", "/internal/media-status", "/internal/media-discovery/"]) {
        expect((await handleRequest(new Request(`http://127.0.0.1${path}`, { method: "GET" }))).status).toBe(404);
      }
      expect(work).toEqual([]);
    } finally {
      db.prepare = originalPrepare;
      globalThis.fetch = originalFetch;
      if (previousToken === undefined) delete process.env.MEDIA_TRIGGER_TOKEN;
      else process.env.MEDIA_TRIGGER_TOKEN = previousToken;
    }
  });
});

import { describe, expect, it } from "bun:test";
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
  });
});

const env = { ...process.env, VITE_PROTOTYPE: "true" };
const build = Bun.spawn(["bun", "run", "build"], { env, stdout: "inherit", stderr: "inherit" });
if (await build.exited) process.exit(build.exitCode ?? 1);

const server = Bun.spawn(["bun", "run", "start"], { env, stdout: "inherit", stderr: "inherit" });
process.on("SIGINT", () => server.kill());
process.on("SIGTERM", () => server.kill());
process.exit(await server.exited);

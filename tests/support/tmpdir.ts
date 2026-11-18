import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * The directory that test databases and migration checks create temporary
 * SQLite files under: `VAPORSTATS_TEST_TMPDIR` when it is set, so a machine
 * whose system temporary directory is small or shared can move them to disk,
 * otherwise the system temporary directory.
 */
export function testTemporaryRoot(): string {
  const configured = process.env.VAPORSTATS_TEST_TMPDIR;
  if (!configured) return tmpdir();
  mkdirSync(configured, { recursive: true });
  return configured;
}

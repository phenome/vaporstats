import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Hash migration paths and bytes only; reject missing or non-regular artifacts. */
export function fingerprintMigrations(directory: string): string {
  if (!lstatSync(directory).isDirectory()) {
    throw new Error(`Migration directory is not a directory: ${directory}`);
  }

  const hash = createHash("sha256");
  let hasJournal = false;
  let hasSql = false;

  function visit(relativeDirectory: string): void {
    for (const name of readdirSync(join(directory, relativeDirectory)).sort()) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const path = join(directory, relativePath);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        visit(relativePath);
      } else if (stat.isFile()) {
        const bytes = readFileSync(path);
        // Length framing keeps paths and arbitrary file bytes unambiguous.
        hash.update(`${JSON.stringify([relativePath, bytes.length])}\n`);
        hash.update(bytes);
        if (relativePath === "meta/_journal.json") hasJournal = true;
        if (relativePath.endsWith(".sql")) hasSql = true;
      } else {
        throw new Error(`Migration artifact is not a regular file or directory: ${relativePath}`);
      }
    }
  }

  visit("");
  if (!hasJournal || !hasSql) {
    throw new Error("Migration artifacts require meta/_journal.json and SQL files");
  }
  return hash.digest("hex");
}

if (import.meta.main) {
  const [directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length > 0) {
    throw new Error("Usage: bun migration-fingerprint.ts <migration-directory>");
  }
  console.log(fingerprintMigrations(directory));
}

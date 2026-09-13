#!/usr/bin/env bash
set -Eeuo pipefail

readonly MEDIA_DISCOVERY_SCRIPT='const game = Bun.argv.at(-1);
const token = process.env.MEDIA_TRIGGER_TOKEN;
if (typeof game !== "string" || !token) {
  console.error("media discovery authorization is unavailable");
  process.exit(1);
}
try {
  const response = await fetch("http://127.0.0.1:3000/internal/media-discovery", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pass: "initial", game }),
  });
  const body = await response.text();
  process.stdout.write(body.slice(0, 8192));
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s/]+/gi, "[redacted endpoint]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 256);
  console.error(`media discovery request failed: ${message}`);
  process.exit(1);
}'

readonly MEDIA_STATUS_SCRIPT='import { Database } from "bun:sqlite";
const appid = Number(Bun.argv.at(-1));
const databasePath = process.env.DATABASE_PATH;
if (!Number.isInteger(appid) || !databasePath) {
  console.error("media status is unavailable");
  process.exit(1);
}
const db = new Database(databasePath, { readonly: true });
const authorization = db.query(`SELECT a.run_id, a.status, a.stop_reason
  FROM media_processing_authorizations AS a
  JOIN media_discovery_runs AS r ON r.id = a.run_id
  WHERE EXISTS (SELECT 1 FROM json_each(r.selected_games) WHERE value = ?)
  ORDER BY a.run_id DESC LIMIT 1`).get(appid);
if (!authorization) {
  console.log(JSON.stringify({ appid, status: "not_authorized" }));
  db.close();
  process.exit(0);
}
const jobs = db.query(`SELECT stage, status, COUNT(*) AS count,
  COALESCE(SUM(charged_microusd), 0) AS charged_microusd,
  COALESCE(SUM(CASE WHEN reservation_active = 1 THEN reserved_microusd ELSE 0 END), 0) AS reserved_microusd
  FROM media_processing_jobs WHERE run_id = ? GROUP BY stage, status ORDER BY stage, status`).all(authorization.run_id);
const overview = db.query("SELECT COUNT(*) AS count FROM media_game_overviews WHERE appid = ? AND active = 1").get(appid);
console.log(JSON.stringify({ appid, authorization, jobs, overviewStored: Number(overview?.count ?? 0) > 0 }));
db.close();'

original_command=${SSH_ORIGINAL_COMMAND-}
if [[ "$original_command" == *$'\n'* || "$original_command" == *$'\r'* || "$original_command" == *$'\t'* ]]; then
  printf '%s\n' 'invalid remote command' >&2
  exit 64
fi

if [[ "$original_command" =~ ^deploy\ ([0-9a-fA-F]{40})$ ]]; then
  script_dir=${BASH_SOURCE[0]%/*}
  [[ "$script_dir" == "${BASH_SOURCE[0]}" ]] && script_dir=.
  exec "$script_dir/deploy.sh" "${BASH_REMATCH[1]}"
fi

media_script=$MEDIA_DISCOVERY_SCRIPT
media_argument=
case "$original_command" in
  "media initial all") media_argument=all ;;
  "media initial cyberpunk-2077") media_argument=cyberpunk-2077 ;;
  "media initial baldurs-gate-3") media_argument=baldurs-gate-3 ;;
  "media initial hades-ii") media_argument=hades-ii ;;
  "media status cyberpunk-2077") media_script=$MEDIA_STATUS_SCRIPT; media_argument=1091500 ;;
  "media status baldurs-gate-3") media_script=$MEDIA_STATUS_SCRIPT; media_argument=1086940 ;;
  "media status hades-ii") media_script=$MEDIA_STATUS_SCRIPT; media_argument=1145350 ;;
  *)
    printf '%s\n' 'invalid remote command' >&2
    exit 64
    ;;
esac

exec docker exec vaporstats bun -e "$media_script" "$media_argument"

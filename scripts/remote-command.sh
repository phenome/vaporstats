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
} catch {
  console.error("media discovery request failed");
  process.exit(1);
}'

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

media_game=
case "$original_command" in
  "media initial all") media_game=all ;;
  "media initial cyberpunk-2077") media_game=cyberpunk-2077 ;;
  "media initial baldurs-gate-3") media_game=baldurs-gate-3 ;;
  "media initial hades-ii") media_game=hades-ii ;;
  *)
    printf '%s\n' 'invalid remote command' >&2
    exit 64
    ;;
esac

exec docker exec vaporstats bun -e "$MEDIA_DISCOVERY_SCRIPT" "$media_game" 2>/dev/null

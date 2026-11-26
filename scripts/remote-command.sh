#!/usr/bin/env bash
set -Eeuo pipefail

# The deployment key's forced command. It accepts the exact deploy form and
# the supported media forms; every other command is rejected before anything
# is spawned. Discovery itself runs in the daily ingestion tick.
export LC_ALL=C

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

if [[ "$original_command" =~ ^media\ (watch|unwatch)\ ([a-z0-9]+(-[a-z0-9]+)*)$ ]]; then
  action=${BASH_REMATCH[1]}
  game=${BASH_REMATCH[2]}
  if [[ ${#game} -le 128 ]] && { [[ ! "$game" =~ ^[0-9]+$ ]] || [[ "$game" =~ ^[1-9][0-9]{0,9}$ ]]; }; then
    exec docker container exec vaporstats bun -e '
      const [action, game] = Bun.argv.slice(-2);
      try {
        const response = await fetch("http://127.0.0.1:3000/internal/media-discovery", {
          method: "POST",
          headers: { "Authorization": "Bearer " + process.env.MEDIA_TRIGGER_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ action, game }),
          redirect: "error",
        });
        console.log(await response.text());
        process.exitCode = response.ok ? 0 : 1;
      } catch {
        console.error("Media watchlist request failed");
        process.exitCode = 1;
      }
    ' -- "$action" "$game"
  fi
fi

case "$original_command" in
  "media initial all" | "media initial cyberpunk-2077" | "media initial baldurs-gate-3" | "media initial hades-ii" | \
  "media later all" | "media later cyberpunk-2077" | "media later baldurs-gate-3" | "media later hades-ii")
    printf '%s\n' 'retired media form: media discovery runs in the daily media run' >&2
    exit 64
    ;;
esac

printf '%s\n' 'invalid remote command' >&2
exit 64

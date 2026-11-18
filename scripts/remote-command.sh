#!/usr/bin/env bash
set -Eeuo pipefail

# The deployment key's forced command. It accepts the exact deploy form and
# the supported media forms; every other command is rejected before anything
# is spawned. No media form is supported now: media ingestion runs inside the
# application, and the retired `media initial` and `media later` forms are
# rejected as retired. Later slices add their media forms here.

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

case "$original_command" in
  "media initial all" | "media initial cyberpunk-2077" | "media initial baldurs-gate-3" | "media initial hades-ii" | \
  "media later all" | "media later cyberpunk-2077" | "media later baldurs-gate-3" | "media later hades-ii")
    printf '%s\n' 'retired media form: media discovery runs in the daily media run' >&2
    exit 64
    ;;
esac

printf '%s\n' 'invalid remote command' >&2
exit 64

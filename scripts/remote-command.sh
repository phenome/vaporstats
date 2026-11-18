#!/usr/bin/env bash
set -Eeuo pipefail

# The deployment key's forced command. It accepts only the exact deploy form;
# every other command, including the retired media triggers, is rejected
# before anything is spawned. Media ingestion runs inside the application.

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

printf '%s\n' 'invalid remote command' >&2
exit 64

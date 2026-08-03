#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")" && pwd)"
openai_env="/home/alex/anoname/anoname-api/.env"
telegram_env="${TG_ENV_FILE:-$project_dir/.env}"

if [[ -f "$telegram_env" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$telegram_env"
  set +a
else
  echo "Telegram env file not found: $telegram_env" >&2
  exit 1
fi

if [[ -f "$openai_env" ]]; then
  OPENAI_API_KEY="$(sed -n 's/^OPENAI_API_KEY=//p' "$openai_env" | tail -n 1)"
  export OPENAI_API_KEY
fi

cd "$project_dir"
exec node index.js "$@"

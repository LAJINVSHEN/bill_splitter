#!/bin/sh
# Render start command: migrate (the Supabase DB may still be waking up), then serve.
# One uvicorn worker on purpose: scan jobs are in-process asyncio tasks.
set -eu

attempt=1
until alembic upgrade head; do
  if [ "$attempt" -ge 5 ]; then
    echo "alembic upgrade head failed after $attempt attempts; giving up" >&2
    exit 1
  fi
  echo "alembic upgrade head failed (attempt $attempt/5); retrying in 10s" >&2
  attempt=$((attempt + 1))
  sleep 10
done

exec uvicorn app.main:app \
  --host "${HOST:-0.0.0.0}" \
  --port "${PORT:-8000}" \
  --proxy-headers \
  --forwarded-allow-ips "*" \
  --no-server-header

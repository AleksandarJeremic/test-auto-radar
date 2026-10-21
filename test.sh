#!/usr/bin/env bash
# Runs every suite against a throwaway database, then cleans up after itself.
#
#   ./test.sh
#
set -euo pipefail
cd "$(dirname "$0")"

PORT=8799
DB=server/.test-run.db
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
NODE=$(command -v node || echo /opt/homebrew/bin/node)

cleanup() {
  [[ -n "${PID:-}" ]] && kill "$PID" 2>/dev/null || true
  rm -f "$DB" "$DB-wal" "$DB-shm"
}
trap cleanup EXIT

rm -f "$DB" "$DB-wal" "$DB-shm"
python3 server/server.py --port "$PORT" --db "$DB" > /dev/null 2>&1 &
PID=$!

# Wait for the collector rather than guessing at a sleep duration.
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/health" > /dev/null && break
  sleep 0.25
done

TOKEN=$(cat server/token.txt)
BASE="http://127.0.0.1:$PORT"
fail=0

run() {
  echo
  echo "=== $1 ==="
  shift
  "$@" || fail=1
}

run "ingest i detekcija promena"  python3 server/test/test_ingest.py "$BASE" "$TOKEN"
run "spajanje snimaka i autoritet izvora" python3 server/test/test_merge.py "$BASE" "$TOKEN"
run "parseri cena/km/godista"     "$JSC" extension/src/extract.js extension/test/parsers.test.js
run "marka i model iz slug-a"     "$JSC" extension/src/extract.js extension/test/slug.test.js
run "logika obilaska"             "$NODE" extension/test/crawler.test.mjs

echo
if [[ $fail -eq 0 ]]; then echo "SVE PROLAZI"; else echo "IMA PADOVA"; fi
exit $fail

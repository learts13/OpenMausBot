#!/usr/bin/env bash
set -euo pipefail

image="${1:?Usage: smoke-arm64-image.sh IMAGE}"
test "$(docker image inspect -f '{{.Architecture}}' "$image")" = arm64
fixture="omb-arm64-smoke-$$"
edge="$fixture-edge"
config=$(mktemp)
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker logs "$fixture" 2>/dev/null || true
    docker logs "$edge" 2>/dev/null || true
  fi
  docker rm -fv "$edge" "$fixture" >/dev/null 2>&1 || true
  rm -f "$config"
  exit "$status"
}
trap cleanup EXIT

docker run -d --init --shm-size=512m --name "$fixture" "$image"
for attempt in $(seq 1 60); do
  if docker exec "$fixture" curl -sf http://127.0.0.1:8799/api/health | grep -q openmausbot; then break; fi
  if [ "$attempt" = 60 ]; then echo "Server never became healthy" >&2; exit 1; fi
  sleep 2
done
docker exec "$fixture" curl -sf http://127.0.0.1:8799/ | grep -qi '<html'
test "$(docker exec "$fixture" id -un)" = maus

docker exec -i "$fixture" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire('/app/duckdb/node_modules/smoke.js');
const { DuckDBInstance } = require('@duckdb/node-api');
const instance = await DuckDBInstance.create(':memory:');
const connection = await instance.connect();
const result = await connection.runAndReadAll('SELECT 42 AS answer');
assert.equal(result.getRows()[0][0], 42);
connection.closeSync();
instance.closeSync();
const { Resvg } = require('@resvg/resvg-js');
const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>').render().asPng();
assert.equal(png.subarray(1, 4).toString(), 'PNG');
console.log('Native ARM64 DuckDB and resvg passed');
JS

timeout 60 docker exec "$fixture" agent-browser --session arm64-smoke open 'data:text/html,<title>ARM64 browser ready</title>'
timeout 15 docker exec "$fixture" agent-browser --session arm64-smoke get title | grep -Fx 'ARM64 browser ready'
timeout 15 docker exec "$fixture" agent-browser --session arm64-smoke close

cat > "$config" <<'CADDY'
:8080 {
  handle /hooks/* {
    reverse_proxy 127.0.0.1:8800 {
      header_up X-Forwarded-Proto https
    }
  }
  handle {
    reverse_proxy 127.0.0.1:8799 {
      header_up X-Forwarded-Proto https
      flush_interval -1
    }
  }
}
CADDY
docker run -d --name "$edge" --network "container:$fixture" \
  --mount "type=bind,src=$config,dst=/etc/caddy/Caddyfile,readonly" caddy:2
for attempt in $(seq 1 30); do
  if docker exec "$fixture" curl -sf -H 'Host: fixture.example' http://127.0.0.1:8080/ | grep -qi '<html'; then break; fi
  if [ "$attempt" = 30 ]; then echo "Proxy did not serve the UI" >&2; exit 1; fi
  sleep 2
done
http_status=$(docker exec "$fixture" curl -s -o /dev/null -w '%{http_code}' -H 'Host: fixture.example' http://127.0.0.1:8080/api/bots)
test "$http_status" = 403
pairing=$(docker exec "$fixture" node /app/dist-server/pair-cli.js --label arm64-smoke)
pair_code=$(grep -o 'code=[A-Z2-9-]*' <<< "$pairing" | head -1 | cut -d= -f2)
test -n "$pair_code"
paired=$(docker exec "$fixture" curl -sf -H 'Host: fixture.example' \
  -H 'Origin: https://fixture.example' -H 'Content-Type: application/json' \
  -d "{\"code\":\"$pair_code\"}" http://127.0.0.1:8080/api/auth/pair)
token=$(printf '%s' "$paired" | node -e 'let s=""; for await (const chunk of process.stdin) s+=chunk; const token=JSON.parse(s).token; if (!token) process.exit(1); process.stdout.write(token);')
docker exec "$fixture" curl -sf -H 'Host: fixture.example' \
  -H "Authorization: Bearer $token" http://127.0.0.1:8080/api/bots \
  | node -e 'let s=""; for await (const chunk of process.stdin) s+=chunk; if (!Array.isArray(JSON.parse(s).bots)) process.exit(1);'
echo 'ARM64 image: health, UI, native modules, browser, API rejection and pairing passed'

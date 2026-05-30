#!/bin/bash
# Test the cfFetch fix - hit each provider that was broken and time the response
ROOT="https://flyx-main-v2.vynx-3b3.workers.dev"
echo "=== flixer (was 1042) ==="
curl -s -m 30 -w "STATUS:%{http_code} TIME:%{time_total}s\n" -o /tmp/flixer-out "$ROOT/api/stream/extract?tmdbId=550&type=movie&provider=flixer"
grep -oE '"success":[^,]+|"executionTime":[0-9]+|"error":"[^"]+"' /tmp/flixer-out | head -5
echo ""
echo "=== videasy (was 1042) ==="
curl -s -m 30 -w "STATUS:%{http_code} TIME:%{time_total}s\n" -o /tmp/videasy-out "$ROOT/api/stream/extract?tmdbId=550&type=movie&provider=videasy&title=Fight+Club"
grep -oE '"success":[^,]+|"executionTime":[0-9]+|"error":"[^"]+"' /tmp/videasy-out | head -5
echo ""
echo "=== auto mode (movie) ==="
curl -s -m 30 -w "STATUS:%{http_code} TIME:%{time_total}s\n" -o /tmp/auto-out "$ROOT/api/stream/extract?tmdbId=872585&type=movie&provider=auto"
grep -oE '"success":[^,]+|"executionTime":[0-9]+|"provider":"[^"]+"|"error":"[^"]+"' /tmp/auto-out | head -5
echo ""
echo "=== animekai anime (was anime not found) ==="
curl -s -m 30 -w "STATUS:%{http_code} TIME:%{time_total}s\n" -o /tmp/animekai-out "$ROOT/api/stream/extract?tmdbId=0&malId=21&type=tv&season=1&episode=1&provider=animekai&malTitle=One+Piece"
grep -oE '"success":[^,]+|"executionTime":[0-9]+|"provider":"[^"]+"|"error":"[^"]+"' /tmp/animekai-out | head -5

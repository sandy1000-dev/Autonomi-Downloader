#!/bin/bash
set -e
cd "$(dirname "$0")"

LOG="/tmp/gw-browser.log"
rm -f "$LOG"

# Start gateway with 1mb fixture
node gateway.cjs ../fixtures/1mb --port 8103 > "$LOG" 2>&1 &
GW_PID=$!
sleep 2

ADDR=$(grep 'address =' "$LOG" | awk '{print $NF}')
SHA=$(cat ../fixtures/1mb/original.sha256 | tr -d '\n')
echo "Gateway address: $ADDR"
echo "Expected SHA:    $SHA"

# Run headless Chrome and dump DOM
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
URL="http://localhost:8103/browser-test.html?addr=${ADDR}&sha256=${SHA}"

echo "Fetching: $URL"
# Use virtual-time-budget to let async WASM + fetch complete before dumping DOM.
"$CHROME" --headless --disable-gpu --no-sandbox \
  --virtual-time-budget=10000 \
  --dump-dom "$URL" 2>/tmp/chrome.log > /tmp/chrome-dom.html

echo "--- Browser test DOM result ---"
cat /tmp/chrome-dom.html | grep -oE 'RESULT.*|PASS|FAIL|ERROR.*|sha256=.*' || echo "(no result markers)"
echo "--- Full DOM ---"
cat /tmp/chrome-dom.html

echo "--- Chrome stderr ---"
cat /tmp/chrome.log | grep -v 'ERROR:base/process' | grep -v 'SharedImageManager' | head -30 || true

kill $GW_PID 2>/dev/null || true
wait $GW_PID 2>/dev/null || true


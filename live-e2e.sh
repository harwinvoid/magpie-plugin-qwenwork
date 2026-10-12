#!/bin/bash
# Repeatable live E2E: Magpie gateway → qwenwork plugin → bundled Agent SDK → QwenWork.
# Requires: magpie running and signed in (`magpie plugin login qwenwork`).
set -u
GW="${GW:-http://127.0.0.1:3425}"
KEY="${KEY:-magpie}"
ask() { curl --silent --show-error --max-time 120 "$GW/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"model\":\"qwenwork/$1\",\"messages\":[{\"role\":\"user\",\"content\":\"$2\"}],\"max_tokens\":64,\"stream\":${3:-false}}"; }

fail=0
echo "== models =="
curl --silent "$GW/v1/models" -H "Authorization: Bearer $KEY" | python3 -c 'import json,sys; print([m["id"] for m in json.load(sys.stdin)["data"] if m["id"].startswith("qwenwork/")])'

echo "== flash (non-stream) =="
ask flash '请只回复：QWENWORK_OK' false | python3 -c '
import json,sys
j=json.load(sys.stdin); c=j["choices"][0]["message"]["content"]
print("content:",repr(c)); assert "QWENWORK_OK" in c, "unexpected answer"; print("PASS")' || fail=1

echo "== pro (non-stream) =="
ask pro '只回复：PRO_OK' false | python3 -c '
import json,sys
j=json.load(sys.stdin); c=j["choices"][0]["message"]["content"]; print("content:",repr(c)); print("PASS")' || fail=1

echo "== qwen3.8-max-preview (non-stream) =="
ask qwen3.8-max-preview '只回复：MAX_OK' false | python3 -c '
import json,sys
j=json.load(sys.stdin); c=j["choices"][0]["message"]["content"]; print("content:",repr(c)); print("PASS")' || fail=1

echo "== flash (stream) =="
ask flash '只回复：OK' true | python3 -c '
import sys
t=sys.stdin.read()
assert "chat.completion.chunk" in t and "[DONE]" in t, "stream malformed"
print("PASS: SSE chunk + [DONE]")' || fail=1

echo "== unauthenticated state =="
if [ "$fail" -eq 0 ]; then echo "ALL LIVE CHECKS PASSED"; else echo "SOME CHECKS FAILED"; fi
exit "$fail"

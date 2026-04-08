#!/usr/bin/env bash
# bin/test-wrapper.sh — smoke tests for bin/reporter
#
# Usage: bash bin/test-wrapper.sh

set -euo pipefail

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPORTER="${SCRIPT_DIR}/reporter"

_pass() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
_fail() { printf '  FAIL: %s — %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

# ─── Test 1: reporter — no socket env → silent exit 0 ─────────────────────────
printf '\nTest 1: reporter exits silently when VSCODE_CLAUDE_SOCKET unset\n'
INPUT='{"session_id":"test-123","hook_event_name":"Stop"}'
if printf '%s' "${INPUT}" | VSCODE_CLAUDE_SOCKET="" bash "${REPORTER}" 2>/dev/null; then
  _pass 'reporter exits 0 with no socket'
else
  _fail 'reporter exited non-zero with no socket'
fi

# ─── Test 2: reporter sends correct NDJSON to a live Unix socket ───────────────
printf '\nTest 2: reporter sends correct NDJSON to socket\n'
SOCK_PATH="/tmp/vscode-test-reporter-$$.sock"
RECEIVED_FILE="/tmp/vscode-test-received-$$.txt"
LISTENER_SCRIPT="/tmp/vscode-test-listener-$$.py"
rm -f "${SOCK_PATH}" "${RECEIVED_FILE}" "${LISTENER_SCRIPT}"

# Write listener script to a temp file
cat > "${LISTENER_SCRIPT}" <<'PYEOF'
import socket, os, sys, time

sock_path = sys.argv[1]
out_file  = sys.argv[2]

if os.path.exists(sock_path):
    os.unlink(sock_path)
srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
srv.bind(sock_path)
srv.listen(1)
srv.settimeout(3)
try:
    conn, _ = srv.accept()
    data = conn.recv(4096)
    conn.close()
    with open(out_file, 'wb') as f:
        f.write(data)
except Exception:
    pass
finally:
    srv.close()
    try:
        os.unlink(sock_path)
    except OSError:
        pass
PYEOF

python3 "${LISTENER_SCRIPT}" "${SOCK_PATH}" "${RECEIVED_FILE}" &
LISTENER_PID=$!
sleep 0.3   # let listener bind

INPUT='{"session_id":"sess-abc","hook_event_name":"UserPromptSubmit","prompt":"hello world"}'
printf '%s' "${INPUT}" \
  | VSCODE_CLAUDE_SOCKET="${SOCK_PATH}" bash "${REPORTER}" 2>/dev/null || true

# Wait for listener to finish (up to 2 s)
for _ in 1 2 3 4; do
  sleep 0.5
  [ -f "${RECEIVED_FILE}" ] && break
done
wait "${LISTENER_PID}" 2>/dev/null || true

if [ -f "${RECEIVED_FILE}" ]; then
  RECEIVED="$(cat "${RECEIVED_FILE}")"
  if python3 -c "
import json, sys
data = json.loads(sys.argv[1].strip())
assert data.get('event') == 'user_prompt_submit', f'bad event: {data}'
assert data.get('session_id') == 'sess-abc', f'bad session_id: {data}'
assert data.get('prompt') == 'hello world', f'bad prompt: {data}'
" "${RECEIVED}" 2>/dev/null; then
    _pass 'reporter sends correct user_prompt_submit JSON'
  else
    _fail 'reporter JSON incorrect' "${RECEIVED}"
  fi
else
  _fail 'reporter sent nothing to socket'
fi
rm -f "${RECEIVED_FILE}" "${SOCK_PATH}" "${LISTENER_SCRIPT}"

# ─── Test 3: reporter --save-session writes session_id to file ────────────────
printf '\nTest 3: --save-session writes session_id\n'
SESS_FILE="/tmp/vscode-test-sess-$$.id"
rm -f "${SESS_FILE}"
INPUT='{"session_id":"saved-uuid","hook_event_name":"SessionStart"}'
printf '%s' "${INPUT}" \
  | VSCODE_CLAUDE_SOCKET="/nonexistent.sock" \
    bash "${REPORTER}" --save-session "${SESS_FILE}" 2>/dev/null || true

if [ -f "${SESS_FILE}" ] && [ "$(cat "${SESS_FILE}")" = "saved-uuid" ]; then
  _pass '--save-session writes correct session_id'
else
  _fail '--save-session did not write session_id' \
    "$(cat "${SESS_FILE}" 2>/dev/null || echo '(file missing)')"
fi
rm -f "${SESS_FILE}"

# ─── Test 4: reporter handles all hook event types without crash ───────────────
printf '\nTest 4: reporter handles all known hook event types\n'
for HOOK in SessionStart UserPromptSubmit PreToolUse Stop Notification; do
  printf '%s' "{\"session_id\":\"s1\",\"hook_event_name\":\"${HOOK}\"}" \
    | VSCODE_CLAUDE_SOCKET="/nonexistent.sock" bash "${REPORTER}" 2>/dev/null || true
  _pass "handles ${HOOK} without crash"
done

# ─── Test 5: reporter drops unknown hook event types silently ─────────────────
printf '\nTest 5: reporter silently ignores unknown hook event type\n'
printf '%s' '{"session_id":"s1","hook_event_name":"UnknownHook"}' \
  | VSCODE_CLAUDE_SOCKET="/nonexistent.sock" bash "${REPORTER}" 2>/dev/null || true
_pass 'unknown hook event type ignored without crash'

# ─── Test 6: reporter handles malformed JSON without crash ────────────────────
printf '\nTest 6: malformed stdin JSON → silent exit\n'
printf '%s' 'not-json' \
  | VSCODE_CLAUDE_SOCKET="/nonexistent.sock" bash "${REPORTER}" 2>/dev/null || true
_pass 'malformed JSON ignored without crash'

# ─── Summary ───────────────────────────────────────────────────────────────────
printf '\n───────────────────────────────\n'
printf 'Results: %d passed, %d failed\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ] && exit 0 || exit 1

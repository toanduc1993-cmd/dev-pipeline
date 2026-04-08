#!/bin/bash
# Sprint 05 — Gate verify: orchestrator wiring test
BASE=http://localhost:3001/api
PASS=0; FAIL=0

check() {
  local desc="$1" expect="$2" method="$3" url="$4" body="$5"
  if [ -n "$body" ]; then
    resp=$(curl -s -w "\n%{http_code}" -X "$method" "$url" -H "Content-Type: application/json" -d "$body")
  else
    resp=$(curl -s -w "\n%{http_code}" -X "$method" "$url")
  fi
  status=$(echo "$resp" | tail -1)
  body_out=$(echo "$resp" | sed '$d')
  if [ "$status" = "$expect" ]; then
    echo "  PASS  $desc ($status)"
    PASS=$((PASS+1))
  else
    echo "  FAIL  $desc (expected $expect, got $status)"
    echo "        $(echo "$body_out" | head -1)"
    FAIL=$((FAIL+1))
  fi
  echo "$body_out" > /tmp/_s05_last.json
}

echo "=== Setup: Create project + sprint ==="
check "Create project" 201 POST "$BASE/projects" \
  '{"name":"Sprint05 Test","repoPath":"/tmp/s05-test"}'
PID=$(python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" < /tmp/_s05_last.json 2>/dev/null)
echo "  project: $PID"

check "Create sprint" 201 POST "$BASE/projects/$PID/sprints" \
  '{"name":"Test Sprint","requirementText":"Test requirement"}'
SID=$(python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" < /tmp/_s05_last.json 2>/dev/null)
echo "  sprint: $SID"

# Gate 0 should be waiting_approval (set by createSprint)
G0_ID=$(curl -s "$BASE/sprints/$SID/gates" | python3 -c "
import sys,json
gates = json.load(sys.stdin)
g0 = [g for g in gates if g['gateNumber'] == 0][0]
print(g0['id'])
" 2>/dev/null)
G0_STATUS=$(curl -s "$BASE/sprints/$SID/gates" | python3 -c "
import sys,json
gates = json.load(sys.stdin)
g0 = [g for g in gates if g['gateNumber'] == 0][0]
print(g0['status'])
" 2>/dev/null)
echo "  gate0: $G0_ID (status: $G0_STATUS)"

echo ""
echo "=== TEST 1: Approve Gate 0 via orchestrator ==="
check "Approve gate 0" 200 POST "$BASE/gates/$G0_ID/approve" '{"comment":"LGTM"}'

# Verify response says pipeline triggered
HAS_TRIGGERED=$(python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'triggered' in d.get('message','') else 'no')" < /tmp/_s05_last.json 2>/dev/null)
if [ "$HAS_TRIGGERED" = "yes" ]; then
  echo "  PASS  Response says 'pipeline triggered'"
  PASS=$((PASS+1))
else
  echo "  FAIL  Response missing 'pipeline triggered'"
  FAIL=$((FAIL+1))
fi

# Give setImmediate time to fire _triggerNextStep
sleep 2

echo ""
echo "=== TEST 2: Verify DB state after _triggerNextStep ==="

# Gate 0 should be approved
G0_FINAL=$(curl -s "$BASE/gates/$G0_ID" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
if [ "$G0_FINAL" = "approved" ]; then
  echo "  PASS  Gate 0 status = approved"
  PASS=$((PASS+1))
else
  echo "  FAIL  Gate 0 status = $G0_FINAL (expected approved)"
  FAIL=$((FAIL+1))
fi

# Sprint should be 'failed' because PipelineRunner.runStep throws
SPRINT_STATUS=$(curl -s "$BASE/sprints/$SID" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
if [ "$SPRINT_STATUS" = "failed" ]; then
  echo "  PASS  Sprint status = failed (expected — runner not implemented)"
  PASS=$((PASS+1))
else
  echo "  FAIL  Sprint status = $SPRINT_STATUS (expected failed)"
  FAIL=$((FAIL+1))
fi

# Should have isProcessing = false (reset by error handler)
IS_PROC=$(curl -s "$BASE/sprints/$SID" | python3 -c "import sys,json; print(json.load(sys.stdin)['isProcessing'])" 2>/dev/null)
if [ "$IS_PROC" = "False" ]; then
  echo "  PASS  isProcessing = false (reset after failure)"
  PASS=$((PASS+1))
else
  echo "  FAIL  isProcessing = $IS_PROC (expected False)"
  FAIL=$((FAIL+1))
fi

# Notification should exist for sprint_failed
NOTIF_COUNT=$(curl -s "$BASE/notifications" | python3 -c "
import sys,json
d = json.load(sys.stdin)
notifs = d.get('notifications', d if isinstance(d, list) else [])
failed = [n for n in notifs if n['type'] == 'sprint_failed']
print(len(failed))
" 2>/dev/null)
if [ "$NOTIF_COUNT" -ge "1" ] 2>/dev/null; then
  echo "  PASS  sprint_failed notification created"
  PASS=$((PASS+1))
else
  echo "  FAIL  No sprint_failed notification found ($NOTIF_COUNT)"
  FAIL=$((FAIL+1))
fi

echo ""
echo "=== TEST 3: Approve already-approved gate ==="
check "Approve already-approved gate 0" 400 POST "$BASE/gates/$G0_ID/approve" '{}'

echo ""
echo "=== TEST 4: Reject a gate ==="
# Create a fresh sprint for reject test
check "Create sprint 2" 201 POST "$BASE/projects/$PID/sprints" \
  '{"name":"Test Sprint 2","requirementText":"Test req 2"}'
SID2=$(python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" < /tmp/_s05_last.json 2>/dev/null)
G0_ID2=$(curl -s "$BASE/sprints/$SID2/gates" | python3 -c "
import sys,json; print([g['id'] for g in json.load(sys.stdin) if g['gateNumber']==0][0])
" 2>/dev/null)

check "Reject gate 0" 200 POST "$BASE/gates/$G0_ID2/reject" '{"reason":"Not ready"}'

# Sprint should be waiting_gate after reject
SPRINT2_STATUS=$(curl -s "$BASE/sprints/$SID2" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
if [ "$SPRINT2_STATUS" = "waiting_gate" ]; then
  echo "  PASS  Sprint status = waiting_gate after reject"
  PASS=$((PASS+1))
else
  echo "  FAIL  Sprint status = $SPRINT2_STATUS (expected waiting_gate)"
  FAIL=$((FAIL+1))
fi

# Gate rejected notification should exist
REJECT_NOTIF=$(curl -s "$BASE/notifications" | python3 -c "
import sys,json
d = json.load(sys.stdin)
notifs = d.get('notifications', d if isinstance(d, list) else [])
rejected = [n for n in notifs if n['type'] == 'gate_rejected']
print(len(rejected))
" 2>/dev/null)
if [ "$REJECT_NOTIF" -ge "1" ] 2>/dev/null; then
  echo "  PASS  gate_rejected notification created"
  PASS=$((PASS+1))
else
  echo "  FAIL  No gate_rejected notification found ($REJECT_NOTIF)"
  FAIL=$((FAIL+1))
fi

echo ""
echo "=== TEST 5: 404 / validation ==="
check "Approve nonexistent gate" 404 POST "$BASE/gates/nonexistent/approve" '{}'
check "Reject without reason" 400 POST "$BASE/gates/$G0_ID2/reject" '{}'

echo ""
echo "==================================="
echo "Results: $PASS passed, $FAIL failed"
echo "==================================="
rm -f /tmp/_s05_last.json
[ $FAIL -gt 0 ] && exit 1 || exit 0

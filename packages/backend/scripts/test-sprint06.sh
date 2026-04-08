#!/bin/bash
# Sprint 06 — Live Claude pipeline test: Steps 1 → 2 → 3
# WARNING: This calls Claude for real — each gate approval takes 30-90 seconds
BASE=http://localhost:3001/api
REPO_PATH="/Users/nguyenductoan/Desktop/Projects/ai-dev-pipeline"
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
  echo "$body_out" > /tmp/_s06_last.json
}

py() { python3 -c "$1" < /tmp/_s06_last.json 2>/dev/null; }

wait_for_gate() {
  local gate_num=$1 sprint_id=$2 max_wait=${3:-300}
  echo "  ... waiting for Gate $gate_num (max ${max_wait}s)"
  local elapsed=0
  while [ $elapsed -lt $max_wait ]; do
    local g_status=$(curl -s "$BASE/sprints/$sprint_id/gates" | python3 -c "
import sys,json
gates = json.load(sys.stdin)
g = [x for x in gates if x['gateNumber'] == $gate_num]
print(g[0]['status'] if g else 'missing')
" 2>/dev/null)
    if [ "$g_status" = "waiting_approval" ]; then
      echo "  ... Gate $gate_num is waiting_approval (${elapsed}s)"
      return 0
    fi
    local s_status=$(curl -s "$BASE/sprints/$sprint_id" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
    if [ "$s_status" = "failed" ]; then
      echo "  ... Sprint FAILED (${elapsed}s)"
      return 1
    fi
    sleep 5
    elapsed=$((elapsed+5))
  done
  echo "  ... TIMEOUT waiting for Gate $gate_num"
  return 1
}

echo "=== Setup: Create project + sprint ==="
check "Create project" 201 POST "$BASE/projects" \
  "{\"name\":\"Sprint06 Live Test\",\"repoPath\":\"$REPO_PATH\",\"language\":\"javascript\"}"
PID=$(py "import sys,json; print(json.load(sys.stdin)['id'])")
echo "  project: $PID"

REQUIREMENT="Build a simple login feature: user enters email + password, system validates and returns a JWT token. Tech stack: Express + jsonwebtoken. Keep it simple - just the auth endpoint."

check "Create sprint" 201 POST "$BASE/projects/$PID/sprints" \
  "{\"name\":\"Live Test Sprint\",\"requirementText\":\"$REQUIREMENT\"}"
SID=$(py "import sys,json; print(json.load(sys.stdin)['id'])")
echo "  sprint: $SID"

# Get Gate 0 ID
G0=$(curl -s "$BASE/sprints/$SID/gates" | python3 -c "
import sys,json; print([g['id'] for g in json.load(sys.stdin) if g['gateNumber']==0][0])
" 2>/dev/null)
echo "  gate0: $G0"

echo ""
echo "=== STEP 1: Approve Gate 0 → Architect runs ==="
check "Approve Gate 0" 200 POST "$BASE/gates/$G0/approve" '{"comment":"Go"}'

wait_for_gate 1 $SID 300
if [ $? -ne 0 ]; then
  echo "  FAIL  Step 1 did not complete"
  FAIL=$((FAIL+1))
  # Show error context
  curl -s "$BASE/sprints/$SID" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  Sprint status: {d[\"status\"]}, step: {d[\"currentStep\"]}')" 2>/dev/null
  echo ""
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi

# Verify Gate 1 notes
G1=$(curl -s "$BASE/sprints/$SID/gates" | python3 -c "
import sys,json; print([g['id'] for g in json.load(sys.stdin) if g['gateNumber']==1][0])
" 2>/dev/null)
G1_NOTES=$(curl -s "$BASE/gates/$G1" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('notes','') or ''))" 2>/dev/null)
if [ "$G1_NOTES" -gt 100 ] 2>/dev/null; then
  echo "  PASS  Gate 1 notes have content ($G1_NOTES chars)"
  PASS=$((PASS+1))
else
  echo "  FAIL  Gate 1 notes too short ($G1_NOTES chars)"
  FAIL=$((FAIL+1))
fi

G1_HAS_JSON=$(curl -s "$BASE/gates/$G1" | python3 -c "
import sys,json; notes=json.load(sys.stdin).get('notes',''); print('yes' if '\`\`\`json' in notes else 'no')
" 2>/dev/null)
if [ "$G1_HAS_JSON" = "yes" ]; then
  echo "  PASS  Gate 1 notes contain JSON block"
  PASS=$((PASS+1))
else
  echo "  FAIL  Gate 1 notes missing JSON block"
  FAIL=$((FAIL+1))
fi

SPRINT_GATE=$(curl -s "$BASE/sprints/$SID" | python3 -c "import sys,json; print(json.load(sys.stdin)['currentGateNumber'])" 2>/dev/null)
if [ "$SPRINT_GATE" = "1" ]; then
  echo "  PASS  sprint.currentGateNumber = 1"
  PASS=$((PASS+1))
else
  echo "  FAIL  sprint.currentGateNumber = $SPRINT_GATE (expected 1)"
  FAIL=$((FAIL+1))
fi

echo ""
echo "=== STEP 2: Approve Gate 1 → Feature Specs runs ==="
check "Approve Gate 1" 200 POST "$BASE/gates/$G1/approve" '{"comment":"Approved"}'

wait_for_gate 2 $SID 300
if [ $? -ne 0 ]; then
  echo "  FAIL  Step 2 did not complete"
  FAIL=$((FAIL+1))
  curl -s "$BASE/sprints/$SID" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  Sprint status: {d[\"status\"]}')" 2>/dev/null
  echo "Results: $PASS passed, $FAIL failed"; exit 1
fi

G2=$(curl -s "$BASE/sprints/$SID/gates" | python3 -c "
import sys,json; print([g['id'] for g in json.load(sys.stdin) if g['gateNumber']==2][0])
" 2>/dev/null)
G2_NOTES=$(curl -s "$BASE/gates/$G2" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('notes','') or ''))" 2>/dev/null)
if [ "$G2_NOTES" -gt 100 ] 2>/dev/null; then
  echo "  PASS  Gate 2 notes have content ($G2_NOTES chars)"
  PASS=$((PASS+1))
else
  echo "  FAIL  Gate 2 notes too short ($G2_NOTES chars)"
  FAIL=$((FAIL+1))
fi

echo ""
echo "=== STEP 3: Approve Gate 2 → Atomic Tasks runs ==="
check "Approve Gate 2" 200 POST "$BASE/gates/$G2/approve" '{"comment":"Good specs"}'

wait_for_gate 3 $SID 300
if [ $? -ne 0 ]; then
  echo "  FAIL  Step 3 did not complete"
  FAIL=$((FAIL+1))
  curl -s "$BASE/sprints/$SID" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  Sprint status: {d[\"status\"]}')" 2>/dev/null
  echo "Results: $PASS passed, $FAIL failed"; exit 1
fi

G3=$(curl -s "$BASE/sprints/$SID/gates" | python3 -c "
import sys,json; print([g['id'] for g in json.load(sys.stdin) if g['gateNumber']==3][0])
" 2>/dev/null)
G3_NOTES=$(curl -s "$BASE/gates/$G3" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('notes','') or ''))" 2>/dev/null)
if [ "$G3_NOTES" -gt 100 ] 2>/dev/null; then
  echo "  PASS  Gate 3 notes have content ($G3_NOTES chars)"
  PASS=$((PASS+1))
else
  echo "  FAIL  Gate 3 notes too short ($G3_NOTES chars)"
  FAIL=$((FAIL+1))
fi

# Verify tasks created in DB
TASK_COUNT=$(curl -s "$BASE/sprints/$SID/tasks" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
if [ "$TASK_COUNT" -ge 1 ] 2>/dev/null; then
  echo "  PASS  $TASK_COUNT task(s) created in DB"
  PASS=$((PASS+1))
else
  echo "  FAIL  No tasks in DB ($TASK_COUNT)"
  FAIL=$((FAIL+1))
fi

SPRINT_GATE=$(curl -s "$BASE/sprints/$SID" | python3 -c "import sys,json; print(json.load(sys.stdin)['currentGateNumber'])" 2>/dev/null)
if [ "$SPRINT_GATE" = "3" ]; then
  echo "  PASS  sprint.currentGateNumber = 3"
  PASS=$((PASS+1))
else
  echo "  FAIL  sprint.currentGateNumber = $SPRINT_GATE (expected 3)"
  FAIL=$((FAIL+1))
fi

echo ""
echo "==================================="
echo "Results: $PASS passed, $FAIL failed"
echo "==================================="
rm -f /tmp/_s06_last.json
[ $FAIL -gt 0 ] && exit 1 || exit 0

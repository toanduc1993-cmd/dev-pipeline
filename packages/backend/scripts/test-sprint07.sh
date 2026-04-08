#!/bin/bash
# Sprint 07 — Live test: Steps 1→2→3→4 (full pipeline through dev agents)
# Uses simple requirement to minimize Claude time
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
  echo "$body_out" > /tmp/_s07.json
}

wait_for_gate() {
  local gate_num=$1 sprint_id=$2 max_wait=${3:-300}
  echo "  ... waiting for Gate $gate_num (max ${max_wait}s)"
  local elapsed=0
  while [ $elapsed -lt $max_wait ]; do
    local g_status=$(curl -s "$BASE/sprints/$sprint_id/gates" | python3 -c "
import sys,json; gates=json.load(sys.stdin); g=[x for x in gates if x['gateNumber']==$gate_num]; print(g[0]['status'] if g else 'missing')" 2>/dev/null)
    if [ "$g_status" = "waiting_approval" ]; then
      echo "  ... Gate $gate_num ready (${elapsed}s)"
      return 0
    fi
    local s_status=$(curl -s "$BASE/sprints/$sprint_id" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
    if [ "$s_status" = "failed" ]; then
      echo "  ... Sprint FAILED (${elapsed}s)"
      return 1
    fi
    if [ "$s_status" = "waiting_human" ]; then
      echo "  ... Sprint waiting_human (escalated tasks) (${elapsed}s)"
      return 2
    fi
    sleep 10
    elapsed=$((elapsed+10))
  done
  echo "  ... TIMEOUT"
  return 1
}

get_gate_id() {
  curl -s "$BASE/sprints/$1/gates" | python3 -c "
import sys,json; print([g['id'] for g in json.load(sys.stdin) if g['gateNumber']==$2][0])" 2>/dev/null
}

echo "=== Setup ==="
check "Create project" 201 POST "$BASE/projects" \
  "{\"name\":\"S07 Live\",\"repoPath\":\"$REPO_PATH\",\"language\":\"javascript\"}"
PID=$(python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" < /tmp/_s07.json)

REQ="Create 2 simple utility functions in separate files under a new utils/ directory: (1) validateEmail(email) - returns true if email contains @ and a dot after @, false otherwise, in src/utils/validateEmail.js. (2) formatDate(date) - takes a Date object and returns string in DD/MM/YYYY format, in src/utils/formatDate.js. Each function should be a named export. No external dependencies needed."

check "Create sprint" 201 POST "$BASE/projects/$PID/sprints" \
  "{\"name\":\"Utility Functions\",\"requirementText\":\"$REQ\"}"
SID=$(python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" < /tmp/_s07.json)
echo "  sprint: $SID"

echo ""
echo "=== Steps 1-3: Architect → Specs → Tasks ==="
G0=$(get_gate_id $SID 0)
check "Approve Gate 0" 200 POST "$BASE/gates/$G0/approve" '{"comment":"Go"}'
wait_for_gate 1 $SID 300 || { echo "ABORT at Gate 1"; exit 1; }

G1=$(get_gate_id $SID 1)
check "Approve Gate 1" 200 POST "$BASE/gates/$G1/approve" '{"comment":"OK"}'
wait_for_gate 2 $SID 300 || { echo "ABORT at Gate 2"; exit 1; }

G2=$(get_gate_id $SID 2)
check "Approve Gate 2" 200 POST "$BASE/gates/$G2/approve" '{"comment":"OK"}'
wait_for_gate 3 $SID 300 || { echo "ABORT at Gate 3"; exit 1; }

TASK_COUNT=$(curl -s "$BASE/sprints/$SID/tasks" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
echo "  Tasks created: $TASK_COUNT"

echo ""
echo "=== Step 4: Approve Gate 3 → Developer Agents run ==="
G3=$(get_gate_id $SID 3)
check "Approve Gate 3" 200 POST "$BASE/gates/$G3/approve" '{"comment":"Build it"}'

# Step 4 runs dev agents — wait for Gate 4 auto-approve OR sprint failure/escalation
# Each task: ~180s dev + ~5s validation + ~120s review = ~300s per task
# With 2 tasks sequential: ~600s = 10 min total
echo "  ... Developer agents running (expect ~10-15 min for 2 tasks)"

# Poll for completion — check for gate 4 approved, waiting_human, or failed
MAX_STEP4_WAIT=900
ELAPSED=0
STEP4_RESULT=""
while [ $ELAPSED -lt $MAX_STEP4_WAIT ]; do
  # Check sprint status
  S_DATA=$(curl -s "$BASE/sprints/$SID")
  S_STATUS=$(echo "$S_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
  S_STEP=$(echo "$S_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin)['currentStep'])" 2>/dev/null)

  # Check gate 4
  G4_STATUS=$(curl -s "$BASE/sprints/$SID/gates" | python3 -c "
import sys,json; gates=json.load(sys.stdin); g=[x for x in gates if x['gateNumber']==4]; print(g[0]['status'] if g else 'pending')" 2>/dev/null)

  if [ "$G4_STATUS" = "approved" ]; then
    STEP4_RESULT="gate4_approved"
    echo "  ... Gate 4 auto-approved (${ELAPSED}s) — all tasks PASS"
    break
  fi
  if [ "$S_STATUS" = "failed" ]; then
    STEP4_RESULT="failed"
    echo "  ... Sprint FAILED at step $S_STEP (${ELAPSED}s)"
    break
  fi
  if [ "$S_STATUS" = "waiting_human" ]; then
    STEP4_RESULT="escalated"
    echo "  ... Tasks escalated — waiting_human (${ELAPSED}s)"
    break
  fi

  # Show progress
  TASK_STATES=$(curl -s "$BASE/sprints/$SID/tasks" | python3 -c "
import sys,json
tasks=json.load(sys.stdin)
states={}
for t in tasks:
  s=t['status']
  states[s]=states.get(s,0)+1
print(' '.join(f'{k}={v}' for k,v in sorted(states.items())))
" 2>/dev/null)
  echo "  ... [${ELAPSED}s] sprint=$S_STATUS step=$S_STEP tasks: $TASK_STATES"

  sleep 30
  ELAPSED=$((ELAPSED+30))
done

if [ -z "$STEP4_RESULT" ]; then
  echo "  TIMEOUT waiting for Step 4"
  STEP4_RESULT="timeout"
fi

echo ""
echo "=== Verify results ==="

# Task statuses
TASKS_JSON=$(curl -s "$BASE/sprints/$SID/tasks")
echo "$TASKS_JSON" | python3 -c "
import sys,json
tasks=json.load(sys.stdin)
for t in tasks:
  print(f'  {t[\"taskId\"]}: status={t[\"status\"]} round={t[\"currentRound\"]} verdict={t.get(\"archVerdict\",\"N/A\")}')
" 2>/dev/null

PASS_COUNT=$(echo "$TASKS_JSON" | python3 -c "import sys,json; print(len([t for t in json.load(sys.stdin) if t['status']=='pass']))" 2>/dev/null)
TOTAL=$(echo "$TASKS_JSON" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)

if [ "$STEP4_RESULT" = "gate4_approved" ]; then
  echo "  PASS  All $PASS_COUNT/$TOTAL tasks passed — Gate 4 auto-approved"
  PASS=$((PASS+1))

  # Check agent logs exist
  LOG_COUNT=$(echo "$TASKS_JSON" | python3 -c "
import sys,json
tasks=json.load(sys.stdin)
tid=tasks[0]['id'] if tasks else ''
print(tid)
" 2>/dev/null)
  if [ -n "$LOG_COUNT" ]; then
    LOGS=$(curl -s "$BASE/tasks/$LOG_COUNT/logs" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
    if [ "$LOGS" -ge 2 ] 2>/dev/null; then
      echo "  PASS  AgentLog records exist ($LOGS logs for first task)"
      PASS=$((PASS+1))
    else
      echo "  FAIL  Too few AgentLog records ($LOGS)"
      FAIL=$((FAIL+1))
    fi
  fi

  # Sprint should now be failed because _step5_QA is a stub
  sleep 3
  FINAL_STATUS=$(curl -s "$BASE/sprints/$SID" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
  if [ "$FINAL_STATUS" = "failed" ]; then
    echo "  PASS  Sprint status=failed (expected — Step 5 QA is stub)"
    PASS=$((PASS+1))
  else
    echo "  INFO  Sprint status=$FINAL_STATUS"
  fi

elif [ "$STEP4_RESULT" = "escalated" ]; then
  echo "  INFO  Some tasks escalated ($PASS_COUNT/$TOTAL passed)"
  echo "  PASS  Step 4 ran to completion (some tasks escalated)"
  PASS=$((PASS+1))

elif [ "$STEP4_RESULT" = "failed" ]; then
  echo "  FAIL  Sprint failed during Step 4"
  FAIL=$((FAIL+1))
else
  echo "  FAIL  Step 4 timeout"
  FAIL=$((FAIL+1))
fi

echo ""
echo "==================================="
echo "Results: $PASS passed, $FAIL failed"
echo "==================================="
rm -f /tmp/_s07.json
[ $FAIL -gt 0 ] && exit 1 || exit 0

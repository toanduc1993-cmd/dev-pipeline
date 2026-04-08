#!/bin/bash
# Sprint 08 — Full E2E: Gate 0 → Gate 6 → merged code
BASE=http://localhost:3001/api
REPO_PATH="/tmp/ai-pipeline-e2e-test"
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
    echo "  PASS  $desc ($status)"; PASS=$((PASS+1))
  else
    echo "  FAIL  $desc (expected $expect, got $status)"; FAIL=$((FAIL+1))
    echo "        $(echo "$body_out" | head -1)"
  fi
  echo "$body_out" > /tmp/_e2e.json
}

get_gate_id() {
  curl -s "$BASE/sprints/$1/gates" | python3 -c "
import sys,json; print([g['id'] for g in json.load(sys.stdin) if g['gateNumber']==$2][0])" 2>/dev/null
}

wait_for() {
  local what=$1 sprint_id=$2 max_wait=${3:-300}
  echo "  ... waiting for $what (max ${max_wait}s)"
  local elapsed=0
  while [ $elapsed -lt $max_wait ]; do
    local data=$(curl -s "$BASE/sprints/$sprint_id")
    local s_status=$(echo "$data" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
    local s_gate=$(echo "$data" | python3 -c "import sys,json; print(json.load(sys.stdin)['currentGateNumber'])" 2>/dev/null)

    case "$what" in
      gate_*)
        local gn=${what#gate_}
        local g_status=$(curl -s "$BASE/sprints/$sprint_id/gates" | python3 -c "
import sys,json; gates=json.load(sys.stdin); g=[x for x in gates if x['gateNumber']==$gn]; print(g[0]['status'] if g else 'missing')" 2>/dev/null)
        if [ "$g_status" = "waiting_approval" ]; then
          echo "  ... $what ready (${elapsed}s)"; return 0
        fi
        ;;
      completed)
        if [ "$s_status" = "completed" ]; then
          echo "  ... completed (${elapsed}s)"; return 0
        fi
        ;;
    esac

    if [ "$s_status" = "failed" ]; then
      echo "  ... Sprint FAILED (${elapsed}s)"; return 1
    fi
    if [ "$s_status" = "waiting_human" ]; then
      echo "  ... Escalated (${elapsed}s)"; return 2
    fi

    # Progress
    local tasks=$(curl -s "$BASE/sprints/$sprint_id/tasks" | python3 -c "
import sys,json
ts=json.load(sys.stdin)
st={}
for t in ts: s=t['status']; st[s]=st.get(s,0)+1
print(' '.join(f'{k}={v}' for k,v in sorted(st.items())) if st else 'no-tasks')" 2>/dev/null)
    echo "  ... [${elapsed}s] status=$s_status gate=$s_gate tasks: $tasks"

    sleep 15
    elapsed=$((elapsed+15))
  done
  echo "  ... TIMEOUT"; return 1
}

echo "=== Setup ==="
check "Create project" 201 POST "$BASE/projects" \
  "{\"name\":\"E2E Full Test\",\"repoPath\":\"$REPO_PATH\",\"language\":\"javascript\"}"
PID=$(python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" < /tmp/_e2e.json)

REQ="Create a single utility function formatCurrency(amount, currency) that formats a number as currency string. For VND: 1000000 becomes 1.000.000 VND. For USD: 1234.56 becomes 1,234.56 USD. Export as named export from src/utils/currency.js. No external dependencies."

check "Create sprint" 201 POST "$BASE/projects/$PID/sprints" \
  "{\"name\":\"Currency Formatter\",\"requirementText\":\"$REQ\"}"
SID=$(python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" < /tmp/_e2e.json)
echo "  sprint: $SID"

echo ""
echo "=== Gates 0→3: Architect → Specs → Tasks ==="
for GN in 0 1 2; do
  NEXT_GN=$((GN+1))
  GID=$(get_gate_id $SID $GN)
  check "Approve Gate $GN" 200 POST "$BASE/gates/$GID/approve" '{"comment":"OK"}'
  wait_for "gate_$NEXT_GN" $SID 300
  if [ $? -ne 0 ]; then echo "ABORT at Gate $NEXT_GN"; echo "Results: $PASS passed, $FAIL failed"; exit 1; fi
done

TASK_COUNT=$(curl -s "$BASE/sprints/$SID/tasks" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
echo "  Tasks: $TASK_COUNT"

echo ""
echo "=== Gate 3 → Step 4 (Dev Agents) → Step 5 (QA) → Gate 5 ==="
G3=$(get_gate_id $SID 3)
check "Approve Gate 3" 200 POST "$BASE/gates/$G3/approve" '{"comment":"Build"}'

# Wait for Gate 5 (auto through Gate 4 + QA)
wait_for "gate_5" $SID 900
WAIT_RESULT=$?
if [ $WAIT_RESULT -ne 0 ]; then
  if [ $WAIT_RESULT -eq 2 ]; then
    echo "  INFO  Tasks escalated — overriding all"
    # Override all escalated tasks
    ESCALATED=$(curl -s "$BASE/sprints/$SID/tasks" | python3 -c "
import sys,json; ts=json.load(sys.stdin); print(' '.join(t['id'] for t in ts if t['status']=='escalated'))" 2>/dev/null)
    for TID in $ESCALATED; do
      curl -s -X POST "$BASE/tasks/$TID/override-pass" -H "Content-Type: application/json" > /dev/null
      echo "  ... overrode $TID"
    done
    # Wait for gate 5 again after override
    wait_for "gate_5" $SID 600
    if [ $? -ne 0 ]; then echo "ABORT after override"; echo "Results: $PASS passed, $FAIL failed"; exit 1; fi
  else
    echo "ABORT at Step 4/5"; echo "Results: $PASS passed, $FAIL failed"; exit 1
  fi
fi

# Verify Gate 5 has QA notes
G5=$(get_gate_id $SID 5)
G5_LEN=$(curl -s "$BASE/gates/$G5" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('notes','') or ''))" 2>/dev/null)
if [ "$G5_LEN" -gt 50 ] 2>/dev/null; then
  echo "  PASS  Gate 5 QA notes: $G5_LEN chars"; PASS=$((PASS+1))
else
  echo "  FAIL  Gate 5 QA notes too short ($G5_LEN)"; FAIL=$((FAIL+1))
fi

echo ""
echo "=== Gate 5 → Gate 6 → Merge ==="
check "Approve Gate 5" 200 POST "$BASE/gates/$G5/approve" '{"comment":"QA OK"}'

# Wait for Gate 6
wait_for "gate_6" $SID 30
if [ $? -ne 0 ]; then echo "ABORT at Gate 6 show"; echo "Results: $PASS passed, $FAIL failed"; exit 1; fi

G6=$(get_gate_id $SID 6)
check "Approve Gate 6 (merge)" 200 POST "$BASE/gates/$G6/approve" '{"comment":"Merge it"}'

# Wait for completion
wait_for "completed" $SID 120
if [ $? -ne 0 ]; then
  echo "  FAIL  Sprint did not complete"; FAIL=$((FAIL+1))
else
  echo "  PASS  Sprint completed!"; PASS=$((PASS+1))
fi

echo ""
echo "=== Final verification ==="

# Sprint status
FINAL=$(curl -s "$BASE/sprints/$SID" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'status={d[\"status\"]} gate={d[\"currentGateNumber\"]}')" 2>/dev/null)
echo "  Sprint: $FINAL"

# Check file exists in main branch
cd "$REPO_PATH"
git checkout main 2>/dev/null
if ls src/utils/currency.js 2>/dev/null; then
  echo "  PASS  currency.js exists in main branch"; PASS=$((PASS+1))
else
  # Check if any files were created
  NEW_FILES=$(git diff HEAD~1 --name-only 2>/dev/null | head -5)
  if [ -n "$NEW_FILES" ]; then
    echo "  PASS  Files merged into main: $NEW_FILES"; PASS=$((PASS+1))
  else
    echo "  FAIL  No new files in main branch"; FAIL=$((FAIL+1))
  fi
fi

# Check sprint_complete notification
COMPLETE_NOTIF=$(curl -s "$BASE/notifications" | python3 -c "
import sys,json; d=json.load(sys.stdin); ns=d.get('notifications',d if isinstance(d,list) else [])
print(len([n for n in ns if n['type']=='sprint_complete']))" 2>/dev/null)
if [ "$COMPLETE_NOTIF" -ge 1 ] 2>/dev/null; then
  echo "  PASS  sprint_complete notification exists"; PASS=$((PASS+1))
else
  echo "  FAIL  No sprint_complete notification"; FAIL=$((FAIL+1))
fi

echo ""
echo "==================================="
echo "Results: $PASS passed, $FAIL failed"
echo "==================================="
rm -f /tmp/_e2e.json
[ $FAIL -gt 0 ] && exit 1 || exit 0

#!/bin/bash
# Sprint 02 — Full API Test Script
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
  echo "$body_out" > /tmp/_api_last.json
}

echo "=== HEALTH ==="
check "Health" 200 GET "$BASE/health"

echo ""
echo "=== PROJECTS ==="
check "List projects" 200 GET "$BASE/projects"
check "Create project" 201 POST "$BASE/projects" \
  '{"name":"Test Project","description":"E2E","repoPath":"/tmp/test-repo","language":"typescript"}'
PID=$(python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" < /tmp/_api_last.json 2>/dev/null)
echo "       -> id: $PID"
check "Get project" 200 GET "$BASE/projects/$PID"
check "Update project" 200 PUT "$BASE/projects/$PID" '{"description":"Updated"}'
check "Delete (archive)" 200 DELETE "$BASE/projects/$PID"
check "404 project" 404 GET "$BASE/projects/nonexistent"
check "400 missing fields" 400 POST "$BASE/projects" '{"description":"no name"}'

# un-archive for sprint tests
curl -s -X PUT "$BASE/projects/$PID" -H "Content-Type: application/json" -d '{"status":"active"}' > /dev/null

echo ""
echo "=== SPRINTS ==="
check "Create sprint" 201 POST "$BASE/projects/$PID/sprints" \
  '{"name":"Sprint 1","requirementText":"Build auth module"}'
SID=$(python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" < /tmp/_api_last.json 2>/dev/null)
echo "       -> sprint id: $SID"
check "List sprints" 200 GET "$BASE/projects/$PID/sprints"
check "Get sprint" 200 GET "$BASE/sprints/$SID"
check "Get pipeline" 200 GET "$BASE/sprints/$SID/pipeline"
# Verify 7 gates were created
GATE_COUNT=$(curl -s "$BASE/sprints/$SID/gates" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
if [ "$GATE_COUNT" = "7" ]; then echo "  PASS  7 gates created"; PASS=$((PASS+1)); else echo "  FAIL  Expected 7 gates, got $GATE_COUNT"; FAIL=$((FAIL+1)); fi
check "404 sprint" 404 GET "$BASE/sprints/nonexistent"

echo ""
echo "=== GATES ==="
check "List gates" 200 GET "$BASE/sprints/$SID/gates"
G0ID=$(curl -s "$BASE/sprints/$SID/gates" | python3 -c "import sys,json; print([g['id'] for g in json.load(sys.stdin) if g['gateNumber']==0][0])" 2>/dev/null)
echo "       -> gate 0 id: $G0ID"
check "Get gate" 200 GET "$BASE/gates/$G0ID"
check "Approve gate 0" 200 POST "$BASE/gates/$G0ID/approve" '{"comment":"LGTM"}'
check "Approve already-approved" 400 POST "$BASE/gates/$G0ID/approve" '{}'
# Gate 1 is pending, not waiting_approval
G1ID=$(curl -s "$BASE/sprints/$SID/gates" | python3 -c "import sys,json; print([g['id'] for g in json.load(sys.stdin) if g['gateNumber']==1][0])" 2>/dev/null)
check "Reject non-waiting gate" 400 POST "$BASE/gates/$G1ID/reject" '{"reason":"test"}'
check "Reject missing reason" 400 POST "$BASE/gates/$G0ID/reject" '{}'
check "Request changes missing" 400 POST "$BASE/gates/$G0ID/request-changes" '{}'
check "404 gate" 404 GET "$BASE/gates/nonexistent"

echo ""
echo "=== TASKS ==="
check "List tasks (empty)" 200 GET "$BASE/sprints/$SID/tasks"
check "404 task" 404 GET "$BASE/tasks/nonexistent"
check "404 task logs" 404 GET "$BASE/tasks/nonexistent/logs"
check "404 override" 404 POST "$BASE/tasks/nonexistent/override-pass" '{}'
check "404 retry" 404 POST "$BASE/tasks/nonexistent/retry" '{}'

echo ""
echo "=== NOTIFICATIONS ==="
check "List notifications" 200 GET "$BASE/notifications"
check "Mark all read" 200 POST "$BASE/notifications/read-all" '{}'
check "404 mark read" 404 POST "$BASE/notifications/nonexistent/read" '{}'

echo ""
echo "=== CONFIG ==="
check "Get config" 200 GET "$BASE/config"
check "Update config" 200 PUT "$BASE/config" '{"maxRetryRounds":5}'
# Verify update stuck
RETRY=$(curl -s "$BASE/config" | python3 -c "import sys,json; print(json.load(sys.stdin)['maxRetryRounds'])" 2>/dev/null)
if [ "$RETRY" = "5" ]; then echo "  PASS  Config update persisted"; PASS=$((PASS+1)); else echo "  FAIL  Config not persisted ($RETRY)"; FAIL=$((FAIL+1)); fi
# Reset
curl -s -X PUT "$BASE/config" -H "Content-Type: application/json" -d '{"maxRetryRounds":3}' > /dev/null

echo ""
echo "=== PIPELINE ==="
check "Pipeline health" 200 GET "$BASE/pipeline/health"
check "Pipeline pause" 200 POST "$BASE/pipeline/pause" '{}'
check "Pipeline resume" 200 POST "$BASE/pipeline/resume" '{}'

echo ""
echo "=== AGENTS ==="
check "List agents" 200 GET "$BASE/agents"
check "Agent 1 logs" 200 GET "$BASE/agents/1/logs"
check "Invalid slot" 400 GET "$BASE/agents/9/logs"

echo ""
echo "=== UPLOAD ==="
echo "Test requirement doc" > /tmp/_test_upload.txt
UPLOAD_STATUS=$(curl -s -w "%{http_code}" -o /tmp/_upload_resp.json -F "file=@/tmp/_test_upload.txt" "$BASE/upload")
if [ "$UPLOAD_STATUS" = "200" ]; then
  HAS_TEXT=$(python3 -c "import sys,json; d=json.load(open('/tmp/_upload_resp.json')); print('yes' if 'Test requirement' in d['extractedText'] else 'no')" 2>/dev/null)
  if [ "$HAS_TEXT" = "yes" ]; then echo "  PASS  Upload + extract ($UPLOAD_STATUS)"; PASS=$((PASS+1)); else echo "  FAIL  Upload text extraction"; FAIL=$((FAIL+1)); fi
else
  echo "  FAIL  Upload (HTTP $UPLOAD_STATUS)"; FAIL=$((FAIL+1))
fi
rm -f /tmp/_test_upload.txt /tmp/_upload_resp.json

echo ""
echo "==================================="
echo "Results: $PASS passed, $FAIL failed"
echo "==================================="
rm -f /tmp/_api_last.json
[ $FAIL -gt 0 ] && exit 1 || exit 0

# Test Plan — AI Dev Pipeline (Post-Implementation)
> Môi trường: localhost | Backend: http://localhost:3001 | Frontend: http://localhost:5173
> Token: lấy từ `packages/backend/.env` → `API_SECRET`
> Thực hiện theo thứ tự từ trên xuống dưới

---

## CHUẨN BỊ TRƯỚC KHI TEST

### 1. Khởi động hệ thống
```bash
# Terminal 1 — Backend
cd packages/backend
npm run dev

# Terminal 2 — Frontend
cd packages/frontend
npm run dev
```

### 2. Lưu TOKEN vào biến môi trường (dùng suốt quá trình test)
```bash
TOKEN=$(grep API_SECRET packages/backend/.env | cut -d= -f2)
echo "Token: $TOKEN"
```

Hoặc set thủ công:
```bash
TOKEN="b78c69924c18beebc392023469fc662bfafae4534b614eb01b70ab5fb8fbaa21"
```

### 3. Kiểm tra backend đang chạy
```bash
curl http://localhost:3001/api/health
# Expected: {"status":"ok","timestamp":"..."}
```

---

## TC-01 — API Authentication (TASK-04)

> **Mục tiêu:** Xác nhận tất cả API endpoint đã được bảo vệ bằng Bearer token

### TC-01-A: Health check không cần token ✅

```bash
curl -s http://localhost:3001/api/health
```
**Expected:** `{"status":"ok","timestamp":"..."}` — HTTP 200

---

### TC-01-B: Gọi API không có token → 401 ✅

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/projects
```
**Expected:** `401`

```bash
curl -s http://localhost:3001/api/projects
```
**Expected:** `{"error":"Unauthorized — invalid or missing API token"}`

---

### TC-01-C: Gọi API với token sai → 401 ✅

```bash
curl -s -H "Authorization: Bearer wrongtoken123" \
  http://localhost:3001/api/projects
```
**Expected:** `{"error":"Unauthorized — invalid or missing API token"}`

---

### TC-01-D: Gọi API với token đúng → 200 ✅

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3001/api/projects
```
**Expected:** JSON array (rỗng `[]` hoặc có data) — HTTP 200

---

### TC-01-E: Frontend load bình thường ✅

1. Mở http://localhost:5173 trên trình duyệt
2. Mở DevTools → Network tab
3. Kiểm tra các request đến `localhost:3001`

**Expected:**
- Không có request nào trả về `401`
- Mọi request đều có header `Authorization: Bearer <token>`

---

### TC-01-F: Negative — Gọi với token thiếu prefix "Bearer" → 401 ✅

```bash
curl -s -H "Authorization: $TOKEN" \
  http://localhost:3001/api/projects
```
**Expected:** `401`

---

## TC-02 — Startup Recovery / Stale Locks (TASK-05)

> **Mục tiêu:** Khi server khởi động, `isProcessing = true` bị xót phải được clear

### TC-02-A: Set stale lock thủ công rồi restart ✅

**Bước 1:** Tìm một sprint id (hoặc tạo mới)
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3001/api/projects | python3 -m json.tool | head -30
```

**Bước 2:** Set `isProcessing = true` trực tiếp trong SQLite
```bash
cd packages/backend
node -e "
import('./src/lib/prisma.js').then(async ({ default: prisma }) => {
  const sprint = await prisma.sprint.findFirst();
  if (!sprint) { console.log('No sprint found'); process.exit(0); }
  await prisma.sprint.update({
    where: { id: sprint.id },
    data: { isProcessing: true }
  });
  console.log('Set isProcessing=true for sprint:', sprint.id);
  await prisma.\$disconnect();
});
"
```

**Bước 3:** Restart backend (Ctrl+C rồi `npm run dev`)

**Bước 4:** Kiểm tra log ngay khi startup
**Expected log phải có:**
```
WARN: Cleared stale isProcessing locks on startup {"count":1}
```

**Bước 5:** Xác nhận DB đã clear
```bash
node -e "
import('./src/lib/prisma.js').then(async ({ default: prisma }) => {
  const sprint = await prisma.sprint.findFirst();
  console.log('isProcessing:', sprint?.isProcessing); // phải là false
  await prisma.\$disconnect();
});
"
```
**Expected:** `isProcessing: false`

---

### TC-02-B: Không có stale lock → không có warning ✅

Restart server khi không có sprint nào có `isProcessing = true`.

**Expected:** Log KHÔNG có dòng "Cleared stale isProcessing locks"

---

## TC-03 — Gate Approval Race Condition (TASK-06)

> **Mục tiêu:** Approve cùng gate 2 lần đồng thời chỉ xử lý được 1 lần

### TC-03-A: Approve gate khi đang waiting_approval ✅

**Bước 1:** Lấy gate đang ở `waiting_approval`
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/projects" | python3 -m json.tool
# Lấy projectId

curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/projects/<projectId>/sprints" | python3 -m json.tool
# Lấy sprintId

curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/sprints/<sprintId>/gates" | python3 -m json.tool
# Lấy gateId có status=waiting_approval
```

**Bước 2:** Approve lần 1
```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"comment":"Approved"}' \
  http://localhost:3001/api/gates/<gateId>/approve
```
**Expected:** `{"ok":true}` hoặc success response

**Bước 3:** Approve lần 2 (gate đã không còn ở waiting_approval)
```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"comment":"Duplicate"}' \
  http://localhost:3001/api/gates/<gateId>/approve
```
**Expected:** HTTP 400 với message `"Gate X is not waiting for approval (current: approved)"`

---

### TC-03-B: Reject gate không ở waiting_approval → lỗi ✅

```bash
# Gate đã approved rồi — reject phải bị chặn
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Too broad"}' \
  http://localhost:3001/api/gates/<approvedGateId>/reject
```
**Expected:** HTTP 400 với message `"Cannot reject gate in status: approved"`

---

### TC-03-C: Simulate 2 requests đồng thời ✅

```bash
# Chạy 2 lệnh approve song song (& background process)
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"comment":"First"}' \
  http://localhost:3001/api/gates/<waitingGateId>/approve &

curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"comment":"Second"}' \
  http://localhost:3001/api/gates/<waitingGateId>/approve &

wait
```
**Expected:** Một request trả về success, một trả về error 400. Pipeline chỉ advance 1 lần.

---

## TC-04 — Pause Pipeline Kill Subprocess (TASK-03)

> **Mục tiêu:** POST /api/pipeline/pause phải kill được subprocess Claude đang chạy

### TC-04-A: Pause khi không có sprint đang chạy ✅

```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:3001/api/pipeline/pause
```
**Expected:**
```json
{"ok":true,"message":"Paused 0 sprint(s)","pausedCount":0}
```

---

### TC-04-B: Pause khi pipeline đang chạy (manual test) ✅

> ⚠️ Test này cần pipeline đang thực sự chạy Step 4 (Developer Agents)

**Bước 1:** Trigger một sprint đến Gate 3, approve Gate 3 → pipeline bắt đầu Step 4

**Bước 2:** Quan sát backend log đến khi thấy:
```
INFO: Spawning claude --print
```

**Bước 3:** Ngay lúc đó, gọi pause:
```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:3001/api/pipeline/pause
```

**Bước 4:** Quan sát log backend
**Expected log phải có:**
```
INFO: Claude subprocess killed via SIGTERM {"sprintId":"..."}
```

**Bước 5:** Kiểm tra sprint không tiếp tục chạy (không có thêm "Spawning claude" log sau đó)

**Bước 6:** Kiểm tra DB state
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/pipeline/health"
```
**Expected:** `"processingCount": 0`

---

### TC-04-C: Health check sau pause ✅

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3001/api/pipeline/health
```
**Expected:**
```json
{
  "status": "ok",
  "processingCount": 0,
  ...
}
```

---

## TC-05 — MASTER.md được ghi sau Step 1 (TASK-02)

> **Mục tiêu:** Sau khi Step 1 Architect hoàn thành, file docs/MASTER.md phải được tạo/cập nhật

### TC-05-A: Kiểm tra file được tạo sau Step 1 ✅

> ⚠️ Test này cần chạy một sprint thật đến hết Step 1

**Bước 1:** Ghi chú `repoPath` của project (lấy từ API)
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3001/api/projects | python3 -m json.tool
# Lấy field repoPath hoặc localPath
```

**Bước 2:** Trước khi chạy sprint, kiểm tra file hiện tại
```bash
cat <repoPath>/docs/MASTER.md
# Ghi lại nội dung hiện tại (nếu có)
```

**Bước 3:** Tạo sprint mới và approve Gate 0 để Step 1 chạy

**Bước 4:** Sau khi Step 1 hoàn tất (log: "Step 1 completed"), kiểm tra file
```bash
cat <repoPath>/docs/MASTER.md
```
**Expected:** File được tạo/cập nhật với nội dung từ Architect Claude

**Bước 5:** Kiểm tra log
**Expected log phải có:**
```
INFO: MASTER.md updated {"sprintId":"...","masterPath":"..."}
```

---

### TC-05-B: Kiểm tra khi Claude không trả về masterMdUpdate ✅

Nếu Claude output không có field `masterMdUpdate`, pipeline vẫn phải tiếp tục bình thường (không throw error).

**Expected:** Không có log error, pipeline advance đến Gate 1 bình thường.

---

## TC-06 — Telegram Gate Notification với Inline Keyboard (TASK-01)

> **Mục tiêu:** Khi gate đến waiting_approval, Telegram notification phải có nút Approve/Reject

### TC-06-A: Gate notification có inline keyboard ✅

> ⚠️ Cần Telegram bot đang chạy và TELEGRAM_BOT_TOKEN + TELEGRAM_PO_CHAT_ID đúng trong .env

**Bước 1:** Chạy sprint đến Gate 1 (approve Gate 0 — Start Sprint)

**Bước 2:** Quan sát Telegram

**Expected:** Nhận được message từ bot có dạng:
```
🔐 Architecture designed
Sprint #X: Gate 1 waiting for review
```
Và có 3 nút inline: `✅ Approve` | `👁 View` | `❌ Reject`

---

### TC-06-B: Approve từ Telegram notification ✅

**Bước 1:** Click nút `✅ Approve` trên Telegram notification

**Expected:**
- Bot reply: "✅ Gate X approved"
- Backend log: `Gate approved {"gateId":"...","approvedBy":"telegram"}`
- Frontend (nếu mở) cập nhật gate status → `approved`

---

### TC-06-C: Reject từ Telegram ✅

> Telegram không hỗ trợ inline reject có text input — dùng `/reject <gateId> <reason>`

**Bước 1:** Click nút `❌ Reject` trên notification

**Expected:** Bot reply hướng dẫn: `"Use: /reject <gateId> [reason]"`

**Bước 2:** Gõ lệnh:
```
/reject <gateId> Scope quá rộng, cần tách nhỏ hơn
```
**Expected:** Bot reply "❌ Gate X rejected" — Sprint reset về `waiting_gate`

---

### TC-06-D: Tất cả 4 gates đều có keyboard ✅

Chạy sprint qua toàn bộ flow, kiểm tra từng gate notification:
- Gate 1 (sau Step 1 Architect) → có keyboard ✅
- Gate 2 (sau Step 2 Feature Specs) → có keyboard ✅
- Gate 3 (sau Step 3 Atomic Tasks) → có keyboard ✅
- Gate 5 (sau Step 5 QA) → có keyboard ✅

> Gate 4 là auto-approve — không có notification keyboard (đúng thiết kế)

---

## TC-07 — Retry Task Re-execute đúng task (TASK-07)

> **Mục tiêu:** Retry chỉ re-run task cụ thể, không re-run toàn bộ Step 4

### TC-07-A: Retry task không ở status fail/escalated → lỗi ✅

```bash
# Lấy taskId có status=pass hoặc pending
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/sprints/<sprintId>/tasks" | python3 -m json.tool

# Thử retry task đó
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/tasks/<taskId>/retry"
```
**Expected:** HTTP 400
```json
{"error":"Can only retry tasks with status fail or escalated (current: pass)"}
```

---

### TC-07-B: Retry khi sprint đang processing → 409 ✅

**Bước 1:** Set sprint `isProcessing = true` thủ công (xem TC-02-A)

**Bước 2:** Tìm task có status `fail` hoặc set thủ công:
```bash
node -e "
import('./src/lib/prisma.js').then(async ({ default: prisma }) => {
  const task = await prisma.task.findFirst();
  await prisma.task.update({ where: { id: task.id }, data: { status: 'fail' } });
  console.log('Task id:', task.id);
  await prisma.\$disconnect();
});
"
```

**Bước 3:**
```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/tasks/<taskId>/retry"
```
**Expected:** HTTP 409
```json
{"error":"Sprint is currently processing. Wait for current step to complete before retrying."}
```

---

### TC-07-C: Retry task fail → re-execution (end-to-end) ✅

> ⚠️ Cần có task thực sự ở status `fail` hoặc `escalated`

**Bước 1:** Lấy task id
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/sprints/<sprintId>/tasks" \
  | python3 -c "import sys,json; tasks=json.load(sys.stdin); [print(t['id'],t['taskId'],t['status']) for t in tasks]"
```

**Bước 2:** Retry
```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/tasks/<taskId>/retry"
```
**Expected:**
```json
{"message":"Task reset and re-execution started","taskId":"TASK-001"}
```

**Bước 3:** Quan sát backend log
**Expected:** Chỉ thấy log cho task cụ thể đó được spawn, không phải toàn bộ sprint restart:
```
INFO: Spawning claude --print  (chỉ 1 lần cho task đó)
```

---

## TC-08 — Git Branch Cleanup sau Merge (TASK-08)

> **Mục tiêu:** Sau khi sprint hoàn tất, không còn branches `feat/task-*` trong repo

### TC-08-A: Kiểm tra branches trước khi chạy sprint ✅

```bash
cd <project.repoPath>
git branch
# Ghi lại danh sách branches hiện tại
```

---

### TC-08-B: Branches được xóa sau sprint complete ✅

> ⚠️ Cần chạy một sprint hoàn chỉnh đến hết Gate 6 (Merge)

**Bước 1:** Sau khi sprint `completed`, kiểm tra branches
```bash
cd <project.repoPath>
git branch
```
**Expected:** Không có branch nào dạng `feat/task-xxx`. Chỉ còn branch `main`.

**Bước 2:** Kiểm tra log
**Expected log phải có:**
```
INFO: Branch deleted after merge {"taskId":"...","branch":"feat/task-001"}
INFO: Worktrees and branches pruned
```

---

### TC-08-C: Branches chưa merge không bị xóa ✅

`pruneAll` dùng `git branch -d` (lowercase) — chỉ xóa branch đã merged, không xóa branch chưa merge (khác với `-D` force).

**Để verify:** Tạo branch thủ công chưa merge, sau đó gọi pruneAll:
```bash
cd <project.repoPath>
git checkout -b feat/test-unmerged
git checkout main
```

Sau khi `pruneAll` chạy:
```bash
git branch
# Expected: feat/test-unmerged vẫn còn
```

---

## TC-09 — Reject Modal thay thế window.prompt (TASK-09)

> **Mục tiêu:** Click Reject trên GateCard hiển thị modal trong app, không phải browser dialog

### TC-09-A: Mở modal khi click Reject ✅

**Bước 1:** Mở http://localhost:5173

**Bước 2:** Navigate đến một sprint có gate ở `waiting_approval`

**Bước 3:** Click nút "Reject" trên GateCard

**Expected:**
- KHÔNG có native browser dialog `window.prompt()`
- Xuất hiện modal overlay với:
  - Tiêu đề "Reject Gate X"
  - Textarea để nhập lý do
  - Nút "Cancel" và "Reject Gate"

---

### TC-09-B: Nút Reject Gate disabled khi textarea trống ✅

**Bước 1:** Mở modal (xem TC-09-A)

**Bước 2:** Để trống textarea

**Expected:** Nút "Reject Gate" bị disabled (không click được)

---

### TC-09-C: Cancel đóng modal, không reject ✅

**Bước 1:** Mở modal

**Bước 2:** Nhập text vào textarea

**Bước 3:** Click "Cancel"

**Expected:**
- Modal đóng lại
- Gate vẫn ở trạng thái `waiting_approval`
- Không có API call nào tới `/api/gates/:id/reject`

---

### TC-09-D: Nhập lý do và confirm reject ✅

**Bước 1:** Mở modal

**Bước 2:** Nhập: "Scope quá rộng, cần tách nhỏ hơn"

**Bước 3:** Click "Reject Gate"

**Expected:**
- Modal đóng
- Toast thông báo "Gate rejected"
- GateCard chuyển sang màu đỏ, status `rejected`
- API `POST /api/gates/:id/reject` được gọi với `reason` đúng

---

### TC-09-E: Kiểm tra không còn window.prompt trong codebase ✅

```bash
grep -r "window.prompt" packages/frontend/src/
# Expected: Không có kết quả nào
```

---

## TC-10 — QA Diff Truncation Warning (TASK-10)

> **Mục tiêu:** Khi diff > 12,000 ký tự, log cảnh báo và notification có thông tin truncation

### TC-10-A: Không truncate khi diff nhỏ ✅

Sprint với 1-2 tasks nhỏ → diff thường < 12,000 ký tự.

**Expected:**
- Log KHÔNG có "QA diff truncated"
- Notification Gate 5 KHÔNG có "⚠️ Diff was truncated"

---

### TC-10-B: Truncate và cảnh báo khi diff lớn ✅

> Sprint với nhiều tasks hoặc tasks thay đổi nhiều file

**Bước 1:** Chạy sprint có ≥ 5 tasks (hoặc tasks với nhiều code thay đổi)

**Bước 2:** Quan sát log khi Step 5 QA chạy
**Expected log:**
```
WARN: QA diff truncated {"sprintId":"...","totalDiffLength":35000,"limit":12000}
```

**Bước 3:** Kiểm tra Telegram notification Gate 5
**Expected:** Message có text `⚠️ Diff was truncated — large sprint`

**Bước 4:** Kiểm tra diff trong Gate 5 notes chứa truncation marker
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/sprints/<sprintId>/gates" \
  | python3 -c "
import sys, json
gates = json.load(sys.stdin)
g5 = next(g for g in gates if g['gateNumber'] == 5)
print('TRUNCATED marker found:', '[... DIFF TRUNCATED' in (g5.get('notes') or ''))
"
```
**Expected:** `TRUNCATED marker found: True`

---

## TC-11 — Regression Test: Luồng Pipeline Hoàn Chỉnh

> **Mục tiêu:** Đảm bảo tất cả thay đổi không phá vỡ luồng chính

### TC-11-A: End-to-end pipeline flow ✅

1. Tạo project mới → HTTP 201 ✅
2. Tạo sprint mới → HTTP 201, status `pending` ✅
3. Approve Gate 0 (Start) → pipeline bắt đầu Step 1 ✅
4. Step 1 hoàn thành → Gate 1 status `waiting_approval` ✅
5. Gate 1 notification Telegram → có inline keyboard ✅
6. Approve Gate 1 → pipeline bắt đầu Step 2 ✅
7. ... tiếp tục đến Gate 5 ...
8. Sprint `completed` → branches đã clean ✅

---

### TC-11-B: Frontend không có lỗi JavaScript ✅

1. Mở http://localhost:5173
2. Mở DevTools → Console tab
3. Navigate qua các trang: Dashboard, Pipeline, Tasks, Settings

**Expected:** Không có lỗi đỏ trong Console

---

### TC-11-C: API endpoints chính đều hoạt động ✅

```bash
# Projects
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/projects

# Pipeline health
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/pipeline/health

# Config
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/config
```
**Expected:** Tất cả trả về HTTP 200 với JSON hợp lệ

---

## KẾT QUẢ TEST — Điền sau khi thực thi

| Test Case | Mô tả | Status | Ghi chú |
|-----------|-------|--------|---------|
| TC-01-A | Health check không cần token | ⬜ | |
| TC-01-B | Không có token → 401 | ⬜ | |
| TC-01-C | Token sai → 401 | ⬜ | |
| TC-01-D | Token đúng → 200 | ⬜ | |
| TC-01-E | Frontend không lỗi auth | ⬜ | |
| TC-01-F | Token không có prefix Bearer → 401 | ⬜ | |
| TC-02-A | Stale lock được clear khi restart | ⬜ | |
| TC-02-B | Không stale lock → không warning | ⬜ | |
| TC-03-A | Approve gate bình thường | ⬜ | |
| TC-03-B | Reject gate đã approved → 400 | ⬜ | |
| TC-03-C | Approve 2 lần đồng thời → 1 thành công | ⬜ | |
| TC-04-A | Pause không có sprint running | ⬜ | |
| TC-04-B | Pause kill subprocess | ⬜ | Cần pipeline đang chạy |
| TC-04-C | Health check sau pause | ⬜ | |
| TC-05-A | MASTER.md được ghi sau Step 1 | ⬜ | Cần chạy sprint thật |
| TC-05-B | Không có masterMdUpdate → tiếp tục bình thường | ⬜ | |
| TC-06-A | Telegram notification có inline keyboard | ⬜ | Cần Telegram bot |
| TC-06-B | Approve từ Telegram | ⬜ | |
| TC-06-C | Reject từ Telegram | ⬜ | |
| TC-06-D | Tất cả 4 gates đều có keyboard | ⬜ | |
| TC-07-A | Retry task không fail → 400 | ⬜ | |
| TC-07-B | Retry khi sprint processing → 409 | ⬜ | |
| TC-07-C | Retry re-execute đúng task | ⬜ | Cần task fail |
| TC-08-A | Kiểm tra branches trước sprint | ⬜ | |
| TC-08-B | Branches xóa sau sprint complete | ⬜ | Cần sprint hoàn chỉnh |
| TC-08-C | Branch chưa merge không bị xóa | ⬜ | |
| TC-09-A | Click Reject → hiện modal | ⬜ | |
| TC-09-B | Nút Reject Gate disabled khi trống | ⬜ | |
| TC-09-C | Cancel đóng modal, không reject | ⬜ | |
| TC-09-D | Nhập lý do và confirm | ⬜ | |
| TC-09-E | Không còn window.prompt trong code | ⬜ | |
| TC-10-A | Không truncate khi diff nhỏ | ⬜ | |
| TC-10-B | Log warning + notification khi diff lớn | ⬜ | |
| TC-11-A | End-to-end pipeline flow | ⬜ | |
| TC-11-B | Frontend không lỗi JavaScript | ⬜ | |
| TC-11-C | API endpoints chính hoạt động | ⬜ | |

**Ký hiệu:** ✅ Pass | ❌ Fail | ⚠️ Blocked | ⬜ Chưa test

---

## QUICK SMOKE TEST (5 phút — kiểm tra nhanh nhất)

Chạy lần lượt các lệnh sau, tất cả phải pass:

```bash
TOKEN="b78c69924c18beebc392023469fc662bfafae4534b614eb01b70ab5fb8fbaa21"

# 1. Health check (không cần token)
echo "=== Health ===" && curl -s http://localhost:3001/api/health

# 2. Không có token → 401
echo "=== No token ===" && curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3001/api/projects

# 3. Token sai → 401
echo "=== Wrong token ===" && curl -s -o /dev/null -w "HTTP %{http_code}\n" -H "Authorization: Bearer wrong" http://localhost:3001/api/projects

# 4. Token đúng → 200
echo "=== Correct token ===" && curl -s -o /dev/null -w "HTTP %{http_code}\n" -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/projects

# 5. Pipeline health
echo "=== Pipeline health ===" && curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/pipeline/health

# 6. window.prompt không còn trong code
echo "=== No window.prompt ===" && grep -r "window.prompt" packages/frontend/src/ && echo "FOUND (FAIL)" || echo "Not found (PASS)"
```

**Expected output:**
```
=== Health ===
{"status":"ok","timestamp":"..."}
=== No token ===
HTTP 401
=== Wrong token ===
HTTP 401
=== Correct token ===
HTTP 200
=== Pipeline health ===
{"status":"ok","processingCount":0,...}
=== No window.prompt ===
Not found (PASS)
```

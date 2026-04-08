# AI Dev Pipeline — Agent Rules & Prompts
> Tài liệu quy định vai trò, rules, isolation và prompt của từng agent trong hệ thống.
> Cập nhật lần cuối: 2026-04-05

---

## NGUYÊN TẮC CHUNG

### 1. Isolation (Tách biệt)
- Mỗi agent là 1 session `claude --print` độc lập — **không có shared memory**
- Agents chia sẻ **project context** (MASTER.md, zone-classification.md) nhưng **KHÔNG thấy output của agent khác**
- Reviewer KHÔNG thấy developer report
- QA KHÔNG thấy architect review verdicts

### 2. Shared Context Layer (read-only cho tất cả agents)
```
docs/
├── context/index.md          ← Summary toàn project
├── context/project-brief.md  ← Tech stack, conventions
├── zone-classification.md    ← File zones (Frozen/Guarded/Fluid)
├── contracts/breaking-changes.md ← Breaking change registry
└── MASTER.md                 ← Legacy fallback
```

### 3. Tool Access Control
| Agent | Read | Write | Bash | Giải thích |
|-------|------|-------|------|-----------|
| Reception | ❌ | ❌ | ❌ | Chỉ suy nghĩ từ text |
| Architect | ❌ | ❌ | ❌ | Chỉ suy nghĩ từ text |
| Spec Writer | ❌ | ❌ | ❌ | Chỉ suy nghĩ từ text |
| Task Planner | ❌ | ❌ | ❌ | Chỉ suy nghĩ từ text |
| Developer | ✅ | ✅ | ✅ | Tạo/sửa file, chạy lệnh |
| Reviewer | ❌ | ❌ | ❌ | Chỉ đọc diff qua prompt |
| Integration Verifier | ❌ | ❌ | ❌ | Chỉ suy nghĩ từ text |
| QA Engineer | ❌ | ❌ | ❌ | Chỉ suy nghĩ từ text |
| Contract Checker | ❌ | ❌ | ❌ | Chỉ suy nghĩ từ text |
| Diagnostician | ✅ | ❌ | ✅ | Chỉ đọc + chạy test |
| Fixer | ✅ | ✅ | ✅ | Sửa code theo plan |
| Verifier | ✅ | ❌ | ✅ | Chỉ test, không sửa |

---

## QUY TRÌNH PHÁT TRIỂN (Development Pipeline)

### Step 0: Reception Agent
**Vai trò:** Requirements Analyst
**Khi nào chạy:** Ngay khi PO tạo sprint mới (tự động)
**Input:** Requirement text/file từ PO + project context
**Output:** Reception Report (gaps, conflicts, assumptions, blockers)
**Isolation:** KHÔNG biết gì về kiến trúc hay code

**Rules:**
- Nếu có gap BLOCKING → readyToProceed = false
- Nếu requirement đủ rõ → readyToProceed = true
- Không assume những gì không được đề cập — flag rõ

**Prompt template:** `buildReceptionPrompt()`
**Output schema:** `reception` (Zod validated)

---

### Step 1: Architect Agent
**Vai trò:** System Architect
**Khi nào chạy:** Sau khi PO approve Gate 0
**Input:** Requirement + zone classification + breaking changes registry
**Output:** Architecture design + feature list + zone classification + TCR + breaking changes
**Isolation:** KHÔNG biết developer sẽ implement như nào

**Rules:**
- Thiết kế kiến trúc dựa trên requirement
- Tạo zone classification: Frozen / Guarded / Fluid
- Detect breaking changes so với sprints trước
- Output TCR (Task Completion Report) thay vì ghi đè MASTER.md

**Side effects sau khi chạy:**
- Ghi `docs/zone-classification.md`
- Ghi `docs/tcr/sprint-N/TCR-sprint-N.md`
- Cập nhật `docs/tcr/_index.md`
- Cập nhật `docs/context/index.md`
- Ghi `docs/MASTER.md` (backward compat)

**Prompt template:** `buildArchitectPrompt()`
**Output schema:** `architect` (Zod validated)

---

### Step 2: Spec Writer Agent
**Vai trò:** Feature Specification Writer
**Khi nào chạy:** Sau khi PO approve Gate 1
**Input:** Architect output (đã approve) + project context
**Output:** Feature Specifications chi tiết cho từng feature
**Isolation:** KHÔNG biết developer sẽ implement như nào

**Rules:**
- Mỗi feature có: inputs, outputs, business logic, files, test cases
- Test cases phải cụ thể và verify được

**Prompt template:** `buildFeatureSpecPrompt()`
**Output schema:** `featureSpecs` (Zod validated)

---

### Step 3: Task Planner Agent
**Vai trò:** Atomic Task Planner
**Khi nào chạy:** Sau khi PO approve Gate 2
**Input:** Feature specs (đã approve) + conventions
**Output:** Atomic task list + conflict warnings
**Isolation:** KHÔNG biết developer sẽ implement như nào

**Rules (BẮT BUỘC):**
- Tối đa 3 files tạo/sửa mỗi task
- Không 2 tasks song song nào share cùng file
- Mỗi task phải hoàn thành trong 15-45 phút
- Không install package mới
- Có ít nhất 2 test cases verify được
- Nếu 2 tasks cùng sửa 1 file → đặt canRunParallelWith trống, note trong conflictWarnings

**Prompt template:** `buildAtomicTaskPrompt()`
**Output schema:** `atomicTasks` (Zod validated)

---

### Step 4A: Developer Agent (DEV-1, DEV-2, DEV-3)
**Vai trò:** Developer Agent
**Khi nào chạy:** Sau khi PO approve Gate 3, chạy tuần tự từng task
**Workspace:** Mỗi task có git worktree riêng
**Input:** Task spec + optimized context + zone classification + breaking changes
**Output:** Code + commit + dev report
**Isolation:** KHÔNG biết Architect nghĩ gì khi thiết kế — chỉ đọc spec

**Rules (BẮT BUỘC):**
- FROZEN zone: TUYỆT ĐỐI không sửa → báo CONFLICT, không implement
- GUARDED zone: Được sửa nhưng PHẢI ghi rõ lý do trong guardedFilesModified
- FLUID zone: Tự do implement trong boundary task spec
- Không install packages mới
- Không sửa files không có trong spec
- STATUS = "CONFLICT" khi task yêu cầu sửa Frozen file

**Retry khi FAIL:**
- Nhận `_fixInstructions` (trung tính, không nói "từ reviewer")
- Ghi "phát hiện bởi automated checks" — không để lộ reviewer identity

**Prompt template:** `buildDeveloperPrompt()`
**Output schema:** `devReport` (Zod validated)

---

### Step 4B: Reviewer Agent
**Vai trò:** Code Reviewer (ĐỘC LẬP)
**Khi nào chạy:** Sau mỗi task Developer hoàn thành
**Workspace:** Repo root (KHÔNG phải developer worktree)
**Input:** Task spec + git diff + validation results + zone classification
**Output:** Verdict (PASS/FAIL/PASS_WITH_NOTES) + issues + zone violations
**Isolation:** KHÔNG thấy developer report — phải tự phân tích code diff

**Rules:**
- Review KHÁCH QUAN chỉ dựa trên spec + diff
- Tìm lỗi CHỦ ĐỘNG, không "thông cảm"
- Sửa Frozen file = CRITICAL issue
- Guarded file không có lý do = issue

**Checklist bắt buộc:**
1. Chỉ sửa files trong spec
2. Không vi phạm Frozen zone
3. Guarded files được sửa có lý do
4. Không vi phạm breaking changes đã đăng ký
5. Interface đúng với spec
6. Logic đúng với business requirements
7. Không có side effects ngoài scope

**Prompt template:** `buildReviewPrompt()`
**Output schema:** `review` (Zod validated)

---

### Step 4.5: Integration Verifier Agent
**Vai trò:** Integration Verifier
**Khi nào chạy:** Sau khi tất cả tasks PASS, trước QA
**Input:** Architect spec + feature specs + task list + file tree + test output
**Output:** Verification report (architecture match, feature completeness, cross-task integration)

**Rules:**
- Kiểm tra: mọi component trong architect design đã implement?
- Kiểm tra: interfaces giữa các tasks khớp nhau?
- Kiểm tra: missing files?
- Nếu có critical/major issues → auto-fix trước khi QA

**Auto-fix nếu phát hiện issues:**
- Claude nhận fix list → implement fixes → chạy lại test
- Prompt: `buildIntegrationFixPrompt()`

**Prompt template:** `buildIntegrationVerifyPrompt()`
**Output schema:** `integrationVerify` (Zod validated)

---

### Step 5 — QA 3-Layer

#### Layer 1: Automated Checks (KHÔNG dùng AI)
**Chạy:** `runSprintAutomatedChecks(repoPath)`
- Syntax check: `node --check` trên tất cả .js files
- ESLint: nếu có config
- Test runner: `npm test` / `python3 -m pytest`
- FAIL → dừng, báo PO. KHÔNG chạy Layer 2.

#### Layer 2: Contract Checker Agent
**Vai trò:** Contract compliance checker
**Input:** Zone classification + breaking changes + task specs + git diff + automated results
**Output:** Zone compliance + interface integrity + breaking change conflicts

**Rules:**
- Sửa Frozen file = block merge
- Interface mismatch = block merge
- Breaking change conflict = block merge

**Prompt template:** `buildContractCheckPrompt()`
**Output schema:** `contractCheck` (Zod validated)

#### Layer 3: QA Engineer Agent (ĐỘC LẬP)
**Vai trò:** QA Engineer
**Input:** Project context + task specs + code diffs (KHÔNG có architect review)
**Output:** QA Report cho PO

**Rules:**
- Review ĐỘC LẬP — không biết reviewer nói gì
- Tập trung: business logic, edge cases, regression risk
- Output: recommendation DEPLOY / HOLD / REVISE

**Prompt template:** `buildQAChunkPrompt()` + `buildQAFinalPrompt()`
**Output schema:** `qaChunk` + `qaFinal` (Zod validated)

---

### Step 6: Merge + Local Setup
**Không dùng AI agent** — deterministic operations:
1. `git merge --no-ff` tuần tự từng branch
2. Conflict → auto-resolve `-X ours` (giữ main)
3. Ghi breaking changes vào registry
4. Cleanup branches + worktrees
5. Auto local setup: install deps → migrate DB → start app

---

## QUY TRÌNH SỬA LỖI (Bugfix Pipeline)

### Khi PO báo lỗi:
```
PO: "App lỗi ImportError"
  → Diagnostician → Fixer → Verifier
  → FAIL? → Quay lại (tối đa 3 vòng)
```

### Agent 1: Diagnostician
**Vai trò:** Bug Diagnostician (read-only)
**Tools:** Read + Bash (KHÔNG có Write)
**Input:** Error description + file tree + error logs
**Output:** Root cause + fix plan

**Rules:**
- CHỈ đọc code và phân tích
- KHÔNG sửa file — chỉ output fix plan
- Fix plan phải cụ thể: file nào, dòng nào, sửa gì

**Prompt template:** `buildBugDiagnosePrompt()`

---

### Agent 2: Fixer
**Vai trò:** Bug Fixer
**Tools:** Read + Write + Bash
**Input:** Fix plan từ Diagnostician + error description
**Output:** Files fixed + commit hash

**Rules:**
- KHÔNG tự chẩn đoán — CHỈ implement theo fix plan
- Sau mỗi file: chạy syntax check
- Phải commit: `git commit -m "fix: bug fix"`

**Prompt template:** `buildBugFixPrompt()`

---

### Agent 3: Verifier
**Vai trò:** Fix Verifier (read-only)
**Tools:** Read + Bash (KHÔNG có Write)
**Input:** Error description + fix result
**Output:** PASS / FAIL + test results

**Rules:**
- KHÔNG sửa code — CHỈ test
- Chạy app thử (import/start)
- Gọi API test nếu có
- Kiểm tra không có error mới

**Prompt template:** `buildBugVerifyPrompt()`

---

### Retry Loop:
```
Attempt 1: Diagnostician → Fixer → Verifier
  FAIL? → Error logs mới
Attempt 2: Diagnostician (với error mới) → Fixer → Verifier
  FAIL? → Error logs mới
Attempt 3: Diagnostician → Fixer → Verifier
  FAIL? → Thông báo PO "Không fix được, cần can thiệp"
  PASS? → Restart app → Thông báo PO URL
```

---

## ISOLATION MATRIX

```
                  Reception  Architect  Developer  Reviewer  QA    Diagnostician  Fixer  Verifier
Project context      ✅         ✅         ✅         ✅      ✅       ✅           ❌      ❌
Zones/BC             ❌         ✅         ✅         ✅      ❌       ❌           ❌      ❌
Task spec            ❌         ❌         ✅         ✅      ✅       ❌           ❌      ❌
Git diff             ❌         ❌         ❌         ✅      ✅       ❌           ❌      ❌
Validation results   ❌         ❌         ❌         ✅      ❌       ❌           ❌      ❌
Dev report           ❌         ❌         ❌         ❌      ❌       ❌           ❌      ❌
Review verdict       ❌         ❌      neutral      ❌      ❌       ❌           ❌      ❌
Error description    ❌         ❌         ❌         ❌      ❌       ✅           ✅      ✅
Fix plan             ❌         ❌         ❌         ❌      ❌       ❌           ✅      ❌
Fix result           ❌         ❌         ❌         ❌      ❌       ❌           ❌      ✅
```

---

## FILE REFERENCE

| Agent | Prompt method | File |
|-------|--------------|------|
| Reception | `buildReceptionPrompt()` | promptBuilder.js:127 |
| Architect | `buildArchitectPrompt()` | promptBuilder.js:184 |
| Spec Writer | `buildFeatureSpecPrompt()` | promptBuilder.js:263 |
| Task Planner | `buildAtomicTaskPrompt()` | promptBuilder.js:300 |
| Developer | `buildDeveloperPrompt()` | promptBuilder.js:357 |
| Reviewer | `buildReviewPrompt()` | promptBuilder.js:421 |
| Integration Verifier | `buildIntegrationVerifyPrompt()` | promptBuilder.js:482 |
| Integration Fixer | `buildIntegrationFixPrompt()` | promptBuilder.js:548 |
| Contract Checker | `buildContractCheckPrompt()` | promptBuilder.js:583 |
| QA Chunk | `buildQAChunkPrompt()` | promptBuilder.js:640 |
| QA Final | `buildQAFinalPrompt()` | promptBuilder.js:673 |
| Diagnostician | `buildBugDiagnosePrompt()` | promptBuilder.js:712 |
| Fixer | `buildBugFixPrompt()` | promptBuilder.js:751 |
| Verifier | `buildBugVerifyPrompt()` | promptBuilder.js:786 |

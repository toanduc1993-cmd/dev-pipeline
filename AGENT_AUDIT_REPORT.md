# AGENT AUDIT REPORT — AI Dev Pipeline
> Đánh giá toàn diện từ 8 góc nhìn chuyên môn
> Ngày audit: 2026-04-05 | Phiên bản pipeline: post-refactor (19+6 tasks hoàn thành)
> **Bỏ qua: Bảo mật, Runtime Ops**

---

## TÓM TẮT ĐIỂM SỐ

| Nhóm | Điểm | Trạng thái |
|------|------|-----------|
| Pipeline Logic | 8.0/10 | ✅ Tốt |
| Cách bố trí Agent | 7.0/10 | ⚠️ Khá — có gaps |
| Rule hoạt động từng Agent | 7.5/10 | ⚠️ Khá — inconsistent |
| Liên kết giữa các Agent | 6.5/10 | ⚠️ Trung bình — mất dữ liệu ở nhiều điểm |
| Hiểu chung ngữ cảnh | 7.0/10 | ⚠️ Khá — context decay ở cuối pipeline |
| **TỔNG** | **7.2/10** | **Gần sẵn sàng** |

---

## PHẦN 1 — KIẾN TRÚC TỔNG THỂ (System Architect)

### 1.1 Ba pipeline song song

```
MAIN PIPELINE (7 gates)
SprintPlanner → Reception → Architect → SpecWriter → TaskPlanner
  → Developer (parallel) → QA (3 layers) → Merge

INTEGRATION PIPELINE
IntegrationVerifier → IntegrationFixer

BUGFIX PIPELINE
Diagnostician → Fixer → Verifier
```

**Nhận xét:** Ba pipeline tách biệt rõ ràng về trách nhiệm. Main pipeline có logic phân tầng đúng: phân tích → thiết kế → đặc tả → lập kế hoạch → triển khai → kiểm tra → merge. Đây là một thiết kế pipeline trưởng thành.

### 1.2 Điểm mạnh kiến trúc

- **Gate pattern** rõ ràng — mỗi bước đợi approval trước khi tiếp tục
- **Worker isolation** tốt — mỗi task developer chạy trong git worktree riêng
- **StateMachine** bảo vệ state transition
- **God Class refactor** thành công: 2048 → 814 lines, tách thành 7 sub-classes

### 1.3 Vấn đề kiến trúc

**[ARCH-01] Sprint Planning là pipeline riêng nhưng không có gate approval**

`buildSprintPlanPrompt()` và `buildSprintCoverageCheckPrompt()` chạy tự động. Nếu SprintPlanner chia sprint sai, không có cơ chế dừng lại chờ PO xem xét trước khi Reception bắt đầu.

*Đề xuất:* Thêm notification sau SprintPlan + SprintCoverageCheck, chờ PO approve trước khi tiếp tục Step 0.

**[ARCH-02] Integration Pipeline không có rõ trigger point**

`IntegrationVerifier` và `IntegrationFixer` tồn tại trong code nhưng không rõ khi nào chúng được gọi trong main pipeline flow. Nhìn vào `pipelineRunner.js`, không thấy bước nào gọi chúng giữa các gate.

*Đề xuất:* Xác định rõ vị trí Integration Pipeline trong luồng chính — nên chạy sau Step 4 (tất cả tasks PASS) và trước Step 5 (QA).

---

## PHẦN 2 — PIPELINE LOGIC (Engineering: Code Review + Debug)

### 2.1 Luồng dữ liệu chính (Step 0 → Merge)

```
Step 0  → Reception     → Gate0.notes (markdown) + Gate0.structuredData
Step 1  → Architect     → Gate1.structuredData (JSON) + writes TCR + zone-classification.md
Step 2  → SpecWriter    → Gate2.structuredData (JSON) = feature specs
Step 3  → TaskPlanner   → Gate3.structuredData (JSON) + Task.spec per task (DB)
Step 4  → Developer     → task.devOutputRaw, devOutputParsed, validationResult, reviewParsed
Step 5  → QA (3 layers) → Gate5.notes (markdown) = QA report
Merge   → Commit + branch cleanup
```

**Nhận xét:** Luồng dữ liệu có cấu trúc tốt. Việc dùng `Gate.structuredData` (JSON) thay vì parse markdown là tiến bộ quan trọng. `Task.spec` per task giúp developer có đủ context mà không cần đọc toàn bộ sprint.

### 2.2 Lỗi logic đã phát hiện

**[LOGIC-01] Reception → Architect: requirement không được làm phong phú thêm**

Reception tạo ra `receptionReport` với gaps, conflicts, assumptions — nhưng khi Architect nhận `requirement`, đó vẫn là requirement gốc từ PO, không phải requirement đã được enriched bởi Reception analysis.

Architect không đọc `Gate0.structuredData` (reception report). Architect chỉ đọc master context + zone + breaking changes.

*Impact:* Architect có thể đưa ra thiết kế mà bỏ qua các gaps mà Reception đã phát hiện.

*Đề xuất:* Pass `receptionReport` vào `buildArchitectPrompt()` như một input bổ sung.

**[LOGIC-02] QA Fix prompt không dùng agent header**

```javascript
// QARunner.js line 63 — inline prompt, không có _agentHeader()
const fixPrompt = `## CONTEXT
${masterContext}
## QA REPORT — Issues to fix
${qaNotes}
## TASK
Ban la Developer Agent. ${fixScope}
```

Đây là một Developer Agent ẩn danh — không có isolation rules, không có AGENT_PROFILES entry, không được tracked bởi hệ thống.

**[LOGIC-03] QA Final chỉ nhận chunkResults, mất master context**

`buildQAFinalPrompt()` signature: `{ chunkResults }` — không nhận `masterContext`. Agent tổng hợp kết quả QA nhưng không biết project context. Nếu các chunks mâu thuẫn, agent không có basis để phân xử.

**[LOGIC-04] Gate5 lưu kết quả QA vào `.notes` (markdown) thay vì `.structuredData`**

Khi QA Fix đọc lại để fix, nó đọc từ `Gate5.notes` — đây là markdown text, không phải structured JSON. Khó parse chính xác để biết issue nào đã fix, issue nào còn lại.

*Đề xuất:* QA Final output nên được lưu vào `Gate5.structuredData` dạng JSON với list issues có severity.

**[LOGIC-05] BugVerifier không nhận context gì**

```javascript
buildBugVerifyPrompt({ errorDescription, fixResult })
// Không có: master, conventions, originalSpec, taskSpec
```

Verifier chỉ biết "lỗi là gì" và "đã fix gì" — không biết spec yêu cầu gì, không thể verify "fix đúng" hay chỉ "fix qua lỗi". Chỉ có thể verify "không còn error", không verify "behavior đúng với requirement".

---

## PHẦN 3 — PHÂN TÍCH TỪNG AGENT (QA + QC)

### 3.1 Sprint Planner — ✅ Tốt

- Identity rõ ràng (`sprint_planner` profile)
- `_agentHeader()` được gọi
- Nhận: `projectContext` + `requirement` + `receptionReport`
- Output schema chi tiết với `detailedRequirement` (tối thiểu 500 ký tự per sprint)
- **Gap nhỏ:** Không có chain-of-thought block trước JSON output

### 3.2 SprintCoverageCheck — ⚠️ Thiếu infrastructure

- **KHÔNG có entry trong `AGENT_PROFILES`**
- **KHÔNG dùng `_agentHeader()`** — dùng inline identity block thủ công
- **KHÔNG có Zod schema** trong `outputParser.js`
- Identity inline: `Role: Coverage Verifier (doc lap)` — không có `canSee`/`cannotSee`
- Output JSON có 6 fields nhưng không được validate
- **Verdict:** Agent này hoạt động nhưng là "hạng 2 citizen" — không được tracked, không được validate

### 3.3 Reception (Analyst) — ✅ Tốt

- Profile: `reception` — đầy đủ
- Nhận: `projectContext` + `requirement` (+ `FULL_REQUIREMENT.md` nếu có)
- Chain-of-thought block: ✅ (đã thêm ở TASK-4)
- `featureSummary` + `scopeWarning`: ✅
- `readyToProceed` flag: ✅
- Zod schema: ✅
- **Gap:** Kết quả (gaps, conflicts) không được forward sang Architect

### 3.4 Architect — ✅ Tốt nhất trong pipeline

- Profile: `architect` — đầy đủ
- Prompt: English ✅
- Chain-of-thought REASONING block: ✅ (5 câu hỏi bắt buộc)
- Nhận: `_getOptimizedContext(sprintNumber)` + zoneClassification + breakingChanges
- Output: analysis + features + tcrUpdate + zoneClassification + breakingChanges
- Writes: `TCR-sprint-N.md`, `zone-classification.md`, `breaking-changes.md`
- **Gap:** Không nhận reception report → có thể lặp phân tích

### 3.5 SpecWriter — ✅ Tốt

- Profile: `spec_writer` — đầy đủ
- Nhận: `_getOptimizedContext(sprintNumber)` + `architectOutput` (JSON)
- Isolation: Không biết developer code, review results
- Zod schema: ✅
- **Gap:** Prompt còn bằng tiếng Việt

### 3.6 TaskPlanner — ✅ Tốt

- Profile: `task_planner` — đầy đủ
- Nhận: `_getOptimizedContext(sprintNumber)` + `featureSpecs` + `conventions`
- Output lưu vào `Task.spec` (DB) per task — ✅ thiết kế tốt
- Zod schema: ✅
- **Gap:** Prompt còn bằng tiếng Việt

### 3.7 Developer — ✅ Tốt

- Profile: `developer` — đầy đủ
- Nhận: `masterContext` + `conventions` + `zoneClassification` + `breakingChanges` + `taskSpec`
- Max 3 rounds (Dev → Validation → Review)
- Timeout enforced via `Promise.race()` ✅
- `_fixInstructions` appended on FAIL để làm giàu context vòng sau ✅
- **Gap:** Prompt còn bằng tiếng Việt; không nhận reception gaps

### 3.8 Reviewer — ✅ Tốt

- Profile: `reviewer` — đầy đủ
- Prompt: English ✅
- Nhận: master + zones + breakingChanges + taskSpec + gitDiff + validationResults
- **Cố ý KHÔNG nhận devReport** — isolation design đúng ✅
- Verdict rules: PASS / PASS_WITH_NOTES / FAIL ✅
- Zod schema: ✅
- **Gap:** Reviewer verdict chi tiết không được forward sang QA — QA chỉ biết PASS/FAIL

### 3.9 IntegrationVerifier — ⚠️ Tốt thiết kế, thiếu context

- Profile: `integration_verifier` — đầy đủ
- `canSee`: project_context, architect_spec, feature_specs, task_list, file_tree, test_output
- `cannotSee`: dev reports, review verdicts — isolation đúng
- **Vấn đề:** Không rõ trigger point trong main pipeline. Khi nào agent này chạy?

### 3.10 IntegrationFixer — ⚠️ Thiếu task specs

- Profile: `integration_fixer` — đầy đủ
- Nhận: verifyResult + architect_spec + conventions
- **Gap:** KHÔNG nhận original task specs → có thể fix sai spec
- `cannotSee` nói "chi lam theo fix plan" nhưng fix plan có thể conflict với task spec

### 3.11 ContractChecker — ✅ Tốt

- Profile: `contract_checker` — đầy đủ
- Blocking rules: ✅ (TASK-6)
- `verdictReason` field: ✅
- `blockMerge` flag: ✅
- Nhận: zoneClassification + breakingChanges + taskSpecs + gitDiff + automatedResults
- Zod schema: ✅

### 3.12 QA (Chunk + Final) — ⚠️ Có vấn đề context

**QA Chunk:**
- Profile: `qa` — đầy đủ
- Nhận: master + tasks với `archVerdict` field
- **Gap:** `archVerdict` là PASS/FAIL, không phải reviewer's detailed issues
- Reviewer đã tìm ra issues cụ thể nhưng QA Chunk không thấy chúng
- Không thể tránh re-review cùng issues đã được Reviewer flag

**QA Final:**
- Nhận: ONLY `chunkResults` — không có master context
- Nếu chunks mâu thuẫn, không có basis để phán xuyết
- Không biết project context, không thể đánh giá business impact
- Zod schema: ✅

**QA Fix:**
- Không dùng `_agentHeader()` — ẩn danh
- Inline identity: `Ban la Developer Agent`
- Không có AGENT_PROFILES entry
- Output schema: `fixesApplied` + `fixesSkipped` + `testsRun` + `status`
- Max 3 rounds ✅

### 3.13 Diagnostician — ✅ Tốt

- Profile: `diagnostician` — đầy đủ
- Prompt: English ✅
- Nhận: master + errorDescription + errorLogs + fileTree
- Read-only — không được sửa file ✅
- Output: `fixPlan` + `rootCause`
- **Gap:** Không nhận conventions → fix plan có thể không tuân thủ coding standards

### 3.14 Fixer — ✅ Tốt

- Profile: `fixer` — đầy đủ
- Nhận: `fixPlan` + `errorDescription` + `conventions`
- `syntaxCheckResults` field: ✅
- **Gap:** Prompt vẫn bằng tiếng Việt (chưa migrate)

### 3.15 Verifier — ⚠️ Nghiêm trọng — Zero context

- Profile: `verifier` — đầy đủ
- Nhận: `errorDescription` + `fixResult`
- **KHÔNG nhận:** master context, original spec, task spec, conventions
- Chỉ verify "lỗi không còn nữa" — không verify "behavior đúng với spec"
- Không thể phát hiện regression

---

## PHẦN 4 — LIÊN KẾT GIỮA CÁC AGENT (Solution Architect)

### 4.1 Bản đồ dữ liệu chuyển tiếp

```
Reception Output:    receptionReport (JSON)
    ↓ THIẾU — Architect không nhận receptionReport
Architect Output:    Gate1.structuredData + TCR + zone-classification
    ↓ ✅ gate1.structuredData.architectureOverview (JSON)
SpecWriter Output:   Gate2.structuredData (feature specs JSON)
    ↓ ✅ gate2.structuredData (full JSON)
TaskPlanner Output:  Gate3.structuredData + Task.spec per task
    ↓ ✅ Task.spec (full JSON per task)
Developer Output:    task.devOutputRaw / devOutputParsed
    ↓ ✅ task.spec + gitDiff (NOT devOutput — isolation)
Reviewer Output:     reviewParsed (verdict + issues JSON)
    ↓ THIẾU — QA chỉ thấy archVerdict (PASS/FAIL string)
QA Chunk Output:     qaChunkResult (issues JSON per chunk)
    ↓ THIẾU — QAFinal không thấy master context
QA Final Output:     Gate5.notes (MARKDOWN — không phải JSON)
    ↓ YẾUC — QAFix đọc markdown, khó parse
QA Fix Output:       inline JSON trong response
```

### 4.2 Ba điểm mất dữ liệu quan trọng

**[CONTEXT-01] Reception → Architect: gaps không được truyền**

Reception tìm ra N gaps trong requirement. Architect không biết. Thiết kế của Architect có thể:
- Bỏ qua edge cases Reception đã flag
- Không xử lý conflicts Reception đã phát hiện
- Thiếu assumptions Reception đã nêu

**[CONTEXT-02] Reviewer → QA: mất chi tiết issues**

Reviewer viết ra issues cụ thể (file, line, severity, fix suggestion). QA Chunk chỉ nhận `archVerdict: "PASS|FAIL"`. Kết quả:
- QA phải re-review từ đầu những gì Reviewer đã review
- Có thể bỏ sót issues Reviewer đã flag (do không biết chúng tồn tại)
- Lãng phí token/thời gian

**[CONTEXT-03] QAFinal mất master context**

`buildQAFinalPrompt({ chunkResults })` — không có projectContext. Agent tổng hợp kết quả cuối cùng của sprint nhưng không biết:
- Project này đang làm gì
- Business priorities là gì
- Đây là sprint mấy trong lộ trình

### 4.3 Vấn đề nhỏ hơn

- **IntegrationFixer** thiếu original task specs → fix có thể conflict với spec
- **BugVerifier** thiếu original spec → không verify behavior, chỉ verify "không crash"
- **Diagnostician** thiếu conventions → fix plan không tuân thủ coding standards
- **QAFix** không có agent identity → không rõ isolation rules

---

## PHẦN 5 — NGÔN NGỮ PROMPT (Prompt Engineer)

### 5.1 Tình trạng hiện tại

| Agent | Prompt Language |
|-------|----------------|
| Architect | ✅ English |
| Reviewer | ✅ English |
| Diagnostician | ✅ English |
| SprintCoverageCheck | Vietnamese |
| Reception | Vietnamese |
| SpecWriter | Vietnamese |
| TaskPlanner | Vietnamese |
| Developer | Vietnamese |
| IntegrationVerifier | Vietnamese |
| IntegrationFixer | Vietnamese |
| ContractChecker | Vietnamese |
| QA Chunk | Vietnamese |
| QA Final | Vietnamese |
| Fixer | Vietnamese |
| Verifier | Vietnamese |
| QAFix | Vietnamese |

**11/16 agents vẫn dùng tiếng Việt** — bao gồm các agents quan trọng như Developer, Reviewer (English) → QA (Vietnamese) → QAFix (Vietnamese) tạo ra inconsistency trong pipeline.

### 5.2 Chất lượng Chain-of-Thought

| Agent | CoT Status |
|-------|-----------|
| Architect | ✅ 5-câu REASONING block |
| Reception | ✅ 4-câu THINKING block |
| SprintPlanner | ❌ Không có |
| SpecWriter | ❌ Không có |
| TaskPlanner | ❌ Không có |
| Developer | ❌ Không có |
| Reviewer | ❌ Không có |
| ContractChecker | ❌ Không có |
| Diagnostician | ❌ Không có |
| All others | ❌ Không có |

Chỉ 2/14 agents có chain-of-thought. Các agents phức tạp như TaskPlanner (chia atomic tasks), Reviewer (phán xuyết pass/fail), Diagnostician (tìm root cause) sẽ được hưởng lợi nhiều từ CoT.

### 5.3 Chất lượng OUTPUT LIMITS

Architect có output limits rõ ràng (max 3 sentences per field, total JSON < 8000 chars). Các agents khác không có. Điều này có thể gây:
- Token overflow ở SpecWriter/TaskPlanner khi project lớn
- Reviewer viết issues quá ngắn hoặc quá dài
- QAFix không biết cần detail đến mức nào

---

## PHẦN 6 — HIỂU CHUNG NGỮ CẢNH (Engineering: Architecture)

### 6.1 Nguồn context được dùng

```
_getOptimizedContext(sprintNumber):
  1. docs/context/project-brief.md  (stable — tech stack, conventions)
  2. docs/context/index.md          (running summary OR fallback to MASTER.md)
  3. docs/tcr/sprint-N-1/TCR-sprint-N-1.md  (previous sprint memory)
```

**Dùng bởi:** Architect, SpecWriter, TaskPlanner, Developer, Reviewer, IntegrationVerify, IntegrationFix, QAChunk, BugDiagnose

**KHÔNG dùng (thiếu context):** QAFix, QAFinal, BugVerify, SprintCoverageCheck

### 6.2 Context decay qua các bước

```
Sprint N bắt đầu
  Reception       [100% — đọc full requirement]
  Architect       [100% — full optimized context]
  SpecWriter      [100% — full optimized context + architect output]
  TaskPlanner     [100% — full + feature specs]
  Developer       [100% — full + zones + conventions + task spec]
  Reviewer        [100% — full + zones + breakingChanges + gitDiff]
  QA Chunk        [ 70% — full context + chỉ archVerdict, THIẾU reviewer issues]
  QA Final        [ 20% — CHỈ chunk results, KHÔNG có project context]
  QA Fix          [ 60% — có master + conventions + QA notes nhưng không có agent identity]
  Merge           [N/A]
```

Context decay rõ rệt ở 3 bước cuối pipeline. Đây là vấn đề quan trọng nhất của hệ thống hiện tại.

### 6.3 TCR (Technical Context Record)

Architect viết TCR sau mỗi sprint: `docs/tcr/sprint-N/TCR-sprint-N.md`. Sprint N+1's Architect đọc TCR sprint N. Đây là cơ chế memory inter-sprint tốt.

**Gap:** Chỉ Architect đọc TCR. Developer, Reviewer, QA của sprint N+1 không biết những gì đã xảy ra ở sprint N ngoài master context.

---

## PHẦN 7 — VALIDATION & ERROR HANDLING (Debug)

### 7.1 Zod Schema Coverage

| Output | Schema |
|--------|--------|
| sprintPlan | ✅ |
| reception | ✅ |
| architect | ✅ (4 fields mới đã thêm) |
| featureSpecs | ✅ |
| atomicTasks | ✅ |
| devReport | ✅ |
| review | ✅ |
| contractCheck | ✅ |
| integrationVerify | ✅ |
| qaChunk | ✅ |
| qaFinal | ✅ |
| bugDiagnose | ✅ |
| bugFix | ✅ |
| bugVerify | ✅ |
| **sprintCoverageCheck** | ❌ THIẾU |
| **qaFixReport** | ❌ THIẾU |

### 7.2 Error Recovery

- `repairTruncatedJSON`: ✅ Có heuristic repair
- Soft Zod validation: ✅ Return data với warnings thay vì throw
- Max retry: ✅ (3 rounds cho Dev, 3 rounds cho QA Fix, 3 rounds cho Bugfix)
- `Promise.race()` timeout: ✅ 45 min per task
- Orphan process cleanup: ✅ via `claudePid`

---

## PHẦN 8 — DANH SÁCH VẤN ĐỀ THEO ƯU TIÊN

### 🔴 Critical (ảnh hưởng đến chất lượng output)

| ID | Vấn đề | Ảnh hưởng |
|----|--------|-----------|
| C-01 | Reception gaps không được truyền sang Architect | Architect thiết kế thiếu edge cases |
| C-02 | Reviewer detailed issues không đến QA Chunk | QA không biết Reviewer đã flag gì |
| C-03 | BugVerifier không có spec context | Chỉ verify "không crash", không verify "đúng spec" |
| C-04 | QAFinal không có master context | Tổng hợp kết quả mà không biết project context |

### 🟡 Major (giảm chất lượng nhưng pipeline vẫn chạy)

| ID | Vấn đề | Ảnh hưởng |
|----|--------|-----------|
| M-01 | SprintCoverageCheck thiếu AGENT_PROFILES + _agentHeader + Zod schema | Agent không có identity, output không validated |
| M-02 | QAFix không có agent identity | Không có isolation rules, ẩn danh |
| M-03 | IntegrationFixer thiếu task specs | Fix có thể conflict với spec |
| M-04 | Gate5.notes là markdown thay vì structuredData | QAFix đọc markdown, khó parse chính xác |
| M-05 | 11/16 agents dùng tiếng Việt | Inconsistency, giảm output quality của Claude |
| M-06 | Diagnostician thiếu conventions | Fix plan không tuân thủ coding standards |

### 🟢 Minor (cải thiện nhưng không urgent)

| ID | Vấn đề | Ảnh hưởng |
|----|--------|-----------|
| N-01 | SprintPlanner thiếu CoT block | Có thể chia sprint không tối ưu |
| N-02 | TaskPlanner thiếu CoT block | Có thể tạo tasks không atomic |
| N-03 | Reviewer thiếu CoT block | Có thể bỏ sót issues phức tạp |
| N-04 | Diagnostician thiếu CoT block | Root cause có thể không đầy đủ |
| N-05 | 12/16 agents thiếu OUTPUT LIMITS | Risk token overflow ở large projects |
| N-06 | TCR chỉ đến Architect, không đến Dev/Reviewer sprint N+1 | Missed context về kết quả sprint trước |
| N-07 | Integration Pipeline không có rõ trigger point | Không rõ khi nào IntegrationVerifier chạy |
| N-08 | Sprint Planning không có PO approval gate | Sprint sai có thể tiến hành không có review |

---

## PHẦN 9 — ĐỀ XUẤT CẢI TIẾN

### Batch 1 — Critical Fixes (nên làm trước khi dùng thực tế)

**TASK-A: Truyền reception report sang Architect**
```javascript
// buildArchitectPrompt({ requirement, sprintNumber, receptionReport })
// Thêm vào prompt:
${receptionReport ? `## RECEPTION ANALYSIS (reviewed before you)
Gaps: ${receptionReport.gaps.map(g => `- [${g.severity}] ${g.area}: ${g.description}`).join('\n')}
Assumptions: ${receptionReport.assumptions.map(a => `- [${a.risk}] ${a.assumption}`).join('\n')}
` : ''}
```

**TASK-B: Truyền reviewer issues sang QA Chunk**
```javascript
// buildQAChunkPrompt({ ..., reviewerIssues })
// Thêm vào prompt:
${reviewerIssues?.length ? `## REVIEWER ISSUES (đã phát hiện trước)
${reviewerIssues.map(i => `- [${i.severity}] ${i.description}: ${i.fix}`).join('\n')}
QA: Ưu tiên verify các issues trên đã được fix đúng chưa.
` : ''}
```

**TASK-C: BugVerifier nhận spec context**
```javascript
// buildBugVerifyPrompt({ errorDescription, fixResult, originalSpec, conventions })
// Thêm vào prompt:
## ORIGINAL REQUIREMENT (to verify behavior, not just error)
${originalSpec}
## CODING CONVENTIONS
${conventions}
```

**TASK-D: QAFinal nhận master context**
```javascript
// buildQAFinalPrompt({ chunkResults, masterContext })
// Thêm vào đầu:
## PROJECT CONTEXT (for context-aware final verdict)
${masterContext}
```

### Batch 2 — Major Fixes

**TASK-E: Upgrade SprintCoverageCheck lên first-class agent**
- Thêm `coverage_verifier` vào AGENT_PROFILES
- Dùng `_agentHeader('coverage_verifier')`
- Thêm Zod schema `sprintCoverageCheck` vào outputParser.js

**TASK-F: QAFix dùng agent header**
- Thêm `qa_fixer` vào AGENT_PROFILES
- Replace inline identity với `_agentHeader('qa_fixer')`

**TASK-G: Gate5 lưu structuredData JSON**
- QA Final output lưu vào `Gate5.structuredData` (JSON với `issues` array)
- QAFix đọc từ structuredData thay vì parse markdown notes

**TASK-H: Migrate 11 agents còn lại sang English**
Priority: SpecWriter → TaskPlanner → Developer → Fixer → Verifier → QA Chunk → QA Final

### Batch 3 — Minor Improvements

**TASK-I: Thêm CoT cho TaskPlanner, Reviewer, Diagnostician**
- TaskPlanner: "1. Đây có phải atomic task không? 2. Tasks có conflict với nhau không?"
- Reviewer: "1. Code này có làm đúng spec không? 2. Edge cases nào bị bỏ qua?"
- Diagnostician: "1. Nguyên nhân gốc là gì? 2. Fix này có thể gây regression không?"

**TASK-J: Thêm OUTPUT LIMITS cho các agents chính**
- SpecWriter: max 5 features, each businessLogic max 5 steps
- TaskPlanner: max 8 tasks per sprint
- Reviewer: max 10 issues, each fix max 2 sentences

---

## KẾT LUẬN

Pipeline AI Dev này có **thiết kế kiến trúc tốt** — multi-agent isolation, gate approval flow, git worktree separation, 3-layer QA. Các cải tiến trong 19+6 tasks vừa qua đã nâng chất lượng đáng kể (StateMachine, Gate.structuredData, timeout enforcement, QA Fix limiter).

**Điểm mạnh chính:**
- Agent isolation design đúng — Reviewer không biết devReport, QA không biết reviewVerdicts
- Data persistence qua Gate.structuredData (JSON) thay vì parse markdown
- TCR memory system cho context inter-sprint
- Refactor God Class thành công

**Điểm yếu chính (theo thứ tự ưu tiên):**
1. Context decay ở 3 bước cuối pipeline (QAChunk, QAFinal, QAFix)
2. Reception-Architect disconnect (gaps không được truyền)
3. BugVerifier không có spec context
4. 11/16 agents vẫn tiếng Việt
5. SprintCoverageCheck không có infrastructure (profile, header, schema)

**Ước tính sau khi fix Batch 1+2:** 8.5/10 — sẵn sàng cho production cá nhân.

---

*Audit bởi: System Architect + Solution Architect + Engineering:Code-Review + Engineering:Debug + QA + QC + Prompt Engineer*
*Dựa trên: 14 source files, 1036 lines promptBuilder.js, 814 lines pipelineRunner.js*

# TASKS IMPROVE — AI Dev Pipeline
> Dựa trên audit thực tế toàn bộ source code (2026-04-05).
> Không bao gồm nhóm Security + Runtime (xử lý riêng).
> Copy từng TASK vào Claude Code trong VSCode. Làm tuần tự, verify xong mới làm tiếp.

---

## TRẠNG THÁI ĐÃ HOÀN THÀNH (không cần làm nữa)

Audit xác nhận các việc sau đã được implement trong code:

| Hạng mục | Trạng thái |
|----------|-----------|
| AGENT_PROFILES: 14 entries (reception, architect, developer, reviewer, qa, spec_writer, task_planner, integration_verifier, integration_fixer, contract_checker, diagnostician, fixer, sprint_planner, verifier) | ✅ Done |
| Tất cả 15 build methods đều gọi `_agentHeader()` | ✅ Done |
| `buildArchitectPrompt`, `buildFeatureSpecPrompt`, `buildAtomicTaskPrompt` dùng `_getOptimizedContext()` | ✅ Done |
| `buildBugDiagnosePrompt`, `buildBugFixPrompt`, `buildBugVerifyPrompt` dùng `_agentHeader()` thay inline block | ✅ Done |

---

## QUY TẮC LÀM VIỆC

1. Đọc file trước khi sửa — xác nhận line number thực tế
2. Chạy lệnh verify sau mỗi task
3. Báo cáo: `✅ TASK-XX done` hoặc `❌ TASK-XX blocked: <lý do>`
4. Không sửa gì ngoài phạm vi từng task

---

## NHÓM A — PROMPT BUILDER (6 tasks)
> File: `packages/backend/src/services/claude/promptBuilder.js`

---

### TASK-01 — Migrate 5 methods còn dùng `_getMaster()` → `_getOptimizedContext()`

**Vấn đề:** Audit xác nhận 5 methods sau vẫn đang dùng `_getMaster()` thay vì `_getOptimizedContext()`. `_getMaster()` load toàn bộ MASTER.md — context cũ, không có sprint optimization. Gây hallucination vì model nhận quá nhiều context không liên quan.

**Tìm từng method và thay dòng `this._getMaster()`:**

| Method | Line (khoảng) | Thay thế |
|--------|---------------|----------|
| `buildReviewPrompt(...)` | ~623 | `const master = this._getOptimizedContext(sprintNumber);` |
| `buildIntegrationVerifyPrompt(...)` | ~695 | `const master = this._getOptimizedContext(sprintNumber);` |
| `buildIntegrationFixPrompt(...)` | ~762 | `const master = this._getOptimizedContext(sprintNumber);` |
| `buildQAChunkPrompt(...)` | ~864 | `const master = this._getOptimizedContext(sprintNumber);` |
| `buildBugDiagnosePrompt(...)` | ~936 | `const master = this._getOptimizedContext(sprintNumber);` |

**Lưu ý:** Kiểm tra params của từng method — nếu `sprintNumber` chưa có trong destructuring, thêm vào. Ví dụ:
```javascript
// Trước:
buildReviewPrompt({ task, gitDiff, validationResult }) {

// Sau (nếu chưa có sprintNumber):
buildReviewPrompt({ task, gitDiff, validationResult, sprintNumber }) {
```

**Verify:**
```bash
node --check packages/backend/src/services/claude/promptBuilder.js
grep -n "_getMaster()" packages/backend/src/services/claude/promptBuilder.js
# Kết quả mong đợi: không còn dòng nào (ngoài định nghĩa hàm _getMaster ở dòng ~105)
```

---

### TASK-02 — Thêm Chain-of-Thought vào Reception prompt

**Vấn đề:** Reception agent nhận requirement và phân tích scope — đây là bước đầu tiên và quan trọng nhất. Hiện tại không có yêu cầu model "suy nghĩ trước khi output", dẫn đến phân tích hời hợt, bỏ sót ambiguity.

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Trong method `buildReceptionPrompt()`, tìm đoạn `QUAN TRONG:` gần cuối prompt. Chèn khối sau **VÀO TRƯỚC** đoạn đó:

```
## QUY TRINH SUY NGHI (bat buoc, viet ra truoc JSON)
Truoc khi output JSON, viet ngan gon (plain text):
1. Requirement nay de cap den nhung tinh nang nao? (liet ke het)
2. Tinh nang nao thieu ro rang ve: inputs, outputs, error cases?
3. Co gi mau thuan hoac co the hieu nhieu nghia khong?
4. Scope nay thuoc loai: simple (1-3 features) / medium (4-7) / complex (8+)?
Sau khi viet xong phan suy nghi, moi output JSON block.

```

**Verify:**
```bash
node --check packages/backend/src/services/claude/promptBuilder.js
```

---

### TASK-03 — Thêm 2 fields mới vào Reception output schema

**Vấn đề:** Reception hiện không capture danh sách feature rõ ràng hay cảnh báo scope lớn — PO không biết được sprint này có quá nhiều tính năng không.

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Trong `buildReceptionPrompt()`, tìm phần định nghĩa JSON output schema (đoạn liệt kê các fields như `"estimatedComplexity"`, `"clarificationNeeded"`, v.v.). Thêm 2 fields sau **VÀO TRƯỚC** `"estimatedComplexity"`:

```
"featureSummary": ["string — liet ke TUNG tinh nang doc lap duoc de cap trong requirement"],
"scopeWarning": "string hoac null — canh bao neu sprint nay co >7 tinh nang hoac >1 domain phuc tap",
```

**Verify:**
```bash
node --check packages/backend/src/services/claude/promptBuilder.js
```

---

### TASK-04 — Thêm Verdict Rules vào Reviewer prompt

**Vấn đề:** Reviewer hiện không có quy tắc rõ ràng về khi nào thì PASS/FAIL/PASS_WITH_NOTES. Model tự quyết → inconsistent verdicts. Đặc biệt: frozen zone violation đôi khi vẫn được PASS.

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Trong `buildReviewPrompt()`, tìm dòng `## OUTPUT FORMAT`. Chèn khối sau **VÀO TRƯỚC** dòng đó:

```
## VERDICT RULES (BAT BUOC TUYET DOI)
- PASS: Tat ca checklist items = true VA khong co issue "critical" hoac "major"
- PASS_WITH_NOTES: Tat ca checklist items = true VA chi co issue "minor"
- FAIL: Bat ky checklist item = false HOAC co bat ky issue "critical" hoac "major"

RANG BUOC KHONG CO NGOAI LE:
- Frozen zone file bi sua → verdict = FAIL, khong duoc override
- issues[].fix phai ghi ro: ten file, so dong, thay gi bang gi — KHONG duoc viet chung chung
- regressionRiskReason PHAI co noi dung neu regressionRisk la "medium" hoac "high"
- Moi checklist item PHAI co ket qua true/false — khong duoc bo trong

```

**Verify:**
```bash
node --check packages/backend/src/services/claude/promptBuilder.js
```

---

### TASK-05 — Thêm Blocking Rules + field `verdictReason` vào Contract Checker

**Vấn đề:** Contract Checker có thể set `blockMerge = false` ngay cả khi có frozen zone violation. Không có quy tắc cứng buộc nó phải block. Field `verdictReason` thiếu khiến PO không hiểu tại sao bị block.

**File:** `packages/backend/src/services/claude/promptBuilder.js`

**Bước 1:** Trong `buildContractCheckPrompt()`, tìm dòng `## OUTPUT FORMAT`. Chèn khối sau **VÀO TRƯỚC**:

```
## BLOCKING RULES (TUYET DOI, KHONG CO NGOAI LE)
- Bat ky frozen file nao bi sua → blockMerge = true, severity = "critical"
- Interface mismatch giua modules → blockMerge = true
- Breaking change khong co migration plan → blockMerge = true
- blockMerge = true PHAI co it nhat 1 issue voi severity = "critical"
- Khong duoc "thong cam" voi bat ky vi pham nao du ly do nghe co ve hop ly

```

**Bước 2:** Trong phần định nghĩa JSON output schema của cùng method, tìm field `"summary"` và thêm field sau **VÀO SAU** nó:

```
"verdictReason": "string — 1 cau giai thich ro rang tai sao block hoac cho pass (PO se doc cai nay)",
```

**Verify:**
```bash
node --check packages/backend/src/services/claude/promptBuilder.js
```

---

### TASK-06 — Thêm `syntaxCheckResults` vào Fixer output schema

**Vấn đề:** Sau khi Fixer sửa bug, không có bằng chứng rõ ràng là file đã được check syntax. Verifier không biết Fixer có tự check hay không.

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Trong `buildBugFixPrompt()`, tìm phần định nghĩa JSON output schema. Tìm field `"filesSkipped"` (hoặc field cuối cùng trong schema) và thêm field sau **VÀO SAU**:

```
"syntaxCheckResults": [
  { "file": "string — duong dan file da sua", "passed": true, "error": "string hoac null" }
],
```

**Verify:**
```bash
node --check packages/backend/src/services/claude/promptBuilder.js
```

---

## NHÓM B — OUTPUT PARSER (1 task)
> File: `packages/backend/src/services/claude/outputParser.js`

---

### TASK-07 — Sửa Architect Zod Schema — thiếu 4 fields + 1 field sai kiểu

**Vấn đề (xác nhận từ audit):**
- `masterMdUpdate: z.string()` — required, nhưng Architect prompt cho phép null → schema warning mỗi sprint
- Thiếu hoàn toàn: `tcrUpdate`, `contextIndexUpdate`, `zoneClassification`, `breakingChanges` → Claude trả về nhưng không được validate → data bị drop silently

**File:** `packages/backend/src/services/claude/outputParser.js`

Tìm `architect: z.object({` (khoảng dòng 49-62). Thay toàn bộ nội dung bên trong bằng:

```javascript
architect: z.object({
  analysis: z.string(),
  architectureOverview: z.string(),
  features: z.array(z.object({
    id: z.string().optional(),
    name: z.string(),
    description: z.string(),
    priority: z.string().optional(),
    acceptanceCriteria: z.array(z.string()).default([]),
  })),
  techDecisions: z.array(z.string()),
  risks: z.array(z.string()),
  masterMdUpdate: z.string().nullable().optional(),
  estimatedTasks: z.number(),
  tcrUpdate: z.object({
    summary: z.string(),
    decisions: z.array(z.string()).default([]),
    filesChanged: z.array(z.string()).default([]),
    nextSprintContext: z.string().optional(),
  }).optional(),
  contextIndexUpdate: z.string().nullable().optional(),
  zoneClassification: z.object({
    frozen: z.array(z.object({ path: z.string(), reason: z.string() })).default([]),
    guarded: z.array(z.object({ path: z.string(), reason: z.string() })).default([]),
    fluid: z.string().optional(),
  }).optional(),
  breakingChanges: z.array(z.object({
    type: z.string(),
    description: z.string(),
    affectedModules: z.array(z.string()).default([]),
    migrationRequired: z.boolean().default(false),
    migrationNotes: z.string().optional(),
  })).default([]),
}),
```

**Verify:**
```bash
node --check packages/backend/src/services/claude/outputParser.js
```

---

## NHÓM C — DATABASE SCHEMA (3 tasks)
> File: `packages/backend/prisma/schema.prisma`

---

### TASK-08 — Thêm `claudePid` vào Sprint model (chống orphan subprocess)

**Vấn đề:** Khi server restart trong lúc Claude đang chạy, subprocess trở thành orphan process vẫn tiếp tục chạy. Nếu PO resume sprint → tạo thêm subprocess mới → 2 Claude instances cùng ghi vào 1 worktree → git conflict.

**Bước 1 — Sửa schema:**

Tìm model `Sprint`, thêm field sau vào cuối (trước `}`):
```prisma
  claudePid Int?  // PID của Claude subprocess đang chạy — để kill orphan khi restart
```

**Bước 2 — Migration:**
```bash
cd packages/backend && npx prisma migrate dev --name add-sprint-claude-pid
```

**Bước 3 — Lưu PID khi spawn:**

File: `packages/backend/src/services/claude/claudeService.js`

Tìm chỗ spawn subprocess Claude. Ngay sau khi có `subprocess.pid`, thêm:
```javascript
if (sprintId && subprocess?.pid) {
  await prisma.sprint.update({
    where: { id: sprintId },
    data: { claudePid: subprocess.pid },
  }).catch(err => logger.warn({ err }, 'Could not save claudePid'));
}
```

**Bước 4 — Kill orphan trong `clearStaleLocks`:**

File: `packages/backend/src/services/orchestrator/index.js` (hoặc nơi định nghĩa `clearStaleLocks`)

Trong hàm `clearStaleLocks()`, thêm logic kill trước khi reset `isProcessing`:
```javascript
const staleSpints = await prisma.sprint.findMany({ where: { isProcessing: true } });
for (const s of staleSpints) {
  if (s.claudePid) {
    try {
      process.kill(s.claudePid, 'SIGTERM');
      logger.info({ pid: s.claudePid, sprintId: s.id }, 'Killed orphan Claude subprocess on startup');
    } catch {
      // Process đã chết — bỏ qua
    }
  }
}
await prisma.sprint.updateMany({
  where: { isProcessing: true },
  data: { isProcessing: false, claudePid: null },
});
```

**Verify:**
```bash
cd packages/backend && npx prisma validate
node --check packages/backend/src/services/claude/claudeService.js
node --check packages/backend/src/services/orchestrator/index.js
```

---

### TASK-09 — Thêm `Sprint FK` vào Notification model

**Vấn đề (xác nhận từ audit):** `Notification` model có `sprintId String?` nhưng không có `@relation` tới `Sprint` → không cascade delete → khi sprint bị xóa, notifications vẫn tồn tại thành orphaned records mãi mãi.

**File:** `packages/backend/prisma/schema.prisma`

**Bước 1 — Sửa model `Notification`:**

Tìm `model Notification`, thêm relation field ngay sau `sprintId String?`:
```prisma
  sprintId  String?
  sprint    Sprint?  @relation(fields: [sprintId], references: [id], onDelete: SetNull)
```

**Bước 2 — Thêm back-relation vào model `Sprint`:**

Tìm `model Sprint`, thêm vào cuối (trước `}`):
```prisma
  notifications Notification[]
```

**Bước 3 — Migration:**
```bash
cd packages/backend && npx prisma migrate dev --name add-notification-sprint-relation
```

**Verify:**
```bash
cd packages/backend && npx prisma validate
```

---

### TASK-10 — Thêm `structuredData` vào Gate model

**Vấn đề:** Pipeline hiện chuyển data giữa các steps bằng cách embed JSON vào Gate.notes (markdown string), sau đó dùng regex parse lại (`extractJSONFromNotes`). Nếu format notes thay đổi → tất cả downstream steps break silently. Đây là anti-pattern nghiêm trọng về data contract.

**File:** `packages/backend/prisma/schema.prisma`

**Bước 1 — Thêm field vào `Gate` model:**

Tìm `model Gate`, thêm sau field `notes`:
```prisma
  structuredData String?  // JSON string — raw structured data, tách biệt với notes display format
```

**Bước 2 — Migration:**
```bash
cd packages/backend && npx prisma migrate dev --name add-gate-structured-data
```

**Bước 3 — Lưu vào structuredData khi tạo/update Gate:**

File: `packages/backend/src/services/orchestrator/pipelineRunner.js`

Tìm tất cả `prisma.gate.update(` hoặc `prisma.gate.create(` có kèm `notes:`. Thêm `structuredData` song song:
```javascript
await prisma.gate.update({
  where: { id: gate.id },
  data: {
    notes: formattedNotes,                          // display format — giữ nguyên
    structuredData: JSON.stringify(parsedData),     // machine-readable — thêm mới
  },
});
```

**Bước 4 — Đọc từ structuredData thay vì parse notes:**

Tìm tất cả lần gọi `extractJSONFromNotes(`:
```bash
grep -n "extractJSONFromNotes" packages/backend/src/services/orchestrator/pipelineRunner.js
```

Thay từng lần bằng:
```javascript
// Trước:
const data = extractJSONFromNotes(gate.notes);

// Sau:
const data = gate.structuredData
  ? JSON.parse(gate.structuredData)
  : extractJSONFromNotes(gate.notes); // fallback cho gates cũ chưa có structuredData
```

**Verify:**
```bash
cd packages/backend && npx prisma validate
node --check packages/backend/src/services/orchestrator/pipelineRunner.js
```

---

## NHÓM D — ORCHESTRATOR (4 tasks)
> Files: `stateMachine.js`, `constants.js`, `orchestrator/index.js`

---

### TASK-11 — Xóa `GATE_TO_STEP` duplicate trong `stateMachine.js`

**Vấn đề (xác nhận từ audit):** `GATE_TO_STEP` được định nghĩa ở **2 nơi** với nội dung giống hệt nhau: `stateMachine.js` (dòng 30-38) và `constants.js` (dòng 38-46). Nếu ai update 1 bên quên bên kia → silent routing bug.

**Bước 1 — Xóa định nghĩa khỏi `stateMachine.js`:**

File: `packages/backend/src/services/orchestrator/stateMachine.js`

Tìm và xóa toàn bộ block `export const GATE_TO_STEP = { ... }` (dòng 30-38).

**Bước 2 — Import từ constants.js:**

Trong `stateMachine.js`, thêm vào import:
```javascript
import { GATE_TO_STEP } from '../lib/constants.js';
```

Re-export để không break các file import từ stateMachine:
```javascript
export { GATE_TO_STEP };
```

**Bước 3 — Verify không có file nào bị break:**
```bash
grep -rn "GATE_TO_STEP" packages/backend/src/ | grep -v node_modules
node --check packages/backend/src/services/orchestrator/stateMachine.js
```

---

### TASK-12 — Kích hoạt `StateMachine.assertTransition()` trong Orchestrator

**Vấn đề:** `StateMachine` class với `TRANSITIONS` map và `assertTransition()` method đã được viết đầy đủ nhưng **không bao giờ được gọi** → sprint có thể chuyển sang bất kỳ trạng thái nào mà không bị validate → race condition và invalid state có thể xảy ra âm thầm.

**File:** `packages/backend/src/services/orchestrator/index.js`

**Bước 1 — Import và khởi tạo:**

Thêm import (nếu chưa có):
```javascript
import { StateMachine } from './stateMachine.js';
```

Trong `Orchestrator` constructor, thêm:
```javascript
this.sm = new StateMachine();
```

**Bước 2 — Thêm assertion trong `onGateApproved()`:**

Tìm method `onGateApproved()`. Ngay trước `prisma.$transaction` (chỗ update sprint status), thêm:
```javascript
// Validate state transition trước khi commit
try {
  this.sm.assertTransition(sprint.status, targetStatus);
} catch (transitionErr) {
  logger.error({ from: sprint.status, to: targetStatus, sprintId }, 'Invalid sprint state transition blocked');
  throw transitionErr;
}
```

**Bước 3 — Thêm assertion trong `handleErrorAction()`:**

Tương tự, với mọi chỗ update `sprint.status` trong `handleErrorAction()`, thêm assertion trước.

**Verify:**
```bash
node --check packages/backend/src/services/orchestrator/index.js
```

---

### TASK-13 — Thêm explicit logging cho resume mid-sprint

**Vấn đề:** Khi sprint resume với mixed task states (một số `pass`, một số `pending`), code tự động re-run pending tasks mà không log rõ ràng. Khó debug khi pipeline bị stuck.

**File:** `packages/backend/src/services/orchestrator/index.js`

Tìm method `resumeSprint()` (hoặc logic xử lý resume). Tìm đoạn check `hasPending`. Thêm log:

```javascript
if (hasPending) {
  const pendingList = sprint.tasks.filter(t => t.status === 'pending');
  const passList = sprint.tasks.filter(t => t.status === 'pass');
  const escalatedList = sprint.tasks.filter(t => t.status === 'escalated');

  logger.info({
    sprintId,
    resumeFrom: sprint.status,
    pending: pendingList.length,
    pass: passList.length,
    escalated: escalatedList.length,
    pendingTaskIds: pendingList.map(t => t.taskId),
  }, '[RESUME] Resuming sprint mid-execution — re-running pending tasks only');
}
```

**Verify:**
```bash
node --check packages/backend/src/services/orchestrator/index.js
```

---

### TASK-14 — Fix Contract Check dùng sai git diff

**Vấn đề (xác nhận audit tại dòng 1700):**
```javascript
const diffResult = await mainGit.diff([`HEAD~${Math.min(passTasks.length, 20)}`, 'HEAD']);
```
Đây là diff của N commits gần nhất trên main branch — không phải diff của task branches. Sau merge, main có thể có commits từ nhiều sprints lẫn nhau → contract check đang check sai code.

**File:** `packages/backend/src/services/orchestrator/pipelineRunner.js`

Tìm dòng khoảng 1700 trong `_step5_QA`. Thay đoạn lấy diff bằng:

```javascript
// Lấy diff chính xác từng task qua worktree — không dùng main branch history
const taskDiffs = [];
for (const task of passTasks) {
  try {
    const diff = await wtManager.getDiff(task.taskId);
    if (diff?.trim()) {
      taskDiffs.push(`=== Task ${task.taskId}: ${task.title} ===\n${diff}`);
    }
  } catch (err) {
    logger.warn({ taskId: task.taskId, err: err.message }, 'Could not get worktree diff for task');
  }
}
const diffResult = taskDiffs.join('\n\n').substring(0, 12000) || '(no diff available)';
```

**Lưu ý:** Kiểm tra xem `wtManager` đã có trong scope của method đó chưa. Nếu chưa, tìm cách lấy instance.

**Verify:**
```bash
node --check packages/backend/src/services/orchestrator/pipelineRunner.js
```

---

## NHÓM E — WORKTREE MANAGER (1 task)
> File: `packages/backend/src/services/worktreeManager.js`

---

### TASK-15 — Fix stale branches tích lũy (dùng `-D` thay `-d`)

**Vấn đề (audit dòng 226-237):** `pruneAll()` dùng `git branch -d` (safe delete) — branch của task failed/escalated không bao giờ được merge → `-d` throw error → error bị swallow silently → branches tích lũy mãi. Sau 20+ sprints có thể có 100+ stale `feat/*` branches.

**File:** `packages/backend/src/services/worktreeManager.js`

**Bước 1 — Thêm method `deleteSprintBranches(sprintId)`:**

```javascript
/**
 * Force delete tất cả task branches của 1 sprint sau khi sprint complete/failed.
 * Dùng -D vì branches này đã qua review/escalation — không cần giữ.
 */
async deleteSprintBranches(sprintId) {
  const tasks = await prisma.task.findMany({
    where: { sprintId },
    select: { taskId: true, branch: true },
  });

  const results = [];
  for (const task of tasks) {
    const branch = task.branch || `feat/${task.taskId}`;
    try {
      await this.git.branch(['-D', branch]);
      logger.info({ branch, sprintId }, 'Deleted sprint task branch');
      results.push({ branch, deleted: true });
    } catch {
      results.push({ branch, deleted: false }); // Branch không tồn tại hoặc đã xóa
    }
  }
  return results;
}
```

**Bước 2 — Gọi sau khi sprint complete:**

File: `packages/backend/src/services/orchestrator/pipelineRunner.js`

Tìm chỗ sprint được mark `completed` (sau `runMerge` hoặc cuối step cuối). Thêm:
```javascript
// Dọn dẹp task branches sau sprint hoàn thành
await wtManager.deleteSprintBranches(sprint.id).catch(err =>
  logger.warn({ err: err.message }, 'Non-critical: could not clean up sprint branches')
);
```

**Verify:**
```bash
node --check packages/backend/src/services/worktreeManager.js
```

---

## NHÓM F — VALIDATION SERVICE (1 task)
> File: `packages/backend/src/services/validationService.js`

---

### TASK-16 — Fix ESM vs CJS import check (false positive với ESM projects)

**Vấn đề (audit dòng 66-68):** Dùng `node -e "require(path)"` để check syntax. Projects có `"type": "module"` trong `package.json` sẽ fail với `ReferenceError: require is not defined` → báo cáo sai file bị lỗi syntax trong khi thực ra không có lỗi gì.

**File:** `packages/backend/src/services/validationService.js`

Tìm đoạn:
```javascript
await execAsync(`node -e "require('${absPath}')"`, { cwd: worktreePath });
```

Thay bằng:
```javascript
// Detect module system của project trước khi chọn import command
let isESM = absPath.endsWith('.mjs');
if (!isESM && !absPath.endsWith('.cjs')) {
  try {
    const pkgPath = path.join(worktreePath, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    isESM = pkg.type === 'module';
  } catch {
    isESM = false; // Không có package.json → assume CJS
  }
}

const importCmd = isESM
  ? `node --input-type=module -e "import('${absPath.replace(/\\/g, '/')}')" 2>&1 || true`
  : `node -e "require('${absPath}')" 2>&1 || true`;

const { stdout, stderr } = await execAsync(importCmd, { cwd: worktreePath, timeout: 10000 });
```

**Verify:**
```bash
node --check packages/backend/src/services/validationService.js
```

---

## NHÓM G — PIPELINE RUNNER OPTIMIZATION (1 task)

---

### TASK-17 — Tối ưu QA Fix: bỏ re-run Layer 1 + Layer 2

**Vấn đề (audit dòng ~1602):** `runQAFix()` gọi lại `_step5_QA()` full sau mỗi lần fix. Mỗi lần fix = chạy lại: Layer 1 (lint/test) + Layer 2 (contract check AI call) + Layer 3 (chunked QA AI calls). Với sprint 10 tasks = 5-6 Claude calls mỗi lần fix → chậm và tốn kém.

**File:** `packages/backend/src/services/orchestrator/pipelineRunner.js`

**Bước 1 — Tìm trong `runQAFix()` dòng:**
```javascript
await this._step5_QA(freshSprint);
```

**Bước 2 — Thay bằng logic thông minh:**
```javascript
// Sau fix: chỉ chạy Layer 1 nhanh để confirm không break syntax
const quickCheck = await runSprintAutomatedChecks(project.repoPath);

if (!quickCheck.passed) {
  // Syntax/test vẫn fail sau fix → báo PO, không tiếp tục
  logger.warn({ sprintId, quickCheck }, '[QA-FIX] Automated check failed after fix');
  await this._notifyQALayer1Fail(sprint, quickCheck);
  return;
}

// Layer 1 pass → skip Layer 2 (contract check không thay đổi sau business fix)
// Chỉ re-run Layer 3 (business QA review)
logger.info({ sprintId }, '[QA-FIX] Layer 1 passed, running Layer 3 only (skipping Layer 2)');
await this._runQALayer3Only(freshSprint);
```

**Bước 3 — Thêm method `_runQALayer3Only(sprint)`:**

Copy phần Layer 3 logic từ `_step5_QA()` vào method mới, bỏ Layer 1 + Layer 2:
```javascript
async _runQALayer3Only(sprint) {
  logger.info({ sprintId: sprint.id }, '[QA] Running Layer 3 only (post-fix optimization)');
  // Copy toàn bộ code Layer 3 từ _step5_QA:
  // - QA chunk prompts
  // - QA final prompt
  // Bỏ qua: runSprintAutomatedChecks, contract check
}
```

**Verify:**
```bash
node --check packages/backend/src/services/orchestrator/pipelineRunner.js
```

---

## NHÓM H — REFACTOR LỚN (2 tasks — làm cuối)

---

### TASK-18 — Tách `pipelineRunner.js` God Class

**Vấn đề:** `pipelineRunner.js` có ~2000 lines, chứa 15+ methods thuộc 6 concerns hoàn toàn khác nhau. Khó maintain, khó test, merge conflicts liên tục.

**Target structure:**
```
packages/backend/src/services/orchestrator/
├── PipelineRunner.js        ← Core: steps 0-5, runStep, runMerge
├── TaskExecutor.js          ← _executeTask, _escalateTask, retryTask
├── QARunner.js              ← _step5_QA, _runQALayer3Only, runQAFix
├── BugfixRunner.js          ← runBugfix (diagnose → fix → verify)
├── DeployRunner.js          ← runLocalSetup, runUATDeploy
├── IntegrationVerifier.js   ← _step4b_IntegrationVerify
└── formatters/
    ├── receptionFormatter.js
    ├── architectFormatter.js
    └── qaFormatter.js
```

**Thứ tự làm (từ ít dependency nhất):**
1. `formatters/` — không có dependency nào, dễ nhất
2. `DeployRunner.js` — tách `runLocalSetup`, `runUATDeploy`
3. `BugfixRunner.js` — tách `runBugfix`
4. `IntegrationVerifier.js` — tách `_step4b_IntegrationVerify`
5. `QARunner.js` — tách toàn bộ QA logic
6. `TaskExecutor.js` — tách `_executeTask`, `_escalateTask`, `retryTask`
7. Update `PipelineRunner.js` — chỉ giữ core flow, delegate sang các class mới

**Rule bắt buộc:** Sau mỗi file được tách:
```bash
node --check packages/backend/src/services/orchestrator/<NewFile>.js
node --check packages/backend/src/services/orchestrator/pipelineRunner.js
# Không thay đổi behavior — chỉ tổ chức lại
```

---

### TASK-19 — Unify PipelineConfig — một nguồn truth duy nhất

**Vấn đề:** Config được lưu ở 2 nơi: `PipelineConfig` model trong DB và constants trong `constants.js`. Code đôi khi đọc từ DB, đôi khi dùng constants — 2 nguồn truth khác nhau, giá trị có thể diverge.

**Lựa chọn đề xuất: dùng DB làm source of truth duy nhất:**

File: `packages/backend/src/index.js` (hoặc server startup)

Thêm seeding bắt buộc khi start:
```javascript
// Đảm bảo PipelineConfig singleton tồn tại với defaults
await prisma.pipelineConfig.upsert({
  where: { id: 'singleton' },
  create: {
    id: 'singleton',
    maxRetryRounds: parseInt(process.env.MAX_RETRY_ROUNDS || '3'),
    taskTimeoutMins: parseInt(process.env.TASK_TIMEOUT_MINS || '45'),
    claudeTimeoutMins: parseInt(process.env.CLAUDE_TIMEOUT_MINS || '15'),
  },
  update: {}, // Không override nếu đã tồn tại
});
```

Sau đó trong code, thay tất cả `MAX_RETRY_ROUNDS`, `TASK_TIMEOUT_MS` từ constants bằng query DB config (hoặc cache nó tại startup).

**Verify:**
```bash
node --check packages/backend/src/index.js
```

---

## VERIFICATION CUỐI — Chạy sau khi xong tất cả

```bash
# 1. Syntax check tất cả files đã sửa
echo "=== Syntax Check ===" && \
node --check packages/backend/src/services/claude/promptBuilder.js && echo "✅ promptBuilder" && \
node --check packages/backend/src/services/claude/outputParser.js && echo "✅ outputParser" && \
node --check packages/backend/src/services/claude/claudeService.js && echo "✅ claudeService" && \
node --check packages/backend/src/services/orchestrator/index.js && echo "✅ orchestrator/index" && \
node --check packages/backend/src/services/orchestrator/stateMachine.js && echo "✅ stateMachine" && \
node --check packages/backend/src/services/orchestrator/pipelineRunner.js && echo "✅ pipelineRunner" && \
node --check packages/backend/src/services/worktreeManager.js && echo "✅ worktreeManager" && \
node --check packages/backend/src/services/validationService.js && echo "✅ validationService"

# 2. Prisma validate
echo "=== Prisma ===" && cd packages/backend && npx prisma validate && echo "✅ Schema valid"

# 3. Smoke test _getMaster() không còn được gọi ngoài định nghĩa
echo "=== _getMaster check ===" && \
COUNT=$(grep -n "_getMaster()" packages/backend/src/services/claude/promptBuilder.js | grep -v "^[0-9]*:.*_getMaster\(\) {" | wc -l) && \
[ "$COUNT" -eq 0 ] && echo "✅ No more _getMaster() calls in build methods" || echo "❌ Still $COUNT _getMaster() calls remaining"

# 4. Smoke test GATE_TO_STEP chỉ định nghĩa 1 chỗ
echo "=== GATE_TO_STEP deduplicate ===" && \
DEFS=$(grep -rn "const GATE_TO_STEP" packages/backend/src/ | grep -v node_modules | wc -l) && \
[ "$DEFS" -eq 1 ] && echo "✅ GATE_TO_STEP defined in 1 place only" || echo "❌ GATE_TO_STEP still defined in $DEFS places"

# 5. Test suite
echo "=== Tests ===" && \
npm test --prefix packages/backend 2>/dev/null || echo "(no tests configured)"
```

---

## CHECKLIST TỔNG (19 tasks)

```
NHÓM A — promptBuilder.js:
[ ] TASK-01: 5 methods migrate _getMaster() → _getOptimizedContext()
[ ] TASK-02: Reception chain-of-thought block added
[ ] TASK-03: Reception featureSummary + scopeWarning fields added
[ ] TASK-04: Reviewer verdict rules added
[ ] TASK-05: Contract Checker blocking rules + verdictReason added
[ ] TASK-06: Fixer syntaxCheckResults field added

NHÓM B — outputParser.js:
[ ] TASK-07: Architect Zod schema — 4 fields added + masterMdUpdate nullable

NHÓM C — schema.prisma:
[ ] TASK-08: Sprint.claudePid + orphan kill on restart
[ ] TASK-09: Notification → Sprint FK relation + migration
[ ] TASK-10: Gate.structuredData + replace extractJSONFromNotes calls

NHÓM D — orchestrator:
[ ] TASK-11: GATE_TO_STEP deduplicated (1 source only)
[ ] TASK-12: StateMachine.assertTransition() activated in onGateApproved
[ ] TASK-13: Resume sprint explicit logging
[ ] TASK-14: Contract check — fix git diff dùng wtManager.getDiff() per task

NHÓM E — worktreeManager.js:
[ ] TASK-15: deleteSprintBranches() + gọi sau sprint complete

NHÓM F — validationService.js:
[ ] TASK-16: ESM vs CJS detection cho import syntax check

NHÓM G — pipelineRunner optimization:
[ ] TASK-17: QA Fix skip Layer 1+2 re-run + _runQALayer3Only()

NHÓM H — Refactor (làm cuối):
[ ] TASK-18: Split pipelineRunner.js thành 6 files
[ ] TASK-19: Unify PipelineConfig — 1 source of truth

VERIFICATION:
[ ] Tất cả syntax check passed
[ ] Prisma validate passed
[ ] _getMaster() không còn trong build methods
[ ] GATE_TO_STEP chỉ định nghĩa 1 nơi
[ ] Test suite passed (hoặc no tests)
```

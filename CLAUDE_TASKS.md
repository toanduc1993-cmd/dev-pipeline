# AI Dev Pipeline — Implementation Tasks
> Dành cho Claude Code (VSCode). Đọc toàn bộ file này trước khi bắt đầu bất kỳ task nào.
> Mỗi task có đủ context, file cụ thể, và hướng dẫn implement chi tiết.

---

## HƯỚNG DẪN CHUNG

- Implement **tuần tự theo thứ tự** từ TASK-01 đến TASK-10
- Sau mỗi task: chạy `npm run dev` để đảm bảo server khởi động không lỗi
- Không thay đổi schema Prisma (`schema.prisma`) trừ khi task yêu cầu
- Không sửa logic pipeline flow (Gate/Step) trừ khi task yêu cầu
- Giữ nguyên naming convention hiện có (camelCase JS, const UPPER_SNAKE)
- Commit sau mỗi task với message: `fix: TASK-XX <mô tả ngắn>`

---

## TASK-01 — Fix Telegram gate approval keyboard (CRITICAL)

**Vấn đề:** Khi pipeline đến gate_waiting, notification gửi lên Telegram không bao giờ có nút Approve/Reject. PO phải dùng lệnh `/status` thủ công thay vì approve trực tiếp từ notification.

**Root cause:** Hàm `sendTelegramNotification` trong `bot/index.js` chỉ render inline keyboard khi `payload?.gateId` tồn tại. Nhưng tất cả `notif.send()` calls trong `pipelineRunner.js` không truyền `payload.gateId`.

**Files cần sửa:**

### 1. `packages/backend/src/services/orchestrator/pipelineRunner.js`

Tìm tất cả các `notif.send()` có `type: 'gate_waiting'` và thêm `payload: { gateId }`.

Có **4 chỗ** cần sửa:

**Chỗ 1 — Step 1 (khoảng dòng 171-177):**
```js
// TRƯỚC:
await this.orch.notif.send({
  projectId: project.id,
  sprintId,
  type: 'gate_waiting',
  title: 'Architecture designed',
  message: `Sprint #${number}: Gate 1 waiting for review`,
});

// SAU — thêm payload:
const gate1 = await prisma.gate.findUnique({
  where: { sprintId_gateNumber: { sprintId, gateNumber: 1 } },
  select: { id: true },
});
await this.orch.notif.send({
  projectId: project.id,
  sprintId,
  type: 'gate_waiting',
  title: 'Architecture designed',
  message: `Sprint #${number}: Gate 1 waiting for review`,
  payload: { gateId: gate1.id },
});
```

**Chỗ 2 — Step 2 (khoảng dòng 220-226):**
```js
// TRƯỚC:
await this.orch.notif.send({
  projectId: project.id,
  sprintId,
  type: 'gate_waiting',
  title: 'Feature Specs completed',
  message: `Sprint #${number}: Gate 2 waiting for review`,
});

// SAU — thêm payload:
const gate2Notif = await prisma.gate.findUnique({
  where: { sprintId_gateNumber: { sprintId, gateNumber: 2 } },
  select: { id: true },
});
await this.orch.notif.send({
  projectId: project.id,
  sprintId,
  type: 'gate_waiting',
  title: 'Feature Specs completed',
  message: `Sprint #${number}: Gate 2 waiting for review`,
  payload: { gateId: gate2Notif.id },
});
```

**Chỗ 3 — Step 3 (khoảng dòng 302-308):**
```js
// TRƯỚC:
await this.orch.notif.send({
  projectId: project.id,
  sprintId,
  type: 'gate_waiting',
  title: `${tasks.length} Atomic Tasks ready`,
  message: `Sprint #${number}: Gate 3 waiting for approval to start coding`,
});

// SAU — thêm payload:
const gate3 = await prisma.gate.findUnique({
  where: { sprintId_gateNumber: { sprintId, gateNumber: 3 } },
  select: { id: true },
});
await this.orch.notif.send({
  projectId: project.id,
  sprintId,
  type: 'gate_waiting',
  title: `${tasks.length} Atomic Tasks ready`,
  message: `Sprint #${number}: Gate 3 waiting for approval to start coding`,
  payload: { gateId: gate3.id },
});
```

**Chỗ 4 — Step 5 QA (khoảng dòng 669-674):**
```js
// TRƯỚC:
await this.orch.notif.send({
  projectId: project.id, sprintId,
  type: 'gate_waiting',
  title: hasBlock ? 'QA: Issues need review' : 'QA Report completed',
  message: `Sprint #${number}: Gate 5 waiting for PO review`,
});

// SAU — thêm payload:
const gate5 = await prisma.gate.findUnique({
  where: { sprintId_gateNumber: { sprintId, gateNumber: 5 } },
  select: { id: true },
});
await this.orch.notif.send({
  projectId: project.id, sprintId,
  type: 'gate_waiting',
  title: hasBlock ? 'QA: Issues need review' : 'QA Report completed',
  message: `Sprint #${number}: Gate 5 waiting for PO review`,
  payload: { gateId: gate5.id },
});
```

> **Lưu ý:** Với Step 1, gate đã được update trước đó nên có thể lấy id từ kết quả `prisma.gate.update()` thay vì query lại.

**Verification:** Sau khi fix, bật Telegram bot, chạy một sprint đến Gate 1. Notification trên Telegram phải có nút ✅ Approve và ❌ Reject.

---

## TASK-02 — Fix MASTER.md không được ghi sau Step 1 (CRITICAL)

**Vấn đề:** Architect Claude trả về `masterMdUpdate` trong output nhưng không có code nào ghi nội dung đó vào file `docs/MASTER.md`. Context tích lũy không hoạt động.

**File cần sửa:** `packages/backend/src/services/orchestrator/pipelineRunner.js`

**Tìm hàm `_step1_Architect`**, sau đoạn:
```js
const parsed = parseClaudeOutput(result.output, 'architect');
if (!parsed.success) throw new Error(`Cannot parse architect output: ${parsed.error}`);
```

Thêm đoạn ghi file **trước** `const notesForPO = formatArchitectForPO(parsed.data)`:
```js
// Ghi MASTER.md nếu architect trả về cập nhật
if (parsed.data?.masterMdUpdate) {
  const masterPath = path.join(project.repoPath, 'docs', 'MASTER.md');
  try {
    await fs.mkdir(path.join(project.repoPath, 'docs'), { recursive: true });
    await fs.writeFile(masterPath, parsed.data.masterMdUpdate, 'utf8');
    logger.info({ sprintId, masterPath }, 'MASTER.md updated');
  } catch (writeErr) {
    logger.warn({ sprintId, error: writeErr.message }, 'Failed to write MASTER.md — continuing');
  }
}
```

**Import cần thêm ở đầu file** (nếu chưa có `fs` từ `node:fs/promises`):
```js
import { promises as fs } from 'fs';
import path from 'path';
```

> Kiểm tra đầu file `pipelineRunner.js` — nếu đã có `import path from 'path'` thì không cần thêm lại. Nếu chỉ có `import { existsSync }` từ `fs` thì cần thêm `import { promises as fs } from 'fs'`.

**Verification:** Chạy Step 1, kiểm tra `<project.repoPath>/docs/MASTER.md` được tạo/cập nhật với nội dung từ Claude output.

---

## TASK-03 — Fix pausePipeline kill subprocess (CRITICAL)

**Vấn đề:** `POST /api/pipeline/pause` chỉ set `isProcessing = false` trong DB nhưng không kill subprocess `claude --print` đang chạy. Pipeline tiếp tục thực thi sau khi pause.

**Approach:** Lưu subprocess handle vào một Map trong `PipelineRunner`, kill khi pause được gọi.

### Bước 1: Sửa `packages/backend/src/services/claude/claudeService.js`

Thêm một Map để track active processes và export hàm kill:

```js
// Thêm ở đầu file, sau các imports:
const _activeProcesses = new Map(); // sprintId → subprocess

/**
 * Register an active claude subprocess for a sprint.
 * Called by PipelineRunner before spawning.
 */
export function registerProcess(sprintId, subprocess) {
  _activeProcesses.set(sprintId, subprocess);
}

/**
 * Kill active claude subprocess for a sprint, if any.
 * Returns true if a process was killed.
 */
export function killProcess(sprintId) {
  const proc = _activeProcesses.get(sprintId);
  if (!proc) return false;
  try {
    proc.kill('SIGTERM');
    logger.info({ sprintId }, 'Claude subprocess killed via SIGTERM');
  } catch (err) {
    logger.warn({ sprintId, error: err.message }, 'Failed to kill subprocess');
  }
  _activeProcesses.delete(sprintId);
  return true;
}

/**
 * Deregister process after it completes normally.
 */
export function deregisterProcess(sprintId) {
  _activeProcesses.delete(sprintId);
}
```

Sửa hàm `runClaude` để tự register/deregister. Thêm parameter `sprintId`:

```js
export async function runClaude({
  prompt,
  tools = [],
  cwd = process.cwd(),
  timeoutMs = CLAUDE_TIMEOUT_MS,
  onChunk = null,
  sprintId = null,   // <-- thêm parameter này
}) {
  // ... existing args setup ...

  const subprocess = execa(getClaudeBin(), args, { ... });

  // Register để có thể kill khi pause
  if (sprintId) registerProcess(sprintId, subprocess);

  // ... existing stdout/stderr handlers ...

  try {
    await subprocess;
    // ...
    return { success: true, output, durationMs };
  } catch (err) {
    // ...
  } finally {
    if (sprintId) deregisterProcess(sprintId);
  }
}
```

### Bước 2: Sửa `packages/backend/src/services/orchestrator/pipelineRunner.js`

Import thêm `killProcess`:
```js
import { runClaude, runClaudeWithRetry, killProcess } from '../claude/claudeService.js';
```

Trong tất cả `runClaudeWithRetry({ ... })` calls, truyền thêm `sprintId`:
```js
// Ví dụ Step 1:
const result = await runClaudeWithRetry({ prompt, tools: [], cwd: project.repoPath, sprintId });
```

> Tìm tất cả `runClaudeWithRetry({` trong file và thêm `sprintId` (lấy từ `sprint.id` hoặc `sprintId` variable có sẵn trong scope).

Thêm method `killActiveProcess` vào class `PipelineRunner`:
```js
killActiveProcess(sprintId) {
  return killProcess(sprintId);
}
```

### Bước 3: Sửa `packages/backend/src/services/orchestrator/index.js`

Thêm method `pauseSprint`:
```js
async pauseSprint(sprintId) {
  // Kill subprocess nếu đang chạy
  this.runner.killActiveProcess(sprintId);
  // Update DB
  await prisma.sprint.update({
    where: { id: sprintId },
    data: { isProcessing: false },
  });
  logger.info({ sprintId }, 'Sprint paused — subprocess killed');
}
```

### Bước 4: Sửa `packages/backend/src/controllers/pipelineController.js`

```js
// POST /api/pipeline/pause
export async function pausePipeline(req, res) {
  const orchestrator = req.app.get('orchestrator');

  // Tìm tất cả sprints đang processing
  const runningSprints = await prisma.sprint.findMany({
    where: { isProcessing: true },
    select: { id: true },
  });

  for (const sprint of runningSprints) {
    await orchestrator.pauseSprint(sprint.id);
  }

  res.json({
    ok: true,
    message: `Paused ${runningSprints.length} sprint(s)`,
    pausedCount: runningSprints.length,
  });
}
```

**Verification:** Trigger một sprint, ngay khi Claude đang chạy (thấy log "Spawning claude --print"), gọi POST `/api/pipeline/pause`. Kiểm tra log có "Claude subprocess killed via SIGTERM". Sprint không tiếp tục thực thi sau khi pause.

---

## TASK-04 — Thêm API Authentication (SECURITY)

**Vấn đề:** Toàn bộ REST API và Socket.io không có authentication. Bất kỳ ai có URL đều có thể approve/reject gate, xem code, override task results.

**Approach:** Bearer token đơn giản từ environment variable. Phù hợp với single-user/single-team tool.

### Bước 1: Thêm `API_SECRET` vào `.env`

Sửa file `packages/backend/.env` (hoặc `.env.example`):
```
API_SECRET=your-random-secret-here
```

Tạo một secret ngẫu nhiên: chạy `openssl rand -hex 32` trong terminal.

### Bước 2: Tạo file `packages/backend/src/middleware/auth.js`

```js
/**
 * Bearer token authentication middleware.
 * Reads API_SECRET from environment.
 * Skips auth for: GET /api/health
 */
export function authMiddleware(req, res, next) {
  // Bypass health check
  if (req.path === '/api/health') return next();

  const secret = process.env.API_SECRET;
  if (!secret) {
    // Nếu không có secret trong env, log warning nhưng allow (dev mode)
    return next();
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token || token !== secret) {
    return res.status(401).json({ error: 'Unauthorized — invalid or missing API token' });
  }

  next();
}
```

### Bước 3: Sửa `packages/backend/src/index.js`

Import và đăng ký middleware trước tất cả routes:

```js
import { authMiddleware } from './middleware/auth.js';

// Thêm SAU app.use(express.json(...)) và TRƯỚC các routes:
app.use(authMiddleware);
```

### Bước 4: Thêm Socket.io authentication

Trong `packages/backend/src/index.js`, thêm middleware cho Socket.io:

```js
// Thêm TRƯỚC io.on('connection', ...):
io.use((socket, next) => {
  const secret = process.env.API_SECRET;
  if (!secret) return next(); // dev mode

  const token = socket.handshake.auth?.token
    || socket.handshake.headers?.authorization?.replace('Bearer ', '');

  if (!token || token !== secret) {
    return next(new Error('Unauthorized'));
  }
  next();
});
```

### Bước 5: Sửa frontend để gửi token

Sửa `packages/frontend/src/lib/api.js` — thêm Authorization header:

```js
// Đầu file, sau imports:
const API_SECRET = import.meta.env.VITE_API_SECRET || '';

// Trong axios instance hoặc fetch wrapper, thêm header:
// Nếu dùng axios:
const api = axios.create({
  baseURL: ...,
  headers: {
    'Authorization': `Bearer ${API_SECRET}`,
  },
});

// Nếu dùng fetch thuần, wrap mọi fetch call để thêm header.
```

Sửa `packages/frontend/src/lib/socket.js` — thêm auth token:
```js
// Trong io() call:
export const socket = io(BACKEND_URL, {
  auth: { token: import.meta.env.VITE_API_SECRET || '' },
});
```

Thêm `VITE_API_SECRET` vào `packages/frontend/.env`:
```
VITE_API_SECRET=same-secret-as-backend
```

**Verification:** Gọi `curl http://localhost:3001/api/projects` → phải nhận `401 Unauthorized`. Gọi với header `Authorization: Bearer <secret>` → nhận data bình thường. Frontend load bình thường.

---

## TASK-05 — Fix Startup Recovery cho stale isProcessing locks

**Vấn đề:** Nếu server crash khi `isProcessing = true`, sau khi restart pipeline bị kẹt vĩnh viễn — không thể approve gate hay trigger bất kỳ action nào.

**File cần sửa:** `packages/backend/src/index.js`

Thêm startup recovery function và gọi nó trước khi server listen:

```js
/**
 * On startup: clear any stale isProcessing locks.
 * These can occur if server crashed mid-pipeline.
 */
async function clearStaleLocks() {
  const { count } = await prisma.sprint.updateMany({
    where: { isProcessing: true },
    data: { isProcessing: false },
  });
  if (count > 0) {
    logger.warn({ count }, 'Cleared stale isProcessing locks on startup');
  }
}
```

Sửa đoạn startup để gọi function này:
```js
// Trước httpServer.listen():
await clearStaleLocks();

httpServer.listen(PORT, () => {
  logger.info({ port: PORT }, 'AI Dev Pipeline backend running');
});
```

> Lưu ý: file `index.js` hiện tại không phải `async`. Wrap `httpServer.listen` trong async IIFE hoặc sử dụng `.then()`:

```js
// Thay đổi cấu trúc cuối file thành:
async function startServer() {
  await clearStaleLocks();
  httpServer.listen(PORT, () => {
    logger.info({ port: PORT }, 'AI Dev Pipeline backend running');
  });
}

startServer().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
```

**Verification:** Trong DB, set một sprint `isProcessing = true` thủ công. Restart server. Kiểm tra log "Cleared stale isProcessing locks on startup". Sprint trong DB phải có `isProcessing = false`.

---

## TASK-06 — Fix Race Condition trong Gate Approval

**Vấn đề:** Nếu hai request `POST /api/gates/:id/approve` đến cùng lúc, cả hai đều vượt qua check `isProcessing` trước khi bất kỳ cái nào set lock, dẫn đến pipeline chạy hai lần.

**File cần sửa:** `packages/backend/src/services/orchestrator/index.js`

Trong hàm `onGateApproved`, thay đổi để set `isProcessing = true` ngay trong transaction DB trước khi `setImmediate`:

```js
async onGateApproved(gateId, { comment = null, approvedBy = 'web' } = {}) {
  const gate = await prisma.gate.findUnique({
    where: { id: gateId },
    include: { sprint: { include: { project: true } } },
  });

  if (!gate) throw new Error('Gate not found');
  if (gate.status !== GATE_STATUS.WAITING_APPROVAL) {
    throw new Error(`Gate ${gate.gateNumber} is not waiting for approval (current: ${gate.status})`);
  }

  const { sprint } = gate;

  if (sprint.isProcessing) {
    throw new Error('Pipeline is currently processing, please wait');
  }

  // ✅ FIX: Dùng transaction để atomic update gate + set lock cùng lúc
  await prisma.$transaction([
    prisma.gate.update({
      where: { id: gateId },
      data: {
        status: GATE_STATUS.APPROVED,
        poComment: comment,
        approvedAt: new Date(),
        approvedBy,
      },
    }),
    prisma.sprint.update({
      where: { id: sprint.id },
      data: { isProcessing: true },  // Set lock NGAY TRONG TRANSACTION
    }),
  ]);

  this._emit('gate:updated', {
    gateId,
    sprintId: sprint.id,
    gateNumber: gate.gateNumber,
    status: GATE_STATUS.APPROVED,
  });

  logger.info({ gateId, gateNumber: gate.gateNumber, sprintId: sprint.id }, 'Gate approved');

  // Trigger next step async
  setImmediate(() => this._triggerNextStep(sprint, gate.gateNumber));
}
```

> **Quan trọng:** Vì `isProcessing` đã được set `true` ở đây, trong `_triggerNextStep` không cần set lại nữa. Kiểm tra `_triggerNextStep` để xem có `isProcessing = true` không — nếu có thì remove để tránh double-set.

Cũng sửa `onGateRejected` để thêm status guard:

```js
async onGateRejected(gateId, { reason = '', rejectedBy = 'web' } = {}) {
  const gate = await prisma.gate.findUnique({
    where: { id: gateId },
    include: { sprint: true },
  });

  if (!gate) throw new Error('Gate not found');

  // ✅ FIX: Chỉ cho reject khi gate đang waiting_approval
  if (gate.status !== GATE_STATUS.WAITING_APPROVAL) {
    throw new Error(`Cannot reject gate in status: ${gate.status}`);
  }

  // ... phần còn lại giữ nguyên ...
}
```

**Verification:** Dùng curl hoặc Postman gửi 2 request approve cùng lúc đến cùng gateId. Chỉ một request thành công, cái kia nhận lỗi "not waiting for approval".

---

## TASK-07 — Fix retryTask để thực sự re-execute task

**Vấn đề:** `POST /api/tasks/:id/retry` reset task về `pending` nhưng không có cơ chế nào trigger re-execution. Message hướng dẫn cũng sai ("Approve Gate 3 again" sẽ re-run ALL tasks).

**File cần sửa:** `packages/backend/src/controllers/taskController.js`

Sửa hàm `retryTask` để sau khi reset, gọi orchestrator re-execute task đó:

```js
// POST /api/tasks/:id/retry — reset task and re-queue
export async function retryTask(req, res) {
  const task = await prisma.task.findUnique({
    where: { id: req.params.id },
    include: { sprint: { include: { project: true } } },
  });
  if (!task) return res.status(404).json({ error: 'Task not found' });

  if (task.status !== 'fail' && task.status !== 'escalated') {
    return res.status(400).json({
      error: `Can only retry tasks with status fail or escalated (current: ${task.status})`,
    });
  }

  // Kiểm tra sprint không đang processing
  if (task.sprint.isProcessing) {
    return res.status(409).json({
      error: 'Sprint is currently processing. Wait for current step to complete before retrying.',
    });
  }

  // Reset task
  await prisma.task.update({
    where: { id: req.params.id },
    data: {
      status: 'pending',
      currentRound: 0,
      devOutputRaw: null,
      devOutputParsed: null,
      validationResult: null,
      reviewOutputRaw: null,
      reviewParsed: null,
      archVerdict: null,
      escalationReason: null,
      completedAt: null,
    },
  });

  // Trigger re-execution của task này qua orchestrator
  const orchestrator = req.app.get('orchestrator');
  try {
    await orchestrator.retrySingleTask(task.id, task.sprint);
    res.json({
      message: 'Task reset and re-execution started',
      taskId: task.taskId,
    });
  } catch (err) {
    res.json({
      message: 'Task reset to pending. Re-execution could not be triggered automatically.',
      taskId: task.taskId,
      warning: err.message,
    });
  }
}
```

**File cần sửa:** `packages/backend/src/services/orchestrator/index.js`

Thêm method `retrySingleTask`:

```js
/**
 * Re-execute a single task that was reset to pending.
 * Does NOT re-run the full Step 4 — only runs this specific task.
 */
async retrySingleTask(taskId, sprint) {
  const fullSprint = await prisma.sprint.findUnique({
    where: { id: sprint.id },
    include: { project: true },
  });

  if (fullSprint.isProcessing) {
    throw new Error('Sprint is already processing');
  }

  logger.info({ taskId, sprintId: sprint.id }, 'Retrying single task');

  // Set processing lock
  await prisma.sprint.update({
    where: { id: sprint.id },
    data: { isProcessing: true, status: 'running_step' },
  });

  // Chạy async không block response
  setImmediate(() => this.runner.retryTask(taskId, fullSprint));
}
```

**File cần sửa:** `packages/backend/src/services/orchestrator/pipelineRunner.js`

Thêm method `retryTask` vào class `PipelineRunner`:

```js
/**
 * Re-execute a single task (called from orchestrator.retrySingleTask).
 * Replicates the per-task logic from _step4_DeveloperAgents.
 */
async retryTask(taskId, sprint) {
  const { id: sprintId, project } = sprint;

  try {
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new Error(`Task ${taskId} not found`);

    const config = await prisma.pipelineConfig.findUnique({ where: { id: 'singleton' } });
    const maxRetry = config?.maxRetryRounds || 3;

    const wtManager = new WorktreeManager(project.repoPath);
    const builder = new PromptBuilder(project.repoPath);

    await this._executeTask(task, { wtManager, builder, sprint, maxRetry });

    // Check nếu task pass → check xem tất cả tasks đã pass chưa
    const updatedTask = await prisma.task.findUnique({ where: { id: taskId } });
    if (updatedTask.status === TASK_STATUS.PASS) {
      // Delegate về orchestrator để check resume
      await this.orch.resumeAfterHumanOverride(sprintId);
    } else {
      // Task vẫn fail/escalated → về waiting_human
      await prisma.sprint.update({
        where: { id: sprintId },
        data: { isProcessing: false, status: SPRINT_STATUS.WAITING_HUMAN },
      });
    }
  } catch (err) {
    logger.error({ taskId, sprintId, err: err.message }, 'retryTask failed');
    await this._unlock(sprintId);
  }
}
```

**Verification:** Tìm một task có status `fail`, gọi `POST /api/tasks/:id/retry`. Task phải được re-execute (thấy log "Spawning claude --print"), không re-run toàn bộ Step 4.

---

## TASK-08 — Fix Git branch cleanup sau merge

**Vấn đề:** `mergeToMain()` và `pruneAll()` không xóa git branches (`feat/task-xxx`). Sau mỗi sprint, branches tích lũy trong repo.

**File cần sửa:** `packages/backend/src/services/worktreeManager.js`

### Bước 1: Sửa `mergeToMain` để xóa branch sau merge thành công:

```js
async mergeToMain(taskId, branch) {
  const mainGit = simpleGit(this.repoPath);
  await mainGit.checkout('main');

  try {
    await mainGit.merge([branch, '--no-ff', '-m', `merge: ${taskId} — ${branch}`]);
    logger.info({ taskId, branch }, 'Merged to main');

    // ✅ FIX: Xóa branch sau khi merge thành công
    try {
      await mainGit.branch(['-d', branch]);
      logger.info({ taskId, branch }, 'Branch deleted after merge');
    } catch (branchErr) {
      // Không fail merge nếu branch delete lỗi
      logger.warn({ taskId, branch, error: branchErr.message }, 'Could not delete branch after merge');
    }
  } catch (err) {
    await mainGit.merge(['--abort']).catch(() => {});
    throw new Error(`Merge conflict for ${taskId}: ${err.message}`);
  }
}
```

### Bước 2: Sửa `pruneAll` để thêm cleanup branches orphan:

```js
async pruneAll() {
  await this.git.raw(['worktree', 'prune']);

  // ✅ FIX: Xóa các branches feat/task-* còn sót lại (đã merged)
  try {
    const branchSummary = await this.git.branch(['-l', 'feat/*']);
    const featBranches = branchSummary.all || [];
    for (const branch of featBranches) {
      try {
        // -d chỉ xóa nếu đã merged, tránh mất code chưa merge
        await this.git.branch(['-d', branch.trim()]);
        logger.info({ branch }, 'Pruned merged feature branch');
      } catch {
        // Branch chưa merged — skip
      }
    }
  } catch (err) {
    logger.warn({ error: err.message }, 'Branch cleanup had errors — continuing');
  }

  logger.info({ repoPath: this.repoPath }, 'Worktrees and branches pruned');
}
```

**Verification:** Chạy một sprint đến completion. Sau khi sprint `completed`, chạy `git branch` trong repo — không còn branches `feat/task-xxx` nào.

---

## TASK-09 — Cải thiện UX: Replace window.prompt() trong GateCard

**Vấn đề:** `GateCard.jsx` dùng `window.prompt()` để lấy reject reason — blocking native browser dialog, không thể style, UX kém.

**File cần sửa:** `packages/frontend/src/components/pipeline/GateCard.jsx`

Thêm modal inline vào GateCard thay thế `window.prompt()`:

```jsx
import { useState } from 'react';
import { CheckCircle, XCircle, Clock, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';
import { usePipelineStore } from '../../store/pipelineStore';
import toast from 'react-hot-toast';

// ... cfg object giữ nguyên ...

export default function GateCard({ gate, sprintIsProcessing }) {
  const [expanded, setExpanded] = useState(gate.status === 'waiting_approval');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);  // ✅ NEW
  const [rejectReason, setRejectReason] = useState('');            // ✅ NEW
  const { approveGate, rejectGate } = usePipelineStore();

  const st = cfg[gate.status] || cfg.pending;
  const isWaiting = gate.status === 'waiting_approval';

  const handleApprove = async () => {
    setBusy(true);
    try {
      await approveGate(gate.id, comment);
      toast.success(`Gate ${gate.gateNumber} approved`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  // ✅ NEW: Mở modal thay vì window.prompt
  const handleRejectClick = () => {
    setRejectReason('');
    setShowRejectModal(true);
  };

  // ✅ NEW: Confirm reject từ modal
  const handleRejectConfirm = async () => {
    if (!rejectReason.trim()) return;
    setShowRejectModal(false);
    try {
      await rejectGate(gate.id, rejectReason.trim());
      toast.success('Gate rejected');
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <>
      {/* ✅ NEW: Reject Modal */}
      {showRejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 mx-4">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle size={18} className="text-red-500" />
              <h3 className="font-semibold text-gray-800">Reject Gate {gate.gateNumber}</h3>
            </div>
            <p className="text-sm text-gray-500 mb-3">Provide a reason so the AI can understand what to fix.</p>
            <textarea
              className="w-full border border-gray-200 rounded-lg p-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-red-300"
              rows={3}
              placeholder="e.g. Feature scope too broad, split into smaller tasks..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              autoFocus
            />
            <div className="flex gap-2 mt-4 justify-end">
              <button
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
                onClick={() => setShowRejectModal(false)}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50"
                onClick={handleRejectConfirm}
                disabled={!rejectReason.trim()}
              >
                Reject Gate
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Phần còn lại của GateCard giữ nguyên, chỉ đổi onClick của Reject button: */}
      {/* Tìm chỗ gọi handleReject (onClick={handleReject}) và đổi thành onClick={handleRejectClick} */}
      <div className={`rounded-xl border-2 ${st.border} ${st.bg} overflow-hidden transition-all mb-3`}>
        {/* ... giữ nguyên toàn bộ nội dung card ... */}
        {/* Tìm button Reject và đổi handler: */}
        {/* <button ... onClick={handleReject}> → <button ... onClick={handleRejectClick}> */}
      </div>
    </>
  );
}
```

> **Lưu ý thực tế:** Đọc toàn bộ file `GateCard.jsx` hiện tại, giữ nguyên phần render card, chỉ:
> 1. Thêm 2 state mới: `showRejectModal` và `rejectReason`
> 2. Thêm 2 handler mới: `handleRejectClick` và `handleRejectConfirm`
> 3. Thêm modal JSX bọc toàn bộ return bằng `<>...</>`
> 4. Đổi `onClick={handleReject}` thành `onClick={handleRejectClick}` trên button Reject

**Verification:** Click "Reject" trên một gate đang `waiting_approval`. Phải hiện modal với textarea, không phải native browser prompt.

---

## TASK-10 — Thêm warning khi QA diff bị truncate

**Vấn đề:** Khi sprint có nhiều tasks, diff được cắt tại 12,000 ký tự mà không có cảnh báo nào. Claude QA review không đầy đủ nhưng PO không biết.

**File cần sửa:** `packages/backend/src/services/orchestrator/pipelineRunner.js`

Tìm đoạn tạo `combinedDiff` trong Step 5 (`_step5_QA`). Khoảng:

```js
const diffs = ...
const combinedDiff = diffs.join('\n\n').substring(0, 12000);
```

Sửa thành:

```js
const diffs = ...
const fullDiff = diffs.join('\n\n');
const DIFF_LIMIT = 12000;
const diffTruncated = fullDiff.length > DIFF_LIMIT;
const combinedDiff = diffTruncated
  ? fullDiff.substring(0, DIFF_LIMIT) + '\n\n[... DIFF TRUNCATED — showing first 12,000 chars of ' + fullDiff.length + ' total ...]'
  : fullDiff;

if (diffTruncated) {
  logger.warn({ sprintId, totalDiffLength: fullDiff.length, limit: DIFF_LIMIT }, 'QA diff truncated');
}
```

Và trong notification Gate 5, thêm thông tin truncation vào message nếu bị truncate:

```js
// Tìm notif.send() của Gate 5 (đã sửa trong TASK-01) và cập nhật message:
await this.orch.notif.send({
  projectId: project.id, sprintId,
  type: 'gate_waiting',
  title: hasBlock ? 'QA: Issues need review' : 'QA Report completed',
  message: `Sprint #${number}: Gate 5 waiting for PO review${diffTruncated ? ' ⚠️ Diff was truncated — large sprint' : ''}`,
  payload: { gateId: gate5.id },
});
```

**Verification:** Tạo sprint với nhiều tasks (>5). Kiểm tra log có "QA diff truncated" nếu diff vượt 12,000 chars. Notification Gate 5 trên Telegram có text "⚠️ Diff was truncated" nếu bị truncate.

---

## CHECKLIST HOÀN THÀNH

Sau khi implement xong tất cả tasks:

- [ ] TASK-01: Telegram keyboard hiện nút Approve/Reject khi gate_waiting
- [ ] TASK-02: `docs/MASTER.md` được ghi sau mỗi Step 1 Architect
- [ ] TASK-03: `POST /api/pipeline/pause` kill được subprocess Claude
- [ ] TASK-04: API trả `401` khi không có token, frontend gửi token trong header
- [ ] TASK-05: Server restart clear stale `isProcessing` locks và log warning
- [ ] TASK-06: Approve gate 2 lần cùng lúc chỉ xử lý được 1 lần
- [ ] TASK-07: Retry task re-execute đúng task đó, không re-run toàn bộ Step 4
- [ ] TASK-08: `git branch` sau sprint completion không có `feat/task-*` branches
- [ ] TASK-09: Reject gate mở modal trong app, không phải browser native prompt
- [ ] TASK-10: Log cảnh báo khi QA diff bị truncate, notification có thông tin truncation

---

## GHI CHÚ KỸ THUẬT

### Về Prisma transactions
SQLite không support nested transactions. `prisma.$transaction([...])` dùng interactive transaction — safe với SQLite.

### Về ES Modules
Project dùng `"type": "module"` — dùng `import/export`, không dùng `require/module.exports`.

### Về error handling pattern hiện có
Giữ nguyên pattern: `await this._lock(sprintId, N); try { ... } catch (err) { await this._unlock(sprintId); throw err; }`. Không phá vỡ pattern này.

### Về Prisma `include` trong reloadSprint
`_reloadSprint` trong `pipelineRunner.js` include `project` — đảm bảo khi thêm query mới, include đủ các relations cần thiết.

# AUDIT TASKS — AI Dev Pipeline
> Nguồn: AUDIT_REPORT.md (2026-04-05)
> Dành cho Claude Code (VSCode). Implement theo thứ tự AUD-01 → AUD-10.
> Mỗi task độc lập. Đọc kỹ file cần sửa trước khi thay đổi.

---

## TỔNG QUAN

| Task | Tên | Priority | Effort | File chính |
|------|-----|----------|--------|------------|
| AUD-01 | Fix architect schema trong outputParser | 🔴 Critical | 1h | `outputParser.js` |
| AUD-02 | Fix Reject Gate → auto re-run | 🔴 Critical | 3h | `orchestrator/index.js` |
| AUD-03 | Validate repoPath trước khi lưu DB | 🔴 Critical | 1h | `projectController.js` |
| AUD-04 | Fix duplicate GATE_TO_STEP constant | 🟡 Medium | 15m | `constants.js`, `stateMachine.js` |
| AUD-05 | Context size limit trong _getOptimizedContext | 🟡 Medium | 1h | `promptBuilder.js` |
| AUD-06 | SIGKILL fallback sau SIGTERM timeout | 🟡 Medium | 1h | `claudeService.js` |
| AUD-07 | Breaking changes lưu DB field, không parse từ notes | 🟡 Medium | 3h | `schema.prisma`, `pipelineRunner.js` |
| AUD-08 | Gate Notes render Markdown thay vì raw pre | 🟡 Medium | 4h | `GateCard.jsx` |
| AUD-09 | Sprint Progress indicator + step label | 🟡 Medium | 3h | `Pipeline.jsx`, `pipelineController.js` |
| AUD-10 | Reception Report blocking confirmation dialog | 🟢 Low | 2h | `GateCard.jsx`, `orchestrator/index.js` |

---

## AUD-01 — Fix `architect` schema trong outputParser.js

### Vấn đề
`outputParser.js` schema `architect` hoàn toàn thiếu các fields từ IMP-01/02/04:
- `tcrUpdate` (IMP-02) — không validate
- `contextIndexUpdate` (IMP-02) — không validate
- `zoneClassification` (IMP-01) — không validate
- `breakingChanges` (IMP-04) — không validate
- `masterMdUpdate` là `z.string()` required nhưng prompt nói là "có thể null"

Nếu Claude không trả về `masterMdUpdate` → **parse fail → pipeline crash toàn bộ Architect step.**

### Files cần đọc trước
- `packages/backend/src/services/claude/outputParser.js` (xem schema `architect` hiện tại)
- `packages/backend/src/services/claude/promptBuilder.js` (xem `buildArchitectPrompt` output schema để biết đúng format)

### Thay đổi cần thực hiện

**File:** `packages/backend/src/services/claude/outputParser.js`

Tìm schema `architect` và thay toàn bộ bằng:

```js
architect: z.object({
  analysis: z.string(),
  architectureOverview: z.string(),
  features: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    priority: z.string(),
  })),
  techDecisions: z.array(z.string()),
  risks: z.array(z.string()),
  masterMdUpdate: z.string().nullable().optional(),   // optional — backward compat only
  estimatedTasks: z.number(),
  // IMP-02: TCR Structure
  tcrUpdate: z.object({
    summary: z.string(),
    decisions: z.array(z.string()).default([]),
    filesChanged: z.array(z.string()).default([]),
    nextSprintContext: z.string().optional(),
  }).optional(),
  contextIndexUpdate: z.string().optional(),
  // IMP-01: Zone System
  zoneClassification: z.object({
    frozen: z.array(z.object({
      path: z.string(),
      reason: z.string(),
    })).default([]),
    guarded: z.array(z.object({
      path: z.string(),
      reason: z.string(),
    })).default([]),
    fluid: z.string().optional(),
  }).optional(),
  // IMP-04: Breaking Changes
  breakingChanges: z.array(z.object({
    type: z.enum(['api_change', 'schema_change', 'interface_change', 'behavior_change']),
    description: z.string(),
    affectedModules: z.array(z.string()).default([]),
    migrationRequired: z.boolean().default(false),
    migrationNotes: z.string().optional(),
  })).default([]),
}),
```

### Verification
- Chạy `_step1_Architect` với một sprint — không còn `Cannot parse architect output` khi Claude trả về output có tcrUpdate nhưng không có masterMdUpdate
- Schema validation pass với output mẫu chứa đủ fields mới

### Commit
```
fix: AUD-01 align architect schema với IMP-01/02/04 fields
```

---

## AUD-02 — Fix Reject Gate → auto re-run step với PO feedback

### Vấn đề
Hiện tại `onGateRejected()` chỉ set gate status = rejected, sprint = waiting_gate.
PO reject Gate 1 (Architecture) → không có gì tự động xảy ra. PO không biết làm gì tiếp theo.

Flow đúng: PO reject Gate N với lý do → Step tương ứng tự động re-run, inject `poComment` làm additional context vào prompt của Claude.

### Files cần đọc trước
- `packages/backend/src/services/orchestrator/index.js` — xem `onGateRejected`
- `packages/backend/src/services/claude/promptBuilder.js` — xem từng `build*Prompt` để biết cách inject `poFeedback`
- `packages/backend/src/lib/constants.js` — xem `GATE_TO_STEP` để biết gate nào → step nào

### Thay đổi cần thực hiện

**Bước 1 — `orchestrator/index.js`: Sửa `onGateRejected`**

Sau khi reject, tự động re-run step nếu gate là 0, 1, 2, 3, 5 (các gate có Claude step):

```js
async onGateRejected(gateId, { reason = '', rejectedBy = 'web' } = {}) {
  // ... (giữ nguyên validation hiện tại)

  await prisma.gate.update({
    where: { id: gateId },
    data: { status: GATE_STATUS.REJECTED, poComment: reason },
  });

  // Notify
  await this.notif.send({ ... });
  this._emit('gate:updated', { ... });

  // NEW: Auto re-run nếu gate có step tương ứng
  const REJECTABLE_GATES = [0, 1, 2, 3, 5]; // Gates mà PO có thể reject để re-run
  if (REJECTABLE_GATES.includes(gate.gateNumber)) {
    // Reset gate về pending để re-run
    await prisma.gate.update({
      where: { id: gateId },
      data: { status: GATE_STATUS.PENDING },
    });

    await prisma.sprint.update({
      where: { id: gate.sprintId },
      data: { isProcessing: true, status: SPRINT_STATUS.RUNNING_STEP },
    });

    // Store feedback trong sprint để PromptBuilder có thể đọc
    await prisma.sprint.update({
      where: { id: gate.sprintId },
      data: { poFeedback: reason }, // NEW field — xem schema migration bên dưới
    });

    await this.notif.send({
      projectId: gate.sprint.projectId,
      sprintId: gate.sprintId,
      type: 'gate_rejected',
      title: `Gate ${gate.gateNumber} từ chối — đang chạy lại`,
      message: `PO feedback: ${reason.substring(0, 200)}`,
    });

    // Re-run step tương ứng với gate bị reject
    // Gate 0 → re-run Step 0 (Reception), Gate 1 → re-run Step 1 (Architect), v.v.
    const stepToRerun = gate.gateNumber === 0 ? 0 : gate.gateNumber;
    setImmediate(async () => {
      try {
        const freshSprint = await prisma.sprint.findUnique({
          where: { id: gate.sprintId },
          include: { project: true, gates: { orderBy: { gateNumber: 'asc' } } },
        });
        if (stepToRerun === 0) {
          await this.runner._step0_Reception(freshSprint);
        } else {
          await this.runner.runStep(freshSprint, stepToRerun);
        }
      } catch (err) {
        logger.error({ err, gateNumber: gate.gateNumber }, 'Re-run after reject failed');
        await this._askPOOnError({ id: gate.sprintId, projectId: gate.sprint.projectId }, gate.gateNumber, err.message);
      }
    });
  }
}
```

**Bước 2 — `schema.prisma`: Thêm field `poFeedback`**

```prisma
model Sprint {
  // ... existing fields ...
  poFeedback  String?   // Latest PO feedback from rejected gate — injected into next Claude call
}
```

Chạy migration:
```bash
cd packages/backend && npx prisma migrate dev --name add-po-feedback
```

**Bước 3 — `promptBuilder.js`: Inject PO feedback vào prompts**

Thêm method `_getPOFeedback()` — đọc từ sprint context (sẽ được truyền vào builder khi construct):

Hoặc đơn giản hơn: truyền `poFeedback` vào từng `build*Prompt` và inject như section bổ sung:

```js
// Trong buildArchitectPrompt — thêm param poFeedback:
buildArchitectPrompt({ requirement, sprintNumber, poFeedback = null }) {
  // ...
  return `## SYSTEM CONTEXT
${master}

${poFeedback ? `## PO FEEDBACK (từ lần trước — cần điều chỉnh theo feedback này)\n> ${poFeedback}\n` : ''}

## TASK
...`
}
```

Sửa `_step1_Architect` trong `pipelineRunner.js` để đọc và truyền `poFeedback`:
```js
const prompt = builder.buildArchitectPrompt({
  requirement,
  sprintNumber: number,
  poFeedback: sprint.poFeedback || null,  // inject PO feedback
});

// Clear feedback sau khi đã dùng
await prisma.sprint.update({ where: { id: sprintId }, data: { poFeedback: null } });
```

Làm tương tự cho `buildReceptionPrompt`, `buildFeatureSpecPrompt`, `buildQAFinalPrompt`.

### Verification
- PO reject Gate 1 → backend log "Re-run after reject" → Step 1 tự động chạy lại
- Architect prompt có section "## PO FEEDBACK" với lý do reject
- Gate 1 reset về pending → sau khi Claude xong, Gate 1 lại waiting_approval với output mới

### Commit
```
feat: AUD-02 reject gate auto re-run step với PO feedback injection
```

---

## AUD-03 — Validate repoPath trước khi lưu DB

### Vấn đề
- `createProject` lưu `repoPath` vào DB mà không kiểm tra path có tồn tại không
- `repoPath` được dùng trực tiếp trong shell commands — path traversal risk
- User nhập `/Users/hacker/../../etc` → execSync chạy trong thư mục sai

### Files cần đọc trước
- `packages/backend/src/controllers/projectController.js`

### Thay đổi cần thực hiện

**File:** `packages/backend/src/controllers/projectController.js`

Tìm `createProject` function, thêm validation:

```js
import { existsSync, statSync } from 'fs';
import path from 'path';

export async function createProject(req, res) {
  const { name, description, repoPath, repoUrl, language } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required' });

  // Validate repoPath nếu là local path
  if (repoPath) {
    // Prevent path traversal — normalize và check không có '..'
    const normalizedPath = path.normalize(repoPath);
    if (normalizedPath !== repoPath && repoPath.includes('..')) {
      return res.status(400).json({ error: 'repoPath không hợp lệ — không được dùng ".."' });
    }

    // Check tồn tại
    if (!existsSync(normalizedPath)) {
      return res.status(400).json({ error: `Thư mục không tồn tại: ${repoPath}` });
    }

    // Check là directory
    if (!statSync(normalizedPath).isDirectory()) {
      return res.status(400).json({ error: `repoPath phải là thư mục, không phải file` });
    }

    // Check là git repo (có .git folder)
    if (!existsSync(path.join(normalizedPath, '.git'))) {
      return res.status(400).json({ error: `Thư mục không phải git repo (thiếu .git): ${repoPath}` });
    }
  }

  // ... (giữ nguyên phần còn lại)
}
```

### Verification
- POST /api/projects với `repoPath: "/nonexistent"` → 400 error "Thư mục không tồn tại"
- POST /api/projects với `repoPath: "../../etc"` → 400 error path traversal
- POST /api/projects với path hợp lệ → tạo thành công như trước

### Commit
```
fix: AUD-03 validate repoPath tồn tại và không có path traversal
```

---

## AUD-04 — Fix duplicate GATE_TO_STEP constant

### Vấn đề
`GATE_TO_STEP` được định nghĩa ở HAI nơi với nội dung y hệt:
- `packages/backend/src/lib/constants.js` (dòng 38-46)
- `packages/backend/src/services/orchestrator/stateMachine.js` (dòng 30-38)

`orchestrator/index.js` import từ `stateMachine.js`. Nếu hai bên không đồng bộ → silent bug.

### Files cần đọc trước
- `packages/backend/src/lib/constants.js`
- `packages/backend/src/services/orchestrator/stateMachine.js`
- `packages/backend/src/services/orchestrator/index.js` (xem đang import từ đâu)

### Thay đổi cần thực hiện

**Bước 1 — `stateMachine.js`: Xóa GATE_TO_STEP, import từ constants:**

```js
// stateMachine.js — XÓA export const GATE_TO_STEP = { ... }
// THÊM:
export { GATE_TO_STEP } from '../../lib/constants.js';
```

**Bước 2 — Verify `orchestrator/index.js` import vẫn hoạt động:**

```js
// orchestrator/index.js đang import:
import { GATE_TO_STEP } from './stateMachine.js';
// → vẫn hoạt động vì stateMachine.js re-export từ constants
```

### Verification
- `node --check` trên tất cả files liên quan — không có lỗi
- GATE_TO_STEP chỉ có 1 nguồn sự thật (constants.js)

### Commit
```
refactor: AUD-04 deduplicate GATE_TO_STEP — single source of truth
```

---

## AUD-05 — Context size limit trong `_getOptimizedContext`

### Vấn đề
`_getOptimizedContext()` load project-brief.md + context/index.md + TCR sprint trước mà không giới hạn tổng size. Nếu project-brief.md dài 500 dòng → prompt bị phình → Claude timeout hoặc truncate output.

### Files cần đọc trước
- `packages/backend/src/services/claude/promptBuilder.js` — xem `_getOptimizedContext`

### Thay đổi cần thực hiện

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Thêm token budget tracking vào `_getOptimizedContext`:

```js
_getOptimizedContext(currentSprintNumber = null) {
  const MAX_CHARS = 12000; // ~3000 tokens — budget cho context
  const parts = [];
  let totalChars = 0;

  const addPart = (label, content, maxChars = null) => {
    const text = `${label}\n${content}`;
    const allowed = maxChars ? Math.min(maxChars, MAX_CHARS - totalChars) : MAX_CHARS - totalChars;
    if (allowed <= 0) return;
    if (text.length > allowed) {
      parts.push(text.substring(0, allowed) + '\n\n[TRUNCATED — context budget exhausted]');
    } else {
      parts.push(text);
    }
    totalChars += Math.min(text.length, allowed);
  };

  // 1. project-brief.md — max 4000 chars (stable, load first)
  const briefPath = path.join(this.projectPath, 'docs', 'context', 'project-brief.md');
  if (existsSync(briefPath)) {
    addPart('## PROJECT BRIEF', readFileSync(briefPath, 'utf-8'), 4000);
  }

  // 2. context/index.md — max 5000 chars
  const indexPath = path.join(this.projectPath, 'docs', 'context', 'index.md');
  if (existsSync(indexPath)) {
    addPart('## PROJECT CONTEXT', readFileSync(indexPath, 'utf-8'), 5000);
  } else {
    const master = this._getMaster();
    if (master && !master.includes('[Chua co')) {
      addPart('## MASTER CONTEXT', master, 5000);
    }
  }

  // 3. Previous sprint TCR — max 3000 chars (phần còn lại)
  if (currentSprintNumber && currentSprintNumber > 1) {
    const prevSprint = currentSprintNumber - 1;
    const prevTcrPath = path.join(
      this.projectPath, 'docs', 'tcr',
      `sprint-${prevSprint}`, `TCR-sprint-${prevSprint}.md`
    );
    if (existsSync(prevTcrPath)) {
      addPart(`## TCR SPRINT #${prevSprint} (sprint truoc)`, readFileSync(prevTcrPath, 'utf-8'), 3000);
    }
  }

  return parts.join('\n\n') || '# Project Context\n[Sprint dau tien — chua co context]\n';
}
```

### Verification
- Tạo project-brief.md dài 1000 dòng → context vẫn được load nhưng bị truncated ở 4000 chars
- Tổng context không vượt quá 12000 chars
- Log `[TRUNCATED]` khi bị cắt

### Commit
```
fix: AUD-05 giới hạn context size trong _getOptimizedContext (12000 chars max)
```

---

## AUD-06 — SIGKILL fallback sau SIGTERM timeout

### Vấn đề
`killProcess()` trong `claudeService.js` gửi SIGTERM nhưng không có fallback nếu process không terminate. Claude process có thể bỏ qua SIGTERM → memory leak, port không được giải phóng.

### Files cần đọc trước
- `packages/backend/src/services/claude/claudeService.js` — xem `killProcess`

### Thay đổi cần thực hiện

**File:** `packages/backend/src/services/claude/claudeService.js`

Sửa `killProcess`:

```js
export function killProcess(sprintId) {
  const proc = _activeProcesses.get(sprintId);
  if (!proc) return false;

  try {
    proc.kill('SIGTERM');
    logger.info({ sprintId }, 'Claude subprocess sent SIGTERM');

    // Fallback: SIGKILL sau 5 giây nếu process vẫn còn
    const killTimer = setTimeout(() => {
      try {
        if (!proc.killed) {
          proc.kill('SIGKILL');
          logger.warn({ sprintId }, 'Claude subprocess force-killed with SIGKILL (SIGTERM timeout)');
        }
      } catch {
        // Process đã chết rồi — ok
      }
    }, 5000);

    // Không để timer giữ event loop sống nếu chương trình muốn thoát
    if (killTimer.unref) killTimer.unref();

  } catch (err) {
    logger.warn({ sprintId, error: err.message }, 'Failed to kill subprocess');
  }

  _activeProcesses.delete(sprintId);
  return true;
}
```

### Verification
- Pause sprint khi Claude đang chạy → subprocess bị SIGTERM
- Nếu sau 5s process vẫn còn → SIGKILL được gửi (kiểm tra trong log)
- `_activeProcesses` được cleanup đúng sau kill

### Commit
```
fix: AUD-06 SIGKILL fallback sau 5s nếu SIGTERM không đủ
```

---

## AUD-07 — Breaking changes lưu DB field, không parse từ Gate notes

### Vấn đề
`runMerge()` lấy `breakingChanges` bằng cách parse JSON từ Gate 1 notes (`extractJSONFromNotes(gate1?.notes)`). Đây là brittle approach — nếu format notes thay đổi → silent fail, breaking changes không được ghi.

### Files cần đọc trước
- `packages/backend/prisma/schema.prisma`
- `packages/backend/src/services/orchestrator/pipelineRunner.js` — xem `runMerge` và `_step1_Architect`

### Thay đổi cần thực hiện

**Bước 1 — `schema.prisma`: Thêm field cho Sprint**

```prisma
model Sprint {
  // ... existing fields ...
  breakingChangesJson  String?  // JSON array của breakingChanges từ Architect output
}
```

Chạy migration:
```bash
cd packages/backend && npx prisma migrate dev --name add-sprint-breaking-changes
```

**Bước 2 — `pipelineRunner.js`: Lưu vào DB trong `_step1_Architect`**

Sau khi parse Architect output, trước khi ghi TCR:

```js
// Sau: const parsed = parseClaudeOutput(result.output, 'architect');

// Lưu breakingChanges vào sprint record
if (parsed.data?.breakingChanges?.length > 0) {
  await prisma.sprint.update({
    where: { id: sprintId },
    data: { breakingChangesJson: JSON.stringify(parsed.data.breakingChanges) },
  });
}
```

**Bước 3 — `pipelineRunner.js`: Đọc từ DB trong `runMerge`**

Thay đoạn:
```js
const gate1 = await prisma.gate.findUnique({ ... });
const architectData = extractJSONFromNotes(gate1?.notes);
const breakingChanges = architectData?.breakingChanges || [];
```

Bằng:
```js
const breakingChanges = sprint.breakingChangesJson
  ? JSON.parse(sprint.breakingChangesJson)
  : [];
```

(`sprint` đã được load ở đầu `runMerge` với `_reloadSprint`)

### Verification
- Sau Step 1: `prisma.sprint.findUnique({ where: { id } })` có `breakingChangesJson` không null
- Sau merge: `docs/contracts/breaking-changes.md` được cập nhật đúng
- Thay đổi format Gate 1 notes không ảnh hưởng đến breaking change registry

### Commit
```
refactor: AUD-07 lưu breakingChanges vào DB field thay vì parse từ gate notes
```

---

## AUD-08 — Gate Notes render Markdown thay vì raw `<pre>`

### Vấn đề
`GateCard.jsx` hiển thị `gate.notes` bằng `<pre>` tag — PO thấy raw text kể cả khi notes có markdown formatting (headers, bold, bullet points). Reception Report, QA Report, Breaking Change list đều không được render đúng.

### Files cần đọc trước
- `packages/frontend/src/components/pipeline/GateCard.jsx`
- `packages/frontend/package.json` — kiểm tra có `react-markdown` chưa

### Thay đổi cần thực hiện

**Bước 1 — Cài `react-markdown` nếu chưa có:**

```bash
cd packages/frontend && npm install react-markdown
```

**Bước 2 — `GateCard.jsx`: Thay `<pre>` bằng Markdown renderer:**

```jsx
import ReactMarkdown from 'react-markdown';

// Thay đoạn hiển thị notes:
// <pre className="text-xs text-gray-700 whitespace-pre-wrap font-sans leading-relaxed">
//   {stripJsonBlock(gate.notes)}
// </pre>

// Bằng:
<div className="prose prose-sm max-w-none text-gray-700">
  <ReactMarkdown
    components={{
      h2: ({ children }) => <h2 className="text-sm font-bold text-gray-800 mt-3 mb-1">{children}</h2>,
      h3: ({ children }) => <h3 className="text-xs font-semibold text-gray-700 mt-2 mb-1">{children}</h3>,
      p: ({ children }) => <p className="text-xs text-gray-700 mb-1">{children}</p>,
      ul: ({ children }) => <ul className="text-xs list-disc pl-4 mb-1">{children}</ul>,
      li: ({ children }) => <li className="text-xs text-gray-700 mb-0.5">{children}</li>,
      strong: ({ children }) => <strong className="font-semibold text-gray-800">{children}</strong>,
      blockquote: ({ children }) => (
        <blockquote className="border-l-2 border-amber-300 pl-2 text-xs text-gray-500 italic">{children}</blockquote>
      ),
      code: ({ inline, children }) => inline
        ? <code className="bg-gray-100 px-1 rounded text-xs font-mono">{children}</code>
        : <pre className="bg-gray-50 border rounded p-2 text-xs overflow-auto">{children}</pre>,
    }}
  >
    {stripJsonBlock(gate.notes)}
  </ReactMarkdown>
</div>
```

**Bước 3 — Giữ `stripJsonBlock` để loại bỏ raw JSON:**
Function `stripJsonBlock` hiện tại đã đúng — giữ nguyên.

**Bước 4 — Thêm màu sắc cho severity keywords:**

Trong Reception Report, các từ như "🚫 Blockers", "❌ Gaps", "⚠️ Mâu thuẫn" đã có emoji — ReactMarkdown sẽ render đúng. Không cần custom parser thêm.

### Verification
- Gate 0 (Reception Report) notes hiển thị với headers, bullet points đúng format
- Gate 1 (Architecture) notes có Breaking Changes section được format đẹp
- Gate 5 (QA Report) critical/major/minor issues được render rõ ràng
- JSON block không hiển thị (stripJsonBlock đã remove)

### Commit
```
feat: AUD-08 render gate notes dưới dạng Markdown thay vì raw text
```

---

## AUD-09 — Sprint Progress indicator + step label

### Vấn đề
Khi Step 4 chạy (Developer Agents, có thể 45 phút × N tasks), PO không có cách biết đang làm gì, còn bao lâu. Chỉ thấy spinner generic.

### Files cần đọc trước
- `packages/frontend/src/pages/Pipeline.jsx`
- `packages/backend/src/controllers/pipelineController.js` — xem `/health` endpoint trả gì

### Thay đổi cần thực hiện

**Bước 1 — Backend: Thêm step label vào health response**

**File:** `packages/backend/src/controllers/pipelineController.js`

Tìm `pipelineHealth` function, thêm `stepLabel` mapping:

```js
const STEP_LABELS = {
  0: 'Step 0: Đang phân tích requirement...',
  1: 'Step 1: Architect đang thiết kế...',
  2: 'Step 2: Đang tạo Feature Specs...',
  3: 'Step 3: Đang tạo Atomic Tasks...',
  4: 'Step 4: Developer Agents đang code...',
  5: 'Step 5: QA đang kiểm tra...',
  6: 'Step 6: Đang merge vào main...',
};

// Trong response của pipelineHealth hoặc getSprintPipeline:
// Thêm vào sprint object:
sprintLabel: sprint.isProcessing
  ? (STEP_LABELS[sprint.currentStep] || `Step ${sprint.currentStep}: Đang xử lý...`)
  : null,
```

**Bước 2 — Frontend: `Pipeline.jsx` — Hiển thị progress bar và step label**

Thêm vào đầu component, sau phần sprint loaded:

```jsx
// Tính progress dựa trên step và task
const totalSteps = 6;
const progressPercent = sprint.isProcessing
  ? Math.round((sprint.currentStep / totalSteps) * 100)
  : sprint.status === 'completed' ? 100
  : sprint.status === 'waiting_gate' ? Math.round((sprint.currentGateNumber / totalSteps) * 100)
  : 0;

const stepLabel = sprint.isProcessing ? (STEP_LABELS[sprint.currentStep] || 'Đang xử lý...') : null;

const STEP_LABELS = {
  0: '🔍 Đang phân tích requirement...',
  1: '🏗️ Architect đang thiết kế kiến trúc...',
  2: '📋 Đang tạo Feature Specifications...',
  3: '⚙️ Đang chia Atomic Tasks...',
  4: `💻 Developer Agents đang code... (${pass}/${pass + pending + running} tasks)`,
  5: '🔬 QA đang kiểm tra 3 lớp...',
  6: '🔀 Đang merge code vào main...',
};
```

Thêm progress bar UI vào trước PipelineFlow:

```jsx
{sprint.isProcessing && stepLabel && (
  <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-4">
    <div className="flex items-center justify-between mb-2">
      <span className="text-sm font-medium text-blue-700">{stepLabel}</span>
      <span className="text-xs text-blue-500">{progressPercent}%</span>
    </div>
    <div className="w-full bg-blue-100 rounded-full h-1.5">
      <div
        className="bg-blue-500 h-1.5 rounded-full transition-all duration-1000"
        style={{ width: `${progressPercent}%` }}
      />
    </div>
  </div>
)}
```

### Verification
- Khi Step 4 đang chạy: banner hiển thị "💻 Developer Agents đang code... (2/5 tasks)"
- Khi Step 1 đang chạy: banner hiển thị "🏗️ Architect đang thiết kế kiến trúc..."
- Sprint completed: không hiển thị banner (stepLabel = null)

### Commit
```
feat: AUD-09 Sprint progress indicator với step label và progress bar
```

---

## AUD-10 — Reception Report blocking confirmation dialog

### Vấn đề
Khi Gate 0 Reception Report có `readyToProceed = false` (có blockers), PO vẫn có thể Approve bình thường mà không nhận warning rõ ràng. PO có thể vô tình bỏ qua blockers.

### Files cần đọc trước
- `packages/frontend/src/components/pipeline/GateCard.jsx`
- `packages/backend/src/services/orchestrator/pipelineRunner.js` — xem `_step0_Reception`, cách ghi notes

### Thay đổi cần thực hiện

**Bước 1 — `GateCard.jsx`: Detect blockers từ notes**

```jsx
// Thêm helper function:
function notesHaveBlockers(notes) {
  if (!notes) return false;
  // Reception Report với blockers sẽ có "🚫 Blockers" hoặc "readyToProceed: false"
  return notes.includes('🚫 Blockers') || notes.includes('readyToProceed: false') || notes.includes('Cần clarify trước');
}

// Trong component:
const isReceptionGate = gate.gateNumber === 0;
const hasBlockers = isReceptionGate && notesHaveBlockers(gate.notes);
const [showBlockerWarning, setShowBlockerWarning] = useState(false);

// Sửa handleApprove:
const handleApprove = async () => {
  // Nếu Gate 0 có blockers → hiện confirmation dialog trước
  if (hasBlockers && !showBlockerWarning) {
    setShowBlockerWarning(true);
    return;
  }
  setShowBlockerWarning(false);
  setBusy(true);
  try { await approveGate(gate.id, comment); toast.success(`Cổng ${gate.gateNumber} đã duyệt`); }
  catch (err) { toast.error(err.message); }
  finally { setBusy(false); }
};
```

**Bước 2 — Thêm warning dialog vào render:**

```jsx
{showBlockerWarning && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
    <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 mx-4">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle size={20} className="text-amber-500" />
        <h3 className="font-semibold text-gray-800">⚠️ Reception Report có Blockers</h3>
      </div>
      <p className="text-sm text-gray-600 mb-4">
        AI phát hiện requirement chưa đủ rõ để Architect thiết kế chính xác.
        Approve lúc này có thể dẫn đến thiết kế sai và tốn thêm sprint để fix.
      </p>
      <p className="text-sm font-medium text-gray-700 mb-4">
        Bạn có chắc muốn tiếp tục mà không clarify các blockers?
      </p>
      <div className="flex gap-2 justify-end">
        <button className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
          onClick={() => setShowBlockerWarning(false)}>
          Quay lại xem Blockers
        </button>
        <button className="px-4 py-2 text-sm bg-amber-500 text-white rounded-lg hover:bg-amber-600"
          onClick={handleApprove}>
          Tôi hiểu rủi ro — Vẫn tiếp tục
        </button>
      </div>
    </div>
  </div>
)}
```

### Verification
- Gate 0 với "🚫 Blockers" section → Approve button hiện warning dialog
- Click "Quay lại" → đóng dialog, PO có thể đọc thêm
- Click "Vẫn tiếp tục" → approve bình thường
- Gate 0 không có blockers → Approve bình thường, không có dialog

### Commit
```
feat: AUD-10 confirmation dialog khi approve Gate 0 có blockers
```

---

## CHECKLIST HOÀN THÀNH

| Task | Verification | Status |
|------|-------------|--------|
| AUD-01 | `architect` schema validate tcrUpdate/zoneClassification/breakingChanges | ⬜ |
| AUD-01 | `masterMdUpdate` là optional — không crash khi null | ⬜ |
| AUD-02 | Reject Gate 1 → Step 1 tự động re-run với PO feedback | ⬜ |
| AUD-02 | Architect prompt có section "PO FEEDBACK" | ⬜ |
| AUD-03 | POST project với path không tồn tại → 400 error | ⬜ |
| AUD-03 | POST project với `../../etc` → 400 path traversal error | ⬜ |
| AUD-04 | GATE_TO_STEP chỉ có 1 definition trong constants.js | ⬜ |
| AUD-05 | Context không vượt 12000 chars, có log [TRUNCATED] khi bị cắt | ⬜ |
| AUD-06 | Kill process → SIGTERM, sau 5s → SIGKILL nếu process vẫn sống | ⬜ |
| AUD-07 | Sprint record có `breakingChangesJson` sau Step 1 | ⬜ |
| AUD-07 | runMerge đọc từ sprint.breakingChangesJson thay vì gate notes | ⬜ |
| AUD-08 | Gate notes hiển thị markdown headers, bullets, bold | ⬜ |
| AUD-08 | JSON block bị strip — không hiển thị raw JSON | ⬜ |
| AUD-09 | Step 4 đang chạy → banner "💻 Developer Agents đang code..." | ⬜ |
| AUD-09 | Progress bar cập nhật theo currentStep | ⬜ |
| AUD-10 | Gate 0 có blockers → Approve hiện warning dialog | ⬜ |
| AUD-10 | Gate 0 không có blockers → Approve bình thường | ⬜ |

---

## GHI CHÚ KỸ THUẬT

### Thứ tự implement khuyến nghị
- AUD-04 trước (15 phút, không dependency) — dọn dẹp trước khi làm các task khác
- AUD-01 trước AUD-02 — AUD-02 dựa trên schema đúng của AUD-01
- AUD-07 cần migration → chạy `prisma migrate dev` trước
- AUD-08, AUD-09, AUD-10 là frontend — có thể làm song song với backend tasks

### Migration commands
```bash
# AUD-02: thêm poFeedback
cd packages/backend && npx prisma migrate dev --name add-po-feedback

# AUD-07: thêm breakingChangesJson
cd packages/backend && npx prisma migrate dev --name add-sprint-breaking-changes

# Hoặc gộp 2 migration vào 1:
# Sửa schema trước cả 2 fields, rồi:
cd packages/backend && npx prisma migrate dev --name add-po-feedback-and-breaking-changes
```

### Không phá vỡ pipeline hiện tại
- AUD-01: `masterMdUpdate` chuyển sang optional — backward compatible
- AUD-02: Reject flow hiện tại vẫn giữ, chỉ thêm auto re-run sau đó
- AUD-07: `breakingChangesJson` là field mới — không ảnh hưởng sprints cũ (sẽ = null)

### Frontend: react-markdown
Nếu `react-markdown` chưa có trong `package.json`:
```bash
cd packages/frontend && npm install react-markdown
```
Không cần plugin thêm — chỉ dùng core markdown rendering.

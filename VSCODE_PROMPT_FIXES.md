# VSCODE TASKS — 5 Remaining Fixes (8.5 → 9.5/10)
> Dựa trên PRODUCTION_READINESS_REPORT.md — Round 3
> Copy từng TASK vào VSCode, chờ xong mới làm task tiếp theo

---

## TASK-1 — CoverageCheck dùng đúng schema (~5 phút)

```
Đọc file: packages/backend/src/services/orchestrator/pipelineRunner.js

Tìm hàm planSprints(). Trong đó có đoạn gọi buildSprintCoverageCheckPrompt() rồi parseClaudeOutput.

Vấn đề: parseClaudeOutput đang được gọi với schema = null (hoặc không truyền schema name).
Schema 'sprintCoverageCheck' đã tồn tại trong outputParser.js nhưng không được dùng.

SỬA:
Tìm dòng parseClaudeOutput(coverageResult.text, null) hoặc parseClaudeOutput(coverageResult.text)
trong context của planSprints / buildSprintCoverageCheckPrompt.
Đổi thành: parseClaudeOutput(coverageResult.text, 'sprintCoverageCheck')

KIỂM TRA:
- Confirm outputParser.js có case 'sprintCoverageCheck' trong switch/map (search "sprintCoverageCheck" trong file)
- Nếu chưa có case trong parseClaudeOutput switch/map → thêm vào: case 'sprintCoverageCheck': return sprintCoverageCheckSchema.safeParse(data)
- Syntax check: node -e "import('./src/services/orchestrator/pipelineRunner.js').then(() => console.log('OK')).catch(e => console.error(e))"
```

---

## TASK-2 — TCR write failure notify PO (~15 phút)

```
Đọc file: packages/backend/src/services/orchestrator/pipelineRunner.js

Tìm hàm _step1_Architect(). Trong đó có đoạn ghi TCR file (writeTCR hoặc fs.writeFile vào docs/tcr/).
Hiện tại nếu ghi fail chỉ logger.warn — pipeline tiếp tục nhưng Sprint N+1 Architect mất memory.

SỬA — thay đoạn catch hiện tại:
Tìm khối try/catch bao quanh việc ghi TCR file.

Sửa thành:
  } catch (err) {
    logger.warn({ err, sprintId }, 'TCR write failed — next sprint may lose architectural context');
    // Notify PO nhưng không block pipeline
    try {
      await this.orch.notif.send({
        projectId: project.id,
        sprintId,
        type: 'warn',
        title: '⚠️ TCR write failed',
        message: `Sprint #${sprint.number}: Could not write Technical Context Record. Next sprint's Architect agent will not have memory of this sprint's decisions. Check that docs/tcr/ directory exists and is writable.`,
        payload: { sprintId },
      });
    } catch (_) { /* notification failure should not block */ }
  }

KIỂM TRA:
- TCR write failure không throw/crash pipeline (vẫn tiếp tục)
- Notification được gửi đúng format (xem các notif.send() khác trong file để match pattern)
- Syntax check file sau khi sửa
```

---

## TASK-3 — Verifier output nhất quán (~10 phút)

```
Vấn đề: BugfixRunner.js check kết quả Verifier bằng 2 conditions khác nhau:
  if (verifyParsed.status === 'PASS' || verifyParsed.verified === true)
Điều này gây inconsistency — không rõ Claude nên output field nào.

THAY ĐỔI PHẦN 1 — BugfixRunner.js:
Đọc file: packages/backend/src/services/orchestrator/BugfixRunner.js
Tìm dòng check: status === 'PASS' || verified === true (hoặc tương tự)
Đổi thành chỉ check một field:
  if (verifyParsed.status === 'PASS')

THAY ĐỔI PHẦN 2 — promptBuilder.js:
Đọc file: packages/backend/src/services/claude/promptBuilder.js
Tìm method buildBugVerifyPrompt().
Trong OUTPUT FORMAT JSON schema của prompt, tìm field "verified" (boolean).
Xóa field "verified" khỏi output schema.
Đảm bảo output schema chỉ còn: status ("PASS"|"FAIL"), tests[], newErrors[], specCompliance (nếu có).
Cập nhật instruction trong prompt: "Output status: PASS nếu fix hoạt động đúng, FAIL nếu còn lỗi."

KIỂM TRA:
- BugfixRunner.js chỉ check verifyParsed.status === 'PASS'
- buildBugVerifyPrompt output format không còn field "verified"
- Syntax check cả 2 files
```

---

## TASK-4 — Idempotency guard onGateApproved (~15 phút)

```
Đọc file: packages/backend/src/services/orchestrator/index.js

Tìm method onGateApproved(gateId, { comment, approvedBy }).
Vấn đề: nếu PO click approve 2 lần nhanh, cả 2 requests đều trigger _triggerNextStep — step có thể chạy 2 lần song song.

SỬA — thêm idempotency check ở đầu onGateApproved, TRƯỚC khi update DB:

  async onGateApproved(gateId, { comment, approvedBy }) {
    // IDEMPOTENCY GUARD — prevent double-execution
    const gate = await prisma.gate.findUnique({
      where: { id: gateId },
      select: { status: true, sprintId: true, gateNumber: true },
    });
    if (!gate) throw new Error(`Gate ${gateId} not found`);
    if (gate.status !== GATE_STATUS.WAITING_APPROVAL) {
      logger.warn({ gateId, currentStatus: gate.status }, 'Gate already processed — ignoring duplicate approval');
      return { ignored: true };
    }
    // ... phần còn lại của method giữ nguyên

Nếu method đã có logic check status, chỉ cần đảm bảo check xảy ra TRƯỚC khi gọi prisma.gate.update.

KIỂM TRA:
- Tìm pattern GATE_STATUS trong file để dùng đúng constant (WAITING_APPROVAL hoặc tương đương)
- Guard return sớm không crash caller
- Syntax check file sau khi sửa
```

---

## TASK-5 — IntegrationFixer nhận taskSpecs (~20 phút)

```
Vấn đề: IntegrationFixer biết "cần fix gì" (từ verifyResult) nhưng không biết "spec yêu cầu gì"
per task — fix có thể không đúng với original task spec.

THAY ĐỔI PHẦN 1 — promptBuilder.js:
Đọc file: packages/backend/src/services/claude/promptBuilder.js
Tìm method buildIntegrationFixPrompt({ verifyResult, architectSpec, sprintNumber }).

Sửa signature thành:
  buildIntegrationFixPrompt({ verifyResult, architectSpec, taskSpecs = [], sprintNumber })

Thêm section sau "## ARCHITECT DESIGN" (hoặc vị trí tương tự) trong prompt body:
  ${taskSpecs.length > 0 ? `## TASK SPECS (implement fixes according to these specs)
  ${JSON.stringify(taskSpecs.map(t => ({ taskId: t.taskId, title: t.title, description: t.description, definitionOfDone: t.definitionOfDone })), null, 2)}

  IMPORTANT: Your fixes must align with the task specs above. Do not change behavior that is correct per spec.
  ` : ''}

THAY ĐỔI PHẦN 2 — IntegrationVerifier.js hoặc pipelineRunner.js:
Đọc file: packages/backend/src/services/orchestrator/IntegrationVerifier.js (nếu có)
Hoặc tìm trong pipelineRunner.js nơi gọi buildIntegrationFixPrompt().
Sửa để pass taskSpecs: lấy từ DB (prisma.task.findMany where sprintId = sprint.id, select spec field).

Ví dụ:
  const tasks = await prisma.task.findMany({ where: { sprintId }, select: { taskId: true, spec: true } });
  const taskSpecs = tasks.map(t => { try { return JSON.parse(t.spec); } catch { return null; } }).filter(Boolean);
  // rồi pass taskSpecs vào buildIntegrationFixPrompt

KIỂM TRA:
- buildIntegrationFixPrompt vẫn hoạt động khi taskSpecs = [] (backward compat)
- Task specs được inject đúng format (JSON readable, không dump toàn bộ spec — chỉ key fields)
- Syntax check tất cả files đã sửa
```

---

## VERIFICATION — Chạy sau khi hoàn thành tất cả 5 tasks

```
cd packages/backend

node -e "import('./src/services/claude/promptBuilder.js').then(() => console.log('promptBuilder OK')).catch(e => console.error('promptBuilder FAIL:', e.message))"
node -e "import('./src/services/claude/outputParser.js').then(() => console.log('outputParser OK')).catch(e => console.error('outputParser FAIL:', e.message))"
node -e "import('./src/services/orchestrator/pipelineRunner.js').then(() => console.log('pipelineRunner OK')).catch(e => console.error('pipelineRunner FAIL:', e.message))"
node -e "import('./src/services/orchestrator/BugfixRunner.js').then(() => console.log('BugfixRunner OK')).catch(e => console.error('BugfixRunner FAIL:', e.message))"
node -e "import('./src/services/orchestrator/index.js').then(() => console.log('orchestrator OK')).catch(e => console.error('orchestrator FAIL:', e.message))"

Kiểm tra thêm:
- Tìm "sprintCoverageCheck" trong pipelineRunner.js — phải xuất hiện trong parseClaudeOutput call
- Tìm "verified === true" trong BugfixRunner.js — KHÔNG được xuất hiện
- Tìm "WAITING_APPROVAL" trong index.js onGateApproved — phải có idempotency check

Báo cáo: "ALL VERIFICATION PASSED" hoặc liệt kê errors cụ thể.
```

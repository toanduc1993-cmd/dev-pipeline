# Code Review — AI Dev Pipeline
> Đánh giá từ góc độ: Product Owner · Solution Architect · System Architect
> Ngày: 2026-04-04
> Reviewer: Claude (dựa trên đọc toàn bộ source code thực tế)

---

## TÓM TẮT ĐIỀU HÀNH

Hệ thống AI Dev Pipeline được thiết kế tốt về mặt ý tưởng — luồng Gate/Step, worktree isolation, và tích hợp Claude CLI đều là các lựa chọn hợp lý. Tuy nhiên, qua đọc source code thực tế, có **3 lỗi nghiêm trọng** khiến tính năng hoạt động sai hoàn toàn, **2 lỗ hổng bảo mật** ảnh hưởng production, và một số điểm cải thiện về reliability và maintainability.

---

## 🔴 CRITICAL BUGS — Lỗi nghiêm trọng, hoạt động sai

### BUG-01: Telegram Gate Approval Keyboard KHÔNG BAO GIỜ hiện ra

**File:** `packages/backend/src/bot/index.js` + `pipelineRunner.js` + `notificationService.js`

**Mô tả:** Tính năng "PO approve gate từ Telegram notification" được ghi trong spec là core feature, nhưng thực tế hoàn toàn không hoạt động.

**Root cause (đọc từ code):**

Trong `pipelineRunner.js`, mọi lần gọi `this.notif.send()` cho `gate_waiting`:
```js
// Ví dụ _step1_Architect:
await this.notif.send({
  projectId: sprint.projectId,
  sprintId: sprint.id,
  type: 'gate_waiting',
  title: 'Gate 1 ready — Review Architect output',
  message: '...',
  // ❌ KHÔNG có payload: { gateId: gate.id }
});
```

Trong `bot/index.js`, inline keyboard chỉ được thêm vào khi:
```js
if (type === 'gate_waiting' && payload?.gateId) {
  // Thêm Approve/Reject button
}
```

Vì `payload.gateId` luôn là `undefined`, nút Approve/Reject **không bao giờ xuất hiện** trong Telegram notification. PO bị buộc phải dùng lệnh `/status` để tương tác thay vì approve trực tiếp từ notification.

**Fix:** Truyền `payload: { gateId: gate.id }` trong tất cả các `notif.send()` call có `type: 'gate_waiting'` trong `pipelineRunner.js` (Steps 1, 2, 3, 5, và `_showGate6` trong orchestrator).

---

### BUG-02: MASTER.md KHÔNG BAO GIỜ được cập nhật

**File:** `packages/backend/src/services/orchestrator/pipelineRunner.js`

**Mô tả:** Một trong những thiết kế quan trọng nhất của hệ thống — accumulated context trong `MASTER.md` để Claude ngày càng hiểu sâu hơn về project — không hoạt động.

**Root cause (đọc từ code):**

`_step1_Architect` gọi Claude và parse output:
```js
const parsed = this.outputParser.parseArchitectOutput(raw);
// parsed.data.masterMdUpdate có nội dung Claude trả về...
```

Nhưng sau đó `masterMdUpdate` chỉ được lưu vào DB:
```js
await prisma.sprint.update({
  where: { id: sprint.id },
  data: {
    architectOutput: JSON.stringify(parsed.data),
    // masterMdUpdate KHÔNG được extract ra để ghi file
  },
});
```

Không có đoạn code nào trong toàn bộ codebase ghi `parsed.data.masterMdUpdate` vào `docs/MASTER.md`. Hàm `_getMaster()` luôn đọc file gốc không đổi.

**Hệ quả:** Claude ở các sprint sau không nhận được context tích lũy. Mỗi sprint đều "bắt đầu lại từ đầu".

**Fix:** Sau khi parse architect output, bổ sung:
```js
if (parsed.data?.masterMdUpdate) {
  const masterPath = path.join(sprint.project.localPath, 'docs', 'MASTER.md');
  await fs.writeFile(masterPath, parsed.data.masterMdUpdate, 'utf8');
}
```

---

### BUG-03: pausePipeline không dừng được Claude process

**File:** `packages/backend/src/controllers/pipelineController.js`

**Mô tả:** Chức năng "Pause Pipeline" chỉ set `isProcessing = false` trong DB nhưng KHÔNG kill subprocess `claude --print` đang chạy.

**Root cause (đọc từ code):**
```js
// pausePipeline:
await prisma.sprint.update({
  where: { id: req.params.id },
  data: { isProcessing: false },
});
return res.json({ message: 'Pipeline paused' });
```

Trong khi đó, `pipelineRunner.js` spawn Claude process qua `execa()` nhưng không lưu reference nào để kill. Khi subprocess hoàn thành, nó vẫn cập nhật DB, ghi file, và chuyển trạng thái pipeline — hoàn toàn bỏ qua lệnh pause.

**Hệ quả:** PO bấm "Pause" nhưng pipeline tiếp tục chạy. Đây là broken feature.

**Fix (minimal):** Lưu process handle vào `Map` trong `PipelineRunner`, kill khi pause; hoặc implement abort signal pattern với `AbortController`.

---

## 🟠 SECURITY GAPS — Lỗ hổng bảo mật

### SEC-01: Toàn bộ API không có authentication

**File:** `packages/backend/src/index.js`

Không có middleware auth nào trên bất kỳ route nào:
```js
app.use('/api/projects', projectRoutes);
app.use('/api/sprints', sprintRoutes);
app.use('/api/gates', gateRoutes);      // approve/reject gates
app.use('/api/tasks', taskRoutes);      // override task results
app.use('/api/pipeline', pipelineRoutes);
```

Bất kỳ ai biết URL đều có thể approve gate, reject gate, override task, xem toàn bộ code và AI output. Nếu hệ thống chạy trên mạng LAN hoặc có public IP thì đây là critical security issue.

**Fix tối thiểu (single-user):** Thêm `Bearer token` cố định từ `.env`:
```js
app.use('/api', (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== process.env.API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
});
```

---

### SEC-02: Socket.io không authenticate

**File:** `packages/backend/src/index.js`

Socket.io connections cũng không kiểm tra auth. Bất kỳ client nào cũng nhận được toàn bộ real-time events (task output, code diffs, gate status).

**Fix:** Thêm `io.use()` middleware để verify token trước khi accept connection.

---

## 🟡 RELIABILITY ISSUES — Vấn đề độ tin cậy

### REL-01: Race condition trong Gate Approval

**File:** `packages/backend/src/services/orchestrator/index.js`

Đoạn check `isProcessing` và trigger không atomic:
```js
// Tại onGateApproved():
if (sprint.isProcessing) throw new Error('...'); // check

// ... update gate status ...

setImmediate(() => this._triggerNextStep(...)); // trigger sau
// _triggerNextStep mới set isProcessing = true
```

Nếu hai request approve cùng lúc đến, cả hai đều vượt qua check `isProcessing` (vẫn false) trước khi bất kỳ cái nào kịp set lock.

**Fix:** Set `isProcessing = true` ngay trong transaction của `onGateApproved`, trước khi `setImmediate`.

---

### REL-02: Không có startup recovery cho stale locks

**File:** `packages/backend/src/index.js`

Nếu server crash giữa chừng khi đang process (ví dụ Claude đang chạy), `sprint.isProcessing` mãi là `true` trong DB. Sau khi restart, pipeline bị kẹt vĩnh viễn — không thể trigger bất kỳ thao tác nào.

**Fix:** Thêm vào startup:
```js
await prisma.sprint.updateMany({
  where: { isProcessing: true },
  data: { isProcessing: false },
});
```

---

### REL-03: retryTask bị broken

**File:** `packages/backend/src/controllers/taskController.js`

```js
// retryTask:
await prisma.task.update({
  where: { id: taskId },
  data: { status: TASK_STATUS.PENDING, ... }
});
return res.json({ message: 'Task reset. Approve Gate 3 again to retry.' });
```

Task được reset về `PENDING` nhưng không có cơ chế nào trigger thực thi lại task đó. Message hướng dẫn "Approve Gate 3 again" sẽ khởi động lại TẤT CẢ tasks từ đầu, không chỉ task bị lỗi.

**Fix cần thiết:** Implement targeted task re-run, hoặc remove endpoint này và hướng dẫn PO dùng `overridePass` + manual fix.

---

### REL-04: Gate Rejection không kiểm tra trạng thái hiện tại

**File:** `packages/backend/src/services/orchestrator/index.js`

`onGateRejected` không kiểm tra `gate.status` trước khi update. Có thể reject một gate đã được approve, đang running, hay thậm chí đã completed.

**Fix:** Thêm guard:
```js
if (![GATE_STATUS.WAITING_APPROVAL, GATE_STATUS.APPROVED].includes(gate.status)) {
  throw new Error(`Cannot reject gate in status: ${gate.status}`);
}
```

---

## 🔵 DESIGN & TECHNICAL DEBT

### TD-01: Git branch tích lũy không giới hạn

**File:** `packages/backend/src/services/worktreeManager.js`

`mergeToMain()` và `pruneAll()` chỉ remove worktree directory, không xóa git branch. Mỗi task tạo branch `feat/task-xxx`. Theo thời gian sẽ có hàng trăm branches tồn đọng.

**Fix:** Sau khi merge thành công, xóa branch:
```js
await execa('git', ['branch', '-d', branchName], { cwd: repoPath });
```

---

### TD-02: GATE_STATUS.AUTO là dead code

**File:** `packages/backend/src/lib/constants.js`

```js
GATE_STATUS = {
  AUTO: 'auto',  // ❌ Không được dùng ở đâu trong codebase
  ...
}
```

Xóa hoặc implement.

---

### TD-03: Soft validation có thể che giấu lỗi schema

**File:** `packages/backend/src/services/claude/outputParser.js`

Khi Zod validation thất bại, hàm vẫn trả về `{ success: true, data }` với `schemaWarnings`. Code gọi không check `schemaWarnings`, dẫn đến pipeline tiếp tục với data không đúng schema — có thể gây lỗi ở bước sau thay vì fail rõ ràng ngay tại điểm parse.

---

### TD-04: QA diff có thể bị cắt ngắn cho sprint lớn

**File:** `packages/backend/src/services/orchestrator/pipelineRunner.js`

```js
const diffContent = diffs.join('\n\n').substring(0, 12000);
```

Với sprint có nhiều tasks, diff bị cắt tại 12,000 ký tự. Claude QA chỉ review được phần đầu. Không có warning nào cho PO biết review bị truncated.

---

### TD-05: UX — window.prompt() trong GateCard

**File:** `packages/frontend/src/components/GateCard.jsx`

```js
const reason = window.prompt('Reason for rejection:');
```

`window.prompt()` là blocking native browser dialog, không thể style, không thể validate, và trông lạc lõng trong UI React hiện đại. Nên thay bằng modal component.

---

### TD-06: maxBuffer 100MB có thể gây memory pressure

**File:** `packages/backend/src/services/claude/claudeService.js`

```js
const result = await execa(claudeBin, args, {
  maxBuffer: 100 * 1024 * 1024, // 100MB
  ...
});
```

Với nhiều agents chạy song song (dù hiện tại `maxParallelAgents=1`), mỗi process có thể buffer 100MB. Khi scale up, đây sẽ là vấn đề nghiêm trọng.

---

### TD-07: Import resolution check chỉ work với CommonJS

**File:** `packages/backend/src/services/validationService.js`

```js
// Check import resolution:
await execa('node', ['-e', `require('${modulePath}')`]);
```

Dùng `require()` sẽ thất bại với ES module imports (`.js` với `"type": "module"` trong package.json). Nên dùng `node --input-type=module -e "import('...')"` hoặc static analysis.

---

## BẢNG TÓM TẮT ƯU TIÊN

| # | Vấn đề | Mức độ | Effort fix |
|---|--------|--------|-----------|
| BUG-01 | Telegram keyboard không hiện — missing gateId | 🔴 Critical | Thấp — thêm payload vào 5-6 chỗ |
| BUG-02 | MASTER.md không bao giờ được ghi | 🔴 Critical | Thấp — 5 dòng code |
| BUG-03 | pausePipeline không kill process | 🔴 Critical | Trung bình |
| SEC-01 | Không có API authentication | 🟠 High | Thấp |
| SEC-02 | Socket.io không authenticate | 🟠 High | Thấp |
| REL-01 | Race condition gate approval | 🟡 Medium | Thấp |
| REL-02 | Không recovery stale locks khi startup | 🟡 Medium | Rất thấp |
| REL-03 | retryTask broken | 🟡 Medium | Trung bình |
| REL-04 | Gate rejection không kiểm tra status | 🟡 Medium | Thấp |
| TD-01 | Git branch tích lũy | 🔵 Low | Thấp |
| TD-02 | GATE_STATUS.AUTO dead code | 🔵 Low | Rất thấp |
| TD-03 | Soft validation che giấu lỗi | 🔵 Low | Thấp |
| TD-04 | QA diff truncation không có warning | 🔵 Low | Thấp |
| TD-05 | window.prompt() trong GateCard | 🔵 Low | Thấp |
| TD-06 | maxBuffer 100MB | 🔵 Low | Thấp |
| TD-07 | Import check CommonJS only | 🔵 Low | Thấp |

---

## ĐIỂM MẠNH CỦA HỆ THỐNG

Để cân bằng đánh giá, những điểm thiết kế tốt:

- **Worktree isolation** cho từng task — tránh file conflicts hiệu quả
- **Sequential execution** (`maxParallelAgents=1`) — đơn giản hóa state management đúng cách thay vì over-engineer
- **Gate/Step state machine** — luồng approval rõ ràng, dễ debug
- **Consistent error handling** — pattern `_lock → try → catch → _unlock` áp dụng đều khắp các steps
- **AgentLog** — lưu raw Claude output giúp debug rất tốt
- **Zod schema** cho Claude output — đúng hướng dù implementation soft
- **Real-time frontend** với Socket.io — UX tốt cho pipeline monitoring

---

*Review này dựa trên đọc toàn bộ source code thực tế, không phải spec document.*

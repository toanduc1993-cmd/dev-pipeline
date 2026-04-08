# AUDIT REPORT — AI Dev Pipeline
> Ngày audit: 2026-04-05
> Vai trò: Product Owner + Solution Architect
> Phạm vi: Toàn bộ source code (backend + frontend + schema)

---

## EXECUTIVE SUMMARY

Hệ thống AI Dev Pipeline đã được phát triển với nền tảng kỹ thuật vững chắc và đã tích hợp đầy đủ 5 improvements từ AI-Dev-Framework-Team. Pipeline 7-gate hoạt động đúng logic, có auth, có error recovery, có TCR structure, zone system, breaking change registry, và 3-layer QA. Tuy nhiên còn một số điểm chưa hoàn thiện ở cả product experience lẫn kỹ thuật.

**Đánh giá tổng quan:**
| Chiều | Điểm | Nhận xét |
|-------|------|----------|
| Business Logic | 8/10 | Pipeline flow đúng, gate approval rõ ràng |
| UX/PO Experience | 5/10 | Thiếu visibility, feedback loop yếu |
| Architecture | 7.5/10 | Clean nhưng còn coupling và missing pieces |
| Reliability | 6.5/10 | Error handling tốt nhưng thiếu observability |
| Security | 7/10 | Bearer token OK, nhưng còn gaps |

---

## PHẦN 1 — PRODUCT OWNER AUDIT

### 1.1 Business Value — Những gì đã làm tốt

**Gate System hoạt động đúng intent:**
- 7 gates (0-6) đại diện đúng cho từng checkpoint PO cần quyết định
- Gate 0 Reception Report (IMP-03) giải quyết đúng pain point: requirement mơ hồ đến tay Architect
- Gate 4 auto-advance khi tất cả tasks pass — không làm phiền PO với quyết định không cần thiết
- Gate 6 final merge confirm — PO có full control trước khi code merge vào main

**Error Recovery đúng mental model PO:**
- Khi lỗi xảy ra, PO có 3 lựa chọn rõ ràng: Retry / Skip / Stop
- Telegram notification với Approve button trực tiếp — PO không cần vào web app
- Stale lock clearing khi restart server — pipeline không bị stuck vô thời hạn

**Context compression đúng hướng (IMP-02):**
- TCR + context/index.md giữ context ngắn gọn theo sprint
- Developer Agent không còn nhận toàn bộ MASTER.md mỗi lần — tiết kiệm token và thời gian

### 1.2 UX/PO Experience — Những điểm yếu

**[P1] Gate notes hiển thị raw, khó đọc:**
- `GateCard.jsx` dùng `<pre>` để hiển thị notes — PO thấy markdown thuần text
- Reception Report (gaps, conflicts, assumptions) không được render thành UI có cấu trúc
- Breaking change list trong Gate 1 không highlight rõ ràng severity
- **Impact:** PO mất thời gian đọc, dễ bỏ sót thông tin quan trọng

**[P1] Không có Sprint Progress indicator rõ ràng:**
- PipelineFlow component có nhưng chỉ hiển thị gate status — không có "đang ở bước nào, còn bao lâu"
- Khi Step 4 chạy (Dev Agents ~45 phút mỗi task), PO không biết tiến độ
- `AgentStatusCard` hiển thị task nhưng không có ETA, không có % completion
- **Impact:** PO lo lắng, phải F5 liên tục để kiểm tra

**[P1] Reject gate không feed back vào pipeline:**
- `onGateRejected` chỉ set status = rejected, cập nhật sprint về waiting_gate
- Không có flow: PO reject Gate 1 → Architect tự động re-run với feedback của PO
- PO phải tạo sprint mới hoặc manually trigger lại — không intuitive
- **Impact:** Reject gate là dead-end, PO không biết phải làm gì tiếp theo

**[P2] Dashboard thiếu Sprint-level KPI:**
- Dashboard chỉ hiển thị: số project, tổng sprint, số project active
- Không có: sprint đang chạy bây giờ là gì, step nào, bao nhiêu tasks đã pass
- PO phải vào từng project → từng sprint để biết tình trạng
- **Impact:** Không có "big picture" view cho PO

**[P2] Reception Report không blocking đủ mạnh:**
- Khi `readyToProceed = false`, Gate 0 chỉ thay đổi title notification
- PO vẫn có thể Approve bình thường dù có blockers — không có confirmation dialog
- **Impact:** PO vô tình approve qua blockers mà không đọc kỹ

**[P3] Không có Sprint history / audit trail cho PO:**
- Không có màn hình xem lại: sprint đã làm gì, ai approve khi nào, lý do reject là gì
- `approvedBy` chỉ lưu string "web" / "telegram" / "auto" — không có user identity
- **Impact:** Accountability và auditability thấp

**[P3] Language chỉ hỗ trợ 3 lựa chọn:**
- Dashboard form chỉ có: JavaScript, TypeScript, Python
- Không có: Go, Rust, Java, Ruby, PHP — nhiều project thực tế bị bỏ qua
- Auto-detect logic trong localSetup cũng chỉ handle JS/Python

### 1.3 User Story còn thiếu

Đọc source code, các user story sau chưa được implement:

| User Story | Status | Gap |
|------------|--------|-----|
| "Tôi muốn xem lại toàn bộ lịch sử quyết định của sprint" | ❌ Missing | Không có Sprint Audit Log page |
| "Tôi muốn reject Gate 1 và Architect tự sửa" | ❌ Missing | Reject là dead-end |
| "Tôi muốn biết ETA còn bao lâu thì xong" | ❌ Missing | Không có time estimation |
| "Tôi muốn chạy nhiều sprint song song" | ⚠️ Partial | Orchestrator hỗ trợ nhiều sprint nhưng UI không rõ |
| "Tôi muốn xem log chi tiết của từng Developer Agent" | ⚠️ Partial | AgentLog có trong DB nhưng không có UI đọc |
| "Tôi muốn compare hai sprint" | ❌ Missing | Không có feature này |

---

## PHẦN 2 — SOLUTION ARCHITECT AUDIT

### 2.1 Kiến trúc tổng thể — Đánh giá

```
Frontend (React + Zustand + Socket.io)
    ↕ REST API + WebSocket
Backend (Express + Prisma/SQLite)
    ├── Orchestrator (state machine + event dispatch)
    ├── PipelineRunner (step execution)
    ├── PromptBuilder (prompt construction)
    ├── ClaudeService (AI subprocess management)
    ├── WorktreeManager (git isolation)
    ├── ValidationService (deterministic checks)
    └── NotificationService (WebSocket + Telegram)
```

**Điểm mạnh:**
- Separation of concerns rõ ràng: Orchestrator không biết prompt, PromptBuilder không biết DB
- StateMachine đơn giản, GATE_TO_STEP mapping dễ extend
- Git worktree isolation là quyết định kiến trúc đúng đắn
- Atomic transaction khi approve gate (race condition handled)
- Startup lock clearing (clearStaleLocks) — production-ready thinking

### 2.2 Vấn đề kiến trúc

**[CRITICAL] Database: SQLite không phù hợp cho production multi-user:**
- SQLite file-based, không hỗ trợ concurrent writes tốt
- Khi nhiều gate được approve gần cùng lúc → write contention
- Sprint context (TCR, zone, breaking changes) lưu trên filesystem — không portable
- **Recommendation:** Migrate sang PostgreSQL (có thể dùng Prisma — chỉ đổi provider)

**[CRITICAL] Không có input validation trên API endpoints:**
- `createSprint`: chỉ check `name` required, không validate `requirementText` length
- `createProject`: không validate `repoPath` có tồn tại không trước khi lưu DB
- `repoPath` được dùng trực tiếp trong shell commands (`execSync`) — path traversal risk
- `gitToken` trong DeployConfig được lưu plain text trong SQLite

```js
// projectController.js — không có validation
const project = await prisma.project.create({ data: { ... repoPath: req.body.repoPath } });
// Sau đó repoPath được dùng: execSync('git clone', { cwd: repoPath })
```

**[HIGH] Memory leak tiềm năng trong _activeProcesses Map:**
- `claudeService.js` dùng module-level Map `_activeProcesses`
- `deregisterProcess` chỉ được gọi trong `finally` block — đúng
- Nhưng nếu `sprintId` được reuse (sprint bị reset), Map có thể giữ stale reference
- Process bị kill bằng SIGTERM nhưng không có timeout để escalate lên SIGKILL

**[HIGH] pipelineRunner.js quá lớn (>1000 dòng):**
- Một file chứa: step 0-5, merge, local setup, UAT deploy, integration verify, QA fix, format helpers
- Vi phạm Single Responsibility Principle
- Khó test, khó debug
- **Recommendation:** Tách thành: `steps/`, `deploy/`, `helpers/`

**[HIGH] Context load trong PromptBuilder không có size limit:**
- `_getOptimizedContext()` load project-brief.md + context/index.md + TCR sprint trước
- Không có giới hạn tổng token — nếu context/index.md bị phình to → prompt quá dài
- Context/index.md có truncation logic (200 lines) nhưng project-brief.md không có
- **Recommendation:** Enforce max token budget trước khi build prompt

**[MEDIUM] outputParser schema không khớp với promptBuilder output schema:**
- `architect` schema trong outputParser KHÔNG có `tcrUpdate`, `contextIndexUpdate`, `zoneClassification`, `breakingChanges`
- Chỉ validate: `analysis`, `architectureOverview`, `features`, `techDecisions`, `risks`, `masterMdUpdate`, `estimatedTasks`
- Nếu Claude không trả về `masterMdUpdate` → parse fail → pipeline crash
- **Impact:** Architect step có thể fail do schema mismatch dù output đúng

```js
// outputParser.js — architect schema
architect: z.object({
  analysis: z.string(),
  // ...
  masterMdUpdate: z.string(),  // Required! Nhưng buildArchitectPrompt nói là optional (null)
  estimatedTasks: z.number(),
  // tcrUpdate, contextIndexUpdate, zoneClassification, breakingChanges → MISSING
})
```

**[MEDIUM] Breaking Change Registry đọc từ Gate 1 notes — brittle:**
- `runMerge()` gọi `extractJSONFromNotes(gate1?.notes)` để lấy `breakingChanges`
- Gate 1 notes chứa formatted markdown + JSON block ở cuối
- `extractJSONFromNotes` parse JSON từ notes — nếu format thay đổi → break silently
- **Recommendation:** Lưu `breakingChanges` vào DB field riêng thay vì parse từ notes

**[MEDIUM] Không có request timeout trên Express:**
- `index.js` không set `server.timeout` hay request timeout middleware
- Claude calls có timeout (15 phút) nhưng HTTP request không có
- Long-running operations có thể giữ connection mãi
- **Recommendation:** Thêm `server.timeout = 30000` cho regular requests; pipeline routes dùng SSE hoặc polling

**[LOW] Duplicate GATE_TO_STEP mapping:**
- `constants.js` export `GATE_TO_STEP`
- `stateMachine.js` cũng export `GATE_TO_STEP` với nội dung y hệt
- `orchestrator/index.js` import từ `stateMachine.js`
- Hai nguồn của sự thật → maintainability risk

**[LOW] LocalSetup chạy `npm install` và khởi động app trong production server:**
- Sau mỗi sprint merge, backend tự động chạy `npm install` và start app trong repo của user
- Không có sandbox/isolation — process của user app chạy cùng process space với pipeline
- Port conflict nếu nhiều project dùng cùng port 3000
- **Recommendation:** LocalSetup nên là optional, trigger thủ công từ PO

### 2.3 Security Audit

| Điểm | Severity | Mô tả |
|------|----------|-------|
| `repoPath` trong shell commands | HIGH | Path traversal nếu PO nhập `../../etc/passwd` |
| `gitToken` plain text trong SQLite | HIGH | Token lộ nếu DB file bị access |
| `API_SECRET` trong `.env` commit vào repo | MEDIUM | File `.env` có trong `.gitignore` chưa? |
| Không có rate limiting trên API | MEDIUM | Brute force gate approval |
| CORS hardcode localhost:5173 | LOW | Không linh hoạt cho deployment |
| Socket.io auth bypass khi `API_SECRET` không set | LOW | `if (!secret) return next()` — insecure default |

### 2.4 Scalability Assessment

| Tình huống | Khả năng xử lý | Vấn đề |
|------------|----------------|--------|
| 1 project, 1 sprint | ✅ Tốt | - |
| 3 project, sprints song song | ⚠️ Partial | SQLite write contention |
| 10+ tasks per sprint | ⚠️ Partial | Sequential execution — chậm (~45 phút × n) |
| Context/docs/ folder lớn | ⚠️ Risk | Prompt size không bị giới hạn |
| Claude API rate limit | ⚠️ Risk | Retry logic có nhưng không track quota |
| Server restart mid-sprint | ✅ Handled | clearStaleLocks + resumeSprint |

### 2.5 Missing Technical Components

| Component | Tình trạng | Impact |
|-----------|------------|--------|
| Test suite cho pipeline backend | ❌ Missing | Không có regression protection |
| Health check cho Claude binary | ❌ Missing | Server start OK nhưng Claude không có |
| Metrics / observability | ❌ Missing | Không biết average sprint duration |
| Database backup | ❌ Missing | SQLite single file, no backup strategy |
| `architect` schema validation cho IMP fields | ❌ Bug | tcrUpdate/zoneClassification không validate |
| Multi-user auth (who approved) | ❌ Missing | approvedBy chỉ là "web" / "telegram" |
| Git token rotation | ❌ Missing | Token expire không có handler |

---

## PHẦN 3 — PRIORITY MATRIX

### Must Fix (blocking production use)

| # | Issue | File | Effort |
|---|-------|------|--------|
| 1 | outputParser `architect` schema thiếu tcrUpdate/zoneClassification/breakingChanges | `outputParser.js` | 1h |
| 2 | `masterMdUpdate` required trong schema nhưng optional trong prompt | `outputParser.js` | 30m |
| 3 | Validate `repoPath` tồn tại trước khi lưu DB | `projectController.js` | 1h |
| 4 | Reject Gate không có feedback loop → Architect re-run | `orchestrator/index.js` | 3h |

### Should Fix (production quality)

| # | Issue | File | Effort |
|---|-------|------|--------|
| 5 | Gate notes render as markdown UI thay vì raw `<pre>` | `GateCard.jsx` | 4h |
| 6 | Sprint progress indicator với ETA | `Pipeline.jsx` + backend | 4h |
| 7 | Duplicate GATE_TO_STEP constant | `constants.js` / `stateMachine.js` | 15m |
| 8 | `_activeProcesses` SIGKILL fallback sau SIGTERM timeout | `claudeService.js` | 1h |
| 9 | Context size limit trong `_getOptimizedContext` | `promptBuilder.js` | 1h |
| 10 | Breaking changes lưu vào DB field thay vì parse từ notes | Schema + pipelineRunner | 3h |

### Could Fix (nice to have)

| # | Issue | Effort |
|---|-------|--------|
| 11 | Tách pipelineRunner.js thành nhiều modules | 1 ngày |
| 12 | Migrate SQLite → PostgreSQL | 2h (Prisma makes this easy) |
| 13 | Dashboard Sprint KPI overview | 4h |
| 14 | Agent Log viewer UI | 3h |
| 15 | Rate limiting middleware | 1h |
| 16 | Reception Report blocking confirmation dialog | 2h |
| 17 | Sprint history / audit trail page | 1 ngày |

---

## PHẦN 4 — ĐIỂM ĐẶC BIỆT ĐÁNG GHI NHẬN

### Quyết định kiến trúc đúng đắn
- **Git worktree per task:** Đây là quyết định quan trọng nhất. Mỗi task có isolation riêng, merge conflict được phát hiện muộn nhất ở merge step thay vì trong quá trình dev.
- **Atomic gate approval transaction:** `prisma.$transaction([gate.update, sprint.update])` — ngăn race condition đúng cách.
- **setImmediate cho async operations:** Tất cả step execution đều dùng `setImmediate` — HTTP response trả về ngay, pipeline chạy async. Pattern đúng.
- **Graceful degradation trong QA Layer 2:** Nếu Claude call fail → treat as passed, tiếp tục Layer 3. Không để lỗi AI crash toàn bộ QA.

### Thiếu sót đáng ngạc nhiên
- **Không có integration test nào** dù codebase phức tạp (step 0-6, merge, retry, resume...).
- **`architect` schema trong outputParser hoàn toàn không validate các fields từ IMP-01/02/04** dù 3 improvements này đều dựa vào Architect output. Đây là silent failure risk cao.

---

## PHẦN 5 — KHUYẾN NGHỊ THEO THỨ TỰ ƯU TIÊN

### Sprint tiếp theo nên làm (1 tuần)
1. **Fix outputParser architect schema** — thêm tcrUpdate, contextIndexUpdate, zoneClassification, breakingChanges; làm masterMdUpdate optional
2. **Fix Reject Gate flow** — sau khi PO reject, nếu gate là 1/2/3 thì auto re-run step tương ứng với poComment làm additional context cho Claude
3. **Gate Notes Markdown Renderer** — thay `<pre>` bằng react-markdown component; hiển thị gaps, blockers, breaking changes như UI components

### Sprint sau đó (2 tuần)
4. **Migrate SQLite → PostgreSQL** — low effort với Prisma, high impact cho reliability
5. **Sprint Dashboard KPI** — thêm "current active sprint" widget trên Dashboard
6. **Fix architect schema mismatch** — align outputParser với promptBuilder output

### Backlog dài hạn
7. Tách pipelineRunner.js thành modules
8. Thêm integration tests cho critical paths
9. Observability: log average sprint duration, Claude call success rate, token usage
10. Multi-user auth — ai approve, khi nào, tại sao

---

*Báo cáo này dựa trên đọc toàn bộ source code thực tế. Không dựa trên spec hay tài liệu.*

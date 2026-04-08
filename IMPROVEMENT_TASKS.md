# AI Dev Pipeline — Improvement Tasks (Phase 2)
> Nguồn: Phân tích so sánh với AI-Dev-Framework-Team.docx
> Dành cho Claude Code (VSCode). Implement theo thứ tự từ IMP-01 đến IMP-05.
> Đọc kỹ từng task — mỗi task có đủ context, file cần sửa, code mẫu, và verification.

---

## TỔNG QUAN 5 IMPROVEMENTS

| Task | Tên | Tác động | Effort |
|------|-----|----------|--------|
| IMP-01 | Zone System — bảo vệ file quan trọng | Cao | Thấp |
| IMP-02 | TCR Structure — thay thế MASTER.md monolithic | Cao | Trung bình |
| IMP-03 | Reception Report — Gate trước Architect | Cao | Trung bình |
| IMP-04 | Breaking Change Registry | Trung bình | Thấp |
| IMP-05 | 3-Layer QA — tách Quality Gate thành 3 lớp | Trung bình | Trung bình |

---

## IMP-01 — Zone System: Bảo vệ file khỏi Developer Agent

### Mục tiêu
Developer Agent hiện tại có thể sửa bất kỳ file nào trong repo. Cần phân loại file theo 3 zone: Frozen (không được sửa), Guarded (được sửa nhưng phải giải thích), Fluid (tự do). Architect tạo zone-classification khi thiết kế sprint. Developer Agent đọc và tuân thủ.

### Cơ chế hoạt động sau khi implement
1. Sprint bắt đầu → Architect thiết kế kiến trúc VÀ tạo `docs/zone-classification.md`
2. Developer Agent đọc zone-classification trước khi code
3. Nếu task spec yêu cầu sửa Frozen file → Agent từ chối và báo cáo conflict
4. Nếu sửa Guarded file → Agent phải giải thích lý do trong devReport

---

### Bước 1: Tạo file template `docs/zone-classification.md` cho project mới

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Thêm method `_getZoneClassification()` vào class `PromptBuilder`:

```js
_getZoneClassification() {
  const p = path.join(this.projectPath, 'docs', 'zone-classification.md');
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8');
}
```

---

### Bước 2: Bổ sung Zone Classification vào Architect output

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Sửa `buildArchitectPrompt` — thêm yêu cầu output `zoneClassification` vào JSON schema:

```js
buildArchitectPrompt({ requirement, sprintNumber }) {
  const master = this._getMaster();
  const existingZones = this._getZoneClassification();

  return `## SYSTEM CONTEXT
${master}

${existingZones ? `## ZONE CLASSIFICATION HIỆN TẠI\n${existingZones}\n\nCập nhật nếu sprint này thêm files quan trọng mới.` : '## ZONE CLASSIFICATION\nChưa có — tạo mới cho project này.'}

## TASK
Bạn là System Architect. Phân tích yêu cầu sau và thiết kế kiến trúc cho Sprint #${sprintNumber}.

## REQUIREMENT FROM PRODUCT OWNER
${requirement}

## OUTPUT FORMAT
Trả về JSON object theo schema sau. KHÔNG viết gì ngoài JSON block.

\`\`\`json
{
  "analysis": "string — tóm tắt yêu cầu và assumptions",
  "architectureOverview": "string — mô tả kiến trúc, components thêm/sửa",
  "features": [
    {
      "id": "FEAT-001",
      "name": "string",
      "description": "string — 1-2 câu",
      "priority": "high|medium|low"
    }
  ],
  "techDecisions": ["string — quyết định kỹ thuật 1", "string 2"],
  "risks": ["string — rủi ro 1"],
  "masterMdUpdate": "string — nội dung đầy đủ của MASTER.md sau sprint này (markdown)",
  "estimatedTasks": 0,
  "zoneClassification": {
    "frozen": [
      {
        "path": "string — file hoặc glob pattern, ví dụ: src/auth/**",
        "reason": "string — tại sao không được sửa"
      }
    ],
    "guarded": [
      {
        "path": "string — file hoặc glob pattern",
        "reason": "string — tại sao cần cẩn thận khi sửa"
      }
    ],
    "fluid": "string — mô tả tổng quát files nào là fluid (thường là implementation details)"
  }
}
\`\`\`

QUY TẮC ZONE:
- FROZEN: auth logic, shared events/interfaces, core infra, database schema, security boundary
- GUARDED: business logic quan trọng, shared models, cross-module interfaces
- FLUID: UI components, utility functions, helper modules, log format, tests`;
}
```

---

### Bước 3: Ghi zone-classification.md sau Step 1

**File:** `packages/backend/src/services/orchestrator/pipelineRunner.js`

Trong hàm `_step1_Architect`, sau đoạn ghi MASTER.md (khoảng dòng 187), thêm:

```js
// Ghi zone-classification.md nếu architect trả về
if (parsed.data?.zoneClassification) {
  const zonePath = path.join(project.repoPath, 'docs', 'zone-classification.md');
  try {
    const { frozen = [], guarded = [], fluid = '' } = parsed.data.zoneClassification;

    const zoneContent = `# Zone Classification — Sprint #${number}
> Được tạo bởi Architect AI. Developer Agent phải đọc file này trước khi code.
> Cập nhật lần cuối: Sprint #${number}

## 🔴 FROZEN — KHÔNG được sửa
${frozen.length === 0
  ? '_Không có file nào trong sprint này_'
  : frozen.map(z => `- \`${z.path}\` — ${z.reason}`).join('\n')}

## 🟡 GUARDED — Được sửa nhưng PHẢI giải thích lý do
${guarded.length === 0
  ? '_Không có file nào trong sprint này_'
  : guarded.map(z => `- \`${z.path}\` — ${z.reason}`).join('\n')}

## 🟢 FLUID — Tự do implement trong boundary module
${fluid || 'Implementation details, UI components, utilities, tests'}
`;

    await fs.mkdir(path.join(project.repoPath, 'docs'), { recursive: true });
    await fs.writeFile(zonePath, zoneContent, 'utf8');
    logger.info({ sprintId, zonePath }, 'zone-classification.md updated');
  } catch (zoneErr) {
    logger.warn({ sprintId, error: zoneErr.message }, 'Failed to write zone-classification.md — continuing');
  }
}
```

---

### Bước 4: Developer Agent đọc và tuân thủ zone-classification

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Sửa `buildDeveloperPrompt` — thêm zone classification vào context:

```js
buildDeveloperPrompt({ task, masterContext, conventions, repoInfo }) {
  const zoneClassification = this._getZoneClassification();

  return `## SYSTEM CONTEXT
${masterContext}
${conventions ? `\n## CODING CONVENTIONS\n${conventions}` : ''}

${zoneClassification ? `## ⚠️ ZONE CLASSIFICATION — ĐỌC TRƯỚC KHI CODE
${zoneClassification}

RULES BẮT BUỘC:
- 🔴 FROZEN: TUYỆT ĐỐI không sửa file nào trong danh sách Frozen. Nếu task yêu cầu sửa → báo CONFLICT trong devReport, không implement.
- 🟡 GUARDED: Được sửa nhưng PHẢI ghi rõ lý do trong field "deviations" của output.
- 🟢 FLUID: Tự do implement trong boundary của task spec.
` : ''}
## REPO INFO
${repoInfo}

## YOUR TASK
${JSON.stringify(task, null, 2)}

## YOUR ROLE
Bạn là Developer Agent. Implement CHÍNH XÁC theo spec. Không thêm, không sáng tạo ngoài scope.

## PROCESS (theo thứ tự BẮT BUỘC)
1. Đọc zone-classification.md (đã có ở trên) — identify files nào cần đặc biệt chú ý
2. git status — verify branch đúng
3. Đọc tất cả files liên quan trước khi code
4. Implement từng file theo spec
5. Sau mỗi file: chạy node --check <file> để check syntax
6. git add + git commit -m "feat(${task.taskId}): ${task.title}"
7. Output JSON report

## OUTPUT FORMAT (bắt buộc ở cuối response)
\`\`\`json
{
  "taskId": "${task.taskId}",
  "status": "DONE|CONFLICT",
  "branch": "feat/${task.taskId.toLowerCase()}",
  "filesCreated": [{ "path": "string", "lines": 0 }],
  "filesModified": [{ "path": "string", "description": "string", "zone": "guarded|fluid" }],
  "frozenViolationAttempts": [],
  "guardedFilesModified": [{ "path": "string", "reason": "string — tại sao cần sửa Guarded file" }],
  "interfacesImplemented": ["functionName(params): ReturnType"],
  "syntaxCheckResults": [{ "file": "string", "passed": true }],
  "gitCommitHash": "string hoặc null nếu CONFLICT",
  "deviations": [],
  "notes": "string hoặc null"
}
\`\`\`

STATUS = "CONFLICT" khi:
- Task spec yêu cầu sửa Frozen file → không implement, báo conflict`;
}
```

---

### Bước 5: Reviewer kiểm tra zone compliance

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Sửa `buildReviewPrompt` — thêm zone compliance check vào checklist:

```js
buildReviewPrompt({ task, devOutput, gitDiff, validationResult }) {
  const master = this._getMaster();
  const zoneClassification = this._getZoneClassification();

  return `## SYSTEM CONTEXT
${master}

${zoneClassification ? `## ZONE CLASSIFICATION\n${zoneClassification}\n` : ''}
## TASK SPEC
${JSON.stringify(task, null, 2)}

## DEVELOPER REPORT
${JSON.stringify(devOutput, null, 2)}

## DETERMINISTIC VALIDATION RESULTS
${JSON.stringify(validationResult, null, 2)}

## GIT DIFF
\`\`\`diff
${gitDiff.substring(0, 8000)}
\`\`\`
${gitDiff.length > 8000 ? '\n[Diff truncated — only first 8000 chars shown]' : ''}

## TASK
Review code thực tế. Tập trung vào:
- Logic có đúng với spec không?
- Interface exposed có đúng với spec không?
- Có vi phạm zone classification không? (sửa Frozen file là CRITICAL)
- Có side effects ngoài scope không?

## OUTPUT FORMAT
\`\`\`json
{
  "taskId": "${task.taskId}",
  "verdict": "PASS|FAIL|PASS_WITH_NOTES",
  "checklist": [
    { "item": "Chỉ sửa files trong spec", "passed": true },
    { "item": "Không vi phạm Frozen zone", "passed": true },
    { "item": "Guarded files được sửa có lý do", "passed": true },
    { "item": "Interface đúng với spec", "passed": true },
    { "item": "Logic đúng với business requirements", "passed": true },
    { "item": "Không có side effects ngoài scope", "passed": true }
  ],
  "issues": [
    { "severity": "critical|major|minor", "file": "string", "description": "string", "fix": "string" }
  ],
  "zoneViolations": [
    { "zone": "frozen|guarded", "file": "string", "description": "string" }
  ],
  "notesForPO": "string hoặc null",
  "regressionRisk": "low|medium|high",
  "regressionRiskReason": "string"
}
\`\`\``;
}
```

**Verification IMP-01:**
- Chạy sprint mới, sau Step 1: kiểm tra `<repoPath>/docs/zone-classification.md` được tạo
- Kiểm tra Developer Agent prompt trong AgentLog có section "ZONE CLASSIFICATION"
- Nếu task yêu cầu sửa Frozen file: devReport phải có `"status": "CONFLICT"`, không có gitCommitHash

---

## IMP-02 — TCR Structure: Thay thế MASTER.md monolithic

### Mục tiêu
MASTER.md hiện tại là file bị ghi đè toàn bộ mỗi sprint. Với project lớn, file ngày càng phình ra → tốn token, khó maintain. Thay bằng cấu trúc TCR (Task Completion Report) từ framework: mỗi sprint chỉ append một snapshot nhỏ, `docs/context/index.md` là bộ nhớ nén ~100 dòng để load nhanh.

### Cấu trúc file mới sau implement

```
docs/
├── context/
│   ├── index.md          ← Agent đọc đầu tiên (~100 dòng, summary toàn project)
│   └── project-brief.md  ← Stable info: tech stack, conventions, module list
├── tcr/
│   ├── _index.md         ← Danh sách tất cả TCRs (50 dòng)
│   └── sprint-N/
│       └── TCR-sprint-N.md  ← TCR của sprint N
└── zone-classification.md  ← Từ IMP-01
```

---

### Bước 1: Sửa Architect output để tạo TCR thay vì ghi lại MASTER.md

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Sửa `buildArchitectPrompt` — thay field `masterMdUpdate` bằng `tcrUpdate` và `contextIndexUpdate`:

```js
// Trong JSON schema của buildArchitectPrompt, thay:
// "masterMdUpdate": "string — nội dung đầy đủ MASTER.md"
// Bằng:

"tcrUpdate": {
  "summary": "string — 3-5 dòng: sprint này làm gì, quyết định gì",
  "decisions": ["string — quyết định kỹ thuật quan trọng"],
  "filesChanged": ["string — pattern files sẽ được tạo/sửa"],
  "nextSprintContext": "string — thông tin quan trọng cho sprint sau cần biết"
},
"contextIndexUpdate": "string — đoạn text cập nhật vào docs/context/index.md (markdown, tối đa 30 dòng về sprint này)"
```

---

### Bước 2: Sửa pipelineRunner để ghi TCR thay vì MASTER.md

**File:** `packages/backend/src/services/orchestrator/pipelineRunner.js`

Tìm đoạn ghi MASTER.md trong `_step1_Architect` (khoảng dòng 177-187). Thay toàn bộ bằng:

```js
// Ghi TCR cho sprint này
if (parsed.data?.tcrUpdate || parsed.data?.contextIndexUpdate) {
  try {
    const tcrDir = path.join(project.repoPath, 'docs', 'tcr', `sprint-${number}`);
    const tcrIndexDir = path.join(project.repoPath, 'docs', 'tcr');
    const contextDir = path.join(project.repoPath, 'docs', 'context');

    await fs.mkdir(tcrDir, { recursive: true });
    await fs.mkdir(contextDir, { recursive: true });

    // 1. Ghi TCR-sprint-N.md
    if (parsed.data.tcrUpdate) {
      const { summary, decisions = [], filesChanged = [], nextSprintContext } = parsed.data.tcrUpdate;
      const tcrContent = `# TCR — Sprint #${number}
Date: ${new Date().toISOString().split('T')[0]} | Status: In Progress

## Tóm tắt
${summary}

## Quyết định kỹ thuật
${decisions.map(d => `- ${d}`).join('\n') || '_Không có_'}

## Files dự kiến thay đổi
${filesChanged.map(f => `- ${f}`).join('\n') || '_Xem task specs_'}

## Phiên sau cần biết
${nextSprintContext || '_Cập nhật sau khi sprint hoàn thành_'}
`;
      const tcrPath = path.join(tcrDir, `TCR-sprint-${number}.md`);
      await fs.writeFile(tcrPath, tcrContent, 'utf8');
      logger.info({ sprintId, tcrPath }, 'TCR created for sprint');
    }

    // 2. Cập nhật TCR _index.md
    const tcrIndexPath = path.join(tcrIndexDir, '_index.md');
    let tcrIndex = '';
    try { tcrIndex = await fs.readFile(tcrIndexPath, 'utf8'); } catch { tcrIndex = '# TCR Index\n\n'; }

    const newEntry = `- [Sprint #${number}](sprint-${number}/TCR-sprint-${number}.md) — ${new Date().toISOString().split('T')[0]}: ${(parsed.data.tcrUpdate?.summary || '').split('\n')[0].substring(0, 80)}\n`;
    if (!tcrIndex.includes(`Sprint #${number}`)) {
      tcrIndex += newEntry;
      await fs.writeFile(tcrIndexPath, tcrIndex, 'utf8');
    }

    // 3. Cập nhật context/index.md
    if (parsed.data.contextIndexUpdate) {
      const contextIndexPath = path.join(contextDir, 'index.md');
      let contextIndex = '';
      try { contextIndex = await fs.readFile(contextIndexPath, 'utf8'); } catch {
        contextIndex = `# Project Context Index\n> Load file này đầu tiên mỗi phiên làm việc.\n\n`;
      }

      // Append sprint context block
      const sprintBlock = `\n## Sprint #${number} (${new Date().toISOString().split('T')[0]})\n${parsed.data.contextIndexUpdate}\n`;
      if (!contextIndex.includes(`## Sprint #${number}`)) {
        contextIndex += sprintBlock;
        // Giữ index ngắn gọn — chỉ giữ 10 sprints gần nhất
        const lines = contextIndex.split('\n');
        if (lines.length > 200) {
          // Trim older content
          const headerLines = lines.slice(0, 3);
          const recentLines = lines.slice(-150);
          contextIndex = [...headerLines, '_(older sprints truncated)_', ...recentLines].join('\n');
        }
        await fs.writeFile(contextIndexPath, contextIndex, 'utf8');
      }
    }

    logger.info({ sprintId, sprintNumber: number }, 'TCR structure updated');
  } catch (tcrErr) {
    logger.warn({ sprintId, error: tcrErr.message }, 'Failed to write TCR — continuing');
  }
}

// Backward compatibility: vẫn ghi MASTER.md nếu có masterMdUpdate
if (parsed.data?.masterMdUpdate) {
  const masterPath = path.join(project.repoPath, 'docs', 'MASTER.md');
  try {
    await fs.mkdir(path.join(project.repoPath, 'docs'), { recursive: true });
    await fs.writeFile(masterPath, parsed.data.masterMdUpdate, 'utf8');
    logger.info({ sprintId, masterPath }, 'MASTER.md updated (legacy)');
  } catch (writeErr) {
    logger.warn({ sprintId, error: writeErr.message }, 'Failed to write MASTER.md — continuing');
  }
}
```

---

### Bước 3: Sửa PromptBuilder để load context theo thứ tự tối ưu

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Thêm method `_getOptimizedContext()` để thay thế `_getMaster()` trong các bước nặng:

```js
/**
 * Load context theo thứ tự tối ưu — thay thế _getMaster() monolithic.
 * Load order: context/index.md → tcr/_index.md → tcr/sprint-N/TCR-sprint-N.md
 * Tổng ~150-300 dòng thay vì full MASTER.md
 */
_getOptimizedContext(currentSprintNumber = null) {
  const parts = [];

  // 1. project-brief.md — stable info (tech stack, conventions)
  const briefPath = path.join(this.projectPath, 'docs', 'context', 'project-brief.md');
  if (existsSync(briefPath)) {
    parts.push('## PROJECT BRIEF\n' + readFileSync(briefPath, 'utf-8'));
  }

  // 2. context/index.md — running summary
  const indexPath = path.join(this.projectPath, 'docs', 'context', 'index.md');
  if (existsSync(indexPath)) {
    parts.push('## PROJECT CONTEXT\n' + readFileSync(indexPath, 'utf-8'));
  } else {
    // Fallback to MASTER.md nếu chưa migrate
    const masterPath = path.join(this.projectPath, 'docs', 'MASTER.md');
    if (existsSync(masterPath)) {
      parts.push('## MASTER CONTEXT\n' + readFileSync(masterPath, 'utf-8'));
    }
  }

  // 3. TCR của sprint trước (nếu có)
  if (currentSprintNumber && currentSprintNumber > 1) {
    const prevSprint = currentSprintNumber - 1;
    const prevTcrPath = path.join(
      this.projectPath, 'docs', 'tcr',
      `sprint-${prevSprint}`, `TCR-sprint-${prevSprint}.md`
    );
    if (existsSync(prevTcrPath)) {
      parts.push(`## TCR SPRINT #${prevSprint} (sprint trước)\n` + readFileSync(prevTcrPath, 'utf-8'));
    }
  }

  return parts.join('\n\n') || '# Project Context\n[Sprint đầu tiên — chưa có context]\n';
}
```

Sau đó sửa `buildDeveloperPrompt` và `buildReviewPrompt` để dùng `_getOptimizedContext` thay vì `_getMaster`:

```js
// Trong buildDeveloperPrompt — thêm sprintNumber vào params:
buildDeveloperPrompt({ task, masterContext, conventions, repoInfo, sprintNumber }) {
  // masterContext được truyền vào từ pipelineRunner — đã là optimized context
  // ...
}
```

Và trong `pipelineRunner.js`, khi gọi `buildDeveloperPrompt`, truyền optimized context:

```js
// Trong _executeTask hoặc _step4_DeveloperAgents:
const builder = new PromptBuilder(project.repoPath, { sprintNumber: sprint.number });
const masterContext = builder._getOptimizedContext(sprint.number);
// ...
const prompt = builder.buildDeveloperPrompt({ task: taskSpec, masterContext, conventions, repoInfo, sprintNumber: sprint.number });
```

**Verification IMP-02:**
- Sau Step 1: kiểm tra `docs/tcr/sprint-1/TCR-sprint-1.md` được tạo
- Kiểm tra `docs/tcr/_index.md` có entry cho sprint 1
- Kiểm tra `docs/context/index.md` được tạo/cập nhật
- Developer Agent log trong AgentLog: không còn full MASTER.md, thay bằng context ngắn hơn

---

## IMP-03 — Reception Report: Gate kiểm tra requirement trước Architect

### Mục tiêu
Hiện tại requirement được đưa thẳng vào Architect mà không qua bước kiểm tra. Nếu requirement mơ hồ, Architect thiết kế sai → waste toàn bộ Step 1-3. Thêm "Gate 0.5" (Step 0 trong pipeline): Claude audit requirement, output Reception Report, PO review trước khi Architect bắt đầu.

### Cơ chế sau khi implement
1. PO tạo sprint với requirement text/file
2. **[MỚI]** Step 0: Claude đọc requirement → output Reception Report (gaps, conflicts, assumptions, risks)
3. Gate 0 hiển thị Reception Report → PO review và approve/reject
4. Nếu approve → Step 1 Architect bắt đầu (như cũ)
5. Nếu reject + feedback → PO sửa requirement và restart

---

### Bước 1: Thêm `buildReceptionPrompt` vào PromptBuilder

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Thêm method mới vào class `PromptBuilder`:

```js
// ─── STEP 0: RECEPTION REPORT ───────────────────────────────────────────────
buildReceptionPrompt({ requirement, sprintNumber, projectContext }) {
  return `## PROJECT CONTEXT
${projectContext || '# Project\n[Chưa có context — sprint đầu tiên]'}

## TASK
Bạn là Requirements Analyst. Audit yêu cầu sau từ Product Owner trước khi giao cho Architect.
Sprint #${sprintNumber}

## REQUIREMENT FROM PRODUCT OWNER
${requirement}

## OUTPUT FORMAT
\`\`\`json
{
  "requirementSummary": "string — tóm tắt yêu cầu bằng ngôn ngữ kỹ thuật (3-5 câu)",
  "gaps": [
    {
      "area": "string — ví dụ: Authentication, Error handling, Pagination",
      "description": "string — điều gì chưa được đề cập",
      "severity": "blocking|important|minor",
      "suggestedClarification": "string — câu hỏi cụ thể để hỏi PO"
    }
  ],
  "conflicts": [
    {
      "description": "string — mâu thuẫn hoặc ambiguous",
      "option1": "string — cách hiểu 1",
      "option2": "string — cách hiểu 2"
    }
  ],
  "assumptions": [
    {
      "assumption": "string — điều Agent đang giả định",
      "risk": "low|medium|high — nếu assumption sai thì thiệt hại thế nào"
    }
  ],
  "techStackRisks": [
    {
      "description": "string — rủi ro kỹ thuật",
      "recommendation": "string"
    }
  ],
  "estimatedComplexity": "simple|medium|complex",
  "estimatedSprints": 1,
  "readyToProceed": true,
  "blockers": ["string — lý do blocking nếu readyToProceed = false"]
}
\`\`\`

QUAN TRỌNG:
- Nếu có gap BLOCKING → readyToProceed = false, liệt kê vào blockers
- Nếu requirement đủ rõ → readyToProceed = true, có thể có gaps minor
- Đừng assume những gì không được đề cập — flag rõ`;
}
```

---

### Bước 2: Thêm Step 0 vào PipelineRunner

**File:** `packages/backend/src/services/orchestrator/pipelineRunner.js`

Thêm method `_step0_Reception` vào class `PipelineRunner` (thêm trước `_step1_Architect`):

```js
// ─── STEP 0: RECEPTION REPORT ──────────────────────────────────────────────

async _step0_Reception(sprint) {
  const { id: sprintId, project, requirementText, requirementFile, number } = sprint;
  logger.info({ sprintId, step: 0 }, 'Step 0: Reception Report');
  await this._lock(sprintId, 0);

  try {
    let requirement = requirementText || '';
    if (requirementFile) {
      const { extractText } = await import('../fileService.js');
      const { extractedText } = await extractText(requirementFile);
      requirement += `\n\n[File content]:\n${extractedText}`;
    }

    const builder = new PromptBuilder(project.repoPath);
    const projectContext = builder._getOptimizedContext(number);
    const prompt = builder.buildReceptionPrompt({ requirement, sprintNumber: number, projectContext });

    const result = await runClaudeWithRetry({ prompt, tools: [], cwd: project.repoPath, sprintId });
    if (!result.success) throw new Error(`Reception step failed: ${result.error}`);

    const parsed = parseClaudeOutput(result.output, 'reception');

    // Format notes cho PO
    const notesForPO = formatReceptionForPO(parsed.success ? parsed.data : {}, result.output);

    // Update Gate 0 notes
    await prisma.gate.update({
      where: { sprintId_gateNumber: { sprintId, gateNumber: 0 } },
      data: { notes: notesForPO },
    });

    const gate0Rec = await prisma.gate.findUnique({
      where: { sprintId_gateNumber: { sprintId, gateNumber: 0 } },
      select: { id: true },
    });

    const hasBlockers = parsed.success && parsed.data?.readyToProceed === false;

    await this.orch.notif.send({
      projectId: project.id,
      sprintId,
      type: 'gate_waiting',
      title: hasBlockers ? '⚠️ Reception Report — Có vấn đề cần làm rõ' : '✅ Reception Report — Requirement đủ rõ',
      message: `Sprint #${number}: ${hasBlockers ? `${parsed.data.blockers?.length || 0} blocker(s) cần clarify trước khi thiết kế` : 'Gate 0 waiting for approval'}`,
      payload: { gateId: gate0Rec?.id },
    });

    await this._setGateWaiting(sprintId, 0, notesForPO);
    this.orch._emit('sprint:updated', { sprintId, currentGateNumber: 0 });

    logger.info({ sprintId, readyToProceed: parsed.data?.readyToProceed }, 'Step 0 completed');
  } catch (err) {
    await this._unlock(sprintId);
    throw err;
  }
}
```

Thêm helper `formatReceptionForPO` ở cuối file (phần FORMAT HELPERS):

```js
function formatReceptionForPO(data, rawOutput) {
  if (!data || Object.keys(data).length === 0) {
    return `## Reception Report\n\`\`\`\n${rawOutput.substring(0, 2000)}\n\`\`\``;
  }

  const { requirementSummary, gaps = [], conflicts = [], assumptions = [], readyToProceed, blockers = [], estimatedComplexity } = data;

  const blockingGaps = gaps.filter(g => g.severity === 'blocking');
  const importantGaps = gaps.filter(g => g.severity === 'important');
  const minorGaps = gaps.filter(g => g.severity === 'minor');

  let notes = `## Reception Report — Sprint\n`;
  notes += `**Status:** ${readyToProceed ? '✅ Ready to proceed' : '🚫 Cần clarify trước'}\n`;
  notes += `**Complexity:** ${estimatedComplexity || 'unknown'}\n\n`;

  notes += `### Tóm tắt requirement\n${requirementSummary || '_Parse error_'}\n\n`;

  if (blockers.length > 0) {
    notes += `### 🚫 Blockers (phải giải quyết trước khi approve)\n`;
    blockers.forEach(b => { notes += `- ${b}\n`; });
    notes += '\n';
  }

  if (blockingGaps.length > 0) {
    notes += `### ❌ Gaps cần làm rõ\n`;
    blockingGaps.forEach(g => {
      notes += `- **${g.area}**: ${g.description}\n  _Hỏi: ${g.suggestedClarification}_\n`;
    });
    notes += '\n';
  }

  if (conflicts.length > 0) {
    notes += `### ⚠️ Mâu thuẫn / Ambiguous\n`;
    conflicts.forEach(c => {
      notes += `- ${c.description}\n  Option A: ${c.option1}\n  Option B: ${c.option2}\n`;
    });
    notes += '\n';
  }

  if (importantGaps.length > 0) {
    notes += `### 🟡 Gaps quan trọng (nên clarify)\n`;
    importantGaps.forEach(g => { notes += `- **${g.area}**: ${g.description}\n`; });
    notes += '\n';
  }

  if (assumptions.length > 0) {
    notes += `### 💭 Assumptions\n`;
    assumptions.forEach(a => { notes += `- [${a.risk.toUpperCase()}] ${a.assumption}\n`; });
    notes += '\n';
  }

  if (minorGaps.length > 0) {
    notes += `### ℹ️ Minor gaps (có thể bỏ qua)\n`;
    minorGaps.forEach(g => { notes += `- **${g.area}**: ${g.description}\n`; });
  }

  notes += `\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  return notes;
}
```

---

### Bước 3: Thêm schema validation cho reception output

**File:** `packages/backend/src/services/claude/outputParser.js`

Tìm object `SCHEMAS` và thêm schema cho `reception`:

```js
reception: z.object({
  requirementSummary: z.string(),
  gaps: z.array(z.object({
    area: z.string(),
    description: z.string(),
    severity: z.enum(['blocking', 'important', 'minor']),
    suggestedClarification: z.string().optional(),
  })).default([]),
  conflicts: z.array(z.object({
    description: z.string(),
    option1: z.string(),
    option2: z.string(),
  })).default([]),
  assumptions: z.array(z.object({
    assumption: z.string(),
    risk: z.enum(['low', 'medium', 'high']),
  })).default([]),
  techStackRisks: z.array(z.object({
    description: z.string(),
    recommendation: z.string(),
  })).default([]),
  estimatedComplexity: z.enum(['simple', 'medium', 'complex']).default('medium'),
  estimatedSprints: z.number().default(1),
  readyToProceed: z.boolean().default(true),
  blockers: z.array(z.string()).default([]),
}),
```

---

### Bước 4: Kết nối Step 0 vào Gate flow

**File:** `packages/backend/src/services/orchestrator/stateMachine.js`

Kiểm tra `GATE_TO_STEP` mapping. Gate 0 hiện tại trigger Step 1. Cần thêm một "Step 0" trước đó.

```js
// Xem nội dung stateMachine.js hiện tại và adjust GATE_TO_STEP:
// Cách đơn giản: không thay đổi Gate numbering
// Thay vào đó: khi sprint được TẠO MỚI (status = pending),
// tự động trigger Step 0 thay vì chờ Gate 0 approve

// Trong orchestrator/index.js, khi sprint được tạo:
// Thay vì chờ Gate 0 approve để bắt đầu,
// trigger Step 0 ngay khi sprint created
```

**File:** `packages/backend/src/controllers/sprintController.js`

Tìm endpoint tạo sprint (POST). Sau khi tạo sprint thành công, trigger Step 0:

```js
// Trong createSprint, sau khi tạo sprint:
// Hiện tại: trả về sprint và chờ PO approve Gate 0
// Mới: trigger Step 0 Reception ngay lập tức (async)

const orchestrator = req.app.get('orchestrator');
setImmediate(async () => {
  try {
    const fullSprint = await prisma.sprint.findUnique({
      where: { id: sprint.id },
      include: { project: true, gates: true },
    });
    await orchestrator.runner._step0_Reception(fullSprint);
  } catch (err) {
    logger.error({ err, sprintId: sprint.id }, 'Step 0 Reception failed on sprint create');
  }
});
```

> **Lưu ý:** Đọc kỹ `sprintController.js` hiện tại trước khi sửa. Đảm bảo sprint có gates được include, và Gate 0 đã được seed khi tạo sprint.

**Verification IMP-03:**
- Tạo sprint mới → ngay lập tức backend log "Step 0: Reception Report"
- Gate 0 trên frontend/Telegram hiển thị Reception Report với gaps, conflicts, assumptions
- Nếu requirement có blocking gap: Gate 0 title là "⚠️ Reception Report — Có vấn đề cần làm rõ"
- Approve Gate 0 → Step 1 Architect bắt đầu bình thường

---

## IMP-04 — Breaking Change Registry

### Mục tiêu
Khi nhiều sprint chạy liên tiếp, một sprint có thể thay đổi interface/API khiến sprint sau bị break mà không ai biết cho đến khi merge fail. Breaking Change Registry là file `docs/contracts/breaking-changes.md` được cập nhật sau mỗi sprint complete.

---

### Bước 1: Tạo `_getBreakingChanges()` trong PromptBuilder

**File:** `packages/backend/src/services/claude/promptBuilder.js`

```js
_getBreakingChanges() {
  const p = path.join(this.projectPath, 'docs', 'contracts', 'breaking-changes.md');
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8');
}
```

---

### Bước 2: Bổ sung breaking change detection vào Architect output

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Trong `buildArchitectPrompt` JSON schema, thêm field:

```json
"breakingChanges": [
  {
    "type": "api_change|schema_change|interface_change|behavior_change",
    "description": "string — thay đổi gì",
    "affectedModules": ["string — module/file bị ảnh hưởng"],
    "migrationRequired": true,
    "migrationNotes": "string — cần làm gì để migrate"
  }
]
```

Và trong prompt, thêm context về breaking changes cũ:

```js
const existingBC = this._getBreakingChanges();
// Thêm vào prompt:
${existingBC ? `## BREAKING CHANGES REGISTRY (các thay đổi breaking của sprints trước)\n${existingBC}\n\nKiểm tra: sprint này có conflict với bất kỳ breaking change nào không?` : ''}
```

---

### Bước 3: Ghi Breaking Change Registry sau mỗi sprint merge thành công

**File:** `packages/backend/src/services/orchestrator/pipelineRunner.js`

Tìm hàm `runMerge`. Sau khi merge thành công (trước `await wtManager.pruneAll()`), thêm:

```js
// Ghi breaking changes vào registry
try {
  const gate1 = await prisma.gate.findUnique({
    where: { sprintId_gateNumber: { sprintId, gateNumber: 1 } },
    select: { notes: true },
  });

  const architectData = extractJSONFromNotes(gate1?.notes);
  const breakingChanges = architectData?.breakingChanges || [];

  if (breakingChanges.length > 0) {
    const bcDir = path.join(project.repoPath, 'docs', 'contracts');
    const bcPath = path.join(bcDir, 'breaking-changes.md');

    await fs.mkdir(bcDir, { recursive: true });

    let existing = '';
    try { existing = await fs.readFile(bcPath, 'utf8'); } catch {
      existing = `# Breaking Change Registry\n> Tự động cập nhật sau mỗi sprint.\n\n`;
    }

    const newEntries = breakingChanges.map(bc => `
### Sprint #${sprint.number} — ${new Date().toISOString().split('T')[0]}
- **Type:** ${bc.type}
- **Description:** ${bc.description}
- **Affected:** ${(bc.affectedModules || []).join(', ')}
- **Migration:** ${bc.migrationRequired ? `⚠️ Required — ${bc.migrationNotes}` : 'Not required'}
`).join('\n');

    await fs.writeFile(bcPath, existing + newEntries, 'utf8');
    logger.info({ sprintId, count: breakingChanges.length }, 'Breaking changes logged');
  }
} catch (bcErr) {
  logger.warn({ sprintId, error: bcErr.message }, 'Failed to log breaking changes — continuing');
}
```

---

### Bước 4: Hiển thị breaking changes từ sprint trước trong Gate 1

**File:** `packages/backend/src/services/orchestrator/pipelineRunner.js`

Trong `_step1_Architect`, thêm vào `formatArchitectForPO`:

```js
// Trong formatArchitectForPO, thêm section:
function formatArchitectForPO(data) {
  let notes = `## Architecture Design\n`;
  // ... (giữ nguyên phần hiện có)

  // Thêm section Breaking Changes
  if (data.breakingChanges && data.breakingChanges.length > 0) {
    notes += `\n### ⚠️ Breaking Changes trong Sprint này\n`;
    data.breakingChanges.forEach(bc => {
      notes += `- **[${bc.type}]** ${bc.description}`;
      if (bc.migrationRequired) notes += ` — ⚠️ Migration required`;
      notes += '\n';
    });
  }

  // ... (phần JSON ở cuối)
  return notes;
}
```

**Verification IMP-04:**
- Chạy sprint có thay đổi API/interface → sau merge, kiểm tra `docs/contracts/breaking-changes.md` được tạo
- Sprint kế tiếp: Architect prompt có section "BREAKING CHANGES REGISTRY"
- Gate 1 notes của sprint kế tiếp hiển thị breaking changes từ sprint trước

---

## IMP-05 — 3-Layer QA: Tách Quality Gate thành 3 lớp

### Mục tiêu
QA hiện tại (Step 5) là một bước Claude review tổng hợp. Theo framework, Quality Gate nên có 3 lớp độc lập: Automated (chạy tự động) → Contract Check (zone compliance, interface) → Business Rule (human review). Lớp trước fail thì không chạy lớp sau.

### Cơ chế sau khi implement
```
Step 5 QA = 3 sub-steps:
  5a. Automated Layer — chạy tests, lint, check circular dependency
      → Nếu fail: báo PO ngay, không chạy 5b
  5b. Contract Layer — Claude kiểm tra zone violations, interface integrity
      → Nếu có vi phạm critical: báo PO, không chạy 5c
  5c. Business Layer — Claude review business rules, edge cases, QA report cho PO
      → Output: QA Final Report như hiện tại
```

---

### Bước 1: Thêm Automated Layer vào validationService

**File:** `packages/backend/src/services/validationService.js`

Đọc file hiện tại để hiểu cấu trúc, sau đó thêm function `runSprintAutomatedChecks`:

```js
/**
 * Sprint-level automated checks (Layer 1 of 3-layer QA).
 * Runs on the main repo after all tasks merged to main branch.
 */
export async function runSprintAutomatedChecks(repoPath) {
  const results = {
    passed: true,
    checks: [],
  };

  const addCheck = (name, passed, detail = null, error = null) => {
    results.checks.push({ name, passed, detail, error });
    if (!passed) results.passed = false;
  };

  // 1. Syntax check — tất cả .js files
  try {
    const jsFiles = await findFiles(repoPath, '*.js', ['node_modules', '.git', 'workspaces']);
    let syntaxErrors = [];
    for (const file of jsFiles.slice(0, 50)) { // limit 50 files
      try {
        execSync(`node --check "${file}"`, { stdio: 'pipe' });
      } catch (e) {
        syntaxErrors.push({ file, error: e.stderr?.toString()?.substring(0, 200) });
      }
    }
    addCheck('Syntax Check', syntaxErrors.length === 0,
      `Checked ${jsFiles.length} files`, syntaxErrors.length > 0 ? syntaxErrors : null);
  } catch (e) {
    addCheck('Syntax Check', false, null, e.message);
  }

  // 2. ESLint (nếu có config)
  try {
    const eslintConfigs = ['.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js'];
    const hasEslint = eslintConfigs.some(f => existsSync(path.join(repoPath, f)));
    if (hasEslint) {
      try {
        const out = execSync('npx eslint . --max-warnings=0 --format=compact 2>&1', {
          cwd: repoPath, stdio: 'pipe', timeout: 30000,
        }).toString();
        addCheck('ESLint', true, 'No warnings or errors');
      } catch (e) {
        const output = e.stdout?.toString() || e.stderr?.toString() || '';
        addCheck('ESLint', false, output.substring(0, 500));
      }
    } else {
      addCheck('ESLint', true, 'No ESLint config — skipped');
    }
  } catch (e) {
    addCheck('ESLint', true, 'ESLint not available — skipped');
  }

  // 3. Test runner (nếu có)
  try {
    const pkg = JSON.parse(readFileSync(path.join(repoPath, 'package.json'), 'utf-8'));
    if (pkg.scripts?.test && !pkg.scripts.test.includes('no test')) {
      try {
        execSync('npm test --if-present 2>&1', { cwd: repoPath, stdio: 'pipe', timeout: 60000 });
        addCheck('Test Suite', true, 'All tests passed');
      } catch (e) {
        const output = e.stdout?.toString() || '';
        addCheck('Test Suite', false, output.substring(0, 800));
      }
    } else {
      addCheck('Test Suite', true, 'No test script configured — skipped');
    }
  } catch {
    addCheck('Test Suite', true, 'Cannot read package.json — skipped');
  }

  // 4. Import resolution check
  try {
    addCheck('Import Resolution', true, 'Skipped in sprint-level check (per-task validation covers this)');
  } catch (e) {
    addCheck('Import Resolution', false, null, e.message);
  }

  return results;
}

// Helper — tìm files theo pattern
async function findFiles(dir, pattern, excludeDirs = []) {
  const { glob } = await import('glob');
  const files = await glob(`**/${pattern}`, {
    cwd: dir, absolute: true, ignore: excludeDirs.map(d => `**/${d}/**`),
  });
  return files;
}
```

---

### Bước 2: Thêm Contract Layer prompt vào PromptBuilder

**File:** `packages/backend/src/services/claude/promptBuilder.js`

Thêm method `buildContractCheckPrompt`:

```js
// ─── STEP 5b: CONTRACT LAYER ────────────────────────────────────────────────
buildContractCheckPrompt({ sprintNumber, taskSpecs, gitDiff, automatedResults }) {
  const zoneClassification = this._getZoneClassification();
  const breakingChanges = this._getBreakingChanges();

  return `## CONTRACT CHECK — Sprint #${sprintNumber}
Đây là Layer 2 của 3-layer QA. Kiểm tra zone compliance và interface integrity.

${zoneClassification ? `## ZONE CLASSIFICATION\n${zoneClassification}\n` : ''}
${breakingChanges ? `## BREAKING CHANGE REGISTRY\n${breakingChanges}\n` : ''}

## AUTOMATED CHECK RESULTS (Layer 1 — đã pass)
${JSON.stringify(automatedResults, null, 2)}

## TASK SPECS (đã approve ở Gate 3)
${JSON.stringify(taskSpecs.map(t => ({
  taskId: t.taskId,
  filesToCreate: t.filesToCreate,
  filesToModify: t.filesToModify,
  interfaceExposed: t.interfaceExposed,
})), null, 2)}

## GIT DIFF (tổng hợp tất cả tasks)
${gitDiff.substring(0, 10000)}

## OUTPUT FORMAT
\`\`\`json
{
  "layer": "contract",
  "passed": true,
  "zoneCompliance": {
    "passed": true,
    "frozenViolations": [
      { "file": "string", "taskId": "string", "description": "string" }
    ],
    "guardedModifications": [
      { "file": "string", "taskId": "string", "hasJustification": true }
    ]
  },
  "interfaceIntegrity": {
    "passed": true,
    "brokenInterfaces": [
      { "interface": "string", "expectedBy": "string", "actuallyExposed": "string" }
    ]
  },
  "breakingChangeConflicts": [
    { "registeredChange": "string", "conflict": "string" }
  ],
  "blockMerge": false,
  "issues": [
    { "severity": "critical|major|minor", "category": "zone|interface|breaking_change", "description": "string" }
  ],
  "summary": "string — 1-2 câu"
}
\`\`\``;
}
```

---

### Bước 3: Sửa `_step5_QA` thành pipeline 3 lớp

**File:** `packages/backend/src/services/orchestrator/pipelineRunner.js`

Tìm hàm `_step5_QA` và refactor thành 3 sub-steps. Thay toàn bộ logic QA bằng:

```js
async _step5_QA(sprint) {
  const { id: sprintId, project, number } = sprint;
  logger.info({ sprintId, step: 5 }, 'Step 5: QA — 3 layers');
  await this._lock(sprintId, 5);

  try {
    const passTasks = await prisma.task.findMany({
      where: { sprintId, status: TASK_STATUS.PASS },
      include: { logs: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });

    if (passTasks.length === 0) {
      throw new Error('No passed tasks to QA');
    }

    const builder = new PromptBuilder(project.repoPath);

    // ── LAYER 1: AUTOMATED ────────────────────────────────────────────────────
    logger.info({ sprintId }, 'QA Layer 1: Automated checks');
    const { runSprintAutomatedChecks } = await import('../validationService.js');
    const automatedResults = await runSprintAutomatedChecks(project.repoPath);

    logger.info({ sprintId, passed: automatedResults.passed }, 'Layer 1 completed');

    if (!automatedResults.passed) {
      const failedChecks = automatedResults.checks.filter(c => !c.passed);
      const notesForPO = formatQALayer1FailForPO(failedChecks, number);
      await this._setGateWaiting(sprintId, 5, notesForPO);

      const gate5 = await prisma.gate.findUnique({
        where: { sprintId_gateNumber: { sprintId, gateNumber: 5 } },
        select: { id: true },
      });

      await this.orch.notif.send({
        projectId: project.id, sprintId,
        type: 'gate_waiting',
        title: '❌ QA Layer 1 FAIL — Automated checks failed',
        message: `Sprint #${number}: ${failedChecks.length} automated check(s) failed. Review required.`,
        payload: { gateId: gate5?.id },
      });
      this.orch._emit('sprint:updated', { sprintId, currentGateNumber: 5 });
      logger.warn({ sprintId, failedChecks }, 'QA stopped at Layer 1');
      return; // Dừng ở Layer 1 — không chạy Layer 2
    }

    // ── LAYER 2: CONTRACT CHECK ───────────────────────────────────────────────
    logger.info({ sprintId }, 'QA Layer 2: Contract check');

    // Lấy combined diff của tất cả tasks
    const mainGit = simpleGit(project.repoPath);
    const diffs = [];
    for (const task of passTasks) {
      try {
        const diff = await mainGit.diff([`HEAD~${passTasks.length}`, 'HEAD', '--', '--']);
        diffs.push(diff);
      } catch { /* skip */ }
    }
    const fullDiff = diffs.join('\n\n');

    const taskSpecs = passTasks.map(t => {
      try { return JSON.parse(t.spec); } catch { return { taskId: t.taskId }; }
    });

    const contractPrompt = builder.buildContractCheckPrompt({
      sprintNumber: number,
      taskSpecs,
      gitDiff: fullDiff,
      automatedResults,
    });

    const contractResult = await runClaudeWithRetry({
      prompt: contractPrompt, tools: [], cwd: project.repoPath, sprintId,
    });

    const contractParsed = parseClaudeOutput(contractResult.output, 'contractCheck');
    const contractData = contractParsed.success ? contractParsed.data : { passed: true, blockMerge: false };

    logger.info({ sprintId, passed: contractData.passed }, 'Layer 2 completed');

    if (contractData.blockMerge) {
      const notesForPO = formatQALayer2FailForPO(contractData, number);
      await this._setGateWaiting(sprintId, 5, notesForPO);

      const gate5 = await prisma.gate.findUnique({
        where: { sprintId_gateNumber: { sprintId, gateNumber: 5 } },
        select: { id: true },
      });

      await this.orch.notif.send({
        projectId: project.id, sprintId,
        type: 'gate_waiting',
        title: '⚠️ QA Layer 2 — Contract violations found',
        message: `Sprint #${number}: Zone/interface violations need review.`,
        payload: { gateId: gate5?.id },
      });
      this.orch._emit('sprint:updated', { sprintId, currentGateNumber: 5 });
      logger.warn({ sprintId }, 'QA stopped at Layer 2 — contract violations');
      return; // Dừng ở Layer 2
    }

    // ── LAYER 3: BUSINESS REVIEW (Claude QA chunks — như hiện tại) ───────────
    logger.info({ sprintId }, 'QA Layer 3: Business review');

    // --- GIỮ NGUYÊN toàn bộ logic QA chunks và QA Final hiện tại ---
    // (copy từ _step5_QA cũ: buildQAChunkPrompt, buildQAFinalPrompt, etc.)
    // Chỉ thêm kết quả layer 1 và layer 2 vào context của Final Report

    // ... (giữ nguyên code QA hiện tại, chỉ bổ sung contractData vào finalPrompt)

    logger.info({ sprintId }, 'Step 5 QA — all 3 layers completed');
  } catch (err) {
    await this._unlock(sprintId);
    throw err;
  }
}
```

Thêm helpers format cho Layer 1 và Layer 2 fail:

```js
function formatQALayer1FailForPO(failedChecks, sprintNumber) {
  let notes = `## ❌ QA Layer 1 Failed — Sprint #${sprintNumber}\n\n`;
  notes += `Automated checks phát hiện lỗi. **Cần fix trước khi merge.**\n\n`;
  notes += `### Checks Failed\n`;
  failedChecks.forEach(c => {
    notes += `\n**${c.name}**\n`;
    if (c.error) notes += `\`\`\`\n${c.error}\n\`\`\`\n`;
    if (c.detail) notes += `${c.detail}\n`;
  });
  notes += `\n### Hành động\nFix các lỗi trên rồi Approve Gate 5 để re-run QA.`;
  return notes;
}

function formatQALayer2FailForPO(contractData, sprintNumber) {
  let notes = `## ⚠️ QA Layer 2 — Contract Violations — Sprint #${sprintNumber}\n\n`;

  const { zoneCompliance, interfaceIntegrity, issues = [] } = contractData;

  if (zoneCompliance?.frozenViolations?.length > 0) {
    notes += `### 🔴 Frozen Zone Violations\n`;
    zoneCompliance.frozenViolations.forEach(v => {
      notes += `- **${v.file}** (${v.taskId}): ${v.description}\n`;
    });
    notes += '\n';
  }

  if (interfaceIntegrity?.brokenInterfaces?.length > 0) {
    notes += `### Interface Integrity Issues\n`;
    interfaceIntegrity.brokenInterfaces.forEach(i => {
      notes += `- **${i.interface}**: expected by ${i.expectedBy}, got: ${i.actuallyExposed}\n`;
    });
    notes += '\n';
  }

  const criticalIssues = issues.filter(i => i.severity === 'critical');
  if (criticalIssues.length > 0) {
    notes += `### Critical Issues\n`;
    criticalIssues.forEach(i => { notes += `- [${i.category}] ${i.description}\n`; });
  }

  notes += `\n### Hành động\nDeveloper cần fix các vi phạm trên. Override Pass nếu chấp nhận risk.`;
  return notes;
}
```

**Verification IMP-05:**
- Chạy sprint đến Step 5. Backend log phải có 3 dòng:
  - "QA Layer 1: Automated checks"
  - "QA Layer 2: Contract check"
  - "QA Layer 3: Business review"
- Nếu có syntax error: QA dừng ở Layer 1, Gate 5 notes hiển thị lỗi syntax
- Nếu Layer 1 pass: Layer 2 chạy tiếp
- Nếu tất cả pass: Gate 5 hiển thị QA Final Report như bình thường

---

## CHECKLIST HOÀN THÀNH

| Task | Verification | Status |
|------|-------------|--------|
| IMP-01 | `docs/zone-classification.md` được tạo sau Step 1 | ⬜ |
| IMP-01 | Developer Agent log có section ZONE CLASSIFICATION | ⬜ |
| IMP-01 | Task sửa Frozen file → status CONFLICT | ⬜ |
| IMP-02 | `docs/tcr/sprint-N/TCR-sprint-N.md` được tạo sau Step 1 | ⬜ |
| IMP-02 | `docs/tcr/_index.md` có entry mới | ⬜ |
| IMP-02 | `docs/context/index.md` được cập nhật | ⬜ |
| IMP-03 | Tạo sprint → Step 0 tự động chạy | ⬜ |
| IMP-03 | Gate 0 hiển thị Reception Report với gaps | ⬜ |
| IMP-03 | Requirement mơ hồ → Gate 0 title có "⚠️ Có vấn đề" | ⬜ |
| IMP-04 | Sau sprint merge: `docs/contracts/breaking-changes.md` được tạo | ⬜ |
| IMP-04 | Sprint kế tiếp: Architect prompt có Breaking Changes Registry | ⬜ |
| IMP-05 | Step 5 log: 3 dòng "QA Layer 1/2/3" | ⬜ |
| IMP-05 | Syntax error → QA dừng ở Layer 1, không chạy Layer 2 | ⬜ |
| IMP-05 | Zone violation → QA dừng ở Layer 2, blockMerge | ⬜ |

---

## GHI CHÚ KỸ THUẬT

### Thứ tự implement
Implement theo đúng thứ tự IMP-01 → IMP-05. IMP-02 phụ thuộc vào cấu trúc file mà IMP-01 tạo ra. IMP-05 Layer 2 sử dụng zone-classification từ IMP-01.

### Không phá vỡ pipeline hiện tại
Mọi thay đổi phải backward-compatible:
- IMP-02: Vẫn ghi MASTER.md nếu Architect trả về `masterMdUpdate` (legacy support)
- IMP-03: Step 0 fail không block sprint — log error và skip
- IMP-05: Nếu Layer 2 Claude call fail → treat as passed (graceful degradation), tiếp tục Layer 3

### Về `simpleGit` trong IMP-05
`simple-git` đã được import trong `worktreeManager.js`. Trong `pipelineRunner.js`, cần import thêm:
```js
import simpleGit from 'simple-git';
```

### Về schema validation cho contractCheck
Thêm schema `contractCheck` vào `outputParser.js` tương tự như đã thêm `reception` ở IMP-03.

# VSCODE TASKS — Agent Audit Round 2
> Dựa trên AGENT_AUDIT_REPORT.md
> 10 tasks theo thứ tự ưu tiên: Critical → Major → Minor
> Copy từng TASK block vào VSCode, chờ xong mới làm task tiếp theo

---

## TASK-A — Reception Report → Architect (Critical)

```
Đọc file: packages/backend/src/services/claude/promptBuilder.js

Hiện tại buildArchitectPrompt({ requirement, sprintNumber }) không nhận receptionReport.
Architect không biết các gaps/conflicts/assumptions mà Reception đã phát hiện.

THAY ĐỔI YÊU CẦU:

1. Sửa signature của buildArchitectPrompt:
   - Từ: buildArchitectPrompt({ requirement, sprintNumber })
   - Thành: buildArchitectPrompt({ requirement, sprintNumber, receptionReport = null })

2. Trong prompt body, sau block "## SHARED CONTEXT", thêm section sau (chỉ khi receptionReport có giá trị):

## RECEPTION ANALYSIS (requirements already reviewed — do NOT re-analyze)
${receptionReport.gaps?.filter(g => g.severity !== 'minor').map(g =>
  `- [${g.severity.toUpperCase()}] ${g.area}: ${g.description} → Suggested: ${g.suggestedClarification}`
).join('\n') || 'No blocking gaps'}

Assumptions to verify:
${receptionReport.assumptions?.filter(a => a.risk !== 'low').map(a =>
  `- [${a.risk.toUpperCase()} risk] ${a.assumption}`
).join('\n') || 'None'}

${receptionReport.scopeWarning ? `⚠️ SCOPE WARNING: ${receptionReport.scopeWarning}` : ''}

Instruction: Your architecture MUST address all BLOCKING and IMPORTANT gaps listed above.
Do not ignore assumptions marked HIGH risk.

3. Đọc file packages/backend/src/services/orchestrator/pipelineRunner.js
   Tìm nơi gọi buildArchitectPrompt() trong _step1_Architect.
   Sửa để pass receptionReport từ Gate0.structuredData.

4. Tìm Gate0 data loading trong _step1_Architect — cần đọc Gate0.structuredData và parse receptionReport từ đó.

KIỂM TRA:
- buildArchitectPrompt vẫn hoạt động khi receptionReport = null (backward compat)
- Section Reception Analysis chỉ hiện khi receptionReport có giá trị
- Gọi trong pipelineRunner.js pass đúng receptionReport
```

---

## TASK-B — Reviewer Issues → QA Chunk (Critical)

```
Đọc file: packages/backend/src/services/claude/promptBuilder.js
Tìm method: buildQAChunkPrompt

Hiện tại QA Chunk chỉ nhận archVerdict (PASS/FAIL string) mà không nhận chi tiết issues từ Reviewer.
QA phải re-review lại từ đầu những gì Reviewer đã flag — lãng phí và có thể bỏ sót.

THAY ĐỔI YÊU CẦU:

1. Sửa signature buildQAChunkPrompt để nhận thêm reviewerIssues:
   Mỗi task trong tasksWithVerdicts nên có thêm field reviewIssues (array từ reviewParsed.issues)

2. Khi build tasks section trong prompt, với mỗi task đã có reviewIssues, thêm:
   "Known reviewer issues (verify these are fixed):
   - [severity] description: fix_suggestion"

3. Đọc file packages/backend/src/services/orchestrator/QARunner.js
   Tìm step5_QA() — nơi build tasksWithVerdicts để pass vào buildQAChunkPrompt.
   Sửa để include reviewParsed.issues (hoặc reviewParsed.criticalIssues) vào mỗi task object.

4. Task object nên có dạng:
   { taskId, taskSpec, archVerdict, reviewIssues: task.reviewParsed?.issues || [] }

KIỂM TRA:
- Khi task.reviewParsed null hoặc không có issues → reviewIssues = [] → không hiện section
- Format issues trong prompt phải readable (không dump raw JSON)
- Backward compatible với tasks không có reviewParsed
```

---

## TASK-C — BugVerifier nhận Spec Context (Critical)

```
Đọc file: packages/backend/src/services/claude/promptBuilder.js
Tìm method: buildBugVerifyPrompt

Hiện tại buildBugVerifyPrompt({ errorDescription, fixResult }) — không có master context, không có original spec.
Verifier chỉ có thể verify "không còn crash", không thể verify "behavior đúng với yêu cầu".

THAY ĐỔI YÊU CẦU:

1. Sửa signature:
   - Từ: buildBugVerifyPrompt({ errorDescription, fixResult })
   - Thành: buildBugVerifyPrompt({ errorDescription, fixResult, originalSpec = null, sprintNumber = null })

2. Trong prompt body, thêm context sections:
   - Nếu sprintNumber có giá trị: thêm this._getOptimizedContext(sprintNumber) vào đầu prompt
   - Nếu originalSpec có giá trị: thêm section "## ORIGINAL SPEC (verify behavior matches)"

3. Sửa nội dung TASK instruction trong prompt để hướng dẫn Verifier:
   - KHÔNG CHỈ chạy test để xem có crash không
   - PHẢI so sánh behavior với originalSpec nếu có
   - Nếu không có originalSpec: verify theo mô tả trong errorDescription

4. Đọc file packages/backend/src/services/orchestrator/BugfixRunner.js
   Tìm nơi gọi buildBugVerifyPrompt().
   Pass thêm originalSpec (từ task spec nếu có) và sprintNumber.

KIỂM TRA:
- backward compat khi không có originalSpec
- Context không quá dài — chỉ lấy 1 sprint TCR gần nhất
```

---

## TASK-D — QAFinal nhận Master Context (Critical)

```
Đọc file: packages/backend/src/services/claude/promptBuilder.js
Tìm method: buildQAFinalPrompt

Hiện tại buildQAFinalPrompt({ chunkResults }) — không có master context gì cả.
Agent tổng hợp kết quả sprint nhưng không biết project này làm gì, sprint này có business value gì.

THAY ĐỔI YÊU CẦU:

1. Sửa signature:
   - Từ: buildQAFinalPrompt({ chunkResults })
   - Thành: buildQAFinalPrompt({ chunkResults, sprintNumber = null })

2. Thêm vào đầu method:
   const masterContext = sprintNumber ? this._getOptimizedContext(sprintNumber) : null;

3. Trong prompt body, thêm section đầu tiên (trước chunkResults):
   ${masterContext ? `## PROJECT CONTEXT (for business-aware final verdict)
   ${masterContext}

   ` : ''}

4. Thêm instruction trong TASK section:
   "Use the project context above to assess: are the remaining issues blocking for the business goal of this sprint, or are they acceptable minor issues?"

5. Đọc file packages/backend/src/services/orchestrator/QARunner.js
   Tìm nơi gọi buildQAFinalPrompt().
   Pass sprintNumber từ sprint.number.

KIỂM TRA:
- Khi sprintNumber = null → vẫn hoạt động bình thường (backward compat)
- Context được inject trước chunkResults để orient agent
```

---

## TASK-E — SprintCoverageCheck lên First-Class Agent (Major)

```
Đọc file: packages/backend/src/services/claude/promptBuilder.js

Vấn đề: buildSprintCoverageCheckPrompt() dùng inline agent identity thay vì _agentHeader().
Không có AGENT_PROFILES entry → không được tracked, không có canSee/cannotSee.

THAY ĐỔI PHẦN 1 — promptBuilder.js:

1. Trong AGENT_PROFILES object, thêm entry mới:
   coverage_verifier: {
     role: 'Sprint Coverage Verifier',
     identity: 'You are a Coverage Verifier. Your ONLY task: check if the sprint plan covers ALL requirements in the source document. You are NOT a planner — only verify coverage.',
     canSee: ['full_requirement', 'sprint_plan'],
     cannotSee: 'architect designs, developer code, implementation details — only verify requirements vs plan',
   }

2. Sửa buildSprintCoverageCheckPrompt():
   - Xóa inline "## AGENT IDENTITY" block ở đầu method
   - Thay bằng: ${this._agentHeader('coverage_verifier')}

THAY ĐỔI PHẦN 2 — outputParser.js:
Đọc file: packages/backend/src/services/claude/outputParser.js

3. Tìm chỗ định nghĩa các Zod schemas (tìm "z.object" hoặc tên schemas như sprintPlan, reception, etc.)

4. Thêm schema mới cho sprintCoverageCheck:
   const sprintCoverageCheckSchema = z.object({
     totalRequirements: z.number(),
     coveredCount: z.number(),
     missingCount: z.number(),
     coveragePercent: z.number(),
     allRequirements: z.array(z.object({
       requirement: z.string(),
       source: z.string().optional(),
       coveredBySprint: z.number().nullable(),
       status: z.enum(['covered', 'missing', 'vague']),
       notes: z.string().optional(),
     })),
     missingFeatures: z.array(z.object({
       requirement: z.string(),
       source: z.string().optional(),
       suggestedSprint: z.string().optional(),
     })).default([]),
     vagueFeatures: z.array(z.object({
       requirement: z.string(),
       issue: z.string(),
     })).default([]),
     verdict: z.enum(['FULL_COVERAGE', 'PARTIAL', 'MISSING_CRITICAL']),
     summary: z.string(),
   });

5. Export schema này và thêm case 'sprintCoverageCheck' vào hàm parseClaudeOutput (hoặc tương đương trong file).

KIỂM TRA:
- buildSprintCoverageCheckPrompt() output có AGENT IDENTITY header đúng format
- parseClaudeOutput('sprintCoverageCheck', text) hoạt động không lỗi
```

---

## TASK-F — QAFix dùng Agent Header (Major)

```
Đọc file: packages/backend/src/services/orchestrator/QARunner.js
Tìm method: runQAFix()

Vấn đề: fixPrompt dùng inline "Ban la Developer Agent" — không có agent identity infrastructure.

THAY ĐỔI PHẦN 1 — promptBuilder.js:
Đọc file: packages/backend/src/services/claude/promptBuilder.js

1. Thêm entry mới vào AGENT_PROFILES:
   qa_fixer: {
     role: 'QA Fixer',
     identity: 'You are a QA Fixer. Your task: fix ONLY the issues listed in the QA report. Do NOT refactor unrelated code. Do NOT change working functionality. Fix minimal code to resolve each issue.',
     canSee: ['project_context', 'qa_report', 'coding_conventions'],
     cannotSee: 'original review verdicts, architect reasoning — only fix what QA flagged',
   }

2. Thêm method buildQAFixPrompt({ masterContext, conventions, qaNotes, fixAll = false, sprintNumber = null }):
   - Dùng this._agentHeader('qa_fixer') ở đầu
   - Inject masterContext nếu có
   - Inject conventions nếu có
   - fixScope logic giống hiện tại (fixAll → fix tất cả, không → chỉ critical+major)
   - Output format giữ nguyên: fixesApplied, fixesSkipped, testsRun, status

THAY ĐỔI PHẦN 2 — QARunner.js:
3. Trong runQAFix(), thay inline fixPrompt bằng:
   const builder = new PromptBuilder(project.repoPath);
   const fixPrompt = builder.buildQAFixPrompt({
     masterContext,
     conventions,
     qaNotes,
     fixAll,
     sprintNumber: sprint.number,
   });

KIỂM TRA:
- QAFix prompt bắt đầu bằng AGENT IDENTITY block
- Logic fixAll vẫn hoạt động đúng
- Output format không thay đổi
```

---

## TASK-G — Gate5 lưu structuredData JSON (Major)

```
Đọc file: packages/backend/src/services/orchestrator/QARunner.js
Đọc file: packages/backend/src/services/claude/promptBuilder.js — tìm buildQAFinalPrompt

Vấn đề: QA Final output chỉ được lưu vào Gate5.notes (markdown text).
QAFix phải parse markdown để biết issues — dễ miss và khó chính xác.

THAY ĐỔI YÊU CẦU:

1. Trong QARunner.js, tìm nơi QA Final kết quả được lưu vào Gate5.
   Sau khi parseClaudeOutput('qaFinal', finalResult.text):
   - Lưu parsed JSON vào Gate5.structuredData (JSON.stringify)
   - Vẫn giữ Gate5.notes cho backward compat (human-readable)

2. Trong runQAFix(), khi đọc qaNotes để fix:
   - Đọc Gate5.structuredData trước (JSON issues list)
   - Nếu structuredData có → dùng structured format
   - Fallback: đọc Gate5.notes (markdown) như hiện tại

3. Sửa fixPrompt trong buildQAFixPrompt (sau TASK-F) để support cả 2 format:
   - Nếu qaNotes là object (parsed từ structuredData): format thành readable list
   - Nếu qaNotes là string (fallback): dùng nguyên như cũ

4. Cập nhật Prisma query trong step5_QA() để include structuredData khi update Gate5:
   data: { status: ..., notes: formattedNotes, structuredData: JSON.stringify(parsedQAFinal) }

KIỂM TRA:
- Gate5 được update với cả notes VÀ structuredData
- QAFix đọc structuredData thành công khi có
- Fallback về notes khi structuredData null
- Không break existing flow
```

---

## TASK-H — Migrate 11 Agents sang English (Major)

```
Đọc file: packages/backend/src/services/claude/promptBuilder.js

11 methods sau vẫn dùng tiếng Việt trong prompt body (phần ngoài _agentHeader):
buildSprintPlanPrompt, buildSprintCoverageCheckPrompt (inline parts), buildReceptionPrompt,
buildFeatureSpecPrompt, buildAtomicTaskPrompt, buildDeveloperPrompt,
buildIntegrationVerifyPrompt, buildIntegrationFixPrompt, buildContractCheckPrompt,
buildQAChunkPrompt, buildQAFinalPrompt

LƯU Ý QUAN TRỌNG:
- KHÔNG thay đổi logic, structure, output format JSON
- CHỈ dịch text labels, instructions, comments, section headers sang English
- Giữ nguyên: field names trong JSON output, variable names, code
- Giữ nguyên: _agentHeader() output (vì AGENT_PROFILES.identity đã viết tiếng Việt — không đổi)
- Output JSON field names như "requirementSummary", "gaps", etc. KHÔNG đổi

THỨ TỰ ƯU TIÊN (làm theo thứ tự):
1. buildDeveloperPrompt — agent quan trọng nhất
2. buildFeatureSpecPrompt (SpecWriter)
3. buildAtomicTaskPrompt (TaskPlanner)
4. buildQAChunkPrompt (QA)
5. buildQAFinalPrompt (QA Final)
6. buildIntegrationVerifyPrompt
7. buildIntegrationFixPrompt
8. buildContractCheckPrompt
9. buildReceptionPrompt
10. buildSprintPlanPrompt
11. buildSprintCoverageCheckPrompt (non-agentHeader parts)

VÍ DỤ MIGRATION:
- "## TASK\nViet Feature Specifications chi tiet" → "## TASK\nWrite detailed Feature Specifications"
- "## NHIEM VU\nDoc TOAN BO requirement" → "## TASK\nRead the FULL requirement"
- "QUAN TRONG:" → "IMPORTANT:"
- "Chua co" → "Not available yet"
- Section headers sang English, giữ format ## và ký tự đặc biệt

KIỂM TRA sau khi migrate:
- Mỗi method: output JSON structure không thay đổi (fields, types, nested objects giống hệt)
- Run: node -e "import('./src/services/claude/promptBuilder.js').then(m => { const b = new m.PromptBuilder('/tmp'); console.log(b.buildDeveloperPrompt({taskSpec: {}, sprintNumber: 1}).substring(0, 200)); })"
  để verify không có syntax error
```

---

## TASK-I — Chain-of-Thought cho 4 Agents (Minor)

```
Đọc file: packages/backend/src/services/claude/promptBuilder.js

Hiện tại chỉ Architect và Reception có CoT block. Cần thêm cho 4 agents phức tạp:

AGENT 1 — buildAtomicTaskPrompt (TaskPlanner):
Thêm section sau "## TASK" và TRƯỚC "## OUTPUT FORMAT":

## REASONING (required — write before JSON)
Think step by step:
1. Is each task truly atomic? (Can it be implemented independently without needing another task to be done first?)
2. Are there file conflicts between tasks? (Multiple tasks touching the same file → need to split or sequence)
3. What is the minimum set of tasks that delivers the feature? (Avoid over-engineering)
4. Which tasks can run in parallel vs must be sequential?
After completing your reasoning above, output the JSON block.

AGENT 2 — buildReviewPrompt (Reviewer):
Thêm section trước OUTPUT FORMAT:

## REASONING (required — write before JSON)
Think step by step:
1. Does the implementation match the spec exactly? List any spec points NOT covered.
2. Are there edge cases in the spec that are NOT handled in the code?
3. Does the code introduce any breaking changes not listed in the breaking changes registry?
4. Rate your confidence: are you finding real bugs or being overly strict?
After completing your reasoning above, output the JSON block.

AGENT 3 — buildBugDiagnosePrompt (Diagnostician):
Thêm section trước OUTPUT FORMAT:

## REASONING (required — write before JSON)
Think step by step:
1. What is the error message and stack trace telling us? (Exact file + line)
2. What is the ROOT CAUSE? (Not symptom — what fundamental assumption was wrong?)
3. Could this bug be caused by multiple places? List all candidates.
4. Will the fix cause regression in related code?
After completing your reasoning above, output the JSON block.

AGENT 4 — buildFeatureSpecPrompt (SpecWriter):
Thêm section trước OUTPUT FORMAT:

## REASONING (required — write before JSON)
Think step by step:
1. What does the architect output say this feature should do? (Core goal)
2. What are the inputs and outputs that are EXPLICITLY required?
3. What edge cases are obvious but not mentioned? (empty input, concurrent access, large data)
4. What validation rules are implied but not stated?
After completing your reasoning above, output the JSON block.

KIỂM TRA:
- CoT section xuất hiện TRƯỚC ## OUTPUT FORMAT
- CoT section xuất hiện SAU ## TASK
- Format: "## REASONING (required — write before JSON)" nhất quán
```

---

## TASK-J — Output Limits cho Agents Chính (Minor)

```
Đọc file: packages/backend/src/services/claude/promptBuilder.js

Hiện tại chỉ buildArchitectPrompt có OUTPUT LIMITS section. Cần thêm cho các agents khác.

THÊM VÀO CUỐI (trước closing backtick) của các methods sau:

1. buildFeatureSpecPrompt — thêm sau JSON schema:
OUTPUT LIMITS:
- features: max 8 items per sprint
- businessLogic: max 6 steps per feature
- edgeCases: max 5 items per feature
- Entire JSON MUST be under 10000 characters — be specific but concise

2. buildAtomicTaskPrompt — thêm sau JSON schema:
OUTPUT LIMITS:
- tasks: max 10 items per sprint (if more needed, flag in notes)
- Each task description: max 3 sentences
- acceptanceCriteria: max 4 items per task
- Entire JSON MUST be under 8000 characters

3. buildReviewPrompt — thêm sau JSON schema:
OUTPUT LIMITS:
- issues: max 12 items
- Each issue description: max 2 sentences
- Each fixSuggestion: max 2 sentences
- summary: max 3 sentences

4. buildQAChunkPrompt — thêm sau JSON schema:
OUTPUT LIMITS:
- issues: max 15 items per chunk
- Each issue description: max 2 sentences
- summary: max 2 sentences

5. buildBugDiagnosePrompt — thêm sau JSON schema:
OUTPUT LIMITS:
- rootCause: max 3 sentences
- fixPlan steps: max 8 items
- Each step: max 2 sentences
- Entire JSON MUST be under 5000 characters

KIỂM TRA:
- Output limits xuất hiện sau JSON schema block
- Format nhất quán: dùng "OUTPUT LIMITS:" header
- Không thay đổi JSON schema hay logic
```

---

## VERIFICATION — Chạy sau khi hoàn thành tất cả tasks

```
Sau khi hoàn thành TASK-A đến TASK-J, thực hiện verification:

1. Syntax check toàn bộ file đã sửa:
   cd packages/backend
   node --input-type=module < /dev/null && echo "OK"

   Hoặc:
   node -e "import('./src/services/claude/promptBuilder.js').then(() => console.log('promptBuilder OK')).catch(e => console.error(e))"
   node -e "import('./src/services/claude/outputParser.js').then(() => console.log('outputParser OK')).catch(e => console.error(e))"
   node -e "import('./src/services/orchestrator/QARunner.js').then(() => console.log('QARunner OK')).catch(e => console.error(e))"
   node -e "import('./src/services/orchestrator/BugfixRunner.js').then(() => console.log('BugfixRunner OK')).catch(e => console.error(e))"
   node -e "import('./src/services/orchestrator/pipelineRunner.js').then(() => console.log('pipelineRunner OK')).catch(e => console.error(e))"

2. Verify AGENT_PROFILES có các entries mới:
   Tìm trong promptBuilder.js: coverage_verifier, qa_fixer — phải có cả 2

3. Verify Zod schema mới:
   Tìm trong outputParser.js: sprintCoverageCheckSchema — phải có

4. Verify backward compat — các calls sau không throw:
   new PromptBuilder('/tmp').buildArchitectPrompt({ requirement: 'test', sprintNumber: 1 })
   new PromptBuilder('/tmp').buildQAFinalPrompt({ chunkResults: [] })
   new PromptBuilder('/tmp').buildBugVerifyPrompt({ errorDescription: 'err', fixResult: {} })

Báo cáo: "ALL VERIFICATION PASSED" hoặc liệt kê errors cụ thể.
```

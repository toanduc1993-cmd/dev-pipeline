# VSCODE TASKS — Round 5 Fixes + Liberico-Inspired Improvements
> Dựa trên Round 5 Audit Report (9.3/10) và so sánh với Liberico Rules
> Mục tiêu: đưa hệ thống lên 9.7/10

---

## COPY PASTE PROMPT NÀY VÀO VSCODE

```
Tôi cần bạn thực hiện lần lượt các tasks sau đây trên codebase AI Dev Pipeline.
Sau mỗi task, chạy lệnh verify và báo cáo kết quả trước khi sang task tiếp theo.
Không thực hiện nhiều tasks cùng lúc.

Working directory: packages/backend/src/

========================================================
TASK A — Fix Reviewer thiếu sprintNumber (MEDIUM priority)
========================================================

File: packages/backend/src/services/orchestrator/TaskExecutor.js

HIỆN TẠI: buildReviewPrompt được gọi thiếu sprintNumber nên Reviewer không có
TCR context (architectural decisions của sprint hiện tại).

THAY ĐỔI:

1. Tìm chỗ gọi buildReviewPrompt trong TaskExecutor.js.
   Hiện tại trông giống như:
     buildReviewPrompt({ task: taskSpec, gitDiff, validationResult })
   Sửa thành:
     buildReviewPrompt({ task: taskSpec, gitDiff, validationResult, sprintNumber: this.sprintNumber })
   (hoặc sprintNumber lấy từ context object tương ứng trong class — xem cách các method khác
    trong TaskExecutor lấy sprintNumber)

2. Mở file: packages/backend/src/services/claude/promptBuilder.js
   Tìm method buildReviewPrompt({ task, gitDiff, validationResult }).
   Thêm sprintNumber = null vào destructure:
     buildReviewPrompt({ task, gitDiff, validationResult, sprintNumber = null })

3. Trong body của buildReviewPrompt, sau phần build masterContext hoặc conventions,
   thêm đoạn inject optimized context (xem cách buildQAFinalPrompt làm):
     const sprintContext = sprintNumber ? await this._getOptimizedContext(sprintNumber) : '';
   Và inject vào prompt tại section phù hợp (sau conventions hoặc trước task spec):
     ${sprintContext ? `## SPRINT ARCHITECTURAL CONTEXT\n${sprintContext}\n` : ''}

VERIFY:
  grep -n "buildReviewPrompt" packages/backend/src/services/orchestrator/TaskExecutor.js
  grep -n "buildReviewPrompt" packages/backend/src/services/claude/promptBuilder.js
  grep -n "sprintNumber" packages/backend/src/services/claude/promptBuilder.js | grep -i review

Expected: TaskExecutor call có sprintNumber, promptBuilder method accept sprintNumber và
inject _getOptimizedContext khi sprintNumber có giá trị.

========================================================
TASK B — BugfixRunner dùng đúng Zod schemas (LOW priority)
========================================================

File: packages/backend/src/services/orchestrator/BugfixRunner.js

HIỆN TẠI: Tất cả 3 bugfix agents (Diagnostician, Fixer, Verifier) gọi:
  parseClaudeOutput(output, null)
Schemas bugDiagnose và bugFix có trong outputParser nhưng không được dùng.

THAY ĐỔI:

Tìm từng chỗ gọi parseClaudeOutput trong BugfixRunner.js và update schema name:

1. Chỗ parse output của Diagnostician:
   parseClaudeOutput(output, null)  →  parseClaudeOutput(output, 'bugDiagnose')

2. Chỗ parse output của Fixer:
   parseClaudeOutput(output, null)  →  parseClaudeOutput(output, 'bugFix')

3. Chỗ parse output của Verifier: giữ nguyên null NẾU không có schema bugVerify trong
   outputParser. Kiểm tra trước: grep -n "bugVerify" packages/backend/src/services/claude/outputParser.js
   Nếu có schema → đổi thành 'bugVerify'. Nếu không có → giữ null (đừng tạo schema mới).

VERIFY:
  grep -n "parseClaudeOutput" packages/backend/src/services/orchestrator/BugfixRunner.js

Expected: Ít nhất 2 trong 3 calls có schema name thay vì null.

========================================================
TASK C — Cleanup Vietnamese strings trong BugfixRunner + promptBuilder (LOW)
========================================================

Files:
- packages/backend/src/services/orchestrator/BugfixRunner.js
- packages/backend/src/services/claude/promptBuilder.js

THAY ĐỔI 1 — BugfixRunner.js:
Tìm string Vietnamese trong retry/attempt logic. Có dạng:
  `[LAN ${attempt}] Fix truoc chua thanh cong`
  hoặc tương tự với "LAN", "truoc", "chua"
Thay bằng English:
  `[Attempt ${attempt}] Previous fix did not resolve the issue`

THAY ĐỔI 2 — promptBuilder.js:
Tìm method buildBugFixPrompt. Trong body của method, tìm các section headers bằng tiếng Việt:
  "LOI GOC" → "ROOT CAUSE"
  "QUY TRINH BAT BUOC" → "MANDATORY PROCESS"
  "HUONG DAN" hoặc tương tự → English equivalent
  Bất kỳ text tiếng Việt nào khác trong body prompt (KHÔNG đụng vào AGENT_PROFILES identity — đó là intentional)

VERIFY:
  grep -n "LAN\|truoc\|chua thanh\|LOI GOC\|QUY TRINH\|BAT BUOC" \
    packages/backend/src/services/orchestrator/BugfixRunner.js \
    packages/backend/src/services/claude/promptBuilder.js

Expected: 0 kết quả.

========================================================
TASK D — IntegrationVerifier notify PO khi exception (LOW)
========================================================

File: packages/backend/src/services/orchestrator/IntegrationVerifier.js

HIỆN TẠI: Khi exception xảy ra trong integration verify:
  } catch (err) {
    logger.error({ err }, 'IntegrationVerifier failed — proceeding');
    return { decision: 'proceed' };
  }
PO không biết integration verify đã bị skip silently.

THAY ĐỔI:
Trong catch block, thêm notification trước khi return. Xem cách TCR failure notify PO
trong pipelineRunner.js để dùng cùng pattern (notif.send hoặc tương đương):

  } catch (err) {
    logger.error({ err }, 'IntegrationVerifier failed — proceeding without integration check');
    try {
      await this.notif?.send({
        type: 'warn',
        title: '⚠️ Integration verify skipped',
        message: `IntegrationVerifier threw an exception and was bypassed. Sprint may have integration issues. Error: ${err.message}`,
      });
    } catch (notifErr) {
      logger.warn({ notifErr }, 'Failed to send IntegrationVerifier skip notification');
    }
    return { decision: 'proceed' };
  }

Chú ý: xem cách class IntegrationVerifier nhận notif service (qua constructor injection
hay this.notif) để dùng đúng pattern — không tự thêm import mới nếu notif chưa available.

VERIFY:
  grep -n "catch\|notif\|proceed" packages/backend/src/services/orchestrator/IntegrationVerifier.js

Expected: catch block có notif.send call bọc trong try/catch riêng.

========================================================
TASK E — Thêm post-write validation hook cho Developer/QA Fixer output (HIGH value)
========================================================

File mới cần tạo: packages/backend/src/services/orchestrator/CodeQualityChecker.js
File cần sửa: packages/backend/src/services/orchestrator/TaskExecutor.js
File cần sửa: packages/backend/src/services/orchestrator/QARunner.js

MỤC ĐÍCH: Sau khi Developer hoặc QA Fixer ghi file, tự động scan các vi phạm phổ biến
trước khi commit — bắt lỗi sớm hơn Gate 4 (Reviewer) một bước.

BƯỚC 1 — Tạo CodeQualityChecker.js:

```javascript
// packages/backend/src/services/orchestrator/CodeQualityChecker.js
/**
 * Post-write code quality checker.
 * Scans modified JS files for common violations before commit.
 * Advisory only — logs warnings, does NOT throw or block pipeline.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger'); // adjust import path to match project

const CHECKS = [
  {
    code: 'E-BE-01',
    pattern: /\b(readFileSync|writeFileSync|execSync|readdirSync)\b/,
    message: 'Sync I/O detected — use async variant',
  },
  {
    code: 'E-BE-02',
    pattern: /catch\s*\([^)]*\)\s*\{\s*\}/,
    message: 'Empty catch block — must wrap error with context',
  },
  {
    code: 'E-BE-03',
    pattern: /(['"])(sk[_-]|ghp_|AKIA)/,
    message: 'Possible hardcoded secret — use process.env',
  },
  {
    code: 'E-OBS-01',
    pattern: /\bconsole\.(log|debug)\b/,
    message: 'console.log detected — use structured logger',
  },
  {
    code: 'E-ZONE-01',
    pattern: /FROZEN/,
    message: 'File references FROZEN zone — verify no modification to FROZEN files',
    filePatternFilter: null, // applies to all
  },
];

/**
 * Scan a list of file paths for quality violations.
 * @param {string[]} filePaths — absolute paths of files written by agent
 * @param {string} agentName — for log context (e.g. 'developer', 'qa_fixer')
 * @returns {{ violations: Array<{file, line, code, message}>, clean: boolean }}
 */
function checkFiles(filePaths, agentName = 'unknown') {
  const violations = [];

  for (const filePath of filePaths) {
    if (!filePath.endsWith('.js') && !filePath.endsWith('.ts')) continue;
    if (!fs.existsSync(filePath)) continue;

    // Skip test files for some checks
    const isTestFile = /\.(test|spec)\.[tj]s$/.test(filePath);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');

    lines.forEach((line, i) => {
      for (const check of CHECKS) {
        if (check.code === 'E-OBS-01' && isTestFile) continue; // console.log ok in tests
        if (check.pattern.test(line)) {
          violations.push({
            file: path.relative(process.cwd(), filePath),
            line: i + 1,
            code: check.code,
            message: check.message,
          });
        }
      }
    });
  }

  if (violations.length > 0) {
    logger.warn(
      { agentName, violations },
      `[CodeQualityChecker] ${violations.length} violation(s) detected in ${agentName} output`
    );
  } else {
    logger.debug({ agentName }, '[CodeQualityChecker] Clean — no violations detected');
  }

  return { violations, clean: violations.length === 0 };
}

module.exports = { checkFiles };
```

BƯỚC 2 — Gọi checkFiles trong TaskExecutor.js:
Sau khi Developer agent ghi file và trước khi commit (sau step validate/lint),
thêm:
  const { checkFiles } = require('./CodeQualityChecker');
  const writtenFiles = /* lấy danh sách files vừa được write — xem git diff hoặc track từ agent output */;
  checkFiles(writtenFiles, 'developer');

Nếu TaskExecutor không track danh sách files cụ thể, có thể dùng git diff để lấy:
  const { execSync } = require('child_process');
  const changedFiles = execSync('git diff --name-only HEAD', { cwd: worktreePath })
    .toString().trim().split('\n')
    .map(f => path.join(worktreePath, f));
  checkFiles(changedFiles, 'developer');

BƯỚC 3 — Gọi checkFiles trong QARunner.js:
Tương tự, sau khi QA Fixer chạy và trước FROZEN restore check, thêm:
  const { checkFiles } = require('./CodeQualityChecker');
  // lấy files changed sau QA fix (git diff từ worktree)
  checkFiles(qaChangedFiles, 'qa_fixer');

GHI CHÚ QUAN TRỌNG:
- checkFiles chỉ LOG violations (advisory), KHÔNG throw, KHÔNG block pipeline.
- Violations sẽ xuất hiện trong logs và có thể được Reviewer/QA xem.
- Đây là lưới an toàn sớm hơn Gate 4, không thay thế Gate 4.

VERIFY:
  ls packages/backend/src/services/orchestrator/CodeQualityChecker.js
  node -e "const c = require('./packages/backend/src/services/orchestrator/CodeQualityChecker'); console.log(c.checkFiles([]))"
  grep -n "CodeQualityChecker\|checkFiles" packages/backend/src/services/orchestrator/TaskExecutor.js
  grep -n "CodeQualityChecker\|checkFiles" packages/backend/src/services/orchestrator/QARunner.js

Expected: File tồn tại, require không throw error, 2 files orchestrator có import và call.

========================================================
TASK F — Chuẩn hóa project-brief validation trong Reception (LOW)
========================================================

File: packages/backend/src/services/claude/promptBuilder.js

MỤC ĐÍCH: Reception agent hiện tại nhận project-brief tự do format.
Thêm một đoạn check vào buildReceptionPrompt để nhắc AI flag nếu brief thiếu
các sections quan trọng.

THAY ĐỔI:
Tìm method buildReceptionPrompt trong promptBuilder.js.
Trong REASONING block (hoặc cuối instruction section nếu không có REASONING),
thêm đoạn:

## BRIEF COMPLETENESS CHECK
Before analyzing requirements, verify the project brief contains these essential sections.
Flag as WARNING (not blocking) if any are missing:
- [ ] Stack / Technology declaration
- [ ] Folder structure or module boundaries
- [ ] Data zones or zone classification (FROZEN/GUARDED/FLUID files)
- [ ] Explicit constraints or "NOT ALLOWED" rules
- [ ] Definition of Done criteria

If a section is missing, include it in your receptionReport.gaps[] array with
message: "project-brief missing section: [section name]"

VERIFY:
  grep -n "BRIEF COMPLETENESS\|brief.*missing\|missing.*section" \
    packages/backend/src/services/claude/promptBuilder.js

Expected: Đoạn BRIEF COMPLETENESS CHECK có trong buildReceptionPrompt.

========================================================
FINAL VERIFICATION — Chạy sau khi hoàn thành tất cả tasks
========================================================

Chạy lần lượt và báo kết quả từng lệnh:

1. grep -n "sprintNumber" packages/backend/src/services/claude/promptBuilder.js | grep -i review
2. grep -n "parseClaudeOutput" packages/backend/src/services/orchestrator/BugfixRunner.js
3. grep -rn "LAN\|LOI GOC\|QUY TRINH BAT BUOC" packages/backend/src/services/
4. grep -n "notif" packages/backend/src/services/orchestrator/IntegrationVerifier.js
5. ls packages/backend/src/services/orchestrator/CodeQualityChecker.js
6. grep -n "BRIEF COMPLETENESS" packages/backend/src/services/claude/promptBuilder.js

Expected results:
1. Có ít nhất 1 dòng chứa sprintNumber trong buildReviewPrompt
2. Ít nhất 2 calls có schema name (bugDiagnose/bugFix) thay vì null
3. 0 kết quả
4. Có notif.send trong catch block
5. File tồn tại
6. Có BRIEF COMPLETENESS CHECK text
```

---

## GHI CHÚ

| Task | Priority | Impact | Effort |
|------|----------|--------|--------|
| A — Reviewer + TCR context | MEDIUM | +0.2 score | Trung bình |
| B — BugfixRunner schemas | LOW | Validation coverage | Thấp |
| C — Vietnamese cleanup | LOW | Code consistency | Thấp |
| D — IntegrationVerifier notify | LOW | PO visibility | Thấp |
| E — CodeQualityChecker hook | HIGH | Catch lỗi sớm hơn 2 gates | Trung bình |
| F — Brief completeness check | LOW | Context quality | Thấp |

Task A và E có giá trị nhất. Nếu chỉ có thời gian cho 2 tasks, ưu tiên A và E.

**Sau khi hoàn thành 6 tasks này, hệ thống đạt ~9.7/10.**

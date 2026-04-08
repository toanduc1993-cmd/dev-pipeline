# VSCode Prompt — Implement AGENT_RULES v2
> Copy toàn bộ nội dung này vào VSCode để thực hiện

---

Đọc file `AGENT_RULES-v2.md` trong thư mục gốc project, sau đó đọc `packages/backend/src/services/claude/promptBuilder.js`. Thực hiện tuần tự 7 tasks sau:

---

## TASK 1 — Thêm 8 AGENT_PROFILES còn thiếu

Tìm constant `AGENT_PROFILES` trong `promptBuilder.js` (hiện có 5 keys: reception, architect, developer, reviewer, qa). Thêm 8 entries sau vào cuối object đó:

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
  cannotSee: 'previous fix attempts (neu la lan dau), fix results — phan tich tu dau',
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

## TASK 2 — Thêm `_agentHeader()` vào 8 methods đang thiếu

Với mỗi method dưới đây, thêm dòng header vào đầu return string (ngay sau dấu backtick mở):

| Method | Thêm vào đầu |
|--------|-------------|
| `buildFeatureSpecPrompt()` | `${this._agentHeader('spec_writer')}\n` |
| `buildAtomicTaskPrompt()` | `${this._agentHeader('task_planner')}\n` |
| `buildIntegrationVerifyPrompt()` | `${this._agentHeader('integration_verifier')}\n` |
| `buildIntegrationFixPrompt()` | `${this._agentHeader('integration_fixer')}\n` |
| `buildContractCheckPrompt()` | `${this._agentHeader('contract_checker')}\n` |

Với 3 bugfix methods, **xóa** inline block `## AGENT IDENTITY ... Role: X` rồi **thay** bằng:

| Method | Xóa inline block có text | Thay bằng |
|--------|--------------------------|-----------|
| `buildBugDiagnosePrompt()` | `Role: Diagnostician (doc lap)` | `${this._agentHeader('diagnostician')}` |
| `buildBugFixPrompt()` | `Role: Fixer (doc lap)` | `${this._agentHeader('fixer')}` |
| `buildBugVerifyPrompt()` | `Role: Verifier (doc lap)` | `${this._agentHeader('verifier')}` |

---

## TASK 3 — Migrate `_getMaster()` → `_getOptimizedContext()` trong 3 methods

Trong 3 methods sau, tìm dòng `const master = this._getMaster();` và thay bằng `const master = this._getOptimizedContext(sprintNumber);`:

1. `buildArchitectPrompt({ requirement, sprintNumber })`
2. `buildFeatureSpecPrompt({ architectOutput, sprintNumber })`
3. `buildAtomicTaskPrompt({ featureSpecs, sprintNumber })`

---

## TASK 4 — Thêm chain-of-thought vào Reception prompt

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

## TASK 5 — Thêm verdict rules vào Reviewer prompt

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

## TASK 6 — Thêm blocking rules vào Contract Checker prompt

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

## TASK 7 — Thêm syntaxCheckResults vào Fixer output

Trong `buildBugFixPrompt()`, tìm output JSON schema. Thêm field sau VÀO SAU `"filesSkipped"`:

```json
"syntaxCheckResults": [{ "file": "string", "passed": true }],
```

---

## VERIFICATION — Chạy sau khi hoàn thành tất cả

```bash
# 1. Syntax check
node --check packages/backend/src/services/claude/promptBuilder.js

# 2. Smoke test profiles
node --input-type=module << 'EOF'
import { PromptBuilder } from './packages/backend/src/services/claude/promptBuilder.js';
const pb = new PromptBuilder('/tmp', {});
const required = ['spec_writer','task_planner','integration_verifier','integration_fixer','contract_checker','diagnostician','fixer','verifier'];
let ok = true;
for (const key of required) {
  const h = pb._agentHeader(key);
  if (!h || h.trim() === '') { console.error('MISSING:', key); ok = false; }
  else console.log('OK:', key);
}
if (ok) console.log('\nAll 8 new profiles verified.');
EOF

# 3. Chạy test nếu có
npm test --prefix packages/backend 2>/dev/null || echo "No tests configured"
```

Báo cáo kết quả: số methods đã update, số profiles đã thêm, output của smoke test.

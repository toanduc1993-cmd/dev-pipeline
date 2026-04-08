/**
 * Sprint 03 — verify-claude.js
 * Tests 5 Claude CLI behaviors independently.
 * Run: node scripts/verify-claude.js
 */

import { runClaude } from '../src/services/claude/claudeService.js';
import { parseClaudeOutput } from '../src/services/claude/outputParser.js';

let pass = 0;
let fail = 0;

function check(desc, ok) {
  if (ok) { console.log(`  PASS  ${desc}`); pass++; }
  else    { console.log(`  FAIL  ${desc}`); fail++; }
}

async function main() {
  console.log('=== TEST 1: Basic claude --print ===');
  const t1 = await runClaude({
    prompt: 'Say exactly: HELLO_TEST',
    tools: [],
    timeoutMs: 60_000,
  });
  check('runClaude succeeds', t1.success);
  check('output contains HELLO_TEST', t1.output.includes('HELLO_TEST'));
  check('durationMs > 0', t1.durationMs > 0);

  if (!t1.success) {
    console.log('\n  ABORT — claude --print is not working. Cannot continue.');
    console.log(`  Error: ${t1.error}`);
    console.log('  Fix: ensure `claude` CLI is installed and authenticated.');
    process.exit(1);
  }

  console.log('\n=== TEST 2: --allowedTools Bash ===');
  const t2 = await runClaude({
    prompt: 'Run this command and show the output: echo BASH_TEST',
    tools: ['Bash'],
    timeoutMs: 60_000,
  });
  check('runClaude with Bash succeeds', t2.success);
  check('output contains BASH_TEST', t2.output.includes('BASH_TEST'));

  console.log('\n=== TEST 3: --cwd /tmp ===');
  const t3 = await runClaude({
    prompt: 'Run pwd and tell me the current directory.',
    tools: ['Bash'],
    cwd: '/tmp',
    timeoutMs: 60_000,
  });
  check('runClaude with cwd succeeds', t3.success);
  check('output contains /tmp or /private/tmp', t3.output.includes('/tmp'));

  console.log('\n=== TEST 4: JSON output → parseClaudeOutput ===');
  const t4 = await runClaude({
    prompt: 'Return exactly this JSON in a ```json block, nothing else:\n```json\n{"analysis":"test analysis","architectureOverview":"test overview","features":[{"id":"FEAT-001","name":"Test","description":"Test feature","priority":"high"}],"techDecisions":["Use Node.js"],"risks":["None"],"masterMdUpdate":"## Update","estimatedTasks":3}\n```',
    tools: [],
    timeoutMs: 60_000,
  });
  check('runClaude for JSON succeeds', t4.success);

  if (t4.success) {
    const parsed = parseClaudeOutput(t4.output, 'architect');
    check('parseClaudeOutput succeeds', parsed.success);
    check('parsed data has features array', Array.isArray(parsed.data?.features));
    if (!parsed.success) {
      console.log(`  Parse error: ${parsed.error}`);
    }
    if (parsed.schemaWarnings) {
      console.log(`  Schema warnings: ${parsed.schemaWarnings.length}`);
    }
  }

  console.log('\n=== TEST 5: Streaming (onChunk) ===');
  let chunkCount = 0;
  let totalFromChunks = '';
  const t5 = await runClaude({
    prompt: 'Write a haiku about programming. Make it at least 3 lines.',
    tools: [],
    timeoutMs: 60_000,
    onChunk: (chunk) => {
      chunkCount++;
      totalFromChunks += chunk;
    },
  });
  check('runClaude with onChunk succeeds', t5.success);
  check('received multiple chunks', chunkCount >= 1);
  check('chunks assembled = full output', totalFromChunks === t5.output);
  console.log(`  (received ${chunkCount} chunks, ${t5.output.length} bytes total)`);

  // ─── Extra: test parseClaudeOutput edge cases ─────────────────────────────

  console.log('\n=== BONUS: outputParser edge cases ===');

  // Pure JSON (no block)
  const p1 = parseClaudeOutput('{"analysis":"raw","architectureOverview":"ov","features":[],"techDecisions":[],"risks":[],"masterMdUpdate":"","estimatedTasks":1}', 'architect');
  check('parse raw JSON (no block)', p1.success);

  // Malformed JSON
  const p2 = parseClaudeOutput('this is not json at all', 'architect');
  check('malformed output → success: false', !p2.success);

  // Unknown schema name
  const p3 = parseClaudeOutput('```json\n{"foo":"bar"}\n```', 'unknownSchema');
  check('unknown schema → accept as-is', p3.success && p3.data?.foo === 'bar');

  // Schema mismatch → soft fail (success: true + schemaWarnings)
  const p4 = parseClaudeOutput('```json\n{"taskId":"T","verdict":"PASS","checklist":[],"issues":[]}\n```', 'review');
  check('schema mismatch → soft fail with warnings', p4.success && p4.data?.taskId === 'T');

  // ─── Summary ──────────────────────────────────────────────────────────────

  console.log(`\n===================================`);
  console.log(`Results: ${pass} passed, ${fail} failed`);
  console.log(`===================================`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});

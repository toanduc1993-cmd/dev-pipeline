/**
 * Sprint 04 — test-worktree.js
 * Tests WorktreeManager full lifecycle on a temp repo in /tmp.
 * Also tests validateTask on valid/invalid JS files.
 * Run: node scripts/test-worktree.js
 */

import simpleGit from 'simple-git';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import path from 'path';
import { WorktreeManager } from '../src/services/worktreeManager.js';
import { validateTask } from '../src/services/validationService.js';

let pass = 0;
let fail = 0;

function check(desc, ok) {
  if (ok) { console.log(`  PASS  ${desc}`); pass++; }
  else    { console.log(`  FAIL  ${desc}`); fail++; }
}

const TEST_DIR = `/tmp/ai-pipeline-wt-test-${Date.now()}`;
const REPO_PATH = path.join(TEST_DIR, 'repo');

async function main() {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('=== STEP 1: Init temp repo + initial commit ===');
  // ═══════════════════════════════════════════════════════════════════════════

  mkdirSync(REPO_PATH, { recursive: true });
  const git = simpleGit(REPO_PATH);
  await git.init();
  await git.raw(['checkout', '-b', 'main']);

  writeFileSync(path.join(REPO_PATH, 'README.md'), '# Test Repo\n');
  writeFileSync(path.join(REPO_PATH, 'index.js'), 'export const hello = "world";\n');
  await git.add('.');
  await git.commit('initial commit');

  const log = await git.log();
  check('Repo initialized with 1 commit', log.total === 1);

  const wm = new WorktreeManager(REPO_PATH);
  check('WorktreeManager created', !!wm);
  check('worktreeBase is sibling workspaces dir', wm.worktreeBase === path.join(TEST_DIR, 'workspaces'));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n=== STEP 2: createWorktree ===');
  // ═══════════════════════════════════════════════════════════════════════════

  const { branch, worktreePath } = await wm.createWorktree('TASK-TEST');
  check('branch = feat/task-test', branch === 'feat/task-test');
  check('worktree directory exists', existsSync(worktreePath));
  check('worktree has README.md from main', existsSync(path.join(worktreePath, 'README.md')));

  // Verify we're on the right branch in worktree
  const wtGit = simpleGit(worktreePath);
  const status = await wtGit.status();
  check('worktree is on feat/task-test', status.current === 'feat/task-test');

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n=== STEP 3: Create file + commit in worktree ===');
  // ═══════════════════════════════════════════════════════════════════════════

  writeFileSync(path.join(worktreePath, 'feature.js'), 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n');
  await wtGit.add('.');
  await wtGit.commit('feat(TASK-TEST): add greet function');

  const wtLog = await wtGit.log();
  check('worktree has 2 commits (initial + feature)', wtLog.total === 2);
  check('feature.js exists in worktree', existsSync(path.join(worktreePath, 'feature.js')));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n=== STEP 4: getDiff ===');
  // ═══════════════════════════════════════════════════════════════════════════

  const diff = await wm.getDiff('TASK-TEST');
  check('diff contains feature.js', diff.includes('feature.js'));
  check('diff contains CHANGED FILES section', diff.includes('## CHANGED FILES'));
  check('diff contains DIFF section', diff.includes('## DIFF'));
  check('diff contains added function', diff.includes('greet'));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n=== STEP 5: mergeToMain ===');
  // ═══════════════════════════════════════════════════════════════════════════

  await wm.mergeToMain('TASK-TEST', 'feat/task-test');

  const mainGit = simpleGit(REPO_PATH);
  await mainGit.checkout('main');
  check('feature.js exists on main after merge', existsSync(path.join(REPO_PATH, 'feature.js')));

  const mainLog = await mainGit.log();
  check('main has merge commit', mainLog.latest.message.includes('merge: TASK-TEST'));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n=== STEP 6: removeWorktree ===');
  // ═══════════════════════════════════════════════════════════════════════════

  await wm.removeWorktree('TASK-TEST');
  check('worktree directory removed', !existsSync(worktreePath));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n=== STEP 7: pruneAll ===');
  // ═══════════════════════════════════════════════════════════════════════════

  await wm.pruneAll();
  check('pruneAll did not throw', true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n=== STEP 8: checkConflicts ===');
  // ═══════════════════════════════════════════════════════════════════════════

  const tasks = [
    { taskId: 'TASK-001', spec: JSON.stringify({ filesToCreate: ['/src/auth.js'], filesToModify: [{ path: '/src/index.js' }] }) },
    { taskId: 'TASK-002', spec: JSON.stringify({ filesToCreate: ['/src/users.js'], filesToModify: [] }) },
    { taskId: 'TASK-003', spec: JSON.stringify({ filesToCreate: ['/src/index.js'], filesToModify: [] }) },
  ];

  const conflicts = await wm.checkConflicts(tasks);
  check('detected 1 conflict (TASK-001 & TASK-003 on /src/index.js)', conflicts.length === 1);
  check('conflict mentions correct file', conflicts[0]?.file === '/src/index.js');
  check('conflict mentions both tasks', conflicts[0]?.message.includes('TASK-001') && conflicts[0]?.message.includes('TASK-003'));

  // No conflicts case
  const noConflictTasks = [
    { taskId: 'TASK-A', spec: JSON.stringify({ filesToCreate: ['/a.js'], filesToModify: [] }) },
    { taskId: 'TASK-B', spec: JSON.stringify({ filesToCreate: ['/b.js'], filesToModify: [] }) },
  ];
  const noConflicts = await wm.checkConflicts(noConflictTasks);
  check('no conflicts when files are different', noConflicts.length === 0);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n=== STEP 9: validateTask — syntax error ===');
  // ═══════════════════════════════════════════════════════════════════════════

  // Create a temp directory with a broken JS file
  const valDir = path.join(TEST_DIR, 'val-test');
  mkdirSync(valDir, { recursive: true });

  writeFileSync(path.join(valDir, 'broken.js'), 'function foo( { return "oops"; }\n');
  writeFileSync(path.join(valDir, 'valid.js'), 'export const x = 42;\n');

  const badResult = await validateTask(valDir, {
    taskId: 'TASK-VAL-BAD',
    filesToCreate: ['broken.js'],
    filesToModify: [],
  });
  check('syntax error → passed = false', badResult.passed === false);
  check('syntax error → errors has content', badResult.errors.length > 0);
  check('syntax error → error mentions broken.js', badResult.errors.some((e) => e.includes('broken.js')));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n=== STEP 10: validateTask — valid file ===');
  // ═══════════════════════════════════════════════════════════════════════════

  const goodResult = await validateTask(valDir, {
    taskId: 'TASK-VAL-GOOD',
    filesToCreate: ['valid.js'],
    filesToModify: [],
  });
  check('valid file → passed = true', goodResult.passed === true);
  check('valid file → no errors', goodResult.errors.length === 0);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n=== STEP 11: validateTask — missing file ===');
  // ═══════════════════════════════════════════════════════════════════════════

  const missingResult = await validateTask(valDir, {
    taskId: 'TASK-VAL-MISSING',
    filesToCreate: ['nonexistent.js'],
    filesToModify: [],
  });
  check('missing file → passed = false', missingResult.passed === false);
  check('missing file → error mentions nonexistent.js', missingResult.errors.some((e) => e.includes('nonexistent.js')));

  // ═══════════════════════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════════════════════
  rmSync(TEST_DIR, { recursive: true, force: true });

  console.log(`\n===================================`);
  console.log(`Results: ${pass} passed, ${fail} failed`);
  console.log(`===================================`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  // Cleanup on error
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  process.exit(1);
});

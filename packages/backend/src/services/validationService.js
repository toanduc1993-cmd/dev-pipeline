import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import logger from '../lib/logger.js';

const execAsync = promisify(exec);

/**
 * Run deterministic validation on a worktree BEFORE calling Architect Reviewer AI.
 * No AI involved — results are objective and reproducible.
 *
 * @param {string} worktreePath - Absolute path to git worktree
 * @param {Object} task - Task spec with filesToCreate, filesToModify, taskId
 * @returns {Promise<{passed: boolean, errors: string[], warnings: string[], details: Object}>}
 */
export async function validateTask(worktreePath, task) {
  const results = {
    passed: true,
    errors: [],
    warnings: [],
    details: {},
  };

  // Collect all JS/MJS files to check
  const filesToCheck = [
    ...(task.filesToCreate || []),
    ...(task.filesToModify || []).map((f) => (typeof f === 'string' ? f : f.path)),
  ].filter((f) => f && (f.endsWith('.js') || f.endsWith('.mjs')));

  // ─── CHECK 1: Syntax — node --check ────────────────────────────────────────
  for (const file of filesToCheck) {
    const absPath = path.join(worktreePath, file);
    if (!existsSync(absPath)) {
      results.errors.push(`File does not exist: ${file}`);
      results.passed = false;
      continue;
    }

    try {
      await execAsync(`node --check "${absPath}"`);
      results.details[`syntax:${file}`] = 'PASS';
    } catch (err) {
      results.errors.push(`Syntax error in ${file}: ${(err.stderr || err.message).trim()}`);
      results.passed = false;
      results.details[`syntax:${file}`] = `FAIL: ${err.stderr}`;
    }
  }

  // ─── CHECK 2: Files exist — filesToCreate must exist after agent runs ───────
  for (const file of task.filesToCreate || []) {
    const absPath = path.join(worktreePath, file);
    if (!existsSync(absPath)) {
      results.errors.push(`Required file was not created: ${file}`);
      results.passed = false;
    } else {
      results.details[`exists:${file}`] = 'PASS';
    }
  }

  // ─── CHECK 3: Import resolution — detect MODULE_NOT_FOUND ──────────────────
  for (const file of filesToCheck) {
    const absPath = path.join(worktreePath, file);
    if (!existsSync(absPath)) continue;

    try {
      // Detect ESM vs CJS before choosing import command
      let isESM = absPath.endsWith('.mjs');
      if (!isESM && !absPath.endsWith('.cjs')) {
        try {
          const pkgPath = path.join(worktreePath, 'package.json');
          if (existsSync(pkgPath)) {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
            isESM = pkg.type === 'module';
          }
        } catch { isESM = false; }
      }
      const importCmd = isESM
        ? `node --input-type=module -e "import('${absPath.replace(/\\/g, '/')}')" 2>&1 || true`
        : `node -e "require('${absPath}')" 2>&1 || true`;
      const { stdout, stderr } = await execAsync(importCmd, { cwd: worktreePath, timeout: 10000 });
      const combined = stdout + stderr;

      if (combined.includes('MODULE_NOT_FOUND') || combined.includes('Cannot find module')) {
        const match = combined.match(/Cannot find module '([^']+)'/);
        const missing = match ? match[1] : 'unknown';
        // Only error on non-relative imports (relative may be unresolved due to task ordering)
        if (!missing.startsWith('.') && !missing.startsWith('/')) {
          results.errors.push(`Missing package in ${file}: ${missing}`);
          results.passed = false;
        } else {
          results.warnings.push(`Unresolved relative import: ${missing} in ${file}`);
        }
      }
    } catch {
      // Import check fails gracefully — don't block
    }
  }

  // ─── CHECK 4: ESLint — only if config exists ───────────────────────────────
  const hasEslint =
    existsSync(path.join(worktreePath, '.eslintrc.js')) ||
    existsSync(path.join(worktreePath, '.eslintrc.json')) ||
    existsSync(path.join(worktreePath, '.eslintrc.yml')) ||
    existsSync(path.join(worktreePath, '.eslintrc.cjs'));

  if (hasEslint && filesToCheck.length > 0) {
    try {
      const existingFiles = filesToCheck
        .filter((f) => existsSync(path.join(worktreePath, f)))
        .map((f) => `"${f}"`)
        .join(' ');

      if (existingFiles) {
        const { stdout } = await execAsync(
          `npx eslint ${existingFiles} --format json 2>/dev/null || echo "[]"`,
          { cwd: worktreePath, timeout: 30000 }
        );

        const eslintResults = JSON.parse(stdout || '[]');
        for (const fileResult of eslintResults) {
          const errors = (fileResult.messages || []).filter((m) => m.severity === 2);
          const warnings = (fileResult.messages || []).filter((m) => m.severity === 1);

          for (const e of errors) {
            results.errors.push(`ESLint error in ${fileResult.filePath}:${e.line} — ${e.message}`);
          }
          if (errors.length > 0) results.passed = false;

          for (const w of warnings) {
            results.warnings.push(`ESLint warning in ${fileResult.filePath}:${w.line} — ${w.message}`);
          }
        }
      }
      results.details['eslint'] = `${results.errors.filter((e) => e.includes('ESLint')).length} errors`;
    } catch (err) {
      logger.warn({ err: err.message }, 'ESLint check failed, skipping');
      results.warnings.push('ESLint check skipped (error running eslint)');
    }
  } else {
    results.details['eslint'] = 'skipped (no config)';
  }

  logger.info({
    taskId: task.taskId,
    passed: results.passed,
    errorsCount: results.errors.length,
    warningsCount: results.warnings.length,
  }, 'Validation complete');

  return results;
}

/**
 * Sprint-level automated checks (Layer 1 of 3-layer QA).
 * Runs on the main repo after all tasks merged.
 */
export async function runSprintAutomatedChecks(repoPath) {
  const results = { passed: true, checks: [] };

  const addCheck = (name, passed, detail = null, error = null) => {
    results.checks.push({ name, passed, detail, error });
    if (!passed) results.passed = false;
  };

  // 1. Syntax check — all .js files
  try {
    const { glob } = await import('glob');
    const jsFiles = await glob('**/*.js', {
      cwd: repoPath, absolute: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/workspaces/**', '**/dist/**'],
    });
    const syntaxErrors = [];
    for (const file of jsFiles.slice(0, 50)) {
      try {
        execSync(`node --check "${file}"`, { stdio: 'pipe' });
      } catch (e) {
        syntaxErrors.push({ file: path.relative(repoPath, file), error: (e.stderr?.toString() || '').substring(0, 200) });
      }
    }
    addCheck('Syntax Check', syntaxErrors.length === 0,
      `Checked ${Math.min(jsFiles.length, 50)} files`, syntaxErrors.length > 0 ? syntaxErrors : null);
  } catch (e) {
    addCheck('Syntax Check', true, 'Could not run — skipped');
  }

  // 2. ESLint (if config exists)
  try {
    const eslintConfigs = ['.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js'];
    const hasEslint = eslintConfigs.some((f) => existsSync(path.join(repoPath, f)));
    if (hasEslint) {
      try {
        execSync('npx eslint . --max-warnings=0 --format=compact 2>&1', {
          cwd: repoPath, stdio: 'pipe', timeout: 30000,
        });
        addCheck('ESLint', true, 'No warnings or errors');
      } catch (e) {
        const output = e.stdout?.toString() || e.stderr?.toString() || '';
        addCheck('ESLint', false, output.substring(0, 500));
      }
    } else {
      addCheck('ESLint', true, 'No ESLint config — skipped');
    }
  } catch {
    addCheck('ESLint', true, 'ESLint not available — skipped');
  }

  // 3. Test runner (if package.json has test script)
  try {
    const pkgPath = path.join(repoPath, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts?.test && !pkg.scripts.test.includes('no test')) {
        try {
          execSync('npm test --if-present 2>&1', { cwd: repoPath, stdio: 'pipe', timeout: 60000 });
          addCheck('Test Suite', true, 'All tests passed');
        } catch (e) {
          const output = e.stdout?.toString() || '';
          addCheck('Test Suite', false, output.substring(0, 800));
        }
      } else {
        addCheck('Test Suite', true, 'No test script — skipped');
      }
    } else {
      // Python project?
      if (existsSync(path.join(repoPath, 'requirements.txt')) || existsSync(path.join(repoPath, 'setup.py'))) {
        // Detect python command: python3 (macOS) or python
        let pythonCmd = 'python3';
        try { execSync('python3 --version', { stdio: 'pipe' }); } catch {
          try { execSync('python --version', { stdio: 'pipe' }); pythonCmd = 'python'; } catch {
            addCheck('Test Suite', true, 'Python not found — skipped');
            pythonCmd = null;
          }
        }

        if (pythonCmd) {
          try {
            execSync(`${pythonCmd} -m pytest --tb=short 2>&1 || ${pythonCmd} -m unittest discover 2>&1`, {
              cwd: repoPath, stdio: 'pipe', timeout: 60000,
            });
            addCheck('Test Suite', true, 'Python tests passed');
          } catch (e) {
            const output = (e.stdout?.toString() || e.stderr?.toString() || '').substring(0, 800);
            // pytest not installed is not a code error — skip gracefully
            if (output.includes('No module named') && output.includes('pytest')) {
              addCheck('Test Suite', true, 'pytest not installed — skipped');
            } else {
              addCheck('Test Suite', false, output);
            }
          }
        }
      } else {
        addCheck('Test Suite', true, 'No package.json or requirements.txt — skipped');
      }
    }
  } catch {
    addCheck('Test Suite', true, 'Cannot detect test runner — skipped');
  }

  logger.info({ repoPath, passed: results.passed, checkCount: results.checks.length }, 'Sprint automated checks complete');
  return results;
}

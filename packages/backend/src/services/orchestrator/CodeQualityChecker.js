/**
 * Post-write code quality checker.
 * Scans modified JS/TS/Python files for common violations after agent writes.
 * Advisory only — logs warnings, does NOT throw or block pipeline.
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import logger from '../../lib/logger.js';

const CHECKS = [
  { code: 'E-BE-01', pattern: /\b(readFileSync|writeFileSync|execSync|readdirSync)\b/, message: 'Sync I/O — use async variant' },
  { code: 'E-BE-02', pattern: /catch\s*\([^)]*\)\s*\{\s*\}/, message: 'Empty catch block — wrap error with context' },
  { code: 'E-BE-03', pattern: /(['"])(sk[_-]|ghp_|AKIA)/, message: 'Possible hardcoded secret — use process.env' },
  { code: 'E-OBS-01', pattern: /\bconsole\.(log|debug)\b/, message: 'console.log — use structured logger' },
];

export function checkFiles(filePaths = [], agentName = 'unknown') {
  const violations = [];
  for (const filePath of filePaths) {
    if (!/\.[tjp][sy]?$/.test(filePath)) continue;
    if (!existsSync(filePath)) continue;
    const isTestFile = /\.(test|spec)\.[tj]s$/.test(filePath) || /test_/.test(path.basename(filePath));
    let content;
    try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      for (const check of CHECKS) {
        if (check.code === 'E-OBS-01' && isTestFile) continue;
        if (check.pattern.test(line)) {
          violations.push({ file: path.relative(process.cwd(), filePath), line: i + 1, code: check.code, message: check.message });
        }
      }
    });
  }
  if (violations.length > 0) {
    logger.warn({ agentName, violationCount: violations.length, violations: violations.slice(0, 10) }, `[CodeQualityChecker] ${violations.length} violation(s) in ${agentName} output`);
  } else {
    logger.debug({ agentName }, '[CodeQualityChecker] Clean');
  }
  return { violations, clean: violations.length === 0 };
}

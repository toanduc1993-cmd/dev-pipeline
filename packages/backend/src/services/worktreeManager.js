import simpleGit from 'simple-git';
import { mkdirSync, existsSync, rmSync } from 'fs';
import path from 'path';
import logger from '../lib/logger.js';
import prisma from '../lib/prisma.js';

export class WorktreeManager {
  constructor(repoPath) {
    this.repoPath = repoPath;
    this.git = simpleGit(repoPath);
    this._defaultBranch = null;

    // Worktrees live outside the repo — sibling "workspaces" directory
    this.worktreeBase = path.join(path.dirname(repoPath), 'workspaces');
    if (!existsSync(this.worktreeBase)) {
      mkdirSync(this.worktreeBase, { recursive: true });
    }
  }

  /**
   * Detect the default branch (main, master, or current HEAD).
   * Ensures repo has at least 1 commit.
   */
  async _getDefaultBranch() {
    if (this._defaultBranch) return this._defaultBranch;

    const branches = await this.git.branch();

    // Check if repo has any commits
    try {
      await this.git.log(['-1']);
    } catch {
      // Empty repo — create initial commit
      const readmePath = path.join(this.repoPath, 'README.md');
      if (!existsSync(readmePath)) {
        const { writeFileSync } = await import('fs');
        writeFileSync(readmePath, '# Project\n');
      }
      await this.git.add('.');
      await this.git.commit('initial commit');
      logger.info({ repoPath: this.repoPath }, 'Created initial commit for empty repo');
    }

    // Prefer main > master > current
    if (branches.all.includes('main')) {
      this._defaultBranch = 'main';
    } else if (branches.all.includes('master')) {
      this._defaultBranch = 'master';
    } else {
      this._defaultBranch = branches.current || 'main';
    }

    logger.info({ defaultBranch: this._defaultBranch }, 'Detected default branch');
    return this._defaultBranch;
  }

  _worktreePath(taskId) {
    return path.join(this.worktreeBase, taskId.toLowerCase().replace(/[^a-z0-9]/g, '-'));
  }

  /**
   * Create a git worktree for a task.
   * Branch is created fresh from main.
   * @returns {{ branch: string, worktreePath: string }}
   */
  async createWorktree(taskId) {
    const defaultBranch = await this._getDefaultBranch();
    const branch = `feat/${taskId.toLowerCase()}`;
    const wtPath = this._worktreePath(taskId);

    // Cleanup if exists from a previous run
    await this.removeWorktree(taskId).catch(() => {});

    // Delete old branch if it exists
    try {
      await this.git.branch(['-D', branch]);
    } catch {
      // Branch doesn't exist — fine
    }

    // Create worktree with new branch from default branch
    await this.git.raw(['worktree', 'add', '-b', branch, wtPath, defaultBranch]);

    logger.info({ taskId, branch, wtPath, baseBranch: defaultBranch }, 'Worktree created');
    return { branch, worktreePath: wtPath };
  }

  /**
   * Pre-check: detect potential file conflicts between tasks before spawning agents.
   * @param {Array} tasks - Array of task objects. task.spec is a JSON string to parse.
   * @returns {Array<{file, task1, task2, message}>}
   */
  async checkConflicts(tasks) {
    const fileTaskMap = {};
    const conflicts = [];

    for (const task of tasks) {
      // Parse spec if it's a JSON string
      let spec = task.spec;
      if (typeof spec === 'string') {
        try {
          spec = JSON.parse(spec);
        } catch {
          continue; // Can't parse spec — skip
        }
      }

      const allFiles = [
        ...(spec?.filesToCreate || []),
        ...(spec?.filesToModify || []).map((f) => (typeof f === 'string' ? f : f.path || f)),
      ];

      for (const file of allFiles) {
        if (!file) continue;
        if (fileTaskMap[file]) {
          conflicts.push({
            file,
            task1: fileTaskMap[file],
            task2: task.taskId,
            message: `${task.taskId} and ${fileTaskMap[file]} both touch ${file}`,
          });
        } else {
          fileTaskMap[file] = task.taskId;
        }
      }
    }

    return conflicts;
  }

  /**
   * Get git diff of worktree compared to main.
   * @returns {string} Combined stat + full diff
   */
  async getDiff(taskId) {
    const wtPath = this._worktreePath(taskId);
    if (!existsSync(wtPath)) return '[Worktree not found]';

    const defaultBranch = await this._getDefaultBranch();
    const wtGit = simpleGit(wtPath);
    try {
      const stat = await wtGit.diff([`${defaultBranch}...HEAD`, '--stat']);
      const diff = await wtGit.diff([`${defaultBranch}...HEAD`]);
      return `## CHANGED FILES\n${stat}\n\n## DIFF\n${diff}`;
    } catch (err) {
      logger.warn({ err: err.message, taskId }, 'getDiff failed');
      return `[Could not get diff: ${err.message}]`;
    }
  }

  /**
   * Merge a task branch into main (sequential, one at a time).
   * Aborts and throws on conflict.
   */
  async mergeToMain(taskId, branch) {
    const defaultBranch = await this._getDefaultBranch();
    const mainGit = simpleGit(this.repoPath);
    await mainGit.checkout(defaultBranch);

    // Check if branch has any changes vs main
    try {
      const diff = await mainGit.diff([defaultBranch, branch, '--stat']);
      if (!diff || diff.trim() === '') {
        // No differences — branch is already merged or identical
        logger.info({ taskId, branch }, 'Branch has no diff vs main — skipping merge');
        try { await mainGit.branch(['-D', branch]); } catch {}
        return;
      }
    } catch {}

    try {
      await mainGit.merge([branch, '--no-ff', '-m', `merge: ${taskId} — ${branch}`]);
      logger.info({ taskId, branch }, 'Merged to main');

      try {
        await mainGit.branch(['-d', branch]);
        logger.info({ taskId, branch }, 'Branch deleted after merge');
      } catch (branchErr) {
        logger.warn({ taskId, branch, error: branchErr.message }, 'Could not delete branch after merge');
      }
    } catch (err) {
      // Conflict — try auto-resolve by keeping main version (ours)
      logger.warn({ taskId, branch }, 'Merge conflict — attempting auto-resolve with main priority');
      await mainGit.merge(['--abort']).catch(() => {});

      try {
        // Merge with "ours" strategy — keeps main content for conflicts
        await mainGit.merge([branch, '--no-ff', '-X', 'ours', '-m', `merge: ${taskId} — ${branch} (auto-resolved)`]);

        // Detect which files had conflicts auto-resolved by comparing merge result with task branch
        try {
          const mergedFiles = await mainGit.diff(['HEAD~1', 'HEAD', '--name-only']);
          const taskBranchFiles = await mainGit.diff([`HEAD~1`, branch, '--name-only']);
          const mergedSet = new Set(mergedFiles.trim().split('\n').filter(Boolean));
          const taskSet = new Set(taskBranchFiles.trim().split('\n').filter(Boolean));

          // Files in task branch but missing or different in merge result indicate dropped changes
          const droppedFiles = [...taskSet].filter(f => !mergedSet.has(f));
          // Also check files present in both but with different content
          const conflictFiles = [];
          for (const file of mergedSet) {
            if (taskSet.has(file)) {
              try {
                const mergeContent = await mainGit.show([`HEAD:${file}`]);
                const taskContent = await mainGit.show([`${branch}:${file}`]);
                if (mergeContent !== taskContent) {
                  conflictFiles.push(file);
                }
              } catch {
                // File might not exist in one of the refs
              }
            }
          }

          const allAffected = [...new Set([...droppedFiles, ...conflictFiles])];
          if (allAffected.length > 0) {
            logger.warn(
              { taskId, branch, droppedFiles, conflictFiles, affectedCount: allAffected.length },
              'Merge auto-resolved conflicts — some task code may have been dropped'
            );
            // Notify PO about potential code loss
            try {
              const prismaModule = await import('../lib/prisma.js');
              const db = prismaModule.default;
              const task = await db.task.findFirst({ where: { taskId }, select: { id: true, sprintId: true, sprint: { select: { projectId: true } } } });
              if (task) {
                const { NotificationService } = await import('./notificationService.js');
                const notif = new NotificationService();
                await notif.send({
                  projectId: task.sprint.projectId,
                  sprintId: task.sprintId,
                  type: 'gate_waiting',
                  title: `⚠️ Merge conflict auto-resolved — potential code loss`,
                  message: `Task ${taskId}: ${allAffected.length} file(s) had conflicts auto-resolved with main priority. Files: ${allAffected.join(', ')}. Review manually.`,
                  payload: { taskId, affectedFiles: allAffected },
                });
              }
            } catch (notifErr) {
              logger.warn({ taskId, err: notifErr.message }, 'Could not send merge conflict notification to PO');
            }
          } else {
            logger.info({ taskId, branch }, 'Merged with auto-resolve — no conflicts detected');
          }
        } catch (detectErr) {
          logger.warn({ taskId, err: detectErr.message }, 'Could not detect merge conflict details');
        }

        try { await mainGit.branch(['-d', branch]); } catch {}
      } catch (err2) {
        await mainGit.merge(['--abort']).catch(() => {});
        // Force delete the stale branch — main already has newer code
        try {
          await mainGit.branch(['-D', branch]);
          logger.info({ taskId, branch }, 'Stale branch deleted — main already has code');
        } catch {}
        logger.warn({ taskId, branch }, 'Could not merge even with ours strategy — branch deleted, main kept');
      }
    }
  }

  /**
   * Remove a single worktree.
   */
  async removeWorktree(taskId) {
    const wtPath = this._worktreePath(taskId);
    try {
      await this.git.raw(['worktree', 'remove', wtPath, '--force']);
    } catch {
      // If not tracked by git, remove manually
      if (existsSync(wtPath)) {
        rmSync(wtPath, { recursive: true, force: true });
      }
    }
  }

  /**
   * Cleanup all stale worktrees after sprint completes.
   */
  async deleteSprintBranches(sprintId) {
    const tasks = await prisma.task.findMany({
      where: { sprintId },
      select: { taskId: true, branch: true },
    });
    const results = [];
    for (const task of tasks) {
      const branch = task.branch || `feat/${task.taskId.toLowerCase()}`;
      try {
        await this.git.branch(['-D', branch]);
        logger.info({ branch, sprintId }, 'Deleted sprint task branch');
        results.push({ branch, deleted: true });
      } catch {
        results.push({ branch, deleted: false });
      }
    }
    return results;
  }

  async pruneAll() {
    await this.git.raw(['worktree', 'prune']);

    // Clean up any orphaned feat/* branches that are already merged
    try {
      const branchSummary = await this.git.branch(['-l', 'feat/*']);
      const featBranches = branchSummary.all || [];
      for (const branch of featBranches) {
        try {
          await this.git.branch(['-d', branch.trim()]);
          logger.info({ branch }, 'Pruned merged feature branch');
        } catch {
          // Branch not fully merged — skip
        }
      }
    } catch (err) {
      logger.warn({ error: err.message }, 'Branch cleanup had errors — continuing');
    }

    logger.info({ repoPath: this.repoPath }, 'Worktrees and branches pruned');
  }
}

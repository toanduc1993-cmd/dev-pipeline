import prisma from '../lib/prisma.js';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import simpleGit from 'simple-git';
import logger from '../lib/logger.js';

const PROJECTS_BASE = process.env.PROJECTS_BASE_PATH
  || path.join(process.cwd(), '..', '..', 'projects');

/**
 * Detect if input is a git URL (GitHub, GitLab, etc.)
 */
function isGitUrl(str) {
  return /^https?:\/\/.+\.git$/i.test(str)
    || /^https?:\/\/github\.com\/.+/i.test(str)
    || /^https?:\/\/gitlab\.com\/.+/i.test(str)
    || /^git@.+:.+/i.test(str);
}

/**
 * Extract repo name from URL for local directory name.
 * "https://github.com/user/my-repo" → "my-repo"
 * "https://github.com/user/my-repo.git" → "my-repo"
 */
function repoNameFromUrl(url) {
  const parts = url.replace(/\.git$/, '').split('/');
  return parts[parts.length - 1] || 'unnamed-repo';
}

// GET /api/projects
export async function listProjects(_req, res) {
  const projects = await prisma.project.findMany({
    where: { status: 'active' },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { sprints: true } } },
  });
  res.json(projects);
}

// POST /api/projects
export async function createProject(req, res) {
  const { name, description, repoUrl, repoPath: localPath, language } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  const input = repoUrl || localPath;
  if (!input) {
    return res.status(400).json({ error: 'repoUrl or repoPath is required' });
  }

  let finalRepoPath;

  if (isGitUrl(input)) {
    // Auto-clone from GitHub/GitLab URL
    const repoName = repoNameFromUrl(input);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Each project gets its own directory — even from same URL
    finalRepoPath = path.join(PROJECTS_BASE, `${repoName}-${slug}`);

    // If exact path already used by another project, add timestamp
    const existing = await prisma.project.findFirst({ where: { repoPath: finalRepoPath } });
    if (existing) {
      finalRepoPath = path.join(PROJECTS_BASE, `${repoName}-${slug}-${Date.now()}`);
    }

    if (!existsSync(PROJECTS_BASE)) {
      mkdirSync(PROJECTS_BASE, { recursive: true });
    }

    if (existsSync(finalRepoPath)) {
      // Directory exists but not used by another project — pull latest
      logger.info({ repoUrl: input, localPath: finalRepoPath }, 'Repo directory exists, pulling latest');
      try {
        const git = simpleGit(finalRepoPath);
        await git.pull();
      } catch (pullErr) {
        logger.warn({ error: pullErr.message }, 'Pull failed — continuing with existing');
      }
    } else {
      // Clone fresh
      logger.info({ repoUrl: input, localPath: finalRepoPath }, 'Cloning repository');
      try {
        await simpleGit().clone(input, finalRepoPath);
        logger.info({ finalRepoPath }, 'Clone completed');
      } catch (cloneErr) {
        return res.status(400).json({
          error: `Failed to clone repository: ${cloneErr.message}`,
        });
      }
    }

    // Ensure main branch exists
    try {
      const git = simpleGit(finalRepoPath);
      const branches = await git.branch();
      if (!branches.all.includes('main') && branches.all.includes('master')) {
        await git.checkout('master');
      } else if (branches.all.includes('main')) {
        await git.checkout('main');
      }
    } catch { /* ignore */ }
  } else {
    // Local path provided directly
    finalRepoPath = input;
    if (!existsSync(finalRepoPath)) {
      return res.status(400).json({ error: `Local path does not exist: ${finalRepoPath}` });
    }
  }

  // Auto-detect language from package.json / requirements.txt
  let detectedLang = language || 'javascript';
  if (!language) {
    if (existsSync(path.join(finalRepoPath, 'requirements.txt')) || existsSync(path.join(finalRepoPath, 'setup.py'))) {
      detectedLang = 'python';
    } else if (existsSync(path.join(finalRepoPath, 'tsconfig.json'))) {
      detectedLang = 'typescript';
    }
  }

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const project = await prisma.project.create({
    data: {
      name,
      slug,
      description: description || null,
      repoPath: finalRepoPath,
      language: detectedLang,
    },
  });

  res.status(201).json(project);
}

// GET /api/projects/scan-repos — scan local directories for git repos
export async function scanRepos(_req, res) {
  const { readdirSync, statSync } = await import('fs');

  const scanDirs = [
    process.env.PROJECTS_BASE_PATH || path.join(process.cwd(), '..', '..', 'projects'),
    path.join(process.env.HOME || '', 'Desktop', 'Projects'),
    path.join(process.env.HOME || '', 'Documents'),
    path.join(process.env.HOME || '', 'Developer'),
  ];

  const repos = [];
  for (const dir of scanDirs) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        try {
          if (!statSync(fullPath).isDirectory()) continue;
          if (existsSync(path.join(fullPath, '.git'))) {
            repos.push({ name: entry, path: fullPath, dir });
          }
        } catch {}
      }
    } catch {}
  }

  res.json(repos);
}

// GET /api/projects/:id
export async function getProject(req, res) {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: {
      sprints: { orderBy: { number: 'desc' }, take: 10 },
      _count: { select: { sprints: true, notifications: true } },
    },
  });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
}

// PUT /api/projects/:id
export async function updateProject(req, res) {
  const existing = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  const { name, description, repoPath, language, status } = req.body;
  const updated = await prisma.project.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(repoPath !== undefined && { repoPath }),
      ...(language !== undefined && { language }),
      ...(status !== undefined && { status }),
    },
  });
  res.json(updated);
}

// DELETE /api/projects/:id — archive, not hard delete
export async function deleteProject(req, res) {
  const existing = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  const archived = await prisma.project.update({
    where: { id: req.params.id },
    data: { status: 'archived' },
  });
  res.json(archived);
}

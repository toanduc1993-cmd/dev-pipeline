import prisma from '../../lib/prisma.js';
import { existsSync } from 'fs';
import path from 'path';
import logger from '../../lib/logger.js';

export class DeployRunner {
  constructor(orchestrator) {
    this.orch = orchestrator;
  }

  async runLocalSetup(project) {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const repoPath = project.repoPath;
    let config = await prisma.deployConfig.findUnique({ where: { projectId: project.id } });
    const results = { steps: [], success: true, localUrl: null };

    // Auto-assign unique port if not set
    if (!config?.localPort || config.localPort === 3000) {
      const allConfigs = await prisma.deployConfig.findMany({ select: { localPort: true } });
      const usedPorts = new Set(allConfigs.map((c) => c.localPort).filter(Boolean));
      const reserved = new Set([3001, 5173, 3000]);
      let nextPort = 4000;
      while (usedPorts.has(nextPort) || reserved.has(nextPort)) nextPort++;

      config = await prisma.deployConfig.upsert({
        where: { projectId: project.id },
        create: { projectId: project.id, localPort: nextPort },
        update: { localPort: nextPort },
      });
      logger.info({ projectId: project.id, port: nextPort }, 'Auto-assigned port');
    }

    const port = config.localPort;

    // Kill existing process on port
    try {
      const { execSync: es } = await import('child_process');
      const pid = es(`lsof -ti:${port}`, { stdio: 'pipe' }).toString().trim();
      if (pid) { es(`kill ${pid}`, { stdio: 'pipe' }); await new Promise((r) => setTimeout(r, 1000)); }
    } catch {}

    logger.info({ projectId: project.id, repoPath, port }, 'Running local setup');

    const hasPackageJson = existsSync(path.join(repoPath, 'package.json'));
    const hasRequirements = existsSync(path.join(repoPath, 'requirements.txt'));
    const hasPipfile = existsSync(path.join(repoPath, 'Pipfile'));
    const hasPrisma = existsSync(path.join(repoPath, 'prisma', 'schema.prisma'));
    const hasManagePy = existsSync(path.join(repoPath, 'manage.py'));

    // 1. Install dependencies
    try {
      if (config?.localSetupCmd) {
        const { stdout } = await execAsync(config.localSetupCmd, { cwd: repoPath, timeout: 120000 });
        results.steps.push({ step: 'Custom setup', status: 'ok', output: stdout.substring(0, 300) });
      } else if (hasPackageJson) {
        const { stdout } = await execAsync('npm install 2>&1', { cwd: repoPath, timeout: 120000 });
        results.steps.push({ step: 'npm install', status: 'ok', output: stdout.substring(0, 300) });
      } else if (hasRequirements) {
        const { execSync: execSyncLocal } = await import('child_process');
        let pipCmd = 'pip3';
        try { execSyncLocal('pip3 --version', { stdio: 'pipe' }); } catch {
          try { execSyncLocal('pip --version', { stdio: 'pipe' }); pipCmd = 'pip'; } catch { pipCmd = 'pip3'; }
        }
        const { stdout } = await execAsync(`${pipCmd} install -r requirements.txt 2>&1`, { cwd: repoPath, timeout: 120000 });
        results.steps.push({ step: `${pipCmd} install`, status: 'ok', output: stdout.substring(0, 300) });
      } else if (hasPipfile) {
        const { stdout } = await execAsync('pipenv install 2>&1', { cwd: repoPath, timeout: 120000 });
        results.steps.push({ step: 'pipenv install', status: 'ok', output: stdout.substring(0, 300) });
      }
    } catch (err) {
      results.steps.push({ step: 'Install deps', status: 'error', output: err.message.substring(0, 300) });
      results.success = false;
    }

    // 2. Database migration
    try {
      if (hasPrisma) {
        const { stdout } = await execAsync('npx prisma migrate dev --name auto 2>&1', { cwd: repoPath, timeout: 60000 });
        results.steps.push({ step: 'Prisma migrate', status: 'ok', output: stdout.substring(0, 300) });
      } else if (hasManagePy) {
        const { stdout } = await execAsync('python3 manage.py migrate 2>&1', { cwd: repoPath, timeout: 60000 });
        results.steps.push({ step: 'Django migrate', status: 'ok', output: stdout.substring(0, 300) });
      }
    } catch (err) {
      results.steps.push({ step: 'DB migrate', status: 'error', output: err.message.substring(0, 300) });
    }

    // 3. Start app
    try {
      let startCmd = config?.localStartCmd;
      if (!startCmd) {
        if (hasPackageJson) {
          const pkg = JSON.parse((await import('fs')).readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
          if (pkg.scripts?.dev) startCmd = 'npm run dev';
          else if (pkg.scripts?.start) startCmd = 'npm start';
          else startCmd = `node ${pkg.main || 'index.js'}`;
        } else if (hasManagePy) {
          startCmd = `python3 manage.py runserver ${port}`;
        } else if (existsSync(path.join(repoPath, 'src', 'api', 'main.py'))) {
          startCmd = `python3 -m uvicorn src.api.main:app --host 0.0.0.0 --port ${port}`;
        } else if (existsSync(path.join(repoPath, 'main.py'))) {
          startCmd = `python3 main.py`;
        } else if (existsSync(path.join(repoPath, 'app.py'))) {
          startCmd = `python3 app.py`;
        }
      }

      if (startCmd) {
        const env = { ...process.env, PORT: String(port) };
        const { exec: execRaw } = await import('child_process');
        const child = execRaw(startCmd, { cwd: repoPath, env, detached: true, stdio: 'ignore' });
        child.unref();
        results.steps.push({ step: 'Start app', status: 'ok', cmd: startCmd, port });
        results.localUrl = `http://localhost:${port}`;

        await new Promise((r) => setTimeout(r, 3000));
        try {
          const { stdout } = await execAsync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/`, { timeout: 5000 });
          results.steps.push({ step: 'Health check', status: stdout.trim() === '200' ? 'ok' : 'warning', httpCode: stdout.trim() });
        } catch {
          results.steps.push({ step: 'Health check', status: 'warning', output: 'App may still be starting' });
        }
      } else {
        results.steps.push({ step: 'Start app', status: 'skip', output: 'No start command found' });
      }
    } catch (err) {
      results.steps.push({ step: 'Start app', status: 'error', output: err.message.substring(0, 300) });
    }

    await prisma.deployConfig.upsert({
      where: { projectId: project.id },
      create: { projectId: project.id, localSetupDone: results.success, localUrl: results.localUrl },
      update: { localSetupDone: results.success, localUrl: results.localUrl },
    });

    logger.info({ projectId: project.id, success: results.success, localUrl: results.localUrl }, 'Local setup complete');
    return results;
  }

  async runUATDeploy(project, config) {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const repoPath = project.repoPath;
    const results = { steps: [], success: true, uatUrl: null };

    logger.info({ projectId: project.id }, 'Running UAT deploy');

    if (config.gitRemoteUrl && config.gitToken) {
      try {
        const remoteWithToken = config.gitRemoteUrl.replace('https://', `https://${config.gitToken}@`);
        const branch = config.gitBranch || 'main';
        await execAsync(`git remote remove uat-deploy 2>/dev/null || true`, { cwd: repoPath });
        await execAsync(`git remote add uat-deploy "${remoteWithToken}"`, { cwd: repoPath });
        const { stdout } = await execAsync(`git push uat-deploy ${branch} --force 2>&1`, { cwd: repoPath, timeout: 60000 });
        await execAsync(`git remote remove uat-deploy`, { cwd: repoPath });
        results.steps.push({ step: 'Git push', status: 'ok', output: stdout.substring(0, 200) });
      } catch (err) {
        results.steps.push({ step: 'Git push', status: 'error', output: err.message.substring(0, 300) });
        results.success = false;
      }
    }

    if (config.vercelToken) {
      try {
        let vercelCmd = `npx vercel --yes --token ${config.vercelToken}`;
        if (config.vercelProjectId) vercelCmd += ` --scope ${config.vercelTeamId || ''}`;
        vercelCmd += ' --prod 2>&1';
        const { stdout } = await execAsync(vercelCmd, { cwd: repoPath, timeout: 180000 });
        const urlMatch = stdout.match(/https:\/\/[^\s]+\.vercel\.app/);
        if (urlMatch) results.uatUrl = urlMatch[0];
        results.steps.push({ step: 'Vercel deploy', status: 'ok', output: stdout.substring(0, 300), url: results.uatUrl });
      } catch (err) {
        results.steps.push({ step: 'Vercel deploy', status: 'error', output: err.message.substring(0, 300) });
        results.success = false;
      }
    }

    if (config.customDeployCmd) {
      try {
        const env = { ...process.env };
        if (config.uatDbUrl) env.DATABASE_URL = config.uatDbUrl;
        const { stdout } = await execAsync(config.customDeployCmd, { cwd: repoPath, timeout: 180000, env });
        results.steps.push({ step: 'Custom deploy', status: 'ok', output: stdout.substring(0, 300) });
      } catch (err) {
        results.steps.push({ step: 'Custom deploy', status: 'error', output: err.message.substring(0, 300) });
        results.success = false;
      }
    }

    await prisma.deployConfig.update({
      where: { projectId: project.id },
      data: { uatDeployDone: results.success, uatUrl: results.uatUrl },
    });

    await this.orch.notif.send({
      projectId: project.id,
      type: results.success ? 'sprint_complete' : 'sprint_failed',
      title: results.success ? 'UAT Deploy thanh cong' : 'UAT Deploy that bai',
      message: results.uatUrl ? `URL: ${results.uatUrl}` : results.steps.map((s) => `${s.step}: ${s.status}`).join(', '),
    });

    logger.info({ projectId: project.id, success: results.success, uatUrl: results.uatUrl }, 'UAT deploy complete');
    return results;
  }
}

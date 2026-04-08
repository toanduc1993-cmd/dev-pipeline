-- CreateTable
CREATE TABLE "DeployConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "localPort" INTEGER DEFAULT 3000,
    "localSetupCmd" TEXT,
    "localStartCmd" TEXT,
    "vercelToken" TEXT,
    "vercelProjectId" TEXT,
    "vercelTeamId" TEXT,
    "uatDbProvider" TEXT,
    "uatDbUrl" TEXT,
    "gitRemoteUrl" TEXT,
    "gitBranch" TEXT DEFAULT 'main',
    "gitToken" TEXT,
    "customDeployCmd" TEXT,
    "localSetupDone" BOOLEAN NOT NULL DEFAULT false,
    "uatDeployDone" BOOLEAN NOT NULL DEFAULT false,
    "localUrl" TEXT,
    "uatUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DeployConfig_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "DeployConfig_projectId_key" ON "DeployConfig"("projectId");

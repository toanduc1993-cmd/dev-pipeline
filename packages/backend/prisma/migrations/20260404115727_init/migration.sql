-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "repoPath" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'javascript',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Sprint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "currentGateNumber" INTEGER NOT NULL DEFAULT 0,
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "isProcessing" BOOLEAN NOT NULL DEFAULT false,
    "requirementText" TEXT,
    "requirementFile" TEXT,
    "masterContext" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Sprint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Gate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sprintId" TEXT NOT NULL,
    "gateNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "notes" TEXT,
    "poComment" TEXT,
    "approvedAt" DATETIME,
    "approvedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Gate_sprintId_fkey" FOREIGN KEY ("sprintId") REFERENCES "Sprint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sprintId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "agentSlot" INTEGER NOT NULL,
    "featureRef" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "currentRound" INTEGER NOT NULL DEFAULT 0,
    "branch" TEXT,
    "worktreePath" TEXT,
    "devOutputRaw" TEXT,
    "devOutputParsed" TEXT,
    "validationResult" TEXT,
    "reviewOutputRaw" TEXT,
    "reviewParsed" TEXT,
    "archVerdict" TEXT,
    "escalationReason" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_sprintId_fkey" FOREIGN KEY ("sprintId") REFERENCES "Sprint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "promptLength" INTEGER,
    "rawOutput" TEXT,
    "parsedOutput" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "errorMsg" TEXT,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "sprintId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "payload" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'both',
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PipelineConfig" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "maxParallelAgents" INTEGER NOT NULL DEFAULT 1,
    "maxRetryRounds" INTEGER NOT NULL DEFAULT 3,
    "taskTimeoutMins" INTEGER NOT NULL DEFAULT 45,
    "qaChunkSize" INTEGER NOT NULL DEFAULT 5,
    "masterMaxTokens" INTEGER NOT NULL DEFAULT 3000,
    "telegramEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Sprint_projectId_number_key" ON "Sprint"("projectId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Gate_sprintId_gateNumber_key" ON "Gate"("sprintId", "gateNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Task_sprintId_taskId_key" ON "Task"("sprintId", "taskId");

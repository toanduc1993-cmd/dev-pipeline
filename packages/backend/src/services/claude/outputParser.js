import { z } from 'zod';
import logger from '../../lib/logger.js';

// ─── Zod schemas for each response type ─────────────────────────────────────

const schemas = {
  sprintPlan: z.object({
    totalSprints: z.number(),
    estimatedWeeks: z.number().optional(),
    sprints: z.array(z.object({
      sprintNumber: z.number(),
      name: z.string(),
      scope: z.string(),
      features: z.array(z.string()),
      dependencies: z.array(z.string()).default([]),
      estimatedTasks: z.number().optional(),
      deliverable: z.string(),
    })),
    notes: z.string().optional(),
  }),

  reception: z.object({
    requirementSummary: z.string(),
    gaps: z.array(z.object({
      area: z.string(),
      description: z.string(),
      severity: z.enum(['blocking', 'important', 'minor']),
      suggestedClarification: z.string().optional(),
    })).default([]),
    conflicts: z.array(z.object({
      description: z.string(),
      option1: z.string(),
      option2: z.string(),
    })).default([]),
    assumptions: z.array(z.object({
      assumption: z.string(),
      risk: z.enum(['low', 'medium', 'high']),
    })).default([]),
    techStackRisks: z.array(z.object({
      description: z.string(),
      recommendation: z.string(),
    })).default([]),
    estimatedComplexity: z.enum(['simple', 'medium', 'complex']).default('medium'),
    estimatedSprints: z.number().default(1),
    readyToProceed: z.boolean().default(true),
    blockers: z.array(z.string()).default([]),
  }),

  architect: z.object({
    analysis: z.string(),
    architectureOverview: z.string(),
    features: z.array(z.object({
      id: z.string().optional(),
      name: z.string(),
      description: z.string(),
      priority: z.string().optional(),
      acceptanceCriteria: z.array(z.string()).default([]),
    })),
    techDecisions: z.array(z.string()),
    risks: z.array(z.string()),
    masterMdUpdate: z.string().nullable().optional(),
    estimatedTasks: z.number(),
    tcrUpdate: z.object({
      summary: z.string(),
      decisions: z.array(z.string()).default([]),
      filesChanged: z.array(z.string()).default([]),
      nextSprintContext: z.string().optional(),
    }).optional(),
    contextIndexUpdate: z.string().nullable().optional(),
    zoneClassification: z.object({
      frozen: z.array(z.object({ path: z.string(), reason: z.string() })).default([]),
      guarded: z.array(z.object({ path: z.string(), reason: z.string() })).default([]),
      fluid: z.string().optional(),
    }).optional(),
    breakingChanges: z.array(z.object({
      type: z.string(),
      description: z.string(),
      affectedModules: z.array(z.string()).default([]),
      migrationRequired: z.boolean().default(false),
      migrationNotes: z.string().optional(),
    })).default([]),
  }),

  featureSpecs: z.object({
    sprintNumber: z.number(),
    features: z.array(z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      testCases: z.array(z.string()),
    }).passthrough()),
  }),

  atomicTasks: z.object({
    sprintNumber: z.number(),
    tasks: z.array(z.object({
      taskId: z.string(),
      title: z.string(),
      description: z.string(),
      agentSlot: z.number().optional(),
      filesToCreate: z.array(z.string()).optional(),
      filesToModify: z.array(z.any()).optional(),
    }).passthrough()),
    conflictWarnings: z.array(z.any()).optional(),
  }),

  devReport: z.object({
    taskId: z.string(),
    status: z.string(),
    branch: z.string(),
    filesCreated: z.array(z.any()),
    filesModified: z.array(z.any()),
    deviations: z.array(z.any()),
  }).passthrough(),

  review: z.object({
    taskId: z.string(),
    verdict: z.enum(['PASS', 'FAIL', 'PASS_WITH_NOTES']),
    checklist: z.array(z.any()),
    issues: z.array(z.any()),
    regressionRisk: z.string(),
  }).passthrough(),

  contractCheck: z.object({
    passed: z.boolean(),
    zoneCompliance: z.object({
      passed: z.boolean(),
      frozenViolations: z.array(z.any()).default([]),
      guardedModifications: z.array(z.any()).default([]),
    }).passthrough().optional(),
    interfaceIntegrity: z.object({
      passed: z.boolean(),
      brokenInterfaces: z.array(z.any()).default([]),
    }).passthrough().optional(),
    breakingChangeConflicts: z.array(z.any()).default([]),
    blockMerge: z.boolean(),
    issues: z.array(z.any()).default([]),
    summary: z.string(),
  }).passthrough(),

  integrationVerify: z.object({
    overallStatus: z.enum(['PASS', 'FAIL', 'PASS_WITH_ISSUES']),
    architectureMatch: z.object({ passed: z.boolean() }).passthrough(),
    featureCompleteness: z.object({ passed: z.boolean() }).passthrough(),
    crossTaskIntegration: z.object({ passed: z.boolean() }).passthrough(),
    missingFiles: z.array(z.any()),
    fixes: z.array(z.any()),
    summary: z.string(),
  }).passthrough(),

  qaChunk: z.object({
    chunkIndex: z.number(),
    taskReviews: z.array(z.any()),
    chunkSummary: z.string(),
  }),

  qaFinal: z.object({
    sprintNumber: z.number(),
    executiveSummary: z.object({
      whatWasBuilt: z.string(),
      overallQuality: z.string(),
      recommendation: z.string(),
      recommendationReason: z.string(),
    }),
    technicalIssues: z.object({
      critical: z.array(z.any()),
      major: z.array(z.any()),
      minor: z.array(z.any()),
    }),
    blockMerge: z.boolean(),
  }).passthrough(),

  sprintCoverageCheck: z.object({
    totalRequirements: z.number(),
    coveredCount: z.number(),
    missingCount: z.number(),
    coveragePercent: z.number(),
    allRequirements: z.array(z.object({
      requirement: z.string(),
      source: z.string().optional(),
      coveredBySprint: z.number().nullable(),
      status: z.enum(['covered', 'missing', 'vague']),
      notes: z.string().optional(),
    })),
    missingFeatures: z.array(z.object({
      requirement: z.string(),
      source: z.string().optional(),
      suggestedSprint: z.string().optional(),
    })).default([]),
    vagueFeatures: z.array(z.object({
      requirement: z.string(),
      issue: z.string(),
    })).default([]),
    verdict: z.enum(['FULL_COVERAGE', 'PARTIAL', 'MISSING_CRITICAL']),
    summary: z.string(),
  }),
};

// ─── Main parse function ─────────────────────────────────────────────────────

/**
 * Extract JSON from Claude output and validate against schema.
 *
 * Strategy:
 * 1. Find ```json ... ``` block first
 * 2. Fallback: try parsing entire output as JSON
 * 3. Validate against Zod schema (soft fail — returns data even if schema doesn't fully match)
 *
 * @param {string} rawOutput - Raw stdout from Claude
 * @param {string} schemaName - Key into schemas map
 * @returns {{ success: boolean, data?: any, error?: string, raw?: string, schemaWarnings?: any[] }}
 */
export function parseClaudeOutput(rawOutput, schemaName) {
  // 1. Find ```json block
  const jsonMatch = rawOutput.match(/```json\n?([\s\S]+?)\n?```/);
  if (!jsonMatch) {
    // Fallback: try parsing entire output as JSON
    try {
      const data = JSON.parse(rawOutput.trim());
      return validateWithSchema(data, schemaName);
    } catch {
      logger.warn({ schemaName, outputLength: rawOutput.length }, 'No JSON block found in Claude output');
      return { success: false, error: 'No JSON block found', raw: rawOutput };
    }
  }

  // 2. Parse JSON from block — with truncation repair
  let data;
  let jsonStr = jsonMatch[1];
  try {
    data = JSON.parse(jsonStr);
  } catch (err) {
    // Try to repair truncated JSON (common when output is cut off)
    logger.warn({ schemaName, err: err.message }, 'JSON parse failed — attempting repair');
    try {
      data = repairTruncatedJSON(jsonStr);
      if (data) {
        logger.info({ schemaName }, 'JSON repaired successfully');
      } else {
        return { success: false, error: `JSON parse error: ${err.message}`, raw: rawOutput };
      }
    } catch {
      return { success: false, error: `JSON parse error: ${err.message}`, raw: rawOutput };
    }
  }

  // 3. Validate schema
  return validateWithSchema(data, schemaName);
}

function validateWithSchema(data, schemaName) {
  const schema = schemas[schemaName];
  if (!schema) {
    // No schema for this name — accept as-is
    return { success: true, data };
  }

  const result = schema.safeParse(data);
  if (!result.success) {
    logger.warn({ schemaName, issues: result.error.issues }, 'Schema validation warnings');
    // Soft fail: return original data with warnings, don't crash
    return { success: true, data, schemaWarnings: result.error.issues };
  }

  return { success: true, data: result.data };
}

/**
 * Attempt to repair truncated JSON by closing open brackets/braces/strings.
 * Returns parsed object or null if unrepairable.
 */
function repairTruncatedJSON(str) {
  let s = str.trim();

  // Remove trailing comma
  s = s.replace(/,\s*$/, '');

  // Close any unterminated string
  const quoteCount = (s.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    s += '"';
  }

  // Count open brackets/braces and close them
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && (i === 0 || s[i - 1] !== '\\')) {
      inString = !inString;
    }
    if (!inString) {
      if (c === '{') openBraces++;
      if (c === '}') openBraces--;
      if (c === '[') openBrackets++;
      if (c === ']') openBrackets--;
    }
  }

  // Remove trailing incomplete key-value
  s = s.replace(/,?\s*"[^"]*":\s*$/, '');
  s = s.replace(/,?\s*"[^"]*":\s*"[^"]*$/, '');

  // Close remaining brackets
  for (let i = 0; i < openBrackets; i++) s += ']';
  for (let i = 0; i < openBraces; i++) s += '}';

  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

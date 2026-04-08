export function formatQAForPO(data) {
  const exec = data.executiveSummary || {};
  const tech = data.technicalIssues || {};
  const parts = [
    `## QA Report — Sprint #${data.sprintNumber}`,
    `### Summary\n${exec.whatWasBuilt || 'N/A'}`,
    `**Quality:** ${exec.overallQuality || 'N/A'}`,
    `**Recommendation:** ${exec.recommendation || 'N/A'} — ${exec.recommendationReason || ''}`,
    '### Technical Issues',
  ];

  if (tech.critical?.length) {
    parts.push(`**Critical (must fix):**\n${tech.critical.map((i) => `- ${i.description}`).join('\n')}`);
  } else {
    parts.push('No critical issues');
  }
  if (tech.major?.length) {
    parts.push(`**Major:**\n${tech.major.map((i) => `- ${i.description}`).join('\n')}`);
  }
  if (tech.minor?.length) {
    parts.push(`**Minor (fix later):**\n${tech.minor.map((i) => `- ${i.description}`).join('\n')}`);
  }
  if (data.blockMerge) {
    parts.push('\n**BLOCK MERGE: YES** — Must fix critical issues first');
  }

  return parts.join('\n\n');
}

export function formatQALayer1FailForPO(failedChecks, sprintNumber) {
  let notes = `## QA Layer 1 Failed — Sprint #${sprintNumber}\n\n`;
  notes += `Automated checks phat hien loi. **Can fix truoc khi merge.**\n\n`;
  notes += `### Checks Failed\n`;
  failedChecks.forEach((c) => {
    notes += `\n**${c.name}**\n`;
    if (c.error) {
      const errStr = typeof c.error === 'string' ? c.error : JSON.stringify(c.error, null, 2);
      notes += `\`\`\`\n${errStr.substring(0, 500)}\n\`\`\`\n`;
    }
    if (c.detail) notes += `${c.detail}\n`;
  });
  notes += `\n### Hanh dong\nFix cac loi tren roi Approve Gate 5 de re-run QA.`;
  return notes;
}

export function formatQALayer2FailForPO(contractData, sprintNumber) {
  let notes = `## QA Layer 2 — Contract Violations — Sprint #${sprintNumber}\n\n`;

  const { zoneCompliance, interfaceIntegrity, issues = [] } = contractData;

  if (zoneCompliance?.frozenViolations?.length > 0) {
    notes += `### Frozen Zone Violations\n`;
    zoneCompliance.frozenViolations.forEach((v) => { notes += `- **${v.file}** (${v.taskId}): ${v.description}\n`; });
    notes += '\n';
  }
  if (interfaceIntegrity?.brokenInterfaces?.length > 0) {
    notes += `### Interface Integrity Issues\n`;
    interfaceIntegrity.brokenInterfaces.forEach((i) => { notes += `- **${i.interface}**: expected by ${i.expectedBy}, got: ${i.actuallyExposed}\n`; });
    notes += '\n';
  }

  const criticalIssues = issues.filter((i) => i.severity === 'critical');
  if (criticalIssues.length > 0) {
    notes += `### Critical Issues\n`;
    criticalIssues.forEach((i) => { notes += `- [${i.category}] ${i.description}\n`; });
  }

  notes += `\n### Hanh dong\nFix cac vi pham tren. Override Pass neu chap nhan risk.`;
  return notes;
}

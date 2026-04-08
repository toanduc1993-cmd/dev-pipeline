export function formatReceptionForPO(data, rawOutput) {
  if (!data || Object.keys(data).length === 0) {
    return `## Reception Report\n\`\`\`\n${rawOutput.substring(0, 2000)}\n\`\`\``;
  }

  const { requirementSummary, gaps = [], conflicts = [], assumptions = [], readyToProceed, blockers = [], estimatedComplexity } = data;
  const blockingGaps = gaps.filter((g) => g.severity === 'blocking');
  const importantGaps = gaps.filter((g) => g.severity === 'important');
  const minorGaps = gaps.filter((g) => g.severity === 'minor');

  let notes = `## Reception Report\n`;
  notes += `**Status:** ${readyToProceed ? 'Ready to proceed' : 'Can clarify truoc'}\n`;
  notes += `**Complexity:** ${estimatedComplexity || 'unknown'}\n\n`;
  notes += `### Tom tat requirement\n${requirementSummary || '_Parse error_'}\n\n`;

  if (blockers.length > 0) {
    notes += `### Blockers (phai giai quyet truoc khi approve)\n`;
    blockers.forEach((b) => { notes += `- ${b}\n`; });
    notes += '\n';
  }
  if (blockingGaps.length > 0) {
    notes += `### Gaps can lam ro\n`;
    blockingGaps.forEach((g) => { notes += `- **${g.area}**: ${g.description}\n  _Hoi: ${g.suggestedClarification}_\n`; });
    notes += '\n';
  }
  if (conflicts.length > 0) {
    notes += `### Mau thuan / Ambiguous\n`;
    conflicts.forEach((c) => { notes += `- ${c.description}\n  Option A: ${c.option1}\n  Option B: ${c.option2}\n`; });
    notes += '\n';
  }
  if (importantGaps.length > 0) {
    notes += `### Gaps quan trong (nen clarify)\n`;
    importantGaps.forEach((g) => { notes += `- **${g.area}**: ${g.description}\n`; });
    notes += '\n';
  }
  if (assumptions.length > 0) {
    notes += `### Assumptions\n`;
    assumptions.forEach((a) => { notes += `- [${a.risk.toUpperCase()}] ${a.assumption}\n`; });
    notes += '\n';
  }
  if (minorGaps.length > 0) {
    notes += `### Minor gaps (co the bo qua)\n`;
    minorGaps.forEach((g) => { notes += `- **${g.area}**: ${g.description}\n`; });
  }

  notes += `\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  return notes;
}

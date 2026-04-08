export function formatFeatureSpecsForPO(data) {
  const features = (data.features || []).map((f) => {
    const tests = (f.testCases || []).map((t) => `- ${t}`).join('\n');
    return `### ${f.id}: ${f.name}\n${f.description}\n\n**Test Cases:**\n${tests}`;
  }).join('\n\n---\n\n');

  return `## Feature Specifications — Sprint #${data.sprintNumber}\n\n${features}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

export function formatTasksForPO(tasks, warnings) {
  const warningSection = warnings?.length
    ? `\n\n**Conflict Warnings:**\n${warnings.map((w) => `- ${typeof w === 'string' ? w : w.message || JSON.stringify(w)}`).join('\n')}`
    : '';

  const rows = tasks.map((t) => {
    const files = [
      ...(t.filesToCreate || []),
      ...(t.filesToModify || []).map((f) => (typeof f === 'string' ? f : f.path || '')),
    ].join(', ');
    return `| ${t.taskId} | ${t.title} | ${files} | DEV-${t.agentSlot || 1} |`;
  }).join('\n');

  return [
    `## Atomic Tasks — ${tasks.length} tasks${warningSection}`,
    `| Task | Description | Files | Agent |\n|------|-------------|-------|-------|`,
    rows,
    `\n\`\`\`json\n${JSON.stringify(tasks, null, 2)}\n\`\`\``,
  ].join('\n');
}

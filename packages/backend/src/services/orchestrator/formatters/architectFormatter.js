export function formatArchitectForPO(data) {
  const features = (data.features || []).map((f) => `- **${f.id}**: ${f.name} — ${f.description}`).join('\n');
  const decisions = (data.techDecisions || []).map((d) => `- ${d}`).join('\n');
  const risks = (data.risks || []).map((r) => `- ${r}`).join('\n');

  const parts = [
    `## Phan tich yeu cau\n${data.analysis}`,
    `## Kien truc de xuat\n${data.architectureOverview}`,
    `## Danh sach Features\n${features}`,
    `## Quyet dinh ky thuat\n${decisions}`,
    `## Rui ro\n${risks}`,
  ];

  if (data.breakingChanges?.length > 0) {
    const bcList = data.breakingChanges.map((bc) =>
      `- **[${bc.type}]** ${bc.description}${bc.migrationRequired ? ' — Migration required' : ''}`
    ).join('\n');
    parts.push(`## Breaking Changes trong Sprint nay\n${bcList}`);
  }

  parts.push(`---\n*Uoc tinh: ~${data.estimatedTasks} atomic tasks*`);
  parts.push(`\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``);

  return parts.join('\n\n');
}

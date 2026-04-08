export function extractJSONFromNotes(notes) {
  if (!notes) return null;
  const match = notes.match(/```json\n([\s\S]+?)\n```/);
  if (match) {
    try { return JSON.parse(match[1]); } catch { return null; }
  }
  return null;
}

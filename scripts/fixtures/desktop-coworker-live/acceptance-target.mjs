export function normalizeStatus(input = "") {
  return String(input)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function summarizeStatuses(values = []) {
  const counts = {};
  for (const value of values) {
    const key = normalizeStatus(value);
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

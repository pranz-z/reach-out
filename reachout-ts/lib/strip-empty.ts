/**
 * Port of AgentRunner::stripEmpty — remove null / '' / [] recursively so
 * they never reach the model or a tool as a meaningful field. Lists stay
 * lists; 0 and false are kept.
 */
export function stripEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripEmpty).filter((v) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const s = stripEmpty(v);
      if (s === null || s === '' || (Array.isArray(s) && s.length === 0) || (typeof s === 'object' && !Array.isArray(s) && Object.keys(s as object).length === 0)) {
        continue;
      }
      out[k] = s;
    }
    return out;
  }
  return value;
}

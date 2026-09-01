// One bounded prompt fragment shared by interactive start and cold delegate
// wakes. Charter remains authority; journal state is a fact, never instructions.
// The hard cap keeps a malformed/overgrown charter from consuming a cold wake.
const SECTION_LIMIT = 1800;
const PROMPT_LIMIT = 9000;

function bounded(value, limit = SECTION_LIMIT) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 15))}…[truncated]`;
}

function list(value) {
  return bounded((Array.isArray(value) ? value : []).map(String).join(' | '));
}
export function composePrimaryPrompt(charter, binding, privateSkills = '') {
  const primary = charter?.primary_mission;
  const lines = [
    `CHARTER IDENTITY: ${bounded(charter?.name || 'unknown', 160)} | role: ${bounded(charter?.role || 'worker', 80)} | mission: ${bounded(charter?.mission)}`,
    `GOALS: ${list(charter?.goals)}`,
    `PRINCIPLES: ${list(charter?.principles)}`,
    `ROUTINES: ${list(charter?.routines)}`,
    `OUTPUT CONTRACT: ${bounded(charter?.output_contract)}`,
  ];
  if (primary) {
    lines.push(`PRIMARY DECLARATION: ${bounded(primary.slug, 160)} — ${bounded(primary.goal)}`);
    lines.push(`JOURNAL STATE: mission ${bounded(binding?.mission_id || 'unbound', 160)}; binding ${bounded(binding?.action || 'unknown', 160)}`);
  } else {
    lines.push('JOURNAL STATE: no primary declaration');
  }
  if (charter?.skill_learning?.enabled === true) {
    lines.push('SKILL LEARNING: opted in; during the daily harvest run the sk-agent-skill-learning workflow. Exact reuse keys only; generation, independent audit, and mediated install remain separate gates.');
  }
  if (privateSkills) lines.push(bounded(privateSkills, 2600));
  return bounded(lines.join('\n'), PROMPT_LIMIT);
}

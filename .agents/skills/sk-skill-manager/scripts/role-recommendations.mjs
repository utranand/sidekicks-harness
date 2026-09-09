#!/usr/bin/env node
// Report-only onboarding helper. It may read the local public catalog, but never clones, imports,
// applies, or mentions a private destination.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, '..');
const ROLE_FILE = join(SKILL_ROOT, 'assets', 'role-recommendations.yaml');
const CATEGORY_FILE = join(SKILL_ROOT, 'assets', 'categories.yaml');
const DEFAULTS_FILE = join(SKILL_ROOT, 'config.defaults.yaml');

function splitLines(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n');
}

function die(message) {
  process.stderr.write(`role recommendations: ${message}\n`);
  process.exit(2);
}

function values(argv, flag) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) die(`${flag} requires a value`);
      out.push(...argv[++i].split(',').map((v) => v.trim()).filter(Boolean));
    } else if (argv[i].startsWith(`${flag}=`)) {
      out.push(...argv[i].slice(flag.length + 1).split(',').map((v) => v.trim()).filter(Boolean));
    }
  }
  return out;
}

function scalar(argv, flag) {
  const found = values(argv, flag);
  if (found.length > 1) die(`${flag} may be supplied once`);
  return found[0] || '';
}

function uniqueSorted(items) {
  return [...new Set(items)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function unquote(value) {
  const v = String(value || '').trim();
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

function readRoles() {
  const roles = new Map();
  let current = '';
  for (const raw of splitLines(readFileSync(ROLE_FILE, 'utf8'))) {
    if (!raw.trim() || raw.trimStart().startsWith('#') || /^roles:\s*$/.test(raw)) continue;
    const heading = /^  ([A-Za-z][A-Za-z0-9 -]*):\s*$/.exec(raw);
    if (heading) {
      current = heading[1];
      roles.set(current, []);
      continue;
    }
    const member = /^    -\s+([a-z0-9][a-z0-9:-]*)\s*$/.exec(raw);
    if (member && current) roles.get(current).push(member[1]);
  }
  return roles;
}

function readCategories() {
  const out = [];
  for (const raw of splitLines(readFileSync(CATEGORY_FILE, 'utf8'))) {
    const match = /^([a-z][a-z0-9-]*):\s*$/.exec(raw);
    if (match) out.push(match[1]);
  }
  return uniqueSorted(out);
}

function catalogLocation(pathValue) {
  const abs = resolve(pathValue);
  const isFile = existsSync(abs) ? statSync(abs).isFile() : /\.ya?ml$/i.test(abs);
  return { file: isFile ? abs : join(abs, 'catalog.yaml'), checkout: isFile ? dirname(abs) : abs };
}

function readCatalog(pathValue) {
  if (!pathValue) return { path: '', rows: null };
  const { file } = catalogLocation(pathValue);
  if (!existsSync(file)) return { path: file, rows: null };
  const rows = [];
  let current = null;
  let inSkills = false;
  for (const raw of splitLines(readFileSync(file, 'utf8'))) {
    if (/^skills:\s*$/.test(raw)) {
      inSkills = true;
      continue;
    }
    if (!inSkills) continue;
    if (/^\S/.test(raw)) break;
    const first = /^\s*-\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(raw);
    if (first) {
      current = { [first[1]]: unquote(first[2]) };
      rows.push(current);
      continue;
    }
    const next = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(raw);
    if (next && current) current[next[1]] = unquote(next[2]);
  }
  return { path: file, rows: rows.filter((row) => row.name) };
}

function defaultsPublic() {
  const result = { remote: '', checkout: '' };
  let inPublic = false;
  for (const raw of splitLines(readFileSync(DEFAULTS_FILE, 'utf8'))) {
    if (/^    public:\s*$/.test(raw)) {
      inPublic = true;
      continue;
    }
    if (inPublic && /^    \S/.test(raw)) break;
    if (!inPublic) continue;
    const match = /^      (remote|checkout):\s*(.*)$/.exec(raw);
    if (match) result[match[1]] = unquote(match[2]);
  }
  return result;
}

function posix(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function powershell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function command(argv) {
  if (!argv.length) return null;
  return {
    argv,
    git_bash: argv.map(posix).join(' '),
    powershell: `& ${argv.map(powershell).join(' ')}`,
  };
}

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const roles = readRoles();
const categories = readCategories();
const requestedRoles = values(argv, '--role');
const requestedCategories = values(argv, '--category');
const exactSkills = values(argv, '--skill');
const catalogArg = scalar(argv, '--catalog');
const checkoutArg = scalar(argv, '--checkout');
const knownFlags = new Set(['--role', '--category', '--skill', '--catalog', '--checkout', '--json']);
for (const arg of argv) {
  if (arg.startsWith('--') && ![...knownFlags].some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
    die(`unknown option ${arg}`);
  }
}

const roleLookup = new Map([...roles.keys()].map((name) => [name.toLowerCase(), name]));
const selectedRoles = requestedRoles.map((name) => roleLookup.get(name.toLowerCase()) || die(
  `unknown role ${name}; choose ${[...roles.keys()].join(', ')}`
));
const categorySet = new Set(categories);
for (const category of requestedCategories) {
  if (!categorySet.has(category)) die(`unknown category ${category}; choose ${categories.join(', ')}`);
}
for (const skill of exactSkills) {
  if (!/^[a-z0-9][a-z0-9:-]*$/.test(skill)) die(`invalid skill name ${skill}`);
}

// Deliberately do not invoke the enclosing Sidekicks checkout here. Even a read-only CLI verb may
// repair host exposure links during bootstrap, which would break this helper's report-only promise.
// A source checkout can supply its local public-catalog path explicitly with --checkout.
const publicConfig = defaultsPublic();
const catalogCheckout = catalogArg ? catalogLocation(catalogArg).checkout : '';
const checkout = checkoutArg || catalogCheckout || publicConfig.checkout || '<public-skills-checkout>';
const catalog = readCatalog(catalogArg || (checkout !== '<public-skills-checkout>' ? checkout : ''));
const roleSkills = selectedRoles.flatMap((role) => roles.get(role));
const categorySkills = catalog.rows
  ? catalog.rows.filter((row) => requestedCategories.includes(row.category)).map((row) => row.name)
  : [];
const recommended = uniqueSorted([...roleSkills, ...categorySkills, ...exactSkills]);
const offline = requestedCategories.length > 0 && catalog.rows === null;
const commandCheckout = checkout;
const commands = {
  clone: command(['git', 'clone', publicConfig.remote, commandCheckout]),
  list: command(['node', 'bin/sidekicks', 'skill', 'import', '--all', '--from', commandCheckout, '--list']),
  advise: command(recommended.length
    ? ['node', 'bin/sidekicks', 'skill', 'advise', ...recommended, '--from', commandCheckout]
    : []),
  dry_run: command(recommended.length
    ? ['node', 'bin/sidekicks', 'skill', 'import', ...recommended, '--from', commandCheckout]
    : []),
  apply: command(recommended.length
    ? ['node', 'bin/sidekicks', 'skill', 'import', ...recommended, '--from', commandCheckout, '--apply']
    : []),
};

const report = {
  mode: 'report-only',
  selected: {
    roles: uniqueSorted(selectedRoles),
    categories: uniqueSorted(requestedCategories),
    skills: uniqueSorted(exactSkills),
  },
  available: { roles: [...roles.keys()], categories },
  recommended_skills: recommended,
  public_source: { remote: publicConfig.remote, checkout },
  catalog: {
    path: catalog.path || null,
    available: catalog.rows !== null,
    offline,
    unresolved_categories: offline ? uniqueSorted(requestedCategories) : [],
  },
  commands,
  performed_actions: [],
};

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

const lines = [
  'Skill recommendations (report only; no clone or import was performed)',
  `Roles: ${report.available.roles.join(', ')}`,
  `Categories: ${report.available.categories.join(', ')}`,
];
if (selectedRoles.length || requestedCategories.length || exactSkills.length) {
  lines.push(`Selected roles: ${report.selected.roles.join(', ') || 'none'}`);
  lines.push(`Selected categories: ${report.selected.categories.join(', ') || 'none'}`);
  lines.push(`Exact skills: ${report.selected.skills.join(', ') || 'none'}`);
  lines.push(`Recommended skills: ${recommended.join(', ') || 'none yet'}`);
  if (offline) lines.push(`Offline: categories need a local public catalog before their skill names can be resolved (${report.catalog.unresolved_categories.join(', ')}).`);
}
lines.push(`Public source: ${publicConfig.remote}`);
lines.push(`Checkout: ${checkout}`);
for (const [label, field] of [['Git Bash', 'git_bash'], ['PowerShell', 'powershell']]) {
  lines.push(`Manual commands (${label}):`);
  lines.push(`  clone:   ${commands.clone[field]}`);
  lines.push(`  list:    ${commands.list[field]}`);
  if (commands.advise) lines.push(`  advise:  ${commands.advise[field]}`);
  if (commands.dry_run) lines.push(`  dry-run: ${commands.dry_run[field]}`);
  if (commands.apply) lines.push(`  apply:   ${commands.apply[field]}`);
}
process.stdout.write(`${lines.join('\n')}\n`);

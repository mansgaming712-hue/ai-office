#!/usr/bin/env node
// Validasi file agen di repo (agents/ dan divisions/*/agents/) dan yang terpasang di ~/.claude/agents.
// Pakai: node scripts/validate-agents.mjs   (exit code 1 kalau ada masalah)
import { AGENT_NAMES } from '../shared/roster.js';
import { t } from '../shared/i18n.js';
import { discoverDivisions, divisionsDirFromEnv, pluginAgentFiles } from '../server/divisions.js';
import {
  REPO_AGENTS_DIR, USER_AGENTS_DIR, readAgentDir, riskyTools, validateAgent, agentNameOf,
} from './agent-files.mjs';

let problems = 0;
const fail = (msg) => { problems++; console.log(`  ✗ ${msg}`); };

// Divisi plugin: penemuan sudah memvalidasi tiap worker dengan validateAgent; yang gagal dilaporkan di bawah.
const plugin = discoverDivisions({ dir: divisionsDirFromEnv(process.env) });
const pluginFiles = pluginAgentFiles(plugin);
const pluginNames = pluginFiles.map((f) => f.worker);
const expectedNames = [...AGENT_NAMES, ...pluginNames];

function check(label, dir, names, { mustBeIdenticalTo } = {}) {
  console.log(`\n${label}: ${dir}`);
  const files = readAgentDir(dir);
  const byName = new Map();
  for (const f of files) {
    const name = agentNameOf(f.text);
    if (name) {
      if (byName.has(name)) fail(`nama "${name}" dipakai dua kali (${byName.get(name).fileName} dan ${f.fileName})`);
      byName.set(name, f);
    }
  }
  for (const name of names) {
    const f = byName.get(name);
    if (!f) { fail(`agen "${name}" tidak ada`); continue; }
    const { errors, data } = validateAgent(f.fileName, f.text);
    if (errors.length) errors.forEach((e) => fail(`${f.fileName}: ${e}`));
    else {
      // Agen plugin terpasang dengan tool berisiko diberi label supaya terlihat.
      const risky = pluginNames.includes(name) ? riskyTools(data?.tools) : [];
      console.log(`  ✓ ${name}${risky.length ? `  [RISKY: ${risky.join(', ')}]` : ''}`);
    }
    if (mustBeIdenticalTo) {
      const src = mustBeIdenticalTo.get(name);
      if (src && src.text.replace(/\r\n/g, '\n') !== f.text.replace(/\r\n/g, '\n')) {
        fail(`${f.fileName} berbeda dengan salinan di repo (jalankan: npm run agents:install -- --force)`);
      }
    }
  }
  const extra = [...byName.keys()].filter((n) => !names.includes(n));
  if (extra.length) console.log(`  (agen lain di folder ini, tidak divalidasi: ${extra.join(', ')})`);
  return byName;
}

const repo = check('Repo', REPO_AGENTS_DIR, AGENT_NAMES);
// Agen plugin dianggap bagian "repo" (sumber kebenaran untuk perbandingan salinan terpasang).
for (const f of pluginFiles) repo.set(f.worker, { fileName: f.fileName, text: f.text });

console.log(`\n${t('divisions.validate.header', { n: plugin.divisions.length })}`);
for (const d of plugin.divisions) console.log(`  ✓ ${d.id} (${d.workers.join(', ')})`);
for (const e of plugin.errors) fail(`${e.dir}: ${t(e.key, e.params)}`);

check('Terpasang', USER_AGENTS_DIR, expectedNames, { mustBeIdenticalTo: repo });

console.log(problems ? `\n${problems} masalah ditemukan.` : `\nSemua ${expectedNames.length} agen valid, unik, dan terpasang.`);
process.exit(problems ? 1 : 0);

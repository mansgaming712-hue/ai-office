#!/usr/bin/env node
// Validasi file agen di repo (agents/) dan yang terpasang di ~/.claude/agents.
// Pakai: node scripts/validate-agents.mjs   (exit code 1 kalau ada masalah)
import { AGENT_NAMES } from '../shared/roster.js';
import {
  REPO_AGENTS_DIR, USER_AGENTS_DIR, readAgentDir, validateAgent, agentNameOf,
} from './agent-files.mjs';

let problems = 0;
const fail = (msg) => { problems++; console.log(`  ✗ ${msg}`); };

function check(label, dir, { mustBeIdenticalTo } = {}) {
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
  for (const name of AGENT_NAMES) {
    const f = byName.get(name);
    if (!f) { fail(`agen "${name}" tidak ada`); continue; }
    const { errors } = validateAgent(f.fileName, f.text);
    if (errors.length) errors.forEach((e) => fail(`${f.fileName}: ${e}`));
    else console.log(`  ✓ ${name}`);
    if (mustBeIdenticalTo) {
      const src = mustBeIdenticalTo.get(name);
      if (src && src.text.replace(/\r\n/g, '\n') !== f.text.replace(/\r\n/g, '\n')) {
        fail(`${f.fileName} berbeda dengan salinan di repo (jalankan: npm run agents:install -- --force)`);
      }
    }
  }
  const extra = [...byName.keys()].filter((n) => !AGENT_NAMES.includes(n));
  if (extra.length) console.log(`  (agen lain di folder ini, tidak divalidasi: ${extra.join(', ')})`);
  return byName;
}

const repo = check('Repo', REPO_AGENTS_DIR);
check('Terpasang', USER_AGENTS_DIR, { mustBeIdenticalTo: repo });

console.log(problems ? `\n${problems} masalah ditemukan.` : `\nSemua ${AGENT_NAMES.length} agen valid, unik, dan terpasang.`);
process.exit(problems ? 1 : 0);

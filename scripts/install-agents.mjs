#!/usr/bin/env node
// Salin agents/*.md dari repo ke ~/.claude/agents.
// File yang sudah ada dan isinya berbeda TIDAK ditimpa, kecuali pakai --force.
import '../server/requireNode.js'; // paling awal: cek versi Node (minimal 22.12)
import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_AGENTS_DIR, USER_AGENTS_DIR, readAgentDir } from './agent-files.mjs';

const force = process.argv.includes('--force');
mkdirSync(USER_AGENTS_DIR, { recursive: true });
let copied = 0, same = 0, skipped = 0;
for (const f of readAgentDir(REPO_AGENTS_DIR)) {
  const dest = join(USER_AGENTS_DIR, f.fileName);
  if (existsSync(dest)) {
    const cur = readFileSync(dest, 'utf8');
    if (cur === f.text) { same++; continue; }
    if (!force) { skipped++; console.log(`lewati (sudah ada & berbeda): ${dest}`); continue; }
  }
  copyFileSync(f.path, dest);
  copied++;
  console.log(`terpasang: ${dest}`);
}
console.log(`\nSelesai: ${copied} disalin, ${same} sudah sama, ${skipped} dilewati.`);
if (skipped) console.log('Pakai --force untuk menimpa file yang berbeda.');

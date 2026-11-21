#!/usr/bin/env node
// Pasang agents/*.md dari repo, ditambah divisions/*/agents/*.md dari divisi plugin yang valid, ke ~/.claude/agents.
//   --force               timpa file yang berbeda, tetapi HANYA file yang dulu dipasang AI Office (tercatat di
//                         .ai-office-installed.json) dan belum kamu ubah. File milik kamu tidak pernah ditimpa.
//   --allow-risky-tools   setujui agen plugin dengan tool berisiko (Bash, PowerShell, WebFetch, NotebookEdit, dst.).
//                         Persetujuan terikat ke ISI file (sha256, disimpan di approvedRisky pada manifest): pemasangan
//                         berikutnya tanpa flag hanya memasang/memperbarui agen berisiko yang hash-nya cocok. Agen
//                         berisiko yang baru atau berubah dilewati (exit code 3) sampai disetujui lagi dengan flag.
//                         Agen yang tidak lolos validasi tidak pernah dianggap aman (gagal-tertutup).
// Yang ditulis adalah teks yang sudah dibaca (dan, untuk plugin, divalidasi), bukan salinan file dari disk.
import '../server/requireNode.js'; // paling awal: cek versi Node (minimal 22.12)
import { t } from '../shared/i18n.js';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverDivisions, divisionsDirFromEnv, pluginAgentFiles } from '../server/divisions.js';
import {
  REPO_AGENTS_DIR, RISKY_EXIT_CODE, USER_AGENTS_DIR, classifyAgent, readAgentDir, readInstallManifestFull, sha256,
  writeInstallManifest,
} from './agent-files.mjs';

const force = process.argv.includes('--force');
const allowRisky = process.argv.includes('--allow-risky-tools');
mkdirSync(USER_AGENTS_DIR, { recursive: true });
const { files: manifest, approvedRisky } = readInstallManifestFull(USER_AGENTS_DIR);
let copied = 0, same = 0, skipped = 0, riskySkipped = 0, unverifiable = 0;

function install(f) {
  const dest = join(USER_AGENTS_DIR, f.fileName);
  const hash = sha256(f.text);
  if (existsSync(dest)) {
    const cur = readFileSync(dest, 'utf8');
    if (cur === f.text) { same++; manifest[f.fileName] ??= hash; return 'same'; }
    if (!force) { skipped++; console.log(t('agents.skip', { dest })); return 'skipped'; }
    if (manifest[f.fileName] !== sha256(cur)) { skipped++; console.log(t('agents.skipForeign', { dest })); return 'skipped'; }
  }
  try {
    writeFileSync(dest, f.text, { flag: force ? 'w' : 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    skipped++; // muncul di antara cek dan tulis: jangan ditimpa
    console.log(t('agents.skip', { dest }));
    return 'skipped';
  }
  manifest[f.fileName] = hash;
  copied++;
  console.log(t('agents.installed', { dest }));
  return 'copied';
}

for (const f of readAgentDir(REPO_AGENTS_DIR)) install(f);

// Agen divisi plugin: hanya dari divisi yang lolos validasi (nama worker sudah dijamin kebab-case dan tidak bentrok).
const plugin = discoverDivisions({ dir: divisionsDirFromEnv(process.env) });
for (const e of plugin.errors) console.warn(t('divisions.install.skipDivision', { dir: e.dir, reason: t(e.key, e.params) }));
const pluginFiles = pluginAgentFiles(plugin);
// Gagal-tertutup: agen yang tidak lolos validasi tidak dianggap aman dan tidak dipasang.
const entries = pluginFiles.map((f) => ({ f, c: classifyAgent(f.fileName, f.text), hash: sha256(f.text) }));
if (entries.length) console.log(`
${t('agents.plugin.header')}`);
for (const { f, c } of entries) {
  if (!c.ok) continue;
  console.log(t(c.risky.length ? 'agents.plugin.rowRisky' : 'agents.plugin.row', { division: f.division, agent: f.worker, tools: c.tools, risky: c.risky.join(', ') }));
}
if (allowRisky) {
  const approving = entries.filter(({ c }) => c.ok && c.risky.length);
  if (approving.length) console.log(`
${t('agents.plugin.approving')}`);
  for (const { f, c, hash } of approving) console.log(t('agents.plugin.approveRow', { agent: f.worker, risky: c.risky.join(', '), hash: hash.slice(0, 12) }));
}
for (const { f, c, hash } of entries) {
  if (!c.ok) {
    unverifiable++;
    console.error(t('agents.plugin.unverifiable', { division: f.division, agent: f.worker, reason: String(c.reason).slice(0, 160) }));
    continue;
  }
  if (c.risky.length) {
    if (allowRisky) {
      const st = install(f);
      if (st !== 'skipped') approvedRisky[f.fileName] = hash;
      continue;
    }
    if (approvedRisky[f.fileName] !== hash) {
      riskySkipped++;
      console.error(t('agents.plugin.riskySkipped', { division: f.division, agent: f.worker, risky: c.risky.join(', ') }));
      continue;
    }
  }
  install(f);
}

writeInstallManifest(USER_AGENTS_DIR, manifest, approvedRisky);
console.log(`\n${t('agents.summary', { copied, same, skipped })}`);
if (skipped) console.log(t('agents.forceHint'));
if (riskySkipped) console.error(t('agents.plugin.riskySummary', { n: riskySkipped }));
if (riskySkipped || unverifiable) process.exitCode = RISKY_EXIT_CODE;

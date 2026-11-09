import { describe, expect, it } from 'vitest';
import {
  HANDBACK_TOOL, REDACTED, assignMessage, describeTool, extractText, isAsyncLaunch, mapHookToEvents, parseStatus, programName,
  redactSecrets, safeName, summarize,
} from '../shared/hookMapping.js';
import { DEMO_STEPS, officeUrlFrom } from '../scripts/demo-hooks.mjs';

const common = { session_id: 's1', transcript_path: 't.jsonl', cwd: '/x', permission_mode: 'default' };
const map = (input) => mapHookToEvents({ ...common, ...input });

describe('mapHookToEvents', () => {
  it('PreToolUse Agent → assign manager → subagent', () => {
    const [e] = map({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'dev-frontend', description: 'Bangun navbar', prompt: 'panjang...' },
    });
    expect(e).toMatchObject({ type: 'assign', from: 'manager', to: 'dev-frontend', message: 'Bangun navbar', source: 'hook' });
    expect(typeof e.time).toBe('string');
  });

  it('nama tool lama "Task" juga dikenali; tanpa description pakai baris pertama prompt', () => {
    const [e] = map({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'dev-qa', prompt: 'Uji login\nDetail...' } });
    expect(e).toMatchObject({ type: 'assign', to: 'dev-qa', message: 'Uji login' });
  });

  it('subagent_type kosong → general-purpose; nama aneh disanitasi', () => {
    expect(map({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: {} })[0].to).toBe('general-purpose');
    expect(map({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'My Plugin:Reviewer' } })[0].to).toBe('my-plugin:reviewer');
  });

  it('PreToolUse tool lain di dalam subagent → working dari subagent', () => {
    const [e] = map({ hook_event_name: 'PreToolUse', agent_id: 'a1', agent_type: 'dev-backend', tool_name: 'Edit', tool_input: { file_path: 'C:\\p\\src\\orders.js' } });
    expect(e).toMatchObject({ type: 'working', from: 'dev-backend', to: 'manager', message: 'Edit · orders.js' });
  });

  it('PreToolUse tool lain di sesi utama → working dari manager (Bash tanpa description: nama program saja)', () => {
    const [e] = map({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    expect(e).toMatchObject({ type: 'working', from: 'manager', to: 'ceo', message: 'Bash · npm' });
  });

  it('SubagentStart → working; agent_type kosong diabaikan', () => {
    expect(map({ hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: 'Explore' })[0]).toMatchObject({ type: 'working', from: 'explore' });
    expect(map({ hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: '' })).toEqual([]);
  });

  it('SubagentStop membaca baris STATUS dari last_assistant_message', () => {
    const done = map({ hook_event_name: 'SubagentStop', agent_type: 'dev-qa', last_assistant_message: 'STATUS: SELESAI\n\n**Ringkasan** — 9 test lulus.' });
    expect(done[0]).toMatchObject({ type: 'done', from: 'dev-qa', to: 'manager', message: '9 test lulus.' });
    const blocked = map({ hook_event_name: 'SubagentStop', agent_type: 'dev-qa', last_assistant_message: 'STATUS: BUTUH BANTUAN\nRingkasan: butuh dev-devops' });
    expect(blocked[0]).toMatchObject({ type: 'blocked', message: 'butuh dev-devops' });
    expect(map({ hook_event_name: 'SubagentStop', agent_type: 'dev-qa' })[0]).toMatchObject({ type: 'done', message: 'Tugas selesai' });
  });

  it('SubagentStop agen internal (agent_type kosong) diabaikan', () => {
    expect(map({ hook_event_name: 'SubagentStop', agent_type: '', last_assistant_message: 'x' })).toEqual([]);
  });

  it('PostToolUse Agent → report atau blocked dari isi tool_response', () => {
    const report = map({
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'sales-pricing' },
      tool_response: { content: [{ type: 'text', text: 'STATUS: SELESAI\n1. **Ringkasan** — 3 paket harga.' }] },
    });
    expect(report[0]).toMatchObject({ type: 'report', from: 'sales-pricing', to: 'manager', message: '3 paket harga.' });
    const blocked = map({
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'content-script' },
      tool_response: 'STATUS: BUTUH BANTUAN\nButuh harga dari sales-pricing',
    });
    expect(blocked[0]).toMatchObject({ type: 'blocked', from: 'content-script', message: 'Butuh harga dari sales-pricing' });
    const empty = map({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'x' }, tool_response: {} });
    expect(empty[0].message).toBe('Laporan diterima manajer.');
  });

  it('PostToolUse tool lain, hook lain, dan input rusak → tidak ada event', () => {
    expect(map({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: {} })).toEqual([]);
    expect(map({ hook_event_name: 'Stop' })).toEqual([]);
    expect(map({ hook_event_name: 'PreToolUse' })).toEqual([]);
    expect(mapHookToEvents(null)).toEqual([]);
    expect(mapHookToEvents('x')).toEqual([]);
  });

  it('semua langkah demo menghasilkan event yang valid sesuai harapan', () => {
    const types = DEMO_STEPS.map((s) => map(s).map((e) => e.type).join(','));
    expect(types).toEqual([
      'assign', 'working', 'working', 'working', 'working', 'done', 'report',
      'assign', 'assign', 'working', 'working', 'working', 'working', 'blocked', 'blocked', 'done', 'report',
      '', 'working',
    ]);
  });
});

describe('helper', () => {
  it('redactSecrets menyembunyikan token umum', () => {
    const out = redactSecrets('curl -H "Authorization: Bearer abcdefghijklmnop123" API_KEY=sk-1234567890abcdefXYZ password: hunter2 ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(out).not.toMatch(/abcdefghijklmnop123|sk-1234567890|hunter2|ghp_abc/);
    expect(out).toContain('[disembunyikan]');
    expect(redactSecrets('npm test')).toBe('npm test');
  });

  it('describeTool merangkum pemakaian tool', () => {
    expect(describeTool('Bash', { command: 'ls', description: 'Daftar file' })).toBe('Bash · Daftar file');
    expect(describeTool('WebFetch', { url: 'https://docs.example.com/a?b' })).toBe('WebFetch · docs.example.com');
    expect(describeTool('WebFetch', { url: 'bukan url' })).toBe('WebFetch');
    expect(describeTool('mcp__x__y', {})).toBe('mcp__x__y');
    expect(describeTool('Bash', { command: 'export TOKEN=abcdef1234567890' })).not.toContain('abcdef1234567890');
  });

  it('extractText, parseStatus, summarize, safeName', () => {
    expect(extractText([{ type: 'text', text: 'a' }, { content: 'b' }])).toBe('a\nb');
    expect(extractText({ result: { output: 'c' } })).toBe('c');
    expect(parseStatus('**STATUS: BUTUH BANTUAN**')).toBe('blocked');
    expect(parseStatus('status: selesai')).toBe('done');
    expect(parseStatus('apa saja')).toBe('unknown');
    expect(summarize('STATUS: SELESAI\n\n## Ringkasan\nHasil **bagus**.')).toBe('Hasil bagus.');
    expect(summarize('')).toBe('');
    expect(safeName('  Hello World!  ')).toBe('hello-world-');
  });
});

// ---------------------------------------------------------------- Bagian 4: perbaikan pemetaan hook
describe('agen latar belakang (isAsyncLaunch)', () => {
  const asyncResp = { isAsync: true, status: 'async_launched', agentId: 'a1b2', description: 'Uji auth', prompt: 'Tugas: ...', outputFile: 'C:/x/a1b2.output', canReadOutputFile: true, canContinueAgent: true };
  const ti = { subagent_type: 'dev-qa', description: 'Uji auth', run_in_background: true };

  it('isAsyncLaunch mengenali status async_launched atau isAsync true saja', () => {
    expect(isAsyncLaunch(asyncResp)).toBe(true);
    expect(isAsyncLaunch({ status: 'async_launched' })).toBe(true);
    expect(isAsyncLaunch({ isAsync: true })).toBe(true);
    for (const v of [null, undefined, 'async_launched', ['async_launched'], {}, { isAsync: 'true' }, { isAsync: false }, { status: 'completed' }]) {
      expect(isAsyncLaunch(v)).toBe(false);
    }
  });

  it('PostToolUse Agent/Task saat diluncurkan → tidak ada event (bukan report palsu)', () => {
    expect(map({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: ti, tool_response: asyncResp })).toEqual([]);
    expect(map({ hook_event_name: 'PostToolUse', tool_name: 'Task', tool_input: ti, tool_response: { isAsync: true } })).toEqual([]);
    expect(map({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: ti, tool_response: { status: 'async_launched' } })).toEqual([]);
  });

  it('regresi: PostToolUse sinkron tetap report/blocked', () => {
    const done = map({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-qa' }, tool_response: { status: 'completed', content: [{ type: 'text', text: 'STATUS: SELESAI\nSemua lulus.' }] } });
    expect(done[0]).toMatchObject({ type: 'report', from: 'dev-qa', message: 'Semua lulus.' });
    const blocked = map({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-qa' }, tool_response: { isAsync: false, content: [{ type: 'text', text: 'STATUS: BUTUH BANTUAN\nButuh dev-devops.' }] } });
    expect(blocked[0]).toMatchObject({ type: 'blocked', message: 'Butuh dev-devops.' });
  });
});

describe('PreToolUse SubagentHandback', () => {
  const report = 'STATUS: BUTUH BANTUAN\nRahasia laporan: password: hunter2';

  it('di dalam subagent → working "Menyerahkan laporan ke manajer" (isi laporan tidak ikut)', () => {
    const evs = map({ hook_event_name: 'PreToolUse', agent_id: 'a1', agent_type: 'dev-qa', tool_name: 'SubagentHandback', tool_input: { message: report } });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: 'working', from: 'dev-qa', to: 'manager', message: 'Menyerahkan laporan ke manajer' });
    expect(JSON.stringify(evs)).not.toMatch(/hunter2|BUTUH BANTUAN/);
  });

  it('tanpa agent_type → dari manager ke ceo; HANDBACK_TOOL bernilai "SubagentHandback"', () => {
    expect(HANDBACK_TOOL).toBe('SubagentHandback');
    const [e] = map({ hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', tool_input: { message: 'STATUS: SELESAI' } });
    expect(e).toMatchObject({ type: 'working', from: 'manager', to: 'ceo', message: 'Menyerahkan laporan ke manajer' });
  });
});

describe('parseStatus: penanda STATUS pertama di awal baris', () => {
  it.each([
    ['STATUS: SELESAI', 'done'],
    ['STATUS: BUTUH BANTUAN', 'blocked'],
    ['**STATUS: SELESAI**', 'done'],
    ['**STATUS:** BUTUH BANTUAN', 'blocked'],
    ['## STATUS: SELESAI', 'done'],
    ['> STATUS: DONE', 'done'],
    ['- STATUS: BLOCKED', 'blocked'],
    ['STATUS: MENTOK', 'blocked'],
    ['   status:selesai', 'done'],
    ['STATUS: BUTUH  BANTUAN', 'blocked'],
    ['Halo\n\nSTATUS: BUTUH BANTUAN', 'blocked'],
    ['Laporan "STATUS: BUTUH BANTUAN" tampil sebagai blocked.', 'unknown'],
    ['Kata kunci STATUS: SELESAI ada di tengah kalimat', 'unknown'],
    ['STATUS: SELESAI\n\n1. Laporan "STATUS: BUTUH BANTUAN" kini tampil benar.', 'done'],
    ['STATUS: SELESAI\nSTATUS: BUTUH BANTUAN', 'done'],
    ['Status: 200\nSTATUS: BUTUH BANTUAN', 'blocked'],
    ['STATUS: SELESAIKAN dulu', 'unknown'],
    ['STATUS: SELESAI\r\n\r\nRingkasan\r\n', 'done'],
    ['Pembuka\r\nSTATUS: BUTUH BANTUAN\r\nDetail', 'blocked'],
    ['', 'unknown'],
    [undefined, 'unknown'],
  ])('%j → %s', (text, expected) => {
    expect(parseStatus(text)).toBe(expected);
  });
});

describe('summarize: baris berakhiran titik dua digabung dengan baris berikutnya', () => {
  it('menggabungkan "…diperbaiki:" dengan butir pertama (tanpa nomor/markdown)', () => {
    const text = 'STATUS: SELESAI\n\n## Ringkasan\nKedua bug pemetaan hook sudah diperbaiki:\n1. Laporan "STATUS: BUTUH BANTUAN" tampil sebagai `blocked`.\n2. Lainnya.';
    expect(summarize(text)).toBe('Kedua bug pemetaan hook sudah diperbaiki: Laporan "STATUS: BUTUH BANTUAN" tampil sebagai blocked.');
  });

  it('CRLF dan butir "-" juga', () => {
    expect(summarize('STATUS: SELESAI\r\nHasil:\r\n- 3 test baru\r\n')).toBe('Hasil: 3 test baru');
  });

  it('titik dua di baris terakhir tidak menambah apa pun; baris tanpa titik dua tidak digabung', () => {
    expect(summarize('STATUS: SELESAI\nHasil:')).toBe('Hasil:');
    expect(summarize('Baris satu.\nBaris dua.')).toBe('Baris satu.');
  });

  it('"Ringkasan:" sebagai judul dilewati; hasil gabungan tetap dipotong dan disensor', () => {
    expect(summarize('Ringkasan:\nToken diganti:\npassword: hunter2')).toBe('Token diganti: password: [disembunyikan]');
    expect(summarize(`Daftar:\n${'x'.repeat(400)}`, 50).length).toBeLessThanOrEqual(50);
  });
});

// ------------------------------------------------------------------ S2: redaksi dan data minimal
// Semua nilai rahasia di bawah PALSU dan dirakit saat test berjalan (tidak ada token utuh di file ini).
const fake = (n) => 'Fa1KeX9zQ7'.repeat(Math.ceil(n / 10)).slice(0, n);
const JWT_SIG = fake(43);
const SECRET_CASES = [
  // [label, teks, bagian rahasia yang tidak boleh tersisa]
  ['GitHub ghp_', `git remote set-url origin x; export GH=ghp_${fake(36)}`, fake(36)],
  ['GitHub fine-grained github_pat_', `pakai github_pat_${fake(22)}_${fake(59)}`, fake(22)],
  ['Stripe sk_live_', `stripe sk_live_${fake(24)}`, fake(24)],
  ['Stripe sk_test_', `curl https://api.stripe.com -u sk_test_${fake(24)}:`, fake(24)],
  ['GitLab glpat-', `token glpat-${fake(20)}`, fake(20)],
  ['npm npm_', `npm config set //registry.npmjs.org/:_authToken npm_${fake(36)}`, fake(36)],
  ['Google AIza', `gcloud key AIza${fake(35)}`, fake(35)],
  ['Docker dckr_pat_', `echo dckr_pat_${fake(27)} | docker login`, fake(27)],
  ['AWS AKIA', 'aws id AKIAFAKE0KEY1FAKE2ID', 'FAKE0KEY1FAKE2ID'],
  ['JWT', `cookie jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxYS10ZXN0In0.${JWT_SIG}`, JWT_SIG],
  ['Authorization: Bearer', `curl -H "Authorization: Bearer ${fake(32)}" https://api.example.com`, fake(32)],
  ['bearer di prosa', `pakai bearer ${fake(32)} untuk API`, fake(32)],
  ['://user:pass@', `psql postgres://admin:${fake(14)}@db.internal:5432/prod`, fake(14)],
  ['://token@', `git clone https://${fake(30)}@github.com/x/y.git`, fake(30)],
  ['AWS_SECRET_ACCESS_KEY=', `export AWS_SECRET_ACCESS_KEY=${fake(40)}`, fake(40)],
  ['SESSION_KEY=', `heroku config:set SESSION_KEY=${fake(32)}`, fake(32)],
  ['--password x', `tool --password ${fake(12)}`, fake(12)],
  ['--password=x', `tool --password=${fake(12)}`, fake(12)],
  ['--auth-token', `twilio --auth-token ${fake(32)}`, fake(32)],
  ['--api-key', `stripe login --api-key ${fake(24)}`, fake(24)],
  ['mysql -pX', `mysql -h db -P 3306 -u root -p${fake(12)} prod`, fake(12)],
  ['mysqldump -pX', `mysqldump -uroot -p${fake(12)} db > x.sql`, fake(12)],
  ['sshpass -p', `sshpass -p ${fake(12)} ssh root@203.0.113.10`, fake(12)],
  ['curl -u a:b', `curl -u admin:${fake(12)} https://x.example`, fake(12)],
  ['curl --user a:b', `curl --user admin:${fake(12)} https://x.example`, fake(12)],
  ['blok PRIVATE KEY lengkap', `kunci:\n-----BEGIN RSA PRIVATE KEY-----\n${fake(64)}\n${fake(40)}\n-----END RSA PRIVATE KEY-----\nselesai`, fake(40)],
  ['blok PRIVATE KEY tanpa END', `-----BEGIN OPENSSH PRIVATE KEY-----\n${fake(70)} (terpotong)`, fake(70)],
];

describe('S2: redactSecrets menyensor pola rahasia, di semua jalur pesan', () => {
  it.each(SECRET_CASES)('%s', (_label, text, secret) => {
    const r = redactSecrets(text);
    expect(r).not.toContain(secret);
    expect(r).toContain(REDACTED);
    // Jalur yang benar-benar menghasilkan pesan event:
    const paths = {
      summarize: summarize(`STATUS: SELESAI\n**Ringkasan** — ${text}`, 500),
      bashDescription: describeTool('Bash', { command: text, description: `Jalankan ${text}` }),
      bashTanpaDescription: describeTool('Bash', { command: text }),
      assignDariPrompt: map({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-x', prompt: text } })[0].message,
      assignDariDescription: map({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-x', description: text } })[0].message,
      subagentStop: map({ hook_event_name: 'SubagentStop', agent_type: 'dev-x', last_assistant_message: `STATUS: SELESAI\n${text}` })[0].message,
      postToolUse: map({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-x' }, tool_response: `STATUS: BUTUH BANTUAN\n${text}` })[0].message,
    };
    for (const [path, msg] of Object.entries(paths)) expect(msg, path).not.toContain(secret);
  });

  it('blok PRIVATE KEY lengkap: teks sesudah END tetap ada', () => {
    expect(redactSecrets(SECRET_CASES.find((c) => c[0] === 'blok PRIVATE KEY lengkap')[1])).toBe(`kunci:\n${REDACTED}\nselesai`);
  });

  it('bagian yang bukan rahasia dipertahankan (pre/post): ://[disembunyikan]@host, mysql -p, --password', () => {
    expect(redactSecrets(`psql postgres://admin:${fake(14)}@db.internal/prod`)).toBe(`psql postgres://${REDACTED}@db.internal/prod`);
    expect(redactSecrets(`mysql -u root -p${fake(12)} prod`)).toBe(`mysql -u root -p${REDACTED} prod`);
    expect(redactSecrets(`tool --password=${fake(12)} --verbose`)).toBe(`tool --password=${REDACTED} --verbose`);
  });
});

describe('S2: tanpa false positive', () => {
  it.each([
    'mkdir -p dist',
    'ssh -p 22 root@host',
    'mysql -P 3306 -u root',
    'mysql -u root -p mydb',
    'docker login --password-stdin',
    'curl --user-agent Mozilla https://x.example',
    'Status: 200',
    'npm test',
    'Token diganti',
    'https://docs.example.com/api',
    'Edit · orders.js',
  ])('%j tidak berubah', (text) => {
    expect(redactSecrets(text)).toBe(text);
  });

  it('summarize dan describeTool juga tidak mengubahnya', () => {
    // (baris yang diawali "Status:" memang dilewati summarize sebagai baris STATUS, jadi diberi awalan)
    const text = 'Hasil: Status: 200 untuk mkdir -p dist, ssh -p 22, mysql -P 3306, --user-agent x';
    expect(summarize(`STATUS: SELESAI\n${text}`)).toBe(text);
    expect(describeTool('Bash', { command: 'x', description: 'docker login --password-stdin' })).toBe('Bash · docker login --password-stdin');
  });
});

describe('S2: summarize meredaksi SEBELUM markdown dibuang', () => {
  it('ghp_ tidak lolos walau "_" lalu dibuang', () => {
    const out = summarize(`STATUS: SELESAI\nRingkasan: repo dipush dengan ghp_${fake(36)} tadi`);
    expect(out).toBe(`repo dipush dengan ${REDACTED} tadi`);
    expect(out).not.toMatch(/ghp|Fa1Ke/);
  });

  it('**password**: x dan _AWS_SECRET_ACCESS_KEY_=x tersensor', () => {
    expect(summarize(`STATUS: SELESAI\n**password**: ${fake(12)}`)).toBe(`password: ${REDACTED}`);
    const aws = summarize(`STATUS: SELESAI\n_AWS_SECRET_ACCESS_KEY_=${fake(40)}`);
    expect(aws).not.toContain(fake(40));
    expect(aws).toContain(REDACTED);
  });

  it('blok kunci privat multi-baris di awal laporan tidak bocor sebaris pun', () => {
    const out = summarize(`STATUS: SELESAI\n-----BEGIN EC PRIVATE KEY-----\n${fake(60)}\n-----END EC PRIVATE KEY-----\nKunci dipasang`);
    expect(out).toBe(REDACTED);
  });
});

describe('S2: describeTool mengirim data seminimal mungkin', () => {
  it.each([
    ['Bash + description', 'Bash', { command: 'rm -rf build', description: 'Hapus  folder\nbuild' }, 'Bash · Hapus folder build'],
    ['Bash description kosong → nama program', 'Bash', { command: 'npm test', description: '   ' }, 'Bash · npm'],
    ['Bash tanpa description → nama program saja', 'Bash', { command: 'npm test -- --reporter=verbose' }, 'Bash · npm'],
    ['Bash: argumen path tidak ikut', 'Bash', { command: 'cat ~/.ssh/id_rsa' }, 'Bash · cat'],
    ['Bash: penugasan TOKEN=.. di depan dilewati', 'Bash', { command: `AI_OFFICE_TOKEN=${fake(43)} FOO="a b" node server/index.js` }, 'Bash · node'],
    ['Bash: penugasan berkutip + path program', 'Bash', { command: `TOKEN='${fake(10)} x' ./node_modules/.bin/vitest run` }, 'Bash · vitest'],
    ['Bash: program berkutip dengan spasi', 'Bash', { command: '"C:\\Program Files\\nodejs\\node.exe" -v' }, 'Bash · node.exe'],
    ['Bash tanpa input', 'Bash', {}, 'Bash'],
    ['PowerShell tanpa description → nama program', 'PowerShell', { command: '& "C:\\tools\\gh.exe" auth status' }, 'PowerShell · gh.exe'],
    ['PowerShell $env:X=.. → nama tool saja', 'PowerShell', { command: `$env:AI_OFFICE_TOKEN="${fake(43)}"; npm run demo:hooks` }, 'PowerShell'],
    ['PowerShell + description', 'PowerShell', { command: 'Get-ChildItem', description: 'Daftar file' }, 'PowerShell · Daftar file'],
    ['Grep: pola dan path tidak ikut', 'Grep', { pattern: `sk_live_${fake(20)}`, path: 'src/klien-rahasia' }, 'Grep'],
    ['Glob: pola tidak ikut', 'Glob', { pattern: '**/*.secret' }, 'Glob'],
    ['WebSearch: kueri tidak ikut', 'WebSearch', { query: 'harga domain klien rahasia' }, 'WebSearch'],
    ['WebFetch: host saja (tanpa user:pass, path, query, hash)', 'WebFetch', { url: `https://user:${fake(12)}@docs.example.com/a/b?token=${fake(12)}#x` }, 'WebFetch · docs.example.com'],
    ['WebFetch: host + port', 'WebFetch', { url: 'https://docs.example.com:8443/rahasia' }, 'WebFetch · docs.example.com:8443'],
  ])('%s', (_label, tool, input, expected) => {
    expect(describeTool(tool, input)).toBe(expected);
  });

  it('programName: nama yang tidak tampak seperti program → kosong', () => {
    expect(programName('$env:X="y"; npm test')).toBe('');
    expect(programName(`FOO=1 BAR="${fake(8)} z" npm`)).toBe('npm');
    expect(programName(`${'a'.repeat(41)} x`)).toBe('');
    expect(programName(undefined)).toBe('');
  });

  it('event working dari PreToolUse Grep/WebSearch tidak memuat pola/kueri', () => {
    const evs = [
      ...map({ hook_event_name: 'PreToolUse', agent_type: 'dev-security', tool_name: 'Grep', tool_input: { pattern: 'kata-kunci-rahasia' } }),
      ...map({ hook_event_name: 'PreToolUse', agent_type: 'sales-research', tool_name: 'WebSearch', tool_input: { query: 'nama-klien-rahasia' } }),
    ];
    expect(evs.map((e) => e.message)).toEqual(['Grep', 'WebSearch']);
    expect(JSON.stringify(evs)).not.toMatch(/rahasia/);
  });
});

describe('S2: pesan assign = description, atau baris pertama prompt setelah redaksi (maks 80)', () => {
  it('description dipakai (maks 200), prompt diabaikan', () => {
    expect(assignMessage({ description: 'Uji login', prompt: 'detail panjang' })).toBe('Uji login');
    const long = assignMessage({ description: 'x'.repeat(300) });
    expect(long).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
  });

  it('tanpa description: baris pertama yang tidak kosong, dipotong 80 karakter', () => {
    const m = assignMessage({ prompt: `\n\n  Tugas: ${'x'.repeat(200)}\nbaris dua` });
    expect(m).toHaveLength(80);
    expect(m.startsWith('Tugas: xxx')).toBe(true);
    expect(m.endsWith('…')).toBe(true);
    expect(assignMessage({ description: '   ', prompt: 'Uji\nlain' })).toBe('Uji');
  });

  it('rahasia di baris pertama prompt tersensor; blok kunci privat di awal prompt tidak bocor', () => {
    expect(assignMessage({ prompt: `Token: ghp_${fake(36)}\nlain` })).toBe(`Token: ${REDACTED}`);
    const key = assignMessage({ prompt: `-----BEGIN EC PRIVATE KEY-----\n${fake(60)}\n-----END EC PRIVATE KEY-----\nPasang kunci di server` });
    expect(key).toBe(REDACTED);
  });

  it('tanpa description dan prompt → "Tugas untuk <agen>"', () => {
    expect(map({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-qa' } })[0].message).toBe('Tugas untuk dev-qa');
  });
});

describe('S2: teks adversarial 100 KB selesai cepat (tanpa backtracking berlebihan)', () => {
  it.each([
    ['a-a-a-', 'a-'.repeat(50_000)],
    ['://a:', '://a:'.repeat(20_000)],
    ['curl curl', 'curl '.repeat(20_000)],
    ['mysql -u', 'mysql -u '.repeat(11_000)],
    ['sshpass', 'sshpass '.repeat(12_500)],
    ['--a-b-c-', '--a-b-c-'.repeat(12_500)],
    ['nama variabel', 'a_b.c-d'.repeat(15_000)],
    ['TOKEN TOKEN', 'TOKEN '.repeat(17_000)],
    ['password x', 'password x '.repeat(9_000)],
    ['kata sandi', 'kata sandi '.repeat(9_000)],
    ['-----BEGIN', '-----BEGIN RSA PRIVATE KEY-----'.repeat(3_300)],
    ['bearer', 'bearer '.repeat(15_000)],
    ['x polos', 'x'.repeat(100_000)],
  ])('%s', (_label, text) => {
    expect(text.length).toBeGreaterThanOrEqual(99_000);
    const t0 = performance.now();
    redactSecrets(text);
    summarize(text);
    assignMessage({ prompt: text });
    describeTool('Bash', { command: text, description: text });
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

// ------------------------------------------------------------- kosmetik: scripts/demo-hooks.mjs
describe('officeUrlFrom (alamat animasi yang dicetak demo-hooks)', () => {
  it.each([
    [undefined, 'http://localhost:3000'],
    ['', 'http://localhost:3000'],
    ['https://office.example.com/api/events', 'https://office.example.com'],
    ['https://office.example.com/api/events/', 'https://office.example.com'],
    ['https://user:pass@office.example.com/kantor/api/events?x=1#y', 'https://office.example.com/kantor'],
    ['http://127.0.0.1:3305/api/events', 'http://127.0.0.1:3305'],
    ['bukan url', null],
    ['ftp://office.example.com/api/events', null],
  ])('%j → %j', (input, expected) => {
    expect(officeUrlFrom(input)).toBe(expected);
  });

  it('user:pass dan query tidak pernah tercetak; token di path disamarkan', () => {
    const out = officeUrlFrom(`https://admin:${fake(12)}@office.example.com/api/events?token=${fake(20)}`);
    expect(out).toBe('https://office.example.com');
    expect(officeUrlFrom(`https://office.example.com/${fake(43)}/api/events`, fake(43))).toBe('https://office.example.com/[token]');
  });
});

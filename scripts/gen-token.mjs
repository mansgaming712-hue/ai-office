#!/usr/bin/env node
// Cetak token acak kuat untuk AI_OFFICE_TOKEN (32 byte acak, base64url, 43 karakter).
//   npm run -s token        (-s supaya npm tidak menambah baris judul di output)
//   node scripts/gen-token.mjs
// Simpan hasilnya sebagai rahasia (mis. .env di server, .claude/settings.local.json di komputer);
// jangan di-commit ke repo.
import { randomBytes } from 'node:crypto';

process.stdout.write(`${randomBytes(32).toString('base64url')}\n`);

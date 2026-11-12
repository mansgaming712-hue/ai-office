#!/usr/bin/env node
// Dijalankan otomatis sebelum `npm run build` (prebuild) dan `npm test` (pretest).
// Node minimum AI Office satu angka untuk semuanya (server, hook, build, test): lihat server/nodeVersion.js.
// Tanpa cek ini, Node yang terlalu lama gagal di vite/vitest dengan galat sintaks yang membingungkan.
//   node scripts/check-toolchain-node.mjs build|test
import '../server/requireNode.js';

#!/usr/bin/env node
// Dijalankan otomatis sebelum `npm run build` (prebuild) dan `npm test` (pretest).
// Runtime AI Office cukup Node 20.12, tetapi vite 8 butuh Node ^20.19 atau >=22.12 dan vitest 5 butuh
// Node >=22.12. Tanpa cek ini, Node yang terlalu lama gagal dengan galat sintaks yang membingungkan.
// Sintaks lama saja, supaya pesan tetap sempat tercetak di Node tua.
//   node scripts/check-toolchain-node.mjs build|test
import '../server/requireNode.js';
import { toolchainNodeProblem } from '../server/nodeVersion.js';

var kind = process.argv[2] === 'test' ? 'test' : 'build';
var problem = toolchainNodeProblem(process.versions.node, kind);
if (problem) {
  console.error(problem);
  process.exit(1);
}

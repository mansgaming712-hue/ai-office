import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  plugins: [react()],
  // assetsInlineLimit 0: font kecil tidak disisipkan sebagai data: URI, supaya CSP server
  // (font-src 'self') tetap ketat tanpa error di konsol.
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
  // `npx vite` (port 5173) untuk mengembangkan UI; server event tetap di port 3000.
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 15000,
    // Pesan CLI/server berbahasa Indonesia untuk test lama (lihat shared/i18n.js); test bahasa Inggris
    // mengganti AI_OFFICE_LANG sendiri.
    // Runner key uji di folder sementara: test tidak pernah menyentuh ~/.ai-office milik pengguna.
    env: { AI_OFFICE_LANG: 'id', AI_OFFICE_RUNNER_KEY_FILE: join(tmpdir(), 'ai-office-vitest-runner-key') },
  },
});

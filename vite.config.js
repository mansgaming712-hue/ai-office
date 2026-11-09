import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
  },
});

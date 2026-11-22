// `npm run dev` (scripts/dev.mjs): port Vite 5173 hanya dibuka di mode pengembangan lewat AI_OFFICE_DEV_ORIGINS.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEV_ORIGINS, devOriginsEnv, serverEnv } from '../scripts/dev.mjs';

describe('scripts/dev.mjs', () => {
  it('env server memuat origin 5173 (localhost dan 127.0.0.1)', () => {
    expect(DEV_ORIGINS).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(serverEnv({}).AI_OFFICE_DEV_ORIGINS.split(',')).toEqual(DEV_ORIGINS);
  });
  it('menggabungkan nilai pengguna tanpa duplikat dan tanpa mengubah env asal', () => {
    const env = { AI_OFFICE_DEV_ORIGINS: ' http://localhost:4000 , http://localhost:5173 ,, ', PORT: '3000' };
    const out = serverEnv(env);
    expect(out.AI_OFFICE_DEV_ORIGINS.split(',')).toEqual([...DEV_ORIGINS, 'http://localhost:4000']);
    expect(out.PORT).toBe('3000');
    expect(env.AI_OFFICE_DEV_ORIGINS).toContain('4000');
    expect(devOriginsEnv(undefined)).toBe(DEV_ORIGINS.join(','));
  });
  it('skrip npm: dev memakai scripts/dev.mjs; start/serve tidak', () => {
    const s = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
    expect(s.dev).toBe('node scripts/dev.mjs');
    expect(s.start).toBe('node server/index.js');
    expect(s.serve).toBe('node server/index.js');
  });
});

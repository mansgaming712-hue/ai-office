// Mengubah teks dari kotak perintah menjadi event AI Office.
//   "Buat landing page"            → assign ceo → manager
//   "@dev-qa jalankan semua test"   → assign manager → dev-qa
//   '{"type":"done","from":"dev-qa","to":"manager","message":"ok"}' → event mentah (untuk uji)
import { normalizeBatch, normalizeEvent } from '../shared/events.js';

export function parseCommand(text) {
  const input = String(text ?? '').trim();
  if (!input) return { ok: false, error: 'Perintah masih kosong.' };

  if (input.startsWith('{') || input.startsWith('[')) {
    let data;
    try {
      data = JSON.parse(input);
    } catch {
      return { ok: false, error: 'JSON tidak valid.' };
    }
    const list = (Array.isArray(data) ? data : [data]).map((e) => (e && typeof e === 'object' ? { source: 'ui', ...e } : e));
    const r = normalizeBatch(list);
    return r.ok ? { ok: true, events: r.events } : { ok: false, error: r.error };
  }

  const mention = /^@([A-Za-z0-9][\w.:-]*)\s*([\s\S]*)$/.exec(input);
  if (mention) {
    const [, to, message] = mention;
    if (!message.trim()) return { ok: false, error: `Tulis tugas untuk @${to}.` };
    const r = normalizeEvent({ type: 'assign', from: 'manager', to, message, source: 'ui' });
    return r.ok ? { ok: true, events: [r.event] } : { ok: false, error: r.error };
  }

  const r = normalizeEvent({ type: 'assign', from: 'ceo', to: 'manager', message: input, source: 'ui' });
  return r.ok ? { ok: true, events: [r.event] } : { ok: false, error: r.error };
}

// Ambil laporan akhir subagent dari transkrip JSONL Claude Code (fungsi murni, tanpa I/O).
//
// Subagent menyerahkan laporan lewat tool `SubagentHandback` ({ message: "STATUS: ..." }), jadi
// pesan assistant terakhirnya adalah tool call, bukan teks, dan `last_assistant_message` di hook
// SubagentStop bisa kosong. Fungsi ini membaca transkrip dari belakang:
//   1. `input.message` dari tool_use SubagentHandback terakhir, kalau ada;
//   2. kalau tidak ada, teks assistant terakhir.
// Pencarian berhenti di pesan user berisi teks (awal giliran kerja yang sedang berjalan, mis. pesan
// lanjutan dari coordinator), supaya laporan dari giliran sebelumnya tidak terambil.
// Hanya entri dengan `type` "assistant" / "user" yang dipakai. Entri lain diabaikan, termasuk
// "api-request-blob" (salinan request ke API yang memuat ulang pesan assistant lama, termasuk
// SubagentHandback lama), "api-request", dan "attachment".
// Baris yang rusak atau terpotong (mis. baris pertama dari potongan akhir file) dilewati.

export const HANDBACK_TOOL = 'SubagentHandback';

function blocksOf(message) {
  const c = message?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c.filter((b) => b && typeof b === 'object') : [];
}

/** Pesan user berisi teks (prompt / pesan lanjutan), bukan sekadar tool_result. */
function isUserTurnStart(entry, blocks) {
  if (entry.type !== 'user') return false;
  if (blocks.some((b) => b.type === 'tool_result')) return false;
  return blocks.some((b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim());
}

/**
 * @param {string} text isi (atau potongan akhir) file transkrip JSONL
 * @returns {string} laporan, atau '' bila tidak ditemukan
 */
export function lastReportFromTranscript(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let lastText = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line[0] !== '{') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const blocks = blocksOf(entry.message);
    if (isUserTurnStart(entry, blocks)) break;
    if (entry.type !== 'assistant') continue;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b.type === 'tool_use' && b.name === HANDBACK_TOOL && typeof b.input?.message === 'string' && b.input.message.trim()) {
        return b.input.message;
      }
      if (!lastText && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) lastText = b.text;
    }
  }
  return lastText;
}

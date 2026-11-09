// Daftar agen AI Office per divisi. Satu sumber kebenaran untuk UI, test, dan validasi.
// Nama di sini WAJIB sama dengan file di agents/*.md (dicek oleh tests/agents.test.js).
// Catatan: id divisi '3d' bukan identifier JS yang valid, jadi selalu akses lewat bracket (ZONES['3d']).

export const MANAGER_ID = 'manager';
export const CEO_ID = 'ceo';

export const DIVISIONS = [
  {
    id: 'dev',
    name: 'Divisi Dev',
    color: '#3b6fb6',
    agents: [
      'dev-frontend',
      'dev-backend',
      'dev-qa',
      'dev-security',
      'dev-ui-critic',
      'dev-devops',
      'dev-docs',
    ],
  },
  {
    id: 'sales',
    name: 'Marketing & Sales',
    color: '#d17b2f',
    agents: ['sales-copywriter', 'sales-research', 'sales-pricing'],
  },
  {
    id: 'content',
    name: 'Konten',
    color: '#b8457f',
    agents: ['content-script', 'content-animator'],
  },
  {
    id: 'research',
    name: 'Riset',
    color: '#3c8d5a',
    agents: ['research-analyst'],
  },
  {
    // Ungu: jelas berbeda dari biru Dev, oranye Sales, merah muda Konten, hijau Riset, abu Tamu.
    id: '3d',
    name: 'Divisi 3D',
    color: '#9061f9',
    agents: ['3d-modeler', '3d-materials', '3d-animator', '3d-render'],
  },
];

// Agen yang tidak ada di roster (mis. Explore, general-purpose, agen plugin) duduk di sini.
export const OTHER_DIVISION = { id: 'other', name: 'Tamu / Lainnya', color: '#7b7f87', agents: [] };

export const AGENT_NAMES = DIVISIONS.flatMap((d) => d.agents);

export function divisionOf(name) {
  return DIVISIONS.find((d) => d.agents.includes(name)) ?? OTHER_DIVISION;
}

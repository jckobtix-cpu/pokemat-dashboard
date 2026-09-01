// Jednorázový úklid: odstraní z Pokemat dat (Redis) prodeje ze slotu 95 (lednice).
// POUŽITÍ:
//   1) Otevři /api/cleanup            -> jen VYPÍŠE, co by se smazalo (nic nemaže)
//   2) Otevři /api/cleanup?confirm=ANO -> teprve teď SMAŽE slot 95 a uloží čistá data
// Po úspěšném úklidu soubor klidně smaž z repa.

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  const res = await fetch(`${REDIS_URL}/get/${key}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  const data = await res.json();
  if (!data.result) return [];
  let parsed = data.result;
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  return Array.isArray(parsed) ? parsed : [];
}
async function redisSet(key, value) {
  const str = JSON.stringify(value);
  await fetch(`${REDIS_URL}/set/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(str),
  });
}

// je to prodej z lednice? slot 95 v jakémkoli tvaru
function isFridge(s) {
  const sel = String(s.Selection || '').trim().toLowerCase();
  return sel === '95' || sel === 'slot 95';
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: 'Redis není nakonfigurováno' });

    const all = await redisGet('sales');
    const fridge = all.filter(isFridge);
    const clean = all.filter((s) => !isFridge(s));

    const sum = (arr) => Math.round(arr.reduce((a, s) => a + (parseFloat(s.SettlementValue) || 0), 0));

    const report = {
      celkem_v_redis: all.length,
      lednice_slot95_k_odstraneni: fridge.length,
      lednice_trzby_kc: sum(fridge),
      pokemon_zustane: clean.length,
      pokemon_trzby_kc: sum(clean),
      ukazka_lednice: fridge.slice(0, 3),
    };

    const confirmed = (req.query.confirm || '') === 'ANO';
    if (!confirmed) {
      report.pozn = "Zatím se NIC nesmazalo. Pro smazání otevři /api/cleanup?confirm=ANO";
      return res.status(200).json(report);
    }

    await redisSet('sales', clean);
    report.hotovo = `Smazáno ${fridge.length} lednicových prodejů. V Redis zůstalo ${clean.length} Pokémon prodejů.`;
    return res.status(200).json(report);
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}

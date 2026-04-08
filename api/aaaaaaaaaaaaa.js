const historyData = require('./history.json');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const data = await res.json();
    if (!data.result) return null;
    let parsed = data.result;
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    return Array.isArray(parsed) ? parsed : null;
  } catch(e) { return null; }
}

export default async function handler(req, res) {
  const DISCORD = process.env.DISCORD_WEBHOOK;
  if (!DISCORD) return res.status(500).json({ error: 'No webhook' });

  // Spoj Redis + history
  const savedSales = await redisGet('sales') || [];
  const historyKeys = new Set(historyData.map(s => s.AuthorizationDateTimeGMT + '_' + s.SettlementValue));
  const onlyNew = savedSales.filter(s => !historyKeys.has(s.AuthorizationDateTimeGMT + '_' + s.SettlementValue));
  const allSales = [...onlyNew, ...historyData];

  // Dnešní prodeje
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' });
  const todaySales = allSales.filter(s => (s.AuthorizationDateTimeGMT || '').slice(0, 10) === today);

  if (todaySales.length === 0) {
    await fetch(DISCORD, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '@everyone',
        embeds: [{
          title: `📊 Denní souhrn – ${today}`,
          description: 'Dnes nebyl žádný prodej.',
          color: 0x5a5a6a,
          footer: { text: 'Pokémon Automat · Nayax' }
        }]
      })
    });
    return res.status(200).json({ ok: true, sales: 0 });
  }

  const totalRev = todaySales.reduce((s, t) => s + t.SettlementValue, 0);
  const cashRev = todaySales.filter(s => s.PaymentMethod === 'Hotovost').reduce((s, t) => s + t.SettlementValue, 0);
  const cardRev = totalRev - cashRev;
  const avgRev = totalRev / todaySales.length;
  const maxSale = Math.max(...todaySales.map(s => s.SettlementValue));

  // Nejlepší slot
  const slotMap = {};
  todaySales.forEach(s => {
    const slot = s.Selection || '?';
    slotMap[slot] = (slotMap[slot] || 0) + s.SettlementValue;
  });
  const bestSlot = Object.entries(slotMap).sort((a, b) => b[1] - a[1])[0];

  const fmt = v => Math.round(v).toLocaleString('cs-CZ') + ' Kč';

  await fetch(DISCORD, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: '@everyone',
      embeds: [{
        title: `📊 Denní souhrn – ${today}`,
        color: 0x4f8ef7,
        fields: [
          { name: '💰 Celkové tržby', value: fmt(totalRev), inline: true },
          { name: '🛒 Počet prodejů', value: `${todaySales.length}×`, inline: true },
          { name: '📈 Průměrný nákup', value: fmt(avgRev), inline: true },
          { name: '💵 Hotovost', value: fmt(cashRev), inline: true },
          { name: '💳 Karta', value: fmt(cardRev), inline: true },
          { name: '🏆 Nejvyšší nákup', value: fmt(maxSale), inline: true },
          { name: '⭐ Nejlepší slot', value: `Slot ${bestSlot[0]} · ${fmt(bestSlot[1])}`, inline: false },
        ],
        footer: { text: 'Pokémon Automat · Nayax' },
        timestamp: new Date().toISOString()
      }]
    })
  });

  return res.status(200).json({ ok: true, sales: todaySales.length, revenue: totalRev });
}

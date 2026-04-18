const historyData = require('./history.json');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const SLOTS={'1':'Black Bolt Booster','2':'Clay Burst Booster','3':'Mega Dream EX Booster','4':'Ancient Roar Booster','5':'Mega Symphonia Booster','6':'Scarlet & Violet Booster','7':'Twilight Masquerade Booster','8':'Surging Sparks Booster','9':'Destined Rivals Booster','10':'Ascended Heroes Booster','11':'Temporal Forces Booster','12':'Journey Together Booster','13':'Single karta','14':'Hard Sleeves','15':'Sleeves','16':'Blister 2pack','17':'Blister 3pack','18':'Shrouded Fable Tin','19':'Battle Styles Booster','20':'Terestal Festival Booster (JP)','21':'Astral Radiance Booster','22':'Obsidian Flames Booster','23':'Vivid Voltage Booster','24':'Team of Glory Booster (JP)','25':'Unova Black Tin','26':'Mega Heroes Tin'};
const MARGIN={'1':50,'2':52,'3':100,'4':43,'5':45,'6':33,'7':42,'8':31,'9':41,'10':41,'11':50,'12':42,'13':38,'14':59,'15':42,'16':83,'17':125,'18':67,'19':42,'20':75,'21':45,'22':75,'23':42,'24':18,'25':67,'26':83};
const MONTHS_CS=['Leden','Únor','Březen','Duben','Květen','Červen','Červenec','Srpen','Září','Říjen','Listopad','Prosinec'];

async function redisGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/${key}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
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

  // Zjisti jestli je dnes posledni den v mesici
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isLastDay = tomorrow.getMonth() !== now.getMonth();

  // Lze vynutit poslanim ?force=1
  if (!isLastDay && req.query.force !== '1') {
    return res.status(200).json({ ok: true, skipped: true, reason: 'Not last day of month' });
  }

  // Spoj Redis + history
  const savedSales = await redisGet('sales') || [];
  const historyKeys = new Set(historyData.map(s => s.AuthorizationDateTimeGMT + '_' + s.SettlementValue));
  const onlyNew = savedSales.filter(s => !historyKeys.has(s.AuthorizationDateTimeGMT + '_' + s.SettlementValue));
  const allSales = [...onlyNew, ...historyData];

  // Filtruj tento mesic
  const monthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const monthSales = allSales.filter(s => (s.AuthorizationDateTimeGMT||'').slice(0,7) === monthKey);

  const fmt = v => Math.round(v).toLocaleString('cs-CZ') + ' Kč';
  const monthName = MONTHS_CS[now.getMonth()] + ' ' + now.getFullYear();

  if (monthSales.length === 0) {
    await fetch(DISCORD, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '@everyone',
        embeds: [{
          title: `📅 Měsíční souhrn – ${monthName}`,
          description: 'Tento měsíc nebyl žádný prodej.',
          color: 0x5a5a6a,
          footer: { text: 'Pokémon Automat · Nayax' }
        }]
      })
    });
    return res.status(200).json({ ok: true, sales: 0 });
  }

  const totalRev = monthSales.reduce((s,t) => s + (t.SettlementValue||0), 0);
  const totalProfit = monthSales.reduce((s,t) => s + (MARGIN[String(t.Selection)]||0), 0);
  const cashRev = monthSales.filter(t => t.PaymentMethod==='Hotovost').reduce((s,t) => s+(t.SettlementValue||0), 0);
  const cardRev = totalRev - cashRev;
  const avgRev = totalRev / monthSales.length;
  const maxSale = Math.max(...monthSales.map(t => t.SettlementValue||0));

  // Nejlepší slot
  const slotMap = {};
  monthSales.forEach(s => {
    const slot = String(s.Selection||'?');
    slotMap[slot] = (slotMap[slot]||0) + 1;
  });
  const bestSlotEntry = Object.entries(slotMap).sort((a,b)=>b[1]-a[1])[0];
  const bestSlotName = bestSlotEntry ? (SLOTS[bestSlotEntry[0]]||`Slot ${bestSlotEntry[0]}`) : '–';

  // Nejziskovější slot
  const profitMap = {};
  monthSales.forEach(s => {
    const slot = String(s.Selection||'?');
    profitMap[slot] = (profitMap[slot]||0) + (MARGIN[slot]||0);
  });
  const bestProfitEntry = Object.entries(profitMap).sort((a,b)=>b[1]-a[1])[0];
  const bestProfitName = bestProfitEntry ? (SLOTS[bestProfitEntry[0]]||`Slot ${bestProfitEntry[0]}`) : '–';

  await fetch(DISCORD, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: '@everyone',
      embeds: [{
        title: `📅 Měsíční souhrn – ${monthName}`,
        color: 0x4f8ef7,
        fields: [
          { name: '💰 Celkové tržby', value: fmt(totalRev), inline: true },
          { name: '📈 Čistý profit', value: fmt(totalProfit), inline: true },
          { name: '🛒 Počet prodejů', value: `${monthSales.length}×`, inline: true },
          { name: '💵 Hotovost', value: fmt(cashRev), inline: true },
          { name: '💳 Karta', value: fmt(cardRev), inline: true },
          { name: '📊 Průměrný nákup', value: fmt(avgRev), inline: true },
          { name: '🏆 Nejvyšší nákup', value: fmt(maxSale), inline: true },
          { name: '⭐ Nejprodávanější', value: `${bestSlotName} (${bestSlotEntry?.[1]}×)`, inline: true },
          { name: '💎 Nejziskovější', value: `${bestProfitName} · ${fmt(bestProfitEntry?.[1]||0)}`, inline: true },
        ],
        footer: { text: 'Pokémon Automat · Nayax' },
        timestamp: new Date().toISOString()
      }]
    })
  });

  return res.status(200).json({ ok: true, sales: monthSales.length, revenue: totalRev, profit: totalProfit });
}

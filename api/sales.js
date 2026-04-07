const historyData = require('./history.json');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const TOKEN      = process.env.NAYAX_TOKEN;
  const MACHINE_ID = process.env.NAYAX_MACHINE_ID;

  // Zkus live Nayax API
  if (TOKEN && MACHINE_ID) {
    try {
      const urls = [
        `https://lynx.nayax.com/operational/v1/machines/${MACHINE_ID}/lastSales`,
        `https://lynx.nayax.com/operational/api/v1/machines/${MACHINE_ID}/lastSales`,
      ];
      for (const url of urls) {
        const response = await fetch(url, {
          headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
        });
        if (response.ok) {
          const liveData = await response.json();
          const liveSales = Array.isArray(liveData) ? liveData : (liveData.Sales || liveData.data || []);
          // Spoj live data s historickými (bez duplikátů)
          const liveIds = new Set(liveSales.map(s => s.AuthorizationDateTimeGMT));
          const merged = [...liveSales, ...historyData.filter(s => !liveIds.has(s.AuthorizationDateTimeGMT))];
          return res.status(200).json(merged);
        }
      }
    } catch(e) {
      console.log('Live API nedostupná, vracím historická data:', e.message);
    }
  }

  // Fallback: historická data z xlsx
  return res.status(200).json(historyData);
}

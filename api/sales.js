export default async function handler(req, res) {
  // CORS hlavicky
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const TOKEN      = process.env.NAYAX_TOKEN;
  const MACHINE_ID = process.env.NAYAX_MACHINE_ID;

  if (!TOKEN || !MACHINE_ID) {
    return res.status(500).json({ error: 'Chybí environment variables na Vercelu.' });
  }

  try {
    // Zkusíme oba možné endpointy
    const urls = [
      `https://lynx.nayax.com/operational/api/v1/machines/${MACHINE_ID}/lastSales`,
      `https://lynx.nayax.com/operational/v1/machines/${MACHINE_ID}/lastSales`,
    ];

    let response, lastError;
    for (const url of urls) {
      response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        }
      });
      if (response.ok) break;
      lastError = `${url} → HTTP ${response.status}`;
    }

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: `Nayax API error: ${response.status}`, detail: text, tried: lastError });
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

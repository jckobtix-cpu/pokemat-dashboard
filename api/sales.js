const historyData = require('./history.json');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/${key}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch(e) { return null; }
}

async function redisSet(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    await fetch(`${REDIS_URL}/set/${key}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(value) })
    });
  } catch(e) {}
}

async function sqsRequest(ACCESS_KEY, SECRET_KEY, QUEUE_URL, queryString) {
  const crypto = await import('crypto');
  const url = new URL(QUEUE_URL);
  const region = url.hostname.split('.')[1];
  const now = new Date();
  const dateStr = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateOnly = dateStr.slice(0, 8);

  function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
  function hmacHex(key, data) { return crypto.createHmac('sha256', key).update(data).digest('hex'); }
  function hash(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

  const host = url.hostname;
  const path = url.pathname;
  const payloadHash = hash('');
  const canonicalHeaders = `host:${host}\nx-amz-date:${dateStr}\n`;
  const signedHeaders = 'host;x-amz-date';
  const canonicalRequest = `GET\n${path}\n${queryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const credentialScope = `${dateOnly}/${region}/sqs/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${dateStr}\n${credentialScope}\n${hash(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET_KEY}`, dateOnly), region), 'sqs'), 'aws4_request');
  const signature = hmacHex(signingKey, stringToSign);
  const authHeader = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(`${QUEUE_URL}?${queryString}`, {
    headers: { 'x-amz-date': dateStr, 'Authorization': authHeader }
  });
}

async function fetchFromSQS() {
  const ACCESS_KEY = process.env.NAYAX_AWS_ACCESS_KEY;
  const SECRET_KEY = process.env.NAYAX_AWS_SECRET_KEY;
  const QUEUE_URL = process.env.NAYAX_AWS_QUEUE_URL;
  if (!ACCESS_KEY || !SECRET_KEY || !QUEUE_URL) return [];

  try {
    // 1. Přijmi zprávy
    const response = await sqsRequest(ACCESS_KEY, SECRET_KEY, QUEUE_URL, 'Action=ReceiveMessage&MaxNumberOfMessages=10&WaitTimeSeconds=0');
    if (!response.ok) return [];
    const xml = await response.text();

    const messages = [];
    const receiptHandles = [];

    // Parsuj zprávy a receipt handles
    const msgMatches = [...xml.matchAll(/<Message>([\s\S]*?)<\/Message>/g)];
    
    for (const msgMatch of msgMatches) {
      const msgXml = msgMatch[1];
      try {
        // Získej receipt handle pro smazání
        const rhMatch = msgXml.match(/<ReceiptHandle>([\s\S]*?)<\/ReceiptHandle>/);
        const bodyMatch = msgXml.match(/<Body>([\s\S]*?)<\/Body>/);
        
        if (rhMatch) receiptHandles.push(rhMatch[1]);
        
        if (bodyMatch) {
          const body = bodyMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
          const msg = JSON.parse(body);
          const data = msg.Data || msg;

          // Platební metoda
          const pmDesc = (data['Payment Method Description'] || data['PaymentMethod'] || '').toLowerCase();
          let payMethod = 'Karta';
          if (pmDesc.includes('cash') || pmDesc.includes('hotovost')) payMethod = 'Hotovost';
          else if (pmDesc.includes('mastercard')) payMethod = 'Mastercard';
          else if (pmDesc.includes('visa')) payMethod = 'Visa';
          else if (pmDesc.includes('apple')) payMethod = 'Apple Pay';
          else if (pmDesc.includes('google')) payMethod = 'Google Pay';

          const sale = {
            AuthorizationDateTimeGMT: (data['Machine AuTime'] || data['Authorization Time'] || msg.MachineTime || new Date().toISOString()).replace('Z','').slice(0,19),
            SettlementValue: parseFloat(data['SeValue'] || data['SettlementValue'] || msg.AuthorizationValue || 0),
            Selection: String(data['Product Code in Map'] || data['OP Button Code'] || data['Selection'] || '?'),
            PaymentMethod: payMethod,
            ProductName: data['Product Name'] || null,
          };

          if (sale.SettlementValue > 0) messages.push(sale);
        }
      } catch(e) { console.error('Parse error:', e.message); }
    }

    // 2. Smaž zpracované zprávy ze SQS
    for (const rh of receiptHandles) {
      try {
        const encoded = encodeURIComponent(rh);
        await sqsRequest(ACCESS_KEY, SECRET_KEY, QUEUE_URL, `Action=DeleteMessage&ReceiptHandle=${encoded}`);
      } catch(e) {}
    }

    return messages;
  } catch(e) {
    console.error('SQS error:', e.message);
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 1. Načti nové prodeje ze SQS a hned je smaž z fronty
    const sqsSales = await fetchFromSQS();

    // 2. Načti uložené prodeje z Redis
    let savedSales = await redisGet('sales') || [];

    // 3. Přidej nové prodeje (bez duplikátů)
    if (sqsSales.length > 0) {
      const existingKeys = new Set(savedSales.map(s => s.AuthorizationDateTimeGMT + '_' + s.SettlementValue));
      const newSales = sqsSales.filter(s => !existingKeys.has(s.AuthorizationDateTimeGMT + '_' + s.SettlementValue));

      if (newSales.length > 0) {
        savedSales = [...newSales, ...savedSales];
        await redisSet('sales', savedSales);

        // Discord notifikace
        const DISCORD = process.env.DISCORD_WEBHOOK;
        if (DISCORD) {
          for (const sale of newSales) {
            const pm = sale.PaymentMethod;
            const product = sale.ProductName || `Slot ${sale.Selection}`;
            const amount = Math.round(sale.SettlementValue);
            const time = sale.AuthorizationDateTimeGMT.replace('T', ' ').slice(0, 16);
            await fetch(DISCORD, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                embeds: [{
                  title: '🎮 Nový prodej!',
                  color: 0x22c55e,
                  fields: [
                    { name: '📦 Produkt', value: product, inline: true },
                    { name: '💰 Částka', value: `${amount} Kč`, inline: true },
                    { name: '💳 Platba', value: pm, inline: true },
                    { name: '🕐 Čas', value: time, inline: true },
                  ],
                  footer: { text: 'Pokémon Automat · Nayax' }
                }]
              })
            }).catch(() => {});
          }
        }
      }
    }

    // 4. Spoj: Redis (nové) + history.json (historické)
    const historyKeys = new Set(historyData.map(s => s.AuthorizationDateTimeGMT + '_' + s.SettlementValue));
    const onlyNew = savedSales.filter(s => !historyKeys.has(s.AuthorizationDateTimeGMT + '_' + s.SettlementValue));
    const merged = [...onlyNew, ...historyData];

    return res.status(200).json(merged);

  } catch(e) {
    console.error('Handler error:', e.message);
    return res.status(200).json(historyData);
  }
}

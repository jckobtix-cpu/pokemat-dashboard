const historyData = require('./history.json');

// Upstash Redis - automaticky přidán Vercelem
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
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

// Načte nové prodeje z AWS SQS
async function fetchFromSQS() {
  const ACCESS_KEY = process.env.NAYAX_AWS_ACCESS_KEY;
  const SECRET_KEY = process.env.NAYAX_AWS_SECRET_KEY;
  const QUEUE_URL = process.env.NAYAX_AWS_QUEUE_URL;

  if (!ACCESS_KEY || !SECRET_KEY || !QUEUE_URL) return [];

  try {
    // AWS SQS ReceiveMessage pomocí AWS Signature v4
    const url = new URL(QUEUE_URL);
    const region = url.hostname.split('.')[1];
    const endpoint = `${QUEUE_URL}?Action=ReceiveMessage&MaxNumberOfMessages=10&WaitTimeSeconds=0`;

    const now = new Date();
    const dateStr = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
    const dateOnly = dateStr.slice(0, 8);

    // Jednoduchý AWS Signature v4
    const crypto = await import('crypto');
    
    function hmac(key, data) {
      return crypto.createHmac('sha256', key).update(data).digest();
    }
    function hmacHex(key, data) {
      return crypto.createHmac('sha256', key).update(data).digest('hex');
    }
    function hash(data) {
      return crypto.createHash('sha256').update(data).digest('hex');
    }

    const method = 'GET';
    const service = 'sqs';
    const host = url.hostname;
    const path = url.pathname;
    const queryString = 'Action=ReceiveMessage&MaxNumberOfMessages=10&WaitTimeSeconds=0';
    const payloadHash = hash('');
    const canonicalHeaders = `host:${host}\nx-amz-date:${dateStr}\n`;
    const signedHeaders = 'host;x-amz-date';
    const canonicalRequest = `${method}\n${path}\n${queryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credentialScope = `${dateOnly}/${region}/${service}/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${dateStr}\n${credentialScope}\n${hash(canonicalRequest)}`;
    
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET_KEY}`, dateOnly), region), service), 'aws4_request');
    const signature = hmacHex(signingKey, stringToSign);
    const authHeader = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const response = await fetch(`${QUEUE_URL}?${queryString}`, {
      headers: {
        'x-amz-date': dateStr,
        'Authorization': authHeader,
      }
    });

    if (!response.ok) return [];
    
    const xml = await response.text();
    const messages = [];
    const bodyMatches = xml.matchAll(/<Body>([\s\S]*?)<\/Body>/g);
    
    for (const match of bodyMatches) {
      try {
        const body = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        const msg = JSON.parse(body);
        
        // Převod SQS zprávy na náš formát
        const data = msg.Data || msg;
        const sale = {
          AuthorizationDateTimeGMT: data['Machine AuTime'] || data['Authorization Time'] || msg.MachineTime || new Date().toISOString().replace('Z',''),
          SettlementValue: parseFloat(data['SeValue'] || data['Settlement Value'] || msg.AuthorizationValue || 0),
          Selection: String(data['Product Code in Map'] || data['OP Button Code'] || '?'),
          PaymentMethod: (data['Payment Method Description'] || '').includes('Cash') ? 'Hotovost' : 'Karta',
          ProductName: data['Product Name'] || null,
        };
        
        if (sale.SettlementValue > 0) messages.push(sale);
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
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 1. Načti nové prodeje ze SQS
    const sqsSales = await fetchFromSQS();
    
    // 2. Načti uložené prodeje z Redis
    let savedSales = await redisGet('sales') || [];
    
    // 3. Přidej nové prodeje (bez duplikátů)
    if (sqsSales.length > 0) {
      const existingKeys = new Set(savedSales.map(s => s.AuthorizationDateTimeGMT + s.SettlementValue));
      const newSales = sqsSales.filter(s => !existingKeys.has(s.AuthorizationDateTimeGMT + s.SettlementValue));
      if (newSales.length > 0) {
        savedSales = [...newSales, ...savedSales];
        await redisSet('sales', savedSales);
      }
    }
    
    // 4. Spoj: Redis (nové) + history.json (historické)
    const historyKeys = new Set(historyData.map(s => s.AuthorizationDateTimeGMT + s.SettlementValue));
    const onlyNew = savedSales.filter(s => !historyKeys.has(s.AuthorizationDateTimeGMT + s.SettlementValue));
    const merged = [...onlyNew, ...historyData];
    
    return res.status(200).json(merged);
    
  } catch(e) {
    console.error('Handler error:', e.message);
    return res.status(200).json(historyData);
  }
}

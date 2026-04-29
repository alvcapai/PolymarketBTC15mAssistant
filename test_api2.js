import 'dotenv/config';
import crypto from 'crypto';

const CLOB_HOST = 'https://clob.polymarket.com';
const PROXY_ADDRESS = process.env.POLYMARKET_PROXY_ADDRESS;
const SIGNATURE_TYPE = '2';
const SECRET = process.env.POLYMARKET_API_SECRET;
const API_KEY = process.env.POLYMARKET_API_KEY;
const PASSPHRASE = process.env.POLYMARKET_API_PASSPHRASE;
const walletAddress = '0xBb0cA7CE98c971e4a7b4637aD6ceD0c0e909Bca0';

function buildHmacSignature(secret, timestamp, method, requestPath, body = '') {
  const message = timestamp + method + requestPath + body;
  const hmac = crypto.createHmac('sha256', Buffer.from(secret, 'base64'));
  return hmac.update(message).digest('base64');
}

async function run() {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const path = '/balance-allowance';
  const query = `asset_type=COLLATERAL&signature_type=${SIGNATURE_TYPE}&funder=${PROXY_ADDRESS}`;
  const signature = buildHmacSignature(SECRET, timestamp, 'GET', path);
  
  const res = await fetch(`${CLOB_HOST}${path}?${query}`, {
    method: 'GET',
    headers: {
        'Content-Type': 'application/json',
        'POLY_ADDRESS': walletAddress,
        'POLY_API_KEY': API_KEY,
        'POLY_PASSPHRASE': PASSPHRASE,
        'POLY_TIMESTAMP': timestamp,
        'POLY_SIGNATURE': signature,
    }
  });
  console.log(await res.json());
}
run();

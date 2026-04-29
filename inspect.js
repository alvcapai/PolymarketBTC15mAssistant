import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client-v2';
import { createWalletClient, http, privateKeyToAccount } from 'viem';
import { CONFIG } from './src/config.js';

const pk = process.env.PK.startsWith('0x') ? process.env.PK : '0x' + process.env.PK;
const account = privateKeyToAccount(pk);
const viemSigner = createWalletClient({
  account,
  chain: { id: 137, rpcUrls: { default: { http: [CONFIG.chainlink.polygonRpcUrl] } } },
  transport: http(),
});

const client = new ClobClient({
  host: 'https://clob.polymarket.com',
  chain: 137,
  signer: viemSigner,
  creds: {
    key: process.env.POLYMARKET_API_KEY,
    secret: process.env.POLYMARKET_API_SECRET,
    passphrase: process.env.POLYMARKET_API_PASSPHRASE,
  },
  signatureType: 2,
  funderAddress: process.env.POLYMARKET_PROXY_ADDRESS,
});

console.log('Signer type:', client.signer.constructor?.name ?? typeof client.signer);
console.log('Signer account address:', client.signer.account?.address ?? 'N/A');

try {
  console.log('Testing signTypedData...');
  await client.signer.signTypedData({
    domain: { chainId: 137, name: 'test', version: '1' },
    types: { Test: [{ name: 'value', type: 'uint256' }] },
    primaryType: 'Test',
    message: { value: 1n },
  });
  console.log('signTypedData OK');
} catch (e) {
  console.log('Error calling signTypedData:', e.message);
}

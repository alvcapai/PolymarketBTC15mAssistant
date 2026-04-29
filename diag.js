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

console.log('Viem account address:', account.address);
console.log('Viem account has signTypedData:', typeof account.signTypedData);

const client = new ClobClient({
  host: 'https://clob.polymarket.com',
  chain: 137,
  signer: viemSigner,
});

console.log('Client signer type:', typeof client.signer);
console.log('Client signer has signTypedData:', typeof client.signer?.signTypedData);

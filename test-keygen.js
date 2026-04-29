import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client-v2';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const PK = process.env.PK.startsWith('0x') ? process.env.PK : '0x' + process.env.PK;
const account = privateKeyToAccount(PK);
const signer = createWalletClient({ account, transport: http('https://polygon-bor-rpc.publicnode.com') });

const client = new ClobClient({
  host: 'https://clob.polymarket.com',
  chain: 137,
  signer,
  signatureType: 2,
  funderAddress: process.env.POLYMARKET_PROXY_ADDRESS
});

async function main() {
  const creds = await client.createOrDeriveApiKey(0);
  console.log('Creds from SDK:', creds);
}
main().catch(console.error);

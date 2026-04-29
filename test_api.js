import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
const wallet = new Wallet(process.env.PK);
const client = new ClobClient(
  'https://clob.polymarket.com', 
  137, 
  wallet,
  null,
  process.env.POLYMARKET_PROXY_ADDRESS, 
  2,
  {
      key: process.env.POLYMARKET_API_KEY,
      secret: process.env.POLYMARKET_API_SECRET,
      passphrase: process.env.POLYMARKET_API_PASSPHRASE,
  }
);
client.getAllowanceAndBalanceOf({asset_type: 'COLLATERAL'}).then(console.log).catch(console.error);

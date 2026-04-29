import 'dotenv/config';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client-v2';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const PK = process.env.PK.startsWith('0x') ? process.env.PK : '0x' + process.env.PK;
const account = privateKeyToAccount(PK);
const signer = createWalletClient({ account, transport: http('https://polygon-bor-rpc.publicnode.com') });

const creds = {
  key: process.env.POLYMARKET_API_KEY,
  secret: process.env.POLYMARKET_API_SECRET,
  passphrase: process.env.POLYMARKET_API_PASSPHRASE
};

const client = new ClobClient({
  host: 'https://clob.polymarket.com',
  chain: 137,
  signer,
  creds,
  signatureType: 2,
  funderAddress: process.env.POLYMARKET_PROXY_ADDRESS
});

async function main() {
  const token = '63950897065960821990436367120879712678981772102861122988611727179831934129000'; // token from logs
  try {
      const resp = await client.createAndPostOrder(
      {
        tokenID: token,
        side: Side.BUY,
        price: 0.50,
        size: 2
      },
      { tickSize: '0.01', negRisk: false },
      OrderType.GTC
    );
    console.log(resp);
  } catch (e) {
    console.log('Exception:', e);
  }
}
main().catch(console.error);

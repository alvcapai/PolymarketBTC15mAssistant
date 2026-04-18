import 'dotenv/config';
import { JsonRpcProvider, Wallet } from 'ethers';
import { Chain, ClobClient } from '@polymarket/clob-client';
import { CONFIG } from './src/config.js';

const pk = '0x' + process.env.PK.replace('0x', '');
const provider = new JsonRpcProvider(CONFIG.chainlink.polygonRpcUrl);
const wallet = new Wallet(pk, provider);

const client = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, wallet, {
    key: process.env.POLYMARKET_API_KEY,
    secret: process.env.POLYMARKET_API_SECRET,
    passphrase: process.env.POLYMARKET_API_PASSPHRASE
}, 2, process.env.POLYMARKET_PROXY_ADDRESS);

console.log('Signer constructor:', client.signer.constructor.name);
console.log('Signer keys:', Object.keys(client.signer));
console.log('Signer proto keys:', Object.keys(Object.getPrototypeOf(client.signer)));
console.log('Signer has _signTypedData:', typeof client.signer._signTypedData);
console.log('Signer has signTypedData:', typeof client.signer.signTypedData);

try {
    console.log('Testing call...');
    await client.signer._signTypedData({chainId: 137}, {}, {});
} catch (e) {
    console.log('Error calling _signTypedData:', e.message);
}

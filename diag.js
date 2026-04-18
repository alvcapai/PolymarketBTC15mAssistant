import 'dotenv/config';
import { JsonRpcProvider, Wallet } from 'ethers';
import { Chain, ClobClient } from '@polymarket/clob-client';
import { CONFIG } from './src/config.js';

const pk = process.env.PK;
const provider = new JsonRpcProvider(CONFIG.chainlink.polygonRpcUrl);
const wallet = new Wallet(pk, provider);

console.log('Wallet v6 has signTypedData:', typeof wallet.signTypedData);
console.log('Wallet v6 has _signTypedData:', typeof wallet._signTypedData);

const client = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, wallet);

console.log('Client signer has signTypedData:', typeof client.signer.signTypedData);
console.log('Client signer has _signTypedData:', typeof client.signer._signTypedData);

if (client.signer._signTypedData === undefined) {
    console.log('Applying shim...');
    client.signer._signTypedData = (...args) => client.signer.signTypedData(...args);
}
console.log('After shim, Client signer has _signTypedData:', typeof client.signer._signTypedData);

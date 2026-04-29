import { executeTrade } from './src/trade/executor.js';
import { Side } from '@polymarket/clob-client-v2';
const token = '63950897065960821990436367120879712678981772102861122988611727179831934129000';
executeTrade(token, Side.BUY, 2, 0.50, 50).then(console.log).catch(console.error);

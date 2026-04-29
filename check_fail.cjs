const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com');
async function run() {
  const receipt = await provider.getTransactionReceipt('0xa6721f5f024c4a55fb6a36c481f1f6979787792ec8a11195914644be406445c9');
  for (const log of receipt.logs) {
    if (log.topics[0] === '0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23') {
       console.log('ExecutionFailure Event Found!');
    }
    if (log.topics[0] === '0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e') {
       console.log('ExecutionSuccess Event Found!');
    }
  }
}
run();

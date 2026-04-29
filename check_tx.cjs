const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com');
async function run() {
  const receipt = await provider.getTransactionReceipt('0xa6721f5f024c4a55fb6a36c481f1f6979787792ec8a11195914644be406445c9');
  console.log('Status:', receipt.status);
  console.log('Logs:', receipt.logs.length);
}
run();

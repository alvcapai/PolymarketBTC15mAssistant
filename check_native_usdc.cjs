const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com');
const NATIVE_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const USDC_ABI = ['function balanceOf(address) view returns (uint256)'];
const nativeContract = new ethers.Contract(NATIVE_USDC, USDC_ABI, provider);
const ownerWallet = '0xBb0cA7CE98c971e4a7b4637aD6ceD0c0e909Bca0';

async function check() {
  const nativeBal = await nativeContract.balanceOf(ownerWallet);
  console.log('Native USDC (0x3c49...) L1:', ethers.formatUnits(nativeBal, 6));
}
check();

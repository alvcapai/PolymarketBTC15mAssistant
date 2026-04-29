import 'dotenv/config';
import { Contract, Interface, JsonRpcProvider, Wallet, Network } from 'ethers';

const RPC_URL       = process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com';
const PK_RAW        = String(process.env.PK ?? '').trim();
const PROXY_ADDRESS = String(process.env.POLYMARKET_PROXY_ADDRESS ?? '').trim();
const USDC_ADDRESS     = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

const ERC20_ABI    = [ 'function balanceOf(address account) view returns (uint256)' ];
const EXCHANGE_ABI = [ 'function deposit(uint256 amount) external' ];
const SAFE_ABI     = [
  'function nonce() view returns (uint256)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)'
];

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to',             type: 'address' },
    { name: 'value',          type: 'uint256' },
    { name: 'data',           type: 'bytes'   },
    { name: 'operation',      type: 'uint8'   },
    { name: 'safeTxGas',      type: 'uint256' },
    { name: 'baseGas',        type: 'uint256' },
    { name: 'gasPrice',       type: 'uint256' },
    { name: 'gasToken',       type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce',          type: 'uint256' },
  ],
};

async function main() {
  const polyNetwork = Network.from(137);
  const provider = new JsonRpcProvider(RPC_URL, polyNetwork, { staticNetwork: polyNetwork });
  const wallet   = new Wallet(PK_RAW.startsWith('0x') ? PK_RAW : '0x' + PK_RAW, provider);
  const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, provider);
  const balance = await usdc.balanceOf(PROXY_ADDRESS);
  if (balance === 0n) { console.log('Zero balance'); return; }

  const exchangeIface = new Interface(EXCHANGE_ABI);
  const depositData = exchangeIface.encodeFunctionData('deposit', [balance]);
  const safe = new Contract(PROXY_ADDRESS, SAFE_ABI, provider);
  const nonce = await safe.nonce();

  const safeTx = {
    to:             EXCHANGE_ADDRESS,
    value:          0n,
    data:           depositData,
    operation:      0,
    safeTxGas:      500000n, // Set explicit safeTxGas
    baseGas:        0n,
    gasPrice:       0n,
    gasToken:       '0x0000000000000000000000000000000000000000',
    refundReceiver: '0x0000000000000000000000000000000000000000',
    nonce:          nonce,
  };

  const domain = { chainId: 137, verifyingContract: PROXY_ADDRESS };
  const signature = await wallet.signTypedData(domain, SAFE_TX_TYPES, safeTx);

  console.log('Sending transaction...');
  const tx = await safe.connect(wallet).execTransaction(
    safeTx.to, safeTx.value, safeTx.data, safeTx.operation,
    safeTx.safeTxGas, safeTx.baseGas, safeTx.gasPrice,
    safeTx.gasToken, safeTx.refundReceiver, signature,
    { gasLimit: 1000000 } // Higher outer gas limit
  );
  console.log('Tx sent:', tx.hash);
  await tx.wait();
  console.log('Success');
}
main().catch(console.error);

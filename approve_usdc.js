/**
 * approve_usdc.js — executa USDC.approve(CTF_Exchange, MaxUint256) a partir
 * do Gnosis Safe (POLYMARKET_PROXY_ADDRESS) assinado pelo EOA (PK).
 *
 * Contexto Polymarket:
 *   • PK                      → signer EOA (0xBb0cA7…) — dono do safe
 *   • POLYMARKET_PROXY_ADDRESS → Gnosis Safe (0x8F7997…) — detentor do USDC
 *   • signature_type = 2      → Polymarket usa a safe como funder
 *
 * O USDC fica no safe; portanto o approve deve ser enviado PELO safe via
 * execTransaction(), assinado com EIP-712 pelo owner EOA.
 *
 * Endereços confirmados via @polymarket/order-utils 1.3.1:
 *   USDC    : 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 (Polygon mainnet)
 *   Exchange: 0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E (CTF Exchange)
 */

import "dotenv/config";
import { execSync }          from "child_process";
import { Contract, Interface, MaxUint256, Network, Wallet, JsonRpcProvider } from "ethers";

// ─── ANSI colours ─────────────────────────────────────────────────────────────
const R = "\x1b[31m"; const G = "\x1b[32m"; const Y = "\x1b[33m";
const C = "\x1b[36m"; const B = "\x1b[1m";  const X = "\x1b[0m";

// ─── Config ───────────────────────────────────────────────────────────────────
// Fallback: PublicNode — gratuito, sem API key, sem rate-limit agressivo
const RPC_URL       = process.env.POLYGON_RPC_URL          || "https://polygon-bor-rpc.publicnode.com";
const PK_RAW        = String(process.env.PK                        ?? "").trim();
const PROXY_ADDRESS = String(process.env.POLYMARKET_PROXY_ADDRESS  ?? "").trim();
const SIG_TYPE      = String(process.env.POLYMARKET_SIGNATURE_TYPE ?? "2").trim();

const USDC_ADDRESS     = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

// ─── ABIs ────────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// Gnosis Safe — apenas as funções necessárias
const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
];

// EIP-712 SafeTx types (Gnosis Safe v1.3.0+)
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to",             type: "address" },
    { name: "value",          type: "uint256" },
    { name: "data",           type: "bytes"   },
    { name: "operation",      type: "uint8"   },
    { name: "safeTxGas",      type: "uint256" },
    { name: "baseGas",        type: "uint256" },
    { name: "gasPrice",       type: "uint256" },
    { name: "gasToken",       type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce",          type: "uint256" },
  ],
};

function formatUsdc6(raw) {
  return `$${(Number(raw) / 1e6).toFixed(2)} USDC`;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${Y}${B}[approve_usdc] Iniciando fluxo de aprovação USDC…${X}\n`);

  // ── Validações básicas ────────────────────────────────────────────────────
  if (!PK_RAW) {
    console.error(`${R}${B}[ERRO] Variável PK ausente no .env.${X}`);
    process.exit(1);
  }

  const pk = PK_RAW.startsWith("0x") ? PK_RAW : `0x${PK_RAW}`;

  // ── Conectar ──────────────────────────────────────────────────────────────
  // Network.from(137) cria o objeto Network correto para o ethers v6;
  // staticNetwork evita eth_chainId no startup (evita falha com RPCs lentos)
  const POLYGON_NETWORK = Network.from(137);
  const provider = new JsonRpcProvider(RPC_URL, POLYGON_NETWORK, { staticNetwork: POLYGON_NETWORK });
  const signer   = new Wallet(pk, provider);

  const chainId = 137n;
  console.log(`${C}  • RPC        : ${RPC_URL}${X}`);
  console.log(`${C}  • Chain ID   : ${chainId} (Polygon mainnet)${X}`);
  console.log(`${C}  • EOA signer : ${signer.address}${X}`);

  // ── Detectar modo: EOA direto (sig type 0/1) vs Gnosis Safe (sig type 2) ─
  const isProxy = SIG_TYPE === "2" && PROXY_ADDRESS !== "";
  const TARGET  = isProxy ? PROXY_ADDRESS : signer.address; // detentor do USDC

  console.log(`${C}  • USDC holder: ${TARGET}${isProxy ? " (Gnosis Safe)" : " (EOA)"}${X}`);
  console.log(`${C}  • Spender    : ${EXCHANGE_ADDRESS} (CTF Exchange)${X}\n`);

  const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, provider);

  // ── [1] Verificar allowance atual (on-chain) ──────────────────────────────
  console.log(`${Y}  [1/4] Verificando allowance on-chain…${X}`);
  const currentAllowance = await usdc.allowance(TARGET, EXCHANGE_ADDRESS);
  const balance          = await usdc.balanceOf(TARGET);

  console.log(`${C}        Saldo  : ${formatUsdc6(balance)}${X}`);
  console.log(`${C}        Allowance atual: ${formatUsdc6(currentAllowance)}${X}\n`);

  if (currentAllowance > 0n) {
    console.log(
      `${G}${B}  ✔  Allowance já está definida (${formatUsdc6(currentAllowance)}).${X}\n` +
      `${G}     O contrato Exchange já pode gastar o USDC desta carteira.${X}\n`
    );
    console.log(`${Y}  Executando smoketest.js para confirmar…${X}\n`);
    runSmoketest();
    return;
  }

  // ── [2] Construir calldata do approve ─────────────────────────────────────
  console.log(`${Y}  [2/4] Allowance zerada — construindo transação de approve…${X}`);
  const usdcInterface  = new Interface(ERC20_ABI);
  const approveCalldata = usdcInterface.encodeFunctionData("approve", [
    EXCHANGE_ADDRESS,
    MaxUint256,
  ]);
  console.log(`${C}        Calldata: ${approveCalldata.slice(0, 20)}…${X}\n`);

  // ── [3] Executar approve ──────────────────────────────────────────────────
  let txHash;

  if (!isProxy) {
    // ── Modo EOA direto: signer assina e envia direto ───────────────────────
    console.log(`${Y}  [3/4] Enviando approve diretamente do EOA…${X}`);
    const usdcWithSigner = usdc.connect(signer);
    const tx = await usdcWithSigner.approve(EXCHANGE_ADDRESS, MaxUint256);
    console.log(`${C}        Tx enviada: ${tx.hash}${X}`);
    console.log(`${Y}        Aguardando confirmação…${X}`);
    const receipt = await tx.wait(1);
    txHash = receipt.hash;

  } else {
    // ── Modo Gnosis Safe: execTransaction com assinatura EIP-712 ────────────
    console.log(`${Y}  [3/4] Preparando execTransaction no Gnosis Safe…${X}`);

    const safe = new Contract(PROXY_ADDRESS, SAFE_ABI, provider);

    // Verificar que o signer é dono do safe
    let owners, threshold;
    try {
      owners    = await safe.getOwners();
      threshold = await safe.getThreshold();
      console.log(`${C}        Safe owners (${threshold}/${owners.length}):${X}`);
      owners.forEach(o => console.log(`${C}          ${o}${X}`));
    } catch (err) {
      console.error(
        `\n${R}${B}[ERRO] Não foi possível ler os owners do safe.${X}\n` +
        `${R}  Detalhe: ${err?.message}${X}\n` +
        `${R}  Possível causa: POLYMARKET_PROXY_ADDRESS não é um Gnosis Safe,${X}\n` +
        `${R}  ou o endereço está incorreto.${X}\n`
      );
      process.exit(1);
    }

    const normalizedSigner = signer.address.toLowerCase();
    const isOwner = owners.some(o => o.toLowerCase() === normalizedSigner);
    if (!isOwner) {
      console.error(
        `\n${R}${B}[ERRO] O EOA ${signer.address} NÃO é owner do safe ${PROXY_ADDRESS}.${X}\n` +
        `${R}  Owners: ${owners.join(", ")}${X}\n` +
        `${R}  Verifique se a PK no .env corresponde ao owner do safe.${X}\n`
      );
      process.exit(1);
    }
    console.log(`${G}        EOA confirmado como owner do safe. ✓${X}\n`);

    const safeNonce = await safe.nonce();
    console.log(`${C}        Safe nonce: ${safeNonce}${X}\n`);

    // Monta a SafeTx
    const safeTx = {
      to:             USDC_ADDRESS,
      value:          0n,
      data:           approveCalldata,
      operation:      0,         // CALL (não DELEGATECALL)
      safeTxGas:      0n,
      baseGas:        0n,
      gasPrice:       0n,
      gasToken:       "0x0000000000000000000000000000000000000000",
      refundReceiver: "0x0000000000000000000000000000000000000000",
      nonce:          safeNonce,
    };

    // EIP-712 domain do safe
    const domain = {
      chainId,
      verifyingContract: PROXY_ADDRESS,
    };

    console.log(`${Y}        Assinando SafeTx via EIP-712…${X}`);
    const signature = await signer.signTypedData(domain, SAFE_TX_TYPES, safeTx);
    console.log(`${C}        Assinatura: ${signature.slice(0, 20)}…${X}\n`);

    // execTransaction precisa de uma assinatura "packed" no formato r+s+v (65 bytes)
    // A assinatura EIP-712 já está no formato correto de 65 bytes (r+s+v)
    // Gnosis Safe espera v=27 ou v=28 para ECDSA — ethers já retorna assim

    console.log(`${Y}        Enviando execTransaction no safe…${X}`);
    const safeWithSigner = safe.connect(signer);

    const tx = await safeWithSigner.execTransaction(
      safeTx.to,
      safeTx.value,
      safeTx.data,
      safeTx.operation,
      safeTx.safeTxGas,
      safeTx.baseGas,
      safeTx.gasPrice,
      safeTx.gasToken,
      safeTx.refundReceiver,
      signature,
    );

    console.log(`${C}        Tx enviada: ${tx.hash}${X}`);
    console.log(`${Y}        Aguardando confirmação (pode levar ~15 s)…${X}`);
    const receipt = await tx.wait(1);
    txHash = receipt.hash;
  }

  // ── [4] Verificar resultado ───────────────────────────────────────────────
  console.log(`\n${Y}  [4/4] Verificando allowance pós-transação…${X}`);
  const newAllowance = await usdc.allowance(TARGET, EXCHANGE_ADDRESS);

  if (newAllowance > 0n) {
    console.log(
      `\n${G}${B}╔══════════════════════════════════════════════════════════════════╗${X}\n` +
      `${G}${B}║  [SUCESSO] Approve executado com sucesso!                        ║${X}\n` +
      `${G}${B}╚══════════════════════════════════════════════════════════════════╝${X}\n` +
      `${G}  • Tx hash        : ${txHash}${X}\n` +
      `${G}  • Nova allowance : ${formatUsdc6(newAllowance)}${X}\n` +
      `${G}  • Spender        : ${EXCHANGE_ADDRESS}${X}\n`
    );
  } else {
    console.error(
      `\n${R}${B}[AVISO] Transação confirmada mas allowance ainda é $0.00.${X}\n` +
      `${R}  Tx hash: ${txHash}${X}\n` +
      `${R}  Verifique a transação no PolygonScan.${X}\n`
    );
  }

  // ── Executar smoketest ────────────────────────────────────────────────────
  console.log(`\n${Y}  Executando smoketest.js para validação final…${X}\n`);
  runSmoketest();
}

function runSmoketest() {
  try {
    execSync("node smoketest.js", { stdio: "inherit" });
  } catch (_) {
    // smoketest já imprime o resultado — qualquer exit code não-zero é ok
  }
}

main().catch(err => {
  console.error(`\n${R}${B}[ERRO FATAL] ${err?.message ?? String(err)}${X}\n`);
  if (err?.stack) console.error(`${R}${err.stack}${X}\n`);
  process.exit(1);
});

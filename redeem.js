/**
 * redeem.js — Resgata posições vencedoras no Polymarket via código.
 *
 * O que faz:
 *   1. Consulta a API Gamma para encontrar posições resgatáveis da proxy.
 *   2. Para cada posição, chama redeemPositions() no contrato CTF.
 *   3. Como o safe (proxy) detém os tokens, a chamada vai via execTransaction()
 *      assinado com EIP-712 pelo EOA owner — mesmo padrão do approve_usdc.js.
 *
 * Uso:
 *   node redeem.js            # lista posições e resgata todas resgatáveis
 *   node redeem.js --dry-run  # só lista, não envia transação
 */

import "dotenv/config";
import { Contract, Interface, JsonRpcProvider, Wallet, ZeroHash } from "ethers";

// ─── ANSI ─────────────────────────────────────────────────────────────────────
const G = "\x1b[32m", Y = "\x1b[33m", R = "\x1b[31m", C = "\x1b[36m";
const B = "\x1b[1m",  X = "\x1b[0m",  D = "\x1b[2m";

// ─── Configuração ─────────────────────────────────────────────────────────────
const DRY_RUN       = process.argv.includes("--dry-run");
const RPC_URL       = process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com";
const PK_RAW        = String(process.env.PK ?? "").trim();
const PROXY_ADDRESS = String(process.env.POLYMARKET_PROXY_ADDRESS ?? "").trim();

// Contratos Polymarket na Polygon mainnet
const CTF_ADDRESS   = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// API
const GAMMA_API     = "https://gamma-api.polymarket.com";
const CLOB_API      = "https://clob.polymarket.com";

// ─── ABIs ─────────────────────────────────────────────────────────────────────
const CTF_ABI = [
  // Resgata posições vencedoras de um mercado resolvido
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external",
  // Consulta saldo ERC1155 de um token
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  // Consulta quantos outcomes foram reportados (>0 = resolvido)
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
  // Consulta payout de cada outcome (0=não resolvido, >0=resolvido)
  "function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)",
];

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
];

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

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeKey(raw) {
  const k = String(raw ?? "").trim();
  if (!k) throw new Error("PK não definida no .env");
  return k.startsWith("0x") ? k : `0x${k}`;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

// ─── Busca posições resgatáveis via API Gamma ─────────────────────────────────

async function fetchRedeemablePositions(address) {
  // Tenta endpoint de posições da Gamma API
  let positions = [];
  try {
    const data = await fetchJson(
      `${GAMMA_API}/positions?user=${address}&redeemable=true&limit=100`
    );
    positions = Array.isArray(data) ? data : (data?.results ?? data?.data ?? []);
  } catch {
    console.error(`${Y}Aviso: endpoint redeemable falhou, tentando posições gerais...${X}`);
  }

  if (!positions.length) {
    try {
      const data = await fetchJson(
        `${GAMMA_API}/positions?user=${address}&limit=200`
      );
      positions = Array.isArray(data) ? data : (data?.results ?? data?.data ?? []);
      // Filtrar manualmente as que podem ser resgatáveis
      positions = positions.filter(p =>
        p.redeemable === true ||
        p.redeemable === "true" ||
        (p.market?.closed === true && Number(p.currentValue ?? 0) > 0)
      );
    } catch (e) {
      console.error(`${R}Erro ao buscar posições: ${e.message}${X}`);
    }
  }

  return positions;
}

// ─── Verifica resolução e payout no contrato CTF ──────────────────────────────

async function getConditionInfo(ctf, conditionId, numOutcomes) {
  try {
    const denom = await ctf.payoutDenominator(conditionId);
    if (denom === 0n) return { resolved: false, winningIndexSets: [] };

    const winningIndexSets = [];
    for (let i = 0; i < numOutcomes; i++) {
      const payout = await ctf.payoutNumerators(conditionId, i);
      if (payout > 0n) {
        // indexSet para outcome i é 2^i (bit i ligado)
        winningIndexSets.push(1 << i);
      }
    }
    return { resolved: true, winningIndexSets };
  } catch {
    return { resolved: false, winningIndexSets: [] };
  }
}

// ─── Executa redeemPositions via Gnosis Safe ──────────────────────────────────

async function redeemViaSafe(wallet, safe, ctf, conditionId, indexSets) {
  const ctfIface = new Interface(CTF_ABI);
  const redeemData = ctfIface.encodeFunctionData("redeemPositions", [
    USDC_ADDRESS,
    ZeroHash,          // parentCollectionId = bytes32(0) para mercados de nível raiz
    conditionId,
    indexSets,
  ]);

  const safeNonce = await safe.nonce();
  const safeTx = {
    to:             CTF_ADDRESS,
    value:          0n,
    data:           redeemData,
    operation:      0,        // CALL
    safeTxGas:      0n,
    baseGas:        0n,
    gasPrice:       0n,
    gasToken:       ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce:          safeNonce,
  };

  const domain    = { chainId: 137, verifyingContract: PROXY_ADDRESS };
  const signature = await wallet.signTypedData(domain, SAFE_TX_TYPES, safeTx);

  const safeWithSigner = safe.connect(wallet);
  const tx = await safeWithSigner.execTransaction(
    safeTx.to, safeTx.value, safeTx.data, safeTx.operation,
    safeTx.safeTxGas, safeTx.baseGas, safeTx.gasPrice,
    safeTx.gasToken, safeTx.refundReceiver, signature
  );

  return tx;
}

// ─── Executa redeemPositions direto (EOA) ────────────────────────────────────

async function redeemDirect(ctfWithSigner, conditionId, indexSets) {
  const tx = await ctfWithSigner.redeemPositions(
    USDC_ADDRESS,
    ZeroHash,
    conditionId,
    indexSets
  );
  return tx;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${B}${C}╔══════════════════════════════════════════════════╗`);
  console.log(`║      POLYMARKET — RESGATE DE POSIÇÕES           ║`);
  console.log(`╚══════════════════════════════════════════════════╝${X}\n`);

  if (DRY_RUN) {
    console.log(`${Y}${B}[DRY-RUN] Nenhuma transação será enviada.${X}\n`);
  }

  if (!PROXY_ADDRESS) throw new Error("POLYMARKET_PROXY_ADDRESS não definida no .env");

  const provider   = new JsonRpcProvider(RPC_URL);
  const wallet     = new Wallet(normalizeKey(PK_RAW), provider);
  const ctf        = new Contract(CTF_ADDRESS, CTF_ABI, provider);
  const safe       = new Contract(PROXY_ADDRESS, SAFE_ABI, provider);
  const ctfSigner  = ctf.connect(wallet);

  console.log(`${D}Proxy (safe):  ${PROXY_ADDRESS}${X}`);
  console.log(`${D}EOA (signer):  ${wallet.address}${X}`);
  console.log(`${D}Modo:          ${PROXY_ADDRESS ? "Gnosis Safe (execTransaction)" : "EOA direto"}${X}\n`);

  // 1. Buscar posições resgatáveis
  console.log(`${C}Consultando posições resgatáveis...${X}`);
  const positions = await fetchRedeemablePositions(PROXY_ADDRESS);

  if (!positions.length) {
    console.log(`${Y}Nenhuma posição resgatável encontrada na API.${X}`);
    console.log(`${D}Dica: mercados precisam estar resolvidos e o proxy ter saldo do token vencedor.${X}\n`);

    // Tenta buscar direto no contrato usando logs de mercados conhecidos
    await fallbackCheckFromLogs(wallet, ctf, ctfSigner, safe);
    return;
  }

  console.log(`${G}${positions.length} posição(ões) encontrada(s).${X}\n`);

  let redeemed = 0;

  for (const pos of positions) {
    const conditionId  = pos.conditionId ?? pos.condition_id ?? pos.market?.conditionId;
    const marketTitle  = pos.market?.question ?? pos.market?.slug ?? pos.title ?? conditionId;
    const numOutcomes  = Number(pos.market?.outcomes?.length ?? 2);
    const tokenId      = pos.asset ?? pos.tokenId ?? pos.assetId;
    const size         = Number(pos.size ?? pos.amount ?? 0);

    console.log(`─────────────────────────────────────────────────`);
    console.log(`${B}Mercado:${X}    ${marketTitle}`);
    console.log(`${D}conditionId: ${conditionId}${X}`);
    console.log(`${D}tokenId:     ${tokenId}${X}`);
    console.log(`${D}size:        ${size}${X}`);

    if (!conditionId) {
      console.log(`${Y}Pulando — conditionId não disponível.${X}\n`);
      continue;
    }

    // Verificar resolução no contrato
    const { resolved, winningIndexSets } = await getConditionInfo(ctf, conditionId, numOutcomes);
    if (!resolved) {
      console.log(`${Y}Mercado ainda não resolvido no contrato CTF.${X}`);
      continue;
    }

    // Verificar saldo de tokens na proxy
    if (tokenId) {
      const balance = await ctf.balanceOf(PROXY_ADDRESS, BigInt(tokenId)).catch(() => 0n);
      console.log(`${D}Saldo do token: ${(Number(balance) / 1e6).toFixed(6)}${X}`);
      if (balance === 0n) {
        console.log(`${Y}Saldo zero — já resgatado ou token não detido.${X}`);
        continue;
      }
    }

    console.log(`${G}✔ Resolvido — indexSets vencedores: [${winningIndexSets.join(", ")}]${X}`);

    if (DRY_RUN) {
      console.log(`${Y}[DRY-RUN] Seria chamado: redeemPositions(${conditionId}, [${winningIndexSets}])${X}`);
      continue;
    }

    try {
      let tx;
      if (PROXY_ADDRESS) {
        console.log(`${C}Enviando via Gnosis Safe...${X}`);
        tx = await redeemViaSafe(wallet, safe, ctf, conditionId, winningIndexSets);
      } else {
        console.log(`${C}Enviando via EOA direto...${X}`);
        tx = await redeemDirect(ctfSigner, conditionId, winningIndexSets);
      }

      console.log(`${G}${B}Tx enviada: ${tx.hash}${X}`);
      const receipt = await tx.wait(1);
      console.log(`${G}✔ Confirmada no bloco ${receipt.blockNumber}. USDC creditado na proxy.${X}`);
      redeemed++;
    } catch (err) {
      console.error(`${R}Erro ao resgatar: ${err.message}${X}`);
    }

    console.log();
  }

  console.log(`═════════════════════════════════════════════════`);
  if (!DRY_RUN) {
    console.log(`${G}${B}Resgate concluído: ${redeemed}/${positions.length} posições resgatadas.${X}`);
  } else {
    console.log(`${Y}Dry-run concluído. Remova --dry-run para executar.${X}`);
  }
  console.log();
}

// ─── Fallback: verifica mercados conhecidos dos logs ──────────────────────────

async function fallbackCheckFromLogs(wallet, ctf, ctfSigner, safe) {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const logsDir = "./logs";
  let files = [];
  try {
    files = readdirSync(logsDir).filter(f => f.startsWith("polymarket_market_") && f.endsWith(".json"));
  } catch {
    console.log(`${Y}Pasta logs/ não encontrada — nada a verificar.${X}`);
    return;
  }

  if (!files.length) {
    console.log(`${Y}Nenhum arquivo de mercado em logs/.${X}`);
    return;
  }

  console.log(`${C}Verificando ${files.length} mercado(s) nos logs...${X}\n`);

  for (const file of files) {
    try {
      const market      = JSON.parse(readFileSync(join(logsDir, file), "utf8"));
      const conditionId = market.conditionId;
      const tokenIds    = JSON.parse(market.clobTokenIds ?? "[]");
      const numOutcomes = tokenIds.length || 2;
      const slug        = market.slug ?? file;

      if (!conditionId) continue;

      const { resolved, winningIndexSets } = await getConditionInfo(ctf, conditionId, numOutcomes);
      if (!resolved) {
        console.log(`${D}${slug}: ainda não resolvido.${X}`);
        continue;
      }

      // Verificar se proxy tem saldo em qualquer token do mercado
      let totalBalance = 0n;
      for (const tid of tokenIds) {
        const bal = await ctf.balanceOf(PROXY_ADDRESS, BigInt(tid)).catch(() => 0n);
        totalBalance += bal;
      }

      if (totalBalance === 0n) {
        console.log(`${D}${slug}: resolvido, mas saldo zero — já resgatado.${X}`);
        continue;
      }

      console.log(`${G}✔ ${slug}: resolvido com saldo ${(Number(totalBalance)/1e6).toFixed(6)} tokens.${X}`);
      console.log(`  conditionId: ${conditionId}`);
      console.log(`  indexSets vencedores: [${winningIndexSets.join(", ")}]`);

      if (DRY_RUN) {
        console.log(`${Y}  [DRY-RUN] Seria resgatado.${X}\n`);
        continue;
      }

      try {
        let tx;
        if (PROXY_ADDRESS) {
          const svc  = new Contract(PROXY_ADDRESS, SAFE_ABI, wallet.provider);
          tx = await redeemViaSafe(wallet, svc, ctf, conditionId, winningIndexSets);
        } else {
          tx = await redeemDirect(ctfSigner, conditionId, winningIndexSets);
        }
        console.log(`  ${G}Tx enviada: ${tx.hash}${X}`);
        const receipt = await tx.wait(1);
        console.log(`  ${G}✔ Confirmada. USDC creditado na proxy.${X}\n`);
      } catch (err) {
        console.error(`  ${R}Erro: ${err.message}${X}\n`);
      }

    } catch {
      // arquivo inválido, pular
    }
  }
}

main().catch(err => {
  console.error(`\n${R}${B}Erro fatal: ${err.message}${X}`);
  process.exit(1);
});

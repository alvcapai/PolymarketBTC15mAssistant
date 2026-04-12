/**
 * rawtest.js — diagnóstico raw de autenticação L2 Polymarket
 *
 * Bypassa completamente o SDK e reconstrói os headers L2 manualmente
 * usando o módulo `crypto` nativo do Node.js.
 *
 * Se passar aqui mas falhar no smoketest → bug no SDK v2.8.0 (CryptoJS)
 * Se falhar aqui também → as chaves são genuinamente inválidas
 */

import "dotenv/config";
import crypto from "crypto";

// ─── ANSI colours ────────────────────────────────────────────────────────────

const R = "\x1b[31m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const B = "\x1b[1m";
const X = "\x1b[0m";

// ─── Credenciais ──────────────────────────────────────────────────────────────

const CLOB_HOST  = process.env.POLYMARKET_CLOB_HOST || "https://clob.polymarket.com";
const PK         = String(process.env.PK                       ?? "").trim();
const API_KEY    = String(process.env.POLYMARKET_API_KEY       ?? "").trim();
const SECRET     = String(process.env.POLYMARKET_API_SECRET    ?? "").trim();
const PASSPHRASE = String(process.env.POLYMARKET_API_PASSPHRASE ?? "").trim();

const missing = [
  !API_KEY    && "POLYMARKET_API_KEY",
  !SECRET     && "POLYMARKET_API_SECRET",
  !PASSPHRASE && "POLYMARKET_API_PASSPHRASE",
].filter(Boolean);

if (missing.length) {
  console.error(`\n${R}${B}[ERRO] Variáveis ausentes: ${missing.join(", ")}${X}\n`);
  process.exit(1);
}

// ─── Endereço da wallet (derivado da PK via secp256k1) ────────────────────────

function walletAddressFromPK(pk) {
  try {
    // Usa apenas crypto nativo + math puro para derivar o endereço público
    // sem depender de ethers (para isolar completamente o SDK)
    const { createPublicKey } = crypto;
    void createPublicKey; // apenas verifica disponibilidade
  } catch (_) { /* continua */ }

  // Derivação simplificada: usa keccak256 do ponto público comprimido
  // Para o rawtest, o endereço já está no .env indiretamente — basta
  // usar o que o sistema sabe. Deixamos o usuário fornecer via env
  // ou usamos um placeholder se não for possível derivar sem ethers.
  return process.env.WALLET_ADDRESS ?? null;
}

// ─── Construção do HMAC L2 ────────────────────────────────────────────────────

/**
 * Converte base64 URL-safe para base64 padrão antes de decodificar.
 * O SDK v2.8.0 usa CryptoJS que pode não lidar com `-` e `_`.
 * O Node.js crypto lida corretamente com ambos os formatos.
 */
function buildHmacSignature(secret, timestamp, method, path, body = "") {
  const message       = `${timestamp}${method}${path}${body}`;
  // URL-safe base64 → standard base64
  const secretStd     = secret.replace(/-/g, "+").replace(/_/g, "/");
  const secretBytes   = Buffer.from(secretStd, "base64");
  return crypto.createHmac("sha256", secretBytes).update(message).digest("base64");
}

// ─── Request raw ──────────────────────────────────────────────────────────────

async function runRawTest() {
  const endpoint  = "/auth/api-keys";
  const method    = "GET";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = buildHmacSignature(SECRET, timestamp, method, endpoint);

  console.log(`\n${Y}${B}[rawtest] Enviando requisição L2 manual (sem SDK)…${X}\n`);
  console.log(`${C}  • URL        : ${CLOB_HOST}${endpoint}${X}`);
  console.log(`${C}  • POLY_API_KEY  : ${API_KEY}${X}`);
  console.log(`${C}  • POLY_TIMESTAMP: ${timestamp}${X}`);
  console.log(`${C}  • POLY_SIGNATURE: ${signature.slice(0, 20)}…${X}\n`);

  // POLY_ADDRESS é obrigatório — tenta derivar da PK via import dinâmico do ethers
  let walletAddress = null;
  try {
    const { Wallet, JsonRpcProvider } = await import("ethers");
    const normalizedPK = PK.startsWith("0x") ? PK : `0x${PK}`;
    const provider     = new JsonRpcProvider(CLOB_HOST); // só para instanciar
    const wallet       = new Wallet(normalizedPK, provider);
    walletAddress      = wallet.address;
    console.log(`${C}  • POLY_ADDRESS  : ${walletAddress}${X}\n`);
  } catch (_) {
    console.log(`${Y}  • POLY_ADDRESS  : (não foi possível derivar da PK — PK ausente no .env)${X}\n`);
  }

  const headers = {
    "Content-Type":   "application/json",
    "POLY_API_KEY":   API_KEY,
    "POLY_PASSPHRASE": PASSPHRASE,
    "POLY_TIMESTAMP": timestamp,
    "POLY_SIGNATURE": signature,
    ...(walletAddress ? { "POLY_ADDRESS": walletAddress } : {}),
  };

  try {
    const res  = await fetch(`${CLOB_HOST}${endpoint}`, { method, headers });
    const body = await res.json().catch(() => res.text());

    if (res.ok) {
      const count = Array.isArray(body) ? body.length : "?";
      console.log(
        `${G}${B}╔══════════════════════════════════════════════════════════════════╗${X}\n` +
        `${G}${B}║  [SUCESSO RAW] Chaves válidas! Auth L2 manual funcionou.         ║${X}\n` +
        `${G}${B}╚══════════════════════════════════════════════════════════════════╝${X}\n` +
        `${G}  • HTTP Status       : ${res.status} ${res.statusText}${X}\n` +
        `${G}  • API keys na conta : ${count}${X}\n\n` +
        `${Y}  DIAGNÓSTICO: As chaves são VÁLIDAS mas o SDK v2.8.0 tem um bug de${X}\n` +
        `${Y}  base64 URL-safe (CryptoJS). Solução: atualizar o SDK.${X}\n` +
        `${Y}  Execute: npm install @polymarket/clob-client@latest${X}\n`
      );
    } else if (res.status === 401) {
      console.error(
        `\n${R}${B}╔══════════════════════════════════════════════════════════════════╗${X}\n` +
        `${R}${B}║  [FALHA RAW] 401 — Chaves genuinamente inválidas ou expiradas.   ║${X}\n` +
        `${R}${B}╚══════════════════════════════════════════════════════════════════╝${X}\n` +
        `${R}  • As chaves foram recusadas mesmo sem o SDK.${X}\n` +
        `${R}  • Recrie as chaves em polymarket.com → Configurações → API Keys.${X}\n` +
        `${R}  • Resposta: ${JSON.stringify(body)}${X}\n`
      );
    } else {
      console.error(
        `\n${R}${B}[ERRO ${res.status}] Resposta inesperada:${X}\n` +
        `${R}  ${JSON.stringify(body)}${X}\n`
      );
    }
  } catch (err) {
    console.error(
      `\n${R}${B}[ERRO DE REDE] ${err?.message ?? String(err)}${X}\n`
    );
    process.exit(1);
  }
}

runRawTest();

import "dotenv/config";
import { createRequire } from "node:module";
import { Chain, ClobClient, OrderType, Side } from "@polymarket/clob-client";

const require = createRequire(import.meta.url);
const { Wallet } = require("@polymarket/clob-client/node_modules/ethers");

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m"
};

const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST || "https://clob.polymarket.com";
const CHAIN_ID = Chain.POLYGON;
const TRADE_MOCK_MODE = String(process.env.TRADE_MOCK_MODE || "true").toLowerCase() === "true";

let clobClientInstance = null;

function normalizePrivateKey(pkRaw) {
  const value = String(pkRaw || "").trim();
  if (!value) {
    throw new Error("Missing PK in .env");
  }
  return value.startsWith("0x") ? value : `0x${value}`;
}

function getApiCreds() {
  const key = String(process.env.POLYMARKET_API_KEY || "").trim();
  const secret = String(process.env.POLYMARKET_API_SECRET || "").trim();
  const passphrase = String(process.env.POLYMARKET_API_PASSPHRASE || "").trim();

  if (!key || !secret || !passphrase) {
    throw new Error("Missing Polymarket L2 API credentials in .env");
  }

  return { key, secret, passphrase };
}

export function getClobClient() {
  if (clobClientInstance) return clobClientInstance;

  const wallet = new Wallet(normalizePrivateKey(process.env.PK));
  const creds = getApiCreds();

  clobClientInstance = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, creds);
  return clobClientInstance;
}

function toFiniteNumber(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }
  return parsed;
}

function formatCents(price) {
  return `${(Number(price) * 100).toFixed(1).replace(/\.0$/, "")}c`;
}

export async function executeTrade(marketTokenId, side, size, price, probability) {
  if (String(side).toUpperCase() !== Side.BUY) {
    throw new Error(`Unsupported side "${side}". Only BUY is allowed.`);
  }

  const tokenId = String(marketTokenId || "").trim();
  if (!tokenId) {
    throw new Error("Missing marketTokenId");
  }

  const usdcSize = toFiniteNumber(size, "size");
  const limitPrice = toFiniteNumber(price, "price");
  const probabilityPct = toFiniteNumber(probability, "probability");

  if (usdcSize <= 0) throw new Error("size must be > 0");
  if (limitPrice <= 0 || limitPrice >= 1) throw new Error("price must be between 0 and 1");

  const shareSize = usdcSize / limitPrice;
  const executionLog = `[EXECUCAO] Apostando $${usdcSize} em ${Side.BUY} no Token ${tokenId} a ${formatCents(limitPrice)} (Prob: ${probabilityPct.toFixed(2)}%)`;

  console.log(`${TRADE_MOCK_MODE ? ANSI.yellow : ANSI.green}${executionLog}${ANSI.reset}`);

  if (TRADE_MOCK_MODE) {
    return {
      success: true,
      mock: true,
      tokenId,
      side: Side.BUY,
      usdcSize,
      shareSize,
      price: limitPrice,
      probability: probabilityPct
    };
  }

  const clobClient = getClobClient();
  const order = await clobClient.createOrder({
    tokenID: tokenId,
    side: Side.BUY,
    price: limitPrice,
    size: shareSize,
    feeRateBps: 0
  });

  try {
    const response = await clobClient.postOrder(order, OrderType.GTC);
    console.log(`${ANSI.green}[EXECUCAO] Ordem enviada com sucesso.${ANSI.reset}`);
    return response;
  } catch (error) {
    console.log(`${ANSI.red}[EXECUCAO] Falha ao enviar ordem: ${error?.message ?? String(error)}${ANSI.reset}`);
    throw error;
  }
}

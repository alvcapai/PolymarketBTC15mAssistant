import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { JsonRpcProvider, Wallet } from "ethers";
import { Chain, ClobClient } from "@polymarket/clob-client";

// ─── ANSI colours ────────────────────────────────────────────────────────────

const R = "\x1b[31m"; // red
const G = "\x1b[32m"; // green
const Y = "\x1b[33m"; // yellow
const C = "\x1b[36m"; // cyan
const B = "\x1b[1m";  // bold
const X = "\x1b[0m";  // reset

// ─── Load & validate env vars ────────────────────────────────────────────────

const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST || "https://clob.polymarket.com";
const RPC_URL   = process.env.POLYGON_RPC_URL       || "https://polygon-rpc.com";
const ENV_PATH  = resolve(process.cwd(), ".env");

const PK = String(process.env.PK ?? "").trim();

if (!PK) {
  console.error(
    `\n${R}${B}[ERRO] Variável PK ausente no .env.${X}\n` +
    `${R}  A chave privada da carteira é obrigatória para derivar as API keys.${X}\n`
  );
  process.exit(1);
}

if (!existsSync(ENV_PATH)) {
  console.error(
    `\n${R}${B}[ERRO] Arquivo .env não encontrado em:${X}\n` +
    `${R}  ${ENV_PATH}${X}\n`
  );
  process.exit(1);
}

// ─── .env patcher ────────────────────────────────────────────────────────────

function patchEnv(content, key, value) {
  const line  = `${key}=${value}`;
  // Escapa caracteres especiais do nome da chave para uso em regex
  const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${safeKey}=.*$`, "m");
  return regex.test(content)
    ? content.replace(regex, line)
    : content.trimEnd() + "\n" + line + "\n";
}

// ─── Probe de auth com credenciais em memória ─────────────────────────────────
// Testa as credenciais ANTES de gravar no .env para confirmar que são válidas.

async function probeAuth(creds, wallet) {
  const authClient = new ClobClient(
    CLOB_HOST,
    Chain.POLYGON,
    wallet,
    { key: creds.key, secret: creds.secret, passphrase: creds.passphrase }
  );
  const result = await authClient.getApiKeys();
  return Array.isArray(result) ? result : null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${Y}${B}[keygen] Iniciando derivação de API keys Polymarket L2…${X}\n`);
  console.log(`${C}  • Endpoint : ${CLOB_HOST}${X}`);
  console.log(`${C}  • .env     : ${ENV_PATH}${X}\n`);

  // ── [1] Instanciar wallet ──────────────────────────────────────────────────
  let wallet;
  try {
    const normalizedPK = PK.startsWith("0x") ? PK : `0x${PK}`;
    const provider     = new JsonRpcProvider(RPC_URL);
    wallet             = new Wallet(normalizedPK, provider);
    // Shim ethers v5 → v6: createOrDeriveApiKey usa _signTypedData internamente
    wallet._signTypedData = wallet.signTypedData.bind(wallet);
    console.log(`${Y}  [1/4] Wallet instanciada: ${wallet.address}${X}`);
  } catch (err) {
    console.error(
      `\n${R}${B}╔═══════════════════════════════════════════════════════╗${X}\n` +
      `${R}${B}║  [FALHA] Não foi possível instanciar a wallet.         ║${X}\n` +
      `${R}${B}╚═══════════════════════════════════════════════════════╝${X}\n` +
      `${R}  • Verifique se PK é uma chave privada hex válida.${X}\n` +
      `${R}  • Detalhe: ${err?.message ?? String(err)}${X}\n`
    );
    process.exit(1);
  }

  // ── [2] Derivar / criar API keys ───────────────────────────────────────────
  let creds;
  try {
    const client = new ClobClient(CLOB_HOST, Chain.POLYGON, wallet);
    console.log(`${Y}  [2/4] Solicitando API keys ao servidor…${X}`);
    creds = await client.createOrDeriveApiKey();

    if (!creds?.key || !creds?.secret || !creds?.passphrase) {
      throw new Error("Resposta incompleta — campos key/secret/passphrase ausentes.");
    }
    console.log(`${Y}        Key obtida : ${creds.key}${X}`);
  } catch (err) {
    console.error(
      `\n${R}${B}╔══════════════════════════════════════════════════════════════════╗${X}\n` +
      `${R}${B}║  [FALHA] Não foi possível obter as API keys da Polymarket.       ║${X}\n` +
      `${R}${B}╚══════════════════════════════════════════════════════════════════╝${X}\n` +
      `${R}  • Verifique conectividade com ${CLOB_HOST}${X}\n` +
      `${R}  • A carteira precisa ter uma conta ativa na Polymarket.${X}\n` +
      `${R}  • Detalhe: ${err?.message ?? String(err)}${X}\n`
    );
    process.exit(1);
  }

  // ── [3] Validar credenciais em memória ANTES de gravar ────────────────────
  console.log(`${Y}  [3/4] Validando credenciais contra a API (antes de gravar)…${X}`);
  try {
    const keys = await probeAuth(creds, wallet);
    if (keys === null) {
      // SDK silenciou um 401 e retornou não-array
      console.error(
        `\n${R}${B}╔══════════════════════════════════════════════════════════════════════╗${X}\n` +
        `${R}${B}║  [FALHA] As keys derivadas foram REJEITADAS pela Polymarket (401).   ║${X}\n` +
        `${R}${B}╚══════════════════════════════════════════════════════════════════════╝${X}\n` +
        `${R}  Key rejeitada : ${creds.key}${X}\n\n` +
        `${Y}  Diagnóstico possível:${X}\n` +
        `${Y}  1. A carteira ${wallet.address}${X}\n` +
        `${Y}     nunca criou conta na Polymarket. Acesse polymarket.com,${X}\n` +
        `${Y}     conecte esta carteira e aceite os Termos de Serviço.${X}\n` +
        `${Y}  2. As API keys existentes no servidor foram criadas com uma versão${X}\n` +
        `${Y}     diferente do SDK (ethers v5). Tente excluir as keys antigas:${X}\n` +
        `${Y}     Acesse polymarket.com → Configurações → API → Revogar chaves${X}\n` +
        `${Y}     e execute este script novamente.${X}\n`
      );
      process.exit(1);
    }
    console.log(`${Y}        Validação OK — ${keys.length} key(s) ativa(s) na conta.${X}`);
  } catch (err) {
    console.error(
      `\n${R}${B}[FALHA] Erro ao validar credenciais: ${err?.message ?? String(err)}${X}\n`
    );
    process.exit(1);
  }

  // ── [4] Gravar no .env ─────────────────────────────────────────────────────
  try {
    console.log(`${Y}  [4/4] Gravando credenciais validadas no .env…${X}`);
    let content = readFileSync(ENV_PATH, "utf8");
    content = patchEnv(content, "POLYMARKET_API_KEY",        creds.key);
    content = patchEnv(content, "POLYMARKET_API_SECRET",     creds.secret);
    content = patchEnv(content, "POLYMARKET_API_PASSPHRASE", creds.passphrase);
    writeFileSync(ENV_PATH, content, "utf8");
  } catch (err) {
    console.error(
      `\n${R}${B}[FALHA] Não foi possível gravar no .env.${X}\n` +
      `${R}  Detalhe: ${err?.message ?? String(err)}${X}\n\n` +
      `${Y}  Copie manualmente para o .env:${X}\n` +
      `  POLYMARKET_API_KEY=${creds.key}\n` +
      `  POLYMARKET_API_SECRET=${creds.secret}\n` +
      `  POLYMARKET_API_PASSPHRASE=${creds.passphrase}\n`
    );
    process.exit(1);
  }

  // ── Sucesso total ──────────────────────────────────────────────────────────
  console.log(
    `\n${G}${B}╔══════════════════════════════════════════════════════════════════╗${X}\n` +
    `${G}${B}║  [SUCESSO] Keys validadas e gravadas no .env com sucesso!        ║${X}\n` +
    `${G}${B}╚══════════════════════════════════════════════════════════════════╝${X}\n` +
    `${G}  • Wallet               : ${wallet.address}${X}\n` +
    `${G}  • POLYMARKET_API_KEY   : ${creds.key}${X}\n` +
    `${G}  • POLYMARKET_API_SECRET: ${creds.secret.slice(0, 12)}…${X}\n` +
    `${G}  • POLYMARKET_PASSPHRASE: ${creds.passphrase.slice(0, 12)}…${X}\n\n` +
    `${C}  Execute agora: node smoketest.js${X}\n`
  );
}

run();

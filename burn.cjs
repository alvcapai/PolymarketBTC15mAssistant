const { createWalletClient, http } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { ClobClient, Side, OrderType } = require("@polymarket/clob-client-v2");
require("dotenv").config();

async function burn() {
  const pk = process.env.PK.startsWith("0x") ? process.env.PK : "0x" + process.env.PK;
  const account = privateKeyToAccount(pk);
  const viemSigner = createWalletClient({
    account,
    chain: { id: 137, rpcUrls: { default: { http: ["https://polygon-bor-rpc.publicnode.com"] } } },
    transport: http(),
  });

  const client = new ClobClient({
    host: "https://clob.polymarket.com",
    chain: 137,
    signer: viemSigner,
  });
  
  try {
    console.log("[BURN] Criando credenciais API L2...");
    const creds = await client.createOrDeriveApiKey();
    console.log("[BURN] Credenciais geradas:", creds.key !== undefined);
    console.log("[BURN] API Key:", creds.key);
  } catch (e) {
    console.log("[BURN] Erro ao gerar credenciais:", e.message);
    return;
  }
  
  try {
    const market = "10192";
    console.log("Carteira:", account.address);
  } catch(e) {
     console.log("Erro:", e.message);
  }
}
burn();

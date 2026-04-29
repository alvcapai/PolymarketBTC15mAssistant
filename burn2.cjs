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
  
  const creds = {
    key: process.env.POLYMARKET_API_KEY,
    secret: process.env.POLYMARKET_API_SECRET,
    passphrase: process.env.POLYMARKET_API_PASSPHRASE
  };

  const client = new ClobClient({
    host: "https://clob.polymarket.com",
    chain: 137,
    signer: viemSigner,
    creds,
  });
  
  try {
    console.log("[BURN] Consultando saldo e status do cliente...");
    
    console.log("[BURN] Construindo ordem dummy...");
    const resp = await client.createAndPostOrder(
      {
        tokenID: "94086791387057229994275499851278174589636235829999316794545713096352579372630",
        side: Side.BUY,
        price: 0.01,
        size: 1,
      },
      { tickSize: "0.01", negRisk: false },
      OrderType.GTC,
    );
    
    console.log("[SUCESSO] Ordem enviada. Response:", resp);
    
  } catch(e) {
     console.log("[ERRO L2] Falha na API da Polymarket:", e.message);
  }
}
burn();

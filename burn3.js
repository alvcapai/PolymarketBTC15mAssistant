import { ClobClient, Side, OrderType } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import "dotenv/config";

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
    console.log("[BURN] Buscando mercado BTC 15m atual...");
    const res = await fetch("https://gamma-api.polymarket.com/events?series_id=10192&active=true&closed=false");
    const events = await res.json();
    if(!events.length) { console.log("Sem mercado ativo"); return; }
    
    const market = events[0].markets[0];
    const upTokenId = JSON.parse(market.clobTokenIds)[0];
    
    console.log(`[BURN] Token UP encontrado: ${upTokenId}`);
    console.log("[BURN] Enviando ordem Limit $1 a 1 centavo...");
    
    const resp = await client.createAndPostOrder(
      {
        tokenID: upTokenId,
        side: Side.BUY,
        price: 0.01,
        size: 100,
      },
      { tickSize: "0.01", negRisk: false },
      OrderType.GTC,
    );
    console.log("[SUCESSO] Resposta da API:", resp);
    
  } catch(e) {
     console.log("[ERRO] Falha:", e.message);
  }
}
burn();

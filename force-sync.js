import "dotenv/config";
import { ClobClient } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fetchUsdcBalance } from "./src/trade/executor.js";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;

async function run() {
    const pk = process.env.PK.startsWith("0x") ? process.env.PK : `0x${process.env.PK}`;
    const account = privateKeyToAccount(pk);
    const viemSigner = createWalletClient({
        account,
        chain: { id: CHAIN_ID },
        transport: http("https://polygon-rpc.com"),
    });

    const PROXY_ADDRESS = process.env.POLYMARKET_PROXY_ADDRESS;
    const SIGNATURE_TYPE = PROXY_ADDRESS ? 2 : 0;

    const creds = {
        key: process.env.POLYMARKET_API_KEY,
        secret: process.env.POLYMARKET_API_SECRET,
        passphrase: process.env.POLYMARKET_API_PASSPHRASE,
    };

    const client = new ClobClient({
        host: CLOB_HOST,
        chain: CHAIN_ID,
        signer: viemSigner,
        creds: creds,
        signatureType: SIGNATURE_TYPE,
        funderAddress: PROXY_ADDRESS,
    });

    console.log("Current balance before sync:");
    let balBefore = await fetchUsdcBalance();
    console.log("$" + balBefore);

    console.log("Calling updateBalanceAllowance...");
    await client.updateBalanceAllowance({ asset_type: "COLLATERAL" });
    
    console.log("Current balance after sync:");
    let balAfter = await fetchUsdcBalance();
    console.log("$" + balAfter);
}

run().catch(console.error);

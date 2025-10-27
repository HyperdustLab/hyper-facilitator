import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

const PORT = 4080;
const FACILITATOR_URL = process.env.FACILITATOR_URL || "http://localhost:4020";
const MERCHANT_ADDR   = process.env.MERCHANT_ADDR   || "0xHyperAGIMerchantWallet";
const SCHEME          = process.env.SCHEME          || "exact";
const NETWORK         = process.env.NETWORK         || "base-mainnet";
const ASSET           = process.env.ASSET           || "USDC";
const AMOUNT          = process.env.AMOUNT          || "0.01";

// Example protected endpoint
app.get("/paid", async (req, res) => {
  const paymentHeader = req.header("X-PAYMENT");
  const paymentRequirements = { scheme: SCHEME, network: NETWORK, asset: ASSET, amount: AMOUNT, payTo: MERCHANT_ADDR };

  if (!paymentHeader) {
    return res.status(402).json({ x402Version: "1", paymentRequirements, facilitator: FACILITATOR_URL });
  }

  try {
    const verifyResp = await fetch(`${FACILITATOR_URL}/verify`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x402Version: "1", paymentHeader, paymentRequirements })
    });
    const verifyJson = await verifyResp.json();
    if (!verifyJson.isValid) return res.status(402).json({ reason: verifyJson.invalidReason || "verify_failed" });

    const settleResp = await fetch(`${FACILITATOR_URL}/settle`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x402Version: "1", paymentHeader, paymentRequirements })
    });
    const settleJson = await settleResp.json();
    if (!settleJson.success) return res.status(402).json({ reason: settleJson.error || "settlement_failed" });

    return res.json({ ok: true, txHash: settleJson.txHash || settleJson.transaction, data: "Paid content delivered." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Seller demo listening on :${PORT}`));


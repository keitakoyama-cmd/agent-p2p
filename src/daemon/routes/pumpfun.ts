import { json, readBody } from "../http-util";
import { saveEconomicState } from "../economic-state";
import type { DaemonContext, RequestContext } from "../context";

export async function handlePumpfun(ctx: DaemonContext, rc: RequestContext): Promise<boolean> {
  const { pumpfun, solanaKeypair, economic, dataDir } = ctx;
  const { req, res, url, path } = rc;

  if (req.method === "POST" && path === "/pumpfun/launch") {
    try {
      const body = JSON.parse(await readBody(req));
      const { name, symbol, description, image_base64, initial_buy_sol, twitter, telegram, website } = body;
      if (!name || !symbol || !description) {
        json(res, 400, { error: "name, symbol, and description required" });
        return true;
      }
      // Image: accept base64 or use a default 1x1 pixel PNG
      const imageBuffer = image_base64
        ? Buffer.from(image_base64, "base64")
        : Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

      const result = await pumpfun.launch(
        solanaKeypair,
        name,
        symbol,
        description,
        imageBuffer,
        "token.png",
        initial_buy_sol || 0,
        { twitter, telegram, website }
      );

      if (result.success && result.mintAddress) {
        // Register in local economic state
        const tokenId = `pumpfun:${result.mintAddress}`;
        economic.registerExternalToken(
          tokenId, name, symbol, 6, "solana", result.mintAddress
        );
        saveEconomicState(dataDir, economic);
      }

      json(res, result.success ? 200 : 422, result);
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  if (req.method === "POST" && path === "/pumpfun/buy") {
    try {
      const body = JSON.parse(await readBody(req));
      const { mint_address, sol_amount, slippage_bps } = body;
      if (!mint_address || !sol_amount) {
        json(res, 400, { error: "mint_address and sol_amount required" });
        return true;
      }
      const result = await pumpfun.buy(
        solanaKeypair, mint_address, sol_amount, slippage_bps || 500
      );
      json(res, result.success ? 200 : 422, result);
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  if (req.method === "POST" && path === "/pumpfun/sell") {
    try {
      const body = JSON.parse(await readBody(req));
      const { mint_address, token_amount, slippage_bps } = body;
      if (!mint_address || !token_amount) {
        json(res, 400, { error: "mint_address and token_amount required" });
        return true;
      }
      const result = await pumpfun.sell(
        solanaKeypair, mint_address, token_amount, slippage_bps || 500
      );
      json(res, result.success ? 200 : 422, result);
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  if (req.method === "POST" && path === "/pumpfun/collect-fees") {
    try {
      const result = await pumpfun.collectCreatorFees(solanaKeypair);
      json(res, result.success ? 200 : 422, result);
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  if (req.method === "GET" && path === "/pumpfun/creator-vault") {
    try {
      const result = await pumpfun.getCreatorVaultBalance(solanaKeypair.publicKey.toBase58());
      json(res, 200, result);
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  if (req.method === "GET" && path === "/pumpfun/curve") {
    try {
      const mintAddress = url.searchParams.get("mint_address");
      if (!mintAddress) {
        json(res, 400, { error: "mint_address required" });
        return true;
      }
      const curve = await pumpfun.getBondingCurve(mintAddress);
      json(res, 200, { mint_address: mintAddress, ...curve });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  return false;
}

import { json, readBody } from "../http-util";
import { saveEconomicState } from "../economic-state";
import { getSigningKey } from "../signing";
import type { DaemonContext, RequestContext } from "../context";
import type { AgentId } from "../../types/protocol";

export async function handleSolana(ctx: DaemonContext, rc: RequestContext): Promise<boolean> {
  const { agent, solana, solanaKeypair, economic, dataDir } = ctx;
  const { req, res, url, path } = rc;

  if (req.method === "GET" && path === "/solana/wallet") {
    const address = solanaKeypair.publicKey.toBase58();
    try {
      const balance = await solana.getSOLBalance(address);
      json(res, 200, {
        address,
        network: solana.getNetwork(),
        sol_balance: balance / 1e9,
        sol_balance_lamports: balance,
        explorer_url: solana.explorerUrl("address", address),
      });
    } catch {
      json(res, 200, {
        address,
        network: solana.getNetwork(),
        sol_balance: 0,
        explorer_url: solana.explorerUrl("address", address),
      });
    }
    return true;
  }

  if (req.method === "POST" && path === "/solana/airdrop") {
    try {
      const body = JSON.parse(await readBody(req));
      const amount = body.amount || 1;
      const sig = await solana.airdrop(solanaKeypair.publicKey.toBase58(), amount);
      json(res, 200, {
        success: true,
        amount,
        tx_signature: sig,
        explorer_url: solana.explorerUrl("tx", sig),
      });
    } catch (err) {
      json(res, 422, { success: false, error: (err as Error).message });
    }
    return true;
  }

  if (req.method === "POST" && path === "/solana/token/create") {
    try {
      const body = JSON.parse(await readBody(req));
      const decimals = body.decimals ?? 9;
      const result = await solana.createToken(solanaKeypair, decimals);

      // Also mint initial supply if specified
      let mintResult = null;
      if (body.initial_supply && body.initial_supply > 0) {
        mintResult = await solana.mintTokens(
          solanaKeypair,
          result.mintAddress,
          body.initial_supply,
          decimals
        );
      }

      // Register in local economic state too
      const tokenId = `sol:${result.mintAddress}`;
      economic.registerExternalToken(
        tokenId,
        body.name || "SPL Token",
        body.symbol || "SPL",
        decimals,
        "solana",
        result.mintAddress
      );
      saveEconomicState(dataDir, economic);

      json(res, 200, {
        success: true,
        token_id: tokenId,
        mint_address: result.mintAddress,
        decimals,
        initial_supply: body.initial_supply || 0,
        mint_tx: mintResult?.txSignature || null,
        explorer_url: result.explorerUrl,
        mint_explorer_url: mintResult?.explorerUrl || null,
      });
    } catch (err) {
      json(res, 422, { success: false, error: (err as Error).message });
    }
    return true;
  }

  if (req.method === "POST" && path === "/solana/token/mint") {
    try {
      const body = JSON.parse(await readBody(req));
      const { mint_address, amount, decimals } = body;
      if (!mint_address || !amount) {
        json(res, 400, { error: "mint_address and amount required" });
        return true;
      }
      const result = await solana.mintTokens(
        solanaKeypair,
        mint_address,
        amount,
        decimals ?? 9
      );
      json(res, 200, {
        success: true,
        tx_signature: result.txSignature,
        explorer_url: result.explorerUrl,
      });
    } catch (err) {
      json(res, 422, { success: false, error: (err as Error).message });
    }
    return true;
  }

  if (req.method === "POST" && path === "/solana/token/transfer") {
    try {
      const body = JSON.parse(await readBody(req));
      const { mint_address, to_address, amount, decimals } = body;
      if (!mint_address || !to_address || !amount) {
        json(res, 400, { error: "mint_address, to_address, and amount required" });
        return true;
      }
      const result = await solana.transferTokens(
        solanaKeypair,
        mint_address,
        to_address,
        amount,
        decimals ?? 9
      );

      // Record in local ledger
      const tokenId = `sol:${mint_address}`;
      const privateKey = await getSigningKey(agent);
      const keyId = agent.getKeyId() || "unknown";
      // TODO(PR3d): model on-chain recipients separately from AgentId-backed local ledger entries.
      economic.transfer(
        `solana:${to_address}` as AgentId,
        tokenId,
        amount,
        privateKey,
        keyId
      );
      saveEconomicState(dataDir, economic);

      json(res, 200, {
        success: true,
        tx_signature: result.txSignature,
        explorer_url: result.explorerUrl,
      });
    } catch (err) {
      json(res, 422, { success: false, error: (err as Error).message });
    }
    return true;
  }

  if (req.method === "GET" && path === "/solana/token/balance") {
    try {
      const mintAddress = url.searchParams.get("mint_address");
      const ownerAddress = url.searchParams.get("owner_address") || solanaKeypair.publicKey.toBase58();
      if (!mintAddress) {
        json(res, 400, { error: "mint_address required" });
        return true;
      }
      const balance = await solana.getTokenBalance(ownerAddress, mintAddress);
      json(res, 200, {
        owner: ownerAddress,
        mint_address: mintAddress,
        ...balance,
        explorer_url: solana.explorerUrl("address", ownerAddress),
      });
    } catch (err) {
      json(res, 422, { error: (err as Error).message });
    }
    return true;
  }

  if (req.method === "GET" && path === "/solana/token/info") {
    try {
      const mintAddress = url.searchParams.get("mint_address");
      if (!mintAddress) {
        json(res, 400, { error: "mint_address required" });
        return true;
      }
      const info = await solana.getTokenInfo(mintAddress);
      json(res, 200, {
        mint_address: mintAddress,
        ...info,
        explorer_url: solana.explorerUrl("address", mintAddress),
      });
    } catch (err) {
      json(res, 422, { error: (err as Error).message });
    }
    return true;
  }

  return false;
}

import { json, readBody } from "../http-util";
import { saveEconomicState } from "../economic-state";
import { getSigningKey } from "../signing";
import type { DaemonContext, RequestContext } from "../context";
import type { AgentId } from "../../types/protocol";

export async function handleEconomic(ctx: DaemonContext, rc: RequestContext): Promise<boolean> {
  const { agent, dataDir, economic, reputation } = ctx;
  const { req, res, url, path } = rc;

  if (req.method === "POST" && path === "/token/issue") {
    const body = JSON.parse(await readBody(req));
    const privateKey = await getSigningKey(agent);
    const keyId = agent.getKeyId() || "unknown";
    const token = economic.issueToken(
      body.name, body.symbol, body.decimals || 18,
      body.initial_supply || 0, privateKey, keyId
    );
    saveEconomicState(dataDir, economic);
    json(res, 200, token);
    return true;
  }

  if (req.method === "POST" && path === "/token/register") {
    const body = JSON.parse(await readBody(req));
    const token = economic.registerExternalToken(
      body.token_id, body.name, body.symbol,
      body.decimals || 18, body.chain, body.contract_address
    );
    saveEconomicState(dataDir, economic);
    json(res, 200, token);
    return true;
  }

  if (req.method === "GET" && path === "/token/list") {
    json(res, 200, { tokens: economic.listTokens() });
    return true;
  }

  if (req.method === "POST" && path === "/token/mint") {
    const body = JSON.parse(await readBody(req));
    const privateKey = await getSigningKey(agent);
    const keyId = agent.getKeyId() || "unknown";
    const result = economic.mint(body.token_id, body.amount, privateKey, keyId);
    if (result.success) saveEconomicState(dataDir, economic);
    json(res, result.success ? 200 : 422, result);
    return true;
  }

  if (req.method === "POST" && path === "/token/transfer") {
    const body = JSON.parse(await readBody(req));
    const privateKey = await getSigningKey(agent);
    const keyId = agent.getKeyId() || "unknown";
    const myAgentId = agent.getAgentInfo().agent_id;
    const toAgentId = body.to as AgentId;
    const result = economic.transfer(toAgentId, body.token_id, body.amount, privateKey, keyId);
    if (result.success) {
      saveEconomicState(dataDir, economic);
      // Notify recipient via P2P so they can credit their local ledger
      const swarm = agent.getSwarm();
      const lastEntry = economic.getLedger(1)[0];
      swarm.sendTaskMessage(toAgentId, "token_transfer", {
        from: myAgentId,
        to: toAgentId,
        token_id: body.token_id,
        amount: body.amount,
        ledger_entry: lastEntry,
      });
    }
    json(res, result.success ? 200 : 422, result);
    return true;
  }

  if (req.method === "GET" && path === "/wallet") {
    const myAgentId = agent.getAgentInfo().agent_id;
    const agentIdParam = url.searchParams.get("agent_id") as AgentId || myAgentId;
    const wallet = economic.getWallet(agentIdParam);
    json(res, wallet ? 200 : 404, wallet || { error: "No wallet" });
    return true;
  }

  if (req.method === "POST" && path === "/wallet/connect") {
    const body = JSON.parse(await readBody(req));
    const myAgentId = agent.getAgentInfo().agent_id;
    const wallet = economic.connectWallet(myAgentId, body.chain, body.address);
    json(res, 200, wallet);
    return true;
  }

  if (req.method === "GET" && path === "/wallet/balance") {
    const tokenId = url.searchParams.get("token_id");
    const myAgentId = agent.getAgentInfo().agent_id;
    const agentIdParam = url.searchParams.get("agent_id") as AgentId || myAgentId;
    if (!tokenId) { json(res, 400, { error: "token_id required" }); return true; }
    json(res, 200, { balance: economic.getBalance(agentIdParam, tokenId) });
    return true;
  }

  if (req.method === "POST" && path === "/offer/create") {
    const body = JSON.parse(await readBody(req));
    const offer = economic.createOffer(body.task_id, body.to as AgentId, body.token_id, body.amount);
    saveEconomicState(dataDir, economic);
    json(res, 200, offer);
    return true;
  }

  if (req.method === "GET" && path === "/offer/list") {
    json(res, 200, { offers: economic.listOffers() });
    return true;
  }

  if (req.method === "POST" && path === "/escrow/lock") {
    const body = JSON.parse(await readBody(req));
    const privateKey = await getSigningKey(agent);
    const keyId = agent.getKeyId() || "unknown";
    const result = economic.lockEscrow(body.offer_id, privateKey, keyId);
    if (result.success) saveEconomicState(dataDir, economic);
    json(res, result.success ? 200 : 422, result);
    return true;
  }

  if (req.method === "POST" && path === "/escrow/release") {
    const body = JSON.parse(await readBody(req));
    const privateKey = await getSigningKey(agent);
    const keyId = agent.getKeyId() || "unknown";
    const result = economic.releaseEscrow(body.escrow_id, body.proof_id, privateKey, keyId);
    // Update reputation on payment release
    const escrow = economic.getEscrow(body.escrow_id);
    if (result.success && escrow) {
      reputation.recordTaskCompleted(escrow.to, 0, 0);
    }
    if (result.success) saveEconomicState(dataDir, economic);
    json(res, result.success ? 200 : 422, result);
    return true;
  }

  if (req.method === "POST" && path === "/escrow/refund") {
    const body = JSON.parse(await readBody(req));
    const privateKey = await getSigningKey(agent);
    const keyId = agent.getKeyId() || "unknown";
    const result = economic.refundEscrow(body.escrow_id, privateKey, keyId);
    if (result.success) saveEconomicState(dataDir, economic);
    json(res, result.success ? 200 : 422, result);
    return true;
  }

  if (req.method === "POST" && path === "/escrow/dispute") {
    const body = JSON.parse(await readBody(req));
    const result = economic.disputeEscrow(body.escrow_id);
    // Record dispute in reputation
    const escrow = economic.getEscrow(body.escrow_id);
    if (escrow) {
      reputation.recordDispute(escrow.to);
    }
    if (result.success) saveEconomicState(dataDir, economic);
    json(res, result.success ? 200 : 422, result);
    return true;
  }

  if (req.method === "GET" && path === "/escrow/list") {
    json(res, 200, { escrows: economic.listEscrows() });
    return true;
  }

  if (req.method === "GET" && path === "/ledger") {
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    json(res, 200, { entries: economic.getLedger(limit) });
    return true;
  }

  if (req.method === "GET" && path === "/ledger/verify") {
    json(res, 200, economic.verifyLedgerIntegrity());
    return true;
  }

  return false;
}

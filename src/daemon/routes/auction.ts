import { json, readBody } from "../http-util";
import { getSigningKey } from "../signing";
import { broadcastAuctionTask, buildAuctionAward, serializeAuction } from "../auction-util";
import type { DaemonContext, RequestContext } from "../context";
import type { AuctionStatus } from "../../types/protocol";

export async function handleAuction(ctx: DaemonContext, rc: RequestContext): Promise<boolean> {
  const { agent, auction, auctionOrigins, reputation, profileManager } = ctx;
  const { req, res, url, path } = rc;

  if (req.method === "POST" && path === "/auction/create") {
    const body = JSON.parse(await readBody(req));
    const missing: string[] = [];
    for (const field of ["type", "description", "input", "budget", "bid_deadline", "selection"]) {
      if (body[field] === undefined) missing.push(field);
    }
    if (missing.length > 0) {
      json(res, 400, { error: `Missing required fields: ${missing.join(", ")}` });
      return true;
    }

    const record = auction.createAuction({
      type: body.type,
      description: body.description,
      input: body.input,
      budget: body.budget,
      bid_deadline: body.bid_deadline,
      selection: body.selection,
      min_reputation: body.min_reputation,
      required_capabilities: body.required_capabilities,
      required_skills: body.required_skills,
      timeout_ms: body.timeout_ms,
      priority: body.priority,
    });
    auctionOrigins.set(record.task_id, agent.getAgentInfo().agent_id);

    // Push notification: if required_skills set, notify matching peers first
    let notifiedPeers = 0;
    if (body.required_skills && body.required_skills.length > 0) {
      const matches = profileManager.findMatchingPeers(body.required_skills, 0.3);
      const swarm = agent.getSwarm();
      for (const match of matches) {
        if (swarm.sendTaskMessage(match.agent_id, "task_notify", {
          task_id: record.task_id,
          type: body.type,
          description: body.description,
          required_skills: body.required_skills,
          budget: body.budget,
          match_score: match.score,
        })) {
          notifiedPeers++;
        }
      }
      if (notifiedPeers > 0) {
        console.error(`[Match] Notified ${notifiedPeers} matching peers for ${record.task_id}`);
      }
    }

    const broadcastCount = broadcastAuctionTask(agent, record.broadcast);
    json(res, 200, {
      auction: serializeAuction(record, auctionOrigins),
      broadcast_sent: broadcastCount,
    });
    return true;
  }

  if (req.method === "GET" && path === "/auction/list") {
    const status = url.searchParams.get("status") as AuctionStatus | null;
    const auctions = auction.listAuctions(status ?? undefined).map((record) => (
      serializeAuction(record, auctionOrigins)
    ));
    json(res, 200, { auctions });
    return true;
  }

  if (req.method === "GET" && path.match(/^\/auction\/[^/]+$/)) {
    const taskId = decodeURIComponent(path.split("/")[2]);
    const record = auction.getAuction(taskId);
    json(res, record ? 200 : 404, record ? serializeAuction(record, auctionOrigins) : { error: "Auction not found" });
    return true;
  }

  if (req.method === "POST" && path.match(/^\/auction\/[^/]+\/bid$/)) {
    const taskId = decodeURIComponent(path.split("/")[2]);
    const body = JSON.parse(await readBody(req));
    const record = auction.getAuction(taskId);
    if (!record) {
      json(res, 404, { error: "Auction not found" });
      return true;
    }

    const bidder = agent.getAgentInfo().agent_id;
    const originAgentId = auctionOrigins.get(taskId) ?? bidder;
    if (originAgentId === bidder) {
      const result = auction.submitBid(taskId, {
        task_id: taskId,
        bidder,
        price: body.price,
        estimated_duration_ms: body.estimated_duration_ms,
        reputation_score: reputation.getScore(bidder),
        message: body.message,
        capabilities: body.capabilities ?? [],
      });
      json(res, result.success ? 200 : 422, result);
      return true;
    }

    const swarm = agent.getSwarm();
    const sent = swarm.sendTaskMessage(originAgentId, "task_bid", {
      task_id: taskId,
      price: body.price,
      estimated_duration_ms: body.estimated_duration_ms,
      reputation_score: reputation.getScore(bidder),
      message: body.message,
      capabilities: body.capabilities ?? [],
    });

    json(res, sent ? 200 : 422, sent
      ? { success: true, task_id: taskId, bidder, issuer_agent_id: originAgentId }
      : { success: false, error: "Peer not connected", issuer_agent_id: originAgentId });
    return true;
  }

  if (req.method === "POST" && path.match(/^\/auction\/[^/]+\/award$/)) {
    const taskId = decodeURIComponent(path.split("/")[2]);
    if ((auctionOrigins.get(taskId) ?? agent.getAgentInfo().agent_id) !== agent.getAgentInfo().agent_id) {
      json(res, 403, { error: "Only the auction issuer can award bids" });
      return true;
    }

    const body = JSON.parse(await readBody(req));
    const record = auction.awardTask(taskId, body.bid_id);
    if (!record) {
      json(res, 422, { error: "Unable to award bid" });
      return true;
    }

    const award = buildAuctionAward(record);
    let notified = false;
    if (award && award.awarded_to !== agent.getAgentInfo().agent_id) {
      notified = agent.getSwarm().sendTaskMessage(award.awarded_to, "task_award", award);
    }

    json(res, 200, { auction: serializeAuction(record, auctionOrigins), notified });
    return true;
  }

  if (req.method === "POST" && path.match(/^\/auction\/[^/]+\/close$/)) {
    const taskId = decodeURIComponent(path.split("/")[2]);
    if ((auctionOrigins.get(taskId) ?? agent.getAgentInfo().agent_id) !== agent.getAgentInfo().agent_id) {
      json(res, 403, { error: "Only the auction issuer can close bidding" });
      return true;
    }

    const record = auction.closeBidding(taskId);
    if (!record) {
      json(res, 422, { error: "Unable to close auction" });
      return true;
    }

    const award = buildAuctionAward(record);
    let notified = false;
    if (award && award.awarded_to !== agent.getAgentInfo().agent_id) {
      notified = agent.getSwarm().sendTaskMessage(award.awarded_to, "task_award", award);
    }

    json(res, 200, { auction: serializeAuction(record, auctionOrigins), notified });
    return true;
  }

  if (req.method === "POST" && path.match(/^\/auction\/[^/]+\/cancel$/)) {
    const taskId = decodeURIComponent(path.split("/")[2]);
    if ((auctionOrigins.get(taskId) ?? agent.getAgentInfo().agent_id) !== agent.getAgentInfo().agent_id) {
      json(res, 403, { error: "Only the auction issuer can cancel the auction" });
      return true;
    }

    const record = auction.cancelAuction(taskId);
    json(res, record ? 200 : 422, record ? serializeAuction(record, auctionOrigins) : { error: "Unable to cancel auction" });
    return true;
  }

  if (req.method === "POST" && path.match(/^\/auction\/[^/]+\/prepare$/)) {
    const taskId = decodeURIComponent(path.split("/")[2]);
    if ((auctionOrigins.get(taskId) ?? agent.getAgentInfo().agent_id) !== agent.getAgentInfo().agent_id) {
      json(res, 403, { error: "Only the auction issuer can prepare execution" });
      return true;
    }

    const privateKey = await getSigningKey(agent);
    const keyId = agent.getKeyId() || "unknown";
    const result = auction.prepareExecution(taskId, privateKey, keyId);
    json(res, result.success ? 200 : 422, result);
    return true;
  }

  if (req.method === "POST" && path.match(/^\/auction\/[^/]+\/finalize$/)) {
    const taskId = decodeURIComponent(path.split("/")[2]);
    if ((auctionOrigins.get(taskId) ?? agent.getAgentInfo().agent_id) !== agent.getAgentInfo().agent_id) {
      json(res, 403, { error: "Only the auction issuer can finalize execution" });
      return true;
    }

    const body = JSON.parse(await readBody(req));
    const { fromBase64 } = await import("../../lib/crypto/keys");
    const privateKey = await getSigningKey(agent);
    const workerPublicKey = fromBase64(body.worker_public_key);
    const keyId = agent.getKeyId() || "unknown";
    const result = auction.finalizeExecution(
      taskId,
      body.proof,
      body.expected_input,
      body.received_output,
      workerPublicKey,
      privateKey,
      keyId
    );
    json(res, result.success ? 200 : 422, result);
    return true;
  }

  return false;
}

import type { P2PAgent } from "../agent/core";
import type { P2PSwarm, PeerConnection } from "../lib/p2p/swarm";
import type { AgentId, AuctionRecord, TaskAward, TaskBroadcast } from "../types/protocol";

export function broadcastAuctionTask(agent: P2PAgent, broadcast: TaskBroadcast): number {
  const swarm: P2PSwarm = agent.getSwarm();
  if (typeof swarm.broadcastTask === "function") {
    return swarm.broadcastTask(broadcast);
  }

  const peers: PeerConnection[] = typeof swarm.getConnectedPeers === "function" ? swarm.getConnectedPeers() : [];
  let sent = 0;
  for (const peer of peers) {
    if (!peer.connected || peer.verified === false || !peer.agentId) continue;
    if (swarm.sendTaskMessage(peer.agentId, "task_broadcast", broadcast)) {
      sent++;
    }
  }
  return sent;
}

export function buildAuctionAward(auction: AuctionRecord): TaskAward | null {
  if (!auction.winner_bid_id || !auction.winner_agent_id || !auction.awarded_at) {
    return null;
  }

  const winningBid = auction.bids.find((bid) => bid.bid_id === auction.winner_bid_id);
  if (!winningBid) return null;

  return {
    task_id: auction.task_id,
    bid_id: auction.winner_bid_id,
    awarded_to: auction.winner_agent_id,
    agreed_price: winningBid.price,
    awarded_at: auction.awarded_at,
  };
}

export function serializeAuction(auction: AuctionRecord, auctionOrigins: Map<string, AgentId>) {
  return {
    ...auction,
    issuer_agent_id: auctionOrigins.get(auction.task_id) ?? null,
  };
}

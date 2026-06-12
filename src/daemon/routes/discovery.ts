import { json } from "../http-util";
import type { IncomingMessage, ServerResponse } from "http";
import type { P2PAgent } from "../../agent/core";
import type { DiscoveryClient, ConnectionRequest } from "../../lib/discovery/client";
import type { InviteManager, InviteResult } from "../../lib/invite/manager";

export function addDiscoveryRoutes(
  agent: P2PAgent,
  discovery: DiscoveryClient,
  pendingRequests: ConnectionRequest[],
  inviteManager: InviteManager
) {
  return {
    handleDiscoveryRoute: async (
      req: IncomingMessage,
      res: ServerResponse,
      path: string
    ): Promise<boolean> => {
      if (req.method === "POST" && path === "/discovery/register") {
        const result = await discovery.register();
        json(res, 200, result);
        return true;
      }

      if (req.method === "POST" && path === "/discovery/unregister") {
        discovery.stopPolling();
        const result = await discovery.unregister();
        json(res, 200, result);
        return true;
      }

      if (req.method === "GET" && path === "/discovery/requests") {
        json(res, 200, { requests: pendingRequests });
        return true;
      }

      if (req.method === "POST" && path.startsWith("/discovery/requests/")) {
        const parts = path.split("/");
        const requestId = parts[3];
        const action = parts[4]; // accept or reject
        if (action === "accept" || action === "reject") {
          // Find the request before removing it
          const request = pendingRequests.find(r => r.id === requestId);
          const result = await discovery.ackRequest(requestId, action);
          // Remove from pending
          const idx = pendingRequests.findIndex(r => r.id === requestId);
          if (idx !== -1) pendingRequests.splice(idx, 1);

          // On accept: auto-connect via invite code
          if (action === "accept" && request?.from_agent_id) {
            const inviteCode = request.invite_code;
            if (inviteCode) {
              console.error(`[Discovery] Accepted ${request.from_agent_id} — connecting via invite code ${inviteCode}`);
              // Accept the invite to establish P2P connection
              inviteManager.accept(inviteCode).then((r: InviteResult) => {
                  if (r.success) {
                    console.error(`[Discovery] P2P connected to ${r.peerAgentId} via invite`);
                  } else {
                    console.error(`[Discovery] Invite accept failed: ${r.error}`);
                  }
                }).catch((e: Error) => {
                  console.error(`[Discovery] Invite accept error: ${e.message}`);
                });
            } else {
              console.error(`[Discovery] Accepted ${request.from_agent_id} — no invite code, manual connection needed`);
            }
          }

          json(res, 200, result);
          return true;
        }
      }

      if (req.method === "GET" && path === "/discovery/agents") {
        try {
          const data = await discovery.listAgents();
          json(res, 200, data);
        } catch (err) {
          json(res, 502, { error: `Discovery fetch failed: ${(err as Error).message}` });
        }
        return true;
      }

      return false;
    },
  };
}

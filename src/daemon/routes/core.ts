import { json } from "../http-util";
import type { DaemonContext, RequestContext } from "../context";

export async function handleCore(ctx: DaemonContext, rc: RequestContext): Promise<boolean> {
  const { agent, billing } = ctx;
  const { req, res, path } = rc;

  if (req.method === "GET" && path === "/info") {
    json(res, 200, {
      ...agent.getAgentInfo(),
      billing_enabled: billing !== null,
    });
    return true;
  }

  if (req.method === "GET" && path === "/peers") {
    json(res, 200, agent.getConnectedPeers());
    return true;
  }

  return false;
}

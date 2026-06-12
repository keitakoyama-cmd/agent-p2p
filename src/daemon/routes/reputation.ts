import { json, readBody } from "../http-util";
import type { DaemonContext, RequestContext } from "../context";
import type { AgentId } from "../../types/protocol";

export async function handleReputation(ctx: DaemonContext, rc: RequestContext): Promise<boolean> {
  const { reputation } = ctx;
  const { req, res, url, path } = rc;

  if (req.method === "GET" && path === "/reputation") {
    const agentIdParam = url.searchParams.get("agent_id") as AgentId | null;
    if (agentIdParam) {
      const record = reputation.getRecord(agentIdParam);
      json(res, record ? 200 : 404, record || { error: "No reputation record" });
    } else {
      json(res, 200, { records: reputation.listRecords() });
    }
    return true;
  }

  if (req.method === "GET" && path === "/reputation/policy") {
    json(res, 200, reputation.getPolicy());
    return true;
  }

  if (req.method === "POST" && path === "/reputation/policy") {
    const body = JSON.parse(await readBody(req));
    reputation.setPolicy(body);
    json(res, 200, reputation.getPolicy());
    return true;
  }

  return false;
}

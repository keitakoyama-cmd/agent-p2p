import { json, readBody } from "../http-util";
import type { DaemonContext, RequestContext } from "../context";

export async function handlePolicy(ctx: DaemonContext, rc: RequestContext): Promise<boolean> {
  const { taskPolicy } = ctx;
  const { req, res, path } = rc;

  if (req.method === "GET" && path === "/policy") {
    json(res, 200, taskPolicy.serialize());
    return true;
  }

  if (req.method === "POST" && path === "/policy") {
    const body = JSON.parse(await readBody(req));
    if (body.policy) taskPolicy.updatePolicy(body.policy);
    if (body.peer_override) {
      const { peer_id, ...override } = body.peer_override;
      if (peer_id) taskPolicy.setPeerOverride(peer_id, override);
    }
    json(res, 200, taskPolicy.serialize());
    return true;
  }

  if (req.method === "POST" && path === "/policy/check") {
    const body = JSON.parse(await readBody(req));
    if (!body.from || !body.task) {
      json(res, 400, { error: "from (AgentId) and task (TaskRequest) are required" });
      return true;
    }
    const result = taskPolicy.checkTask(body.from, body.task);
    json(res, 200, result);
    return true;
  }

  return false;
}

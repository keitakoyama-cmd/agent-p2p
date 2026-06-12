import { json, readBody } from "../http-util";
import type { DaemonContext, RequestContext } from "../context";
import type { AgentId, ConnectionMode } from "../../types/protocol";

export async function handlePeers(ctx: DaemonContext, rc: RequestContext): Promise<boolean> {
  const { taskManager } = ctx;
  const { req, res, path } = rc;

  if (req.method === "GET" && path === "/peers/config") {
    json(res, 200, { peers: taskManager.listPeers() });
    return true;
  }

  if (req.method === "POST" && path === "/peers/config") {
    const body = JSON.parse(await readBody(req));
    const config = taskManager.setPeerConfig(
      body.agent_id as AgentId,
      (body.mode || "restricted") as ConnectionMode,
      body.shared_namespace
    );
    json(res, 200, config);
    return true;
  }

  // --- Heartbeat ---

  if (req.method === "GET" && path === "/heartbeat") {
    json(res, 200, taskManager.buildHeartbeat());
    return true;
  }

  return false;
}

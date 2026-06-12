import { readdirSync, statSync } from "fs";
import { join } from "path";
import { json, readBody } from "../http-util";
import type { DaemonContext, RequestContext } from "../context";
import type { AgentId } from "../../types/protocol";

export async function handleMessaging(ctx: DaemonContext, rc: RequestContext): Promise<boolean> {
  const { agent } = ctx;
  const { req, res, path } = rc;

  if (req.method === "GET" && path === "/inbox") {
    json(res, 200, agent.getInbox());
    return true;
  }

  if (req.method === "POST" && path === "/inbox/process") {
    json(res, 200, agent.processNextInboxMessage());
    return true;
  }

  if (req.method === "POST" && path === "/file/send") {
    const body = JSON.parse(await readBody(req));
    const result = agent.sendFile(
      body.target_agent_id as AgentId,
      body.file_path
    );
    json(res, result.success ? 200 : 422, result);
    return true;
  }

  if (req.method === "GET" && path === "/file/received") {
    const dataDir = agent.getDataDir() || "";
    const dir = join(dataDir, "received");
    try {
      const files = readdirSync(dir).map(f => ({
        name: f,
        size: statSync(join(dir, f)).size,
      }));
      json(res, 200, { files, directory: dir });
    } catch {
      json(res, 200, { files: [], directory: dir });
    }
    return true;
  }

  return false;
}

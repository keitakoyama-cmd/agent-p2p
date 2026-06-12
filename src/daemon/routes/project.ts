import { json, readBody } from "../http-util";
import { saveEconomicState } from "../economic-state";
import { getSigningKey } from "../signing";
import { generateIcon } from "../../lib/ai/image";
import type { DaemonContext, RequestContext } from "../context";
import type { Project } from "../../lib/project/manager";

export async function handleProject(ctx: DaemonContext, rc: RequestContext): Promise<boolean> {
  const { agent, economic, projectManager, pumpfun, solanaKeypair, dataDir } = ctx;
  const { req, res, url, path } = rc;

  if (req.method === "POST" && path === "/project/create") {
    try {
      const body = JSON.parse(await readBody(req));
      const myAgentId = agent.getAgentInfo().agent_id;
      const { name, description, funding_goal, tasks, launch_on_pumpfun, image_base64,
              creator_name, icon_url, website, twitter, telegram, discord, github } = body;
      if (!name || !tasks?.length) {
        json(res, 400, { error: "name and tasks required" });
        return true;
      }

      let tokenId = body.token_id;
      let mintAddress: string | undefined;
      let pumpFunUrl: string | undefined;

      // Optionally launch token on pump.fun
      if (launch_on_pumpfun) {
        let imageBuffer: Buffer;
        if (image_base64) {
          imageBuffer = Buffer.from(image_base64, "base64");
        } else if (body.auto_generate_icon) {
          console.error(`[Project] Generating icon via AI...`);
          const iconResult = await generateIcon(name, body.symbol || "TOK", description || name);
          if (iconResult.success && iconResult.buffer) {
            imageBuffer = iconResult.buffer;
            console.error(`[Project] Icon generated (${imageBuffer.length} bytes)`);
          } else {
            console.error(`[Project] Icon generation failed: ${iconResult.error}, using placeholder`);
            imageBuffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64");
          }
        } else {
          imageBuffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64");
        }
        const launchResult = await pumpfun.launch(
          solanaKeypair, name, body.symbol || name.substring(0, 4).toUpperCase(),
          description || name,
          imageBuffer, "token.png", body.initial_buy_sol || 0,
          { website, twitter, telegram }
        );
        if (launchResult.success) {
          mintAddress = launchResult.mintAddress;
          tokenId = `pumpfun:${mintAddress}`;
          pumpFunUrl = launchResult.pumpFunUrl;
          economic.registerExternalToken(tokenId, name, body.symbol || "TOK", 6, "solana", mintAddress);
          saveEconomicState(dataDir, economic);
        } else {
          json(res, 422, { error: `Token launch failed: ${launchResult.error}` });
          return true;
        }
      }

      // If no token provided, issue a local one
      if (!tokenId) {
        const privateKey = await getSigningKey(agent);
        const keyId = agent.getKeyId() || "unknown";
        const token = economic.issueToken(name, body.symbol || "TOK", 6, funding_goal || 1000000, privateKey, keyId);
        tokenId = token.token_id;
        saveEconomicState(dataDir, economic);
      }

      const project = projectManager.createProject(
        myAgentId, name, description || "", tokenId, funding_goal || 0,
        tasks, {
          mintAddress,
          symbol: body.symbol,
          creatorName: creator_name,
          iconUrl: icon_url,
          links: { website, twitter, telegram, discord, github },
        }
      );

      json(res, 200, { ...project, pump_fun_url: pumpFunUrl });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  if (req.method === "POST" && path === "/project/fund") {
    const body = JSON.parse(await readBody(req));
    const investor = body.investor || agent.getAgentInfo().agent_id;
    const result = projectManager.fund(body.project_id, investor, body.amount);
    json(res, result.success ? 200 : 422, result);
    return true;
  }

  if (req.method === "POST" && path === "/project/task/assign") {
    const body = JSON.parse(await readBody(req));
    const result = projectManager.assignTask(body.project_id, body.task_id, body.agent_id);
    json(res, result.success ? 200 : 422, result);
    return true;
  }

  if (req.method === "POST" && path === "/project/task/complete") {
    const body = JSON.parse(await readBody(req));
    const result = projectManager.completeTask(body.project_id, body.task_id, body.proof_id);
    json(res, result.success ? 200 : 422, result);
    return true;
  }

  if (req.method === "POST" && path === "/project/task/fail") {
    const body = JSON.parse(await readBody(req));
    const result = projectManager.failTask(body.project_id, body.task_id);
    json(res, result.success ? 200 : 422, result);
    return true;
  }

  if (req.method === "GET" && path === "/project/distribute") {
    const projectId = url.searchParams.get("project_id");
    if (!projectId) { json(res, 400, { error: "project_id required" }); return true; }
    const result = projectManager.calculateDistribution(projectId);
    json(res, result.success ? 200 : 422, result);
    return true;
  }

  if (req.method === "GET" && path === "/project/list") {
    const status = url.searchParams.get("status") as Project["status"] | null;
    json(res, 200, { projects: projectManager.listProjects(status ?? undefined) });
    return true;
  }

  if (req.method === "GET" && path.startsWith("/project/") && !path.includes("/task/")) {
    const projectId = path.split("/")[2];
    const project = projectManager.getProject(projectId);
    json(res, project ? 200 : 404, project || { error: "Not found" });
    return true;
  }

  if (req.method === "POST" && path === "/project/broadcast") {
    const body = JSON.parse(await readBody(req));
    const payload = projectManager.toBroadcast(body.project_id);
    if (!payload) { json(res, 404, { error: "Project not found" }); return true; }
    const swarm = agent.getSwarm();
    let sent = 0;
    const peers = typeof swarm.getConnectedPeers === "function" ? swarm.getConnectedPeers() : [];
    for (const peer of peers) {
      if (peer.connected && peer.agentId) {
        if (swarm.sendTaskMessage(peer.agentId, "project_broadcast", payload)) sent++;
      }
    }
    json(res, 200, { broadcast: payload, peers_notified: sent });
    return true;
  }

  if (req.method === "POST" && path === "/ai/generate-icon") {
    try {
      const body = JSON.parse(await readBody(req));
      const result = await generateIcon(
        body.name || "Token",
        body.symbol || "TOK",
        body.description || ""
      );
      if (result.success && result.buffer) {
        json(res, 200, {
          success: true,
          image_base64: result.buffer.toString("base64"),
          size: result.buffer.length,
        });
      } else {
        json(res, 422, { success: false, error: result.error });
      }
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  return false;
}

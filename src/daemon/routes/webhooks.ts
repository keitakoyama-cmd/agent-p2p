import { json, readBody } from "../http-util";
import type { DaemonContext, RequestContext } from "../context";

export async function handleWebhooks(ctx: DaemonContext, rc: RequestContext): Promise<boolean> {
  const { webhooks } = ctx;
  const { req, res, path } = rc;

  if (req.method === "GET" && path === "/webhooks") {
    json(res, 200, { webhooks: webhooks });
    return true;
  }

  if (req.method === "POST" && path === "/webhooks") {
    const body = JSON.parse(await readBody(req));
    if (!body.url || !body.events) { json(res, 400, { error: "url and events required" }); return true; }
    const hook = {
      id: `wh_${Date.now().toString(36)}`,
      url: body.url,
      events: body.events as string[],
      created_at: new Date().toISOString(),
    };
    webhooks.push(hook);
    json(res, 200, hook);
    return true;
  }

  if (req.method === "DELETE" && path.startsWith("/webhooks/")) {
    const whId = path.split("/")[2];
    const idx = webhooks.findIndex(w => w.id === whId);
    if (idx === -1) { json(res, 404, { error: "Webhook not found" }); return true; }
    webhooks.splice(idx, 1);
    json(res, 200, { deleted: whId });
    return true;
  }

  return false;
}

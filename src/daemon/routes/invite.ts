import { json, readBody } from "../http-util";
import type { DaemonContext, RequestContext } from "../context";

export async function handleInvite(ctx: DaemonContext, rc: RequestContext): Promise<boolean> {
  const { inviteManager } = ctx;
  const { req, res, path } = rc;

  if (req.method === "POST" && path === "/invite/create") {
    const body = await readBody(req);
    const parsed = body ? JSON.parse(body) : {};
    const expiresIn = Math.min(Math.max(parsed.expires_in || 600, 60), 86400);
    const mode = parsed.mode || "restricted";
    const invite = await inviteManager.create(expiresIn, mode);
    json(res, 200, invite);
    return true;
  }

  if (req.method === "POST" && path === "/invite/accept") {
    const body = JSON.parse(await readBody(req));
    if (!body.code) { json(res, 400, { error: "code required" }); return true; }
    const result = await inviteManager.accept(body.code, body.mode || "restricted");
    json(res, result.success ? 200 : 400, result);
    return true;
  }

  if (req.method === "GET" && path === "/invite/pending") {
    json(res, 200, { invites: inviteManager.listPending() });
    return true;
  }

  return false;
}

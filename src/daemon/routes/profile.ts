import { json, readBody } from "../http-util";
import type { DaemonContext, RequestContext } from "../context";

export async function handleProfile(ctx: DaemonContext, rc: RequestContext): Promise<boolean> {
  const { profileManager } = ctx;
  const { req, res, path } = rc;

  if (req.method === "GET" && path === "/profile") {
    json(res, 200, profileManager.getLocalProfile());
    return true;
  }

  if (req.method === "POST" && path === "/profile") {
    const body = JSON.parse(await readBody(req));
    if (body.skills) profileManager.updateSkills(body.skills);
    if (body.availability) profileManager.setAvailability(body.availability);
    if (body.capability_tier) profileManager.setCapabilityTier(body.capability_tier);
    if (body.task_types) profileManager.setTaskTypes(body.task_types);
    json(res, 200, profileManager.getLocalProfile());
    return true;
  }

  if (req.method === "POST" && path === "/match") {
    const body = JSON.parse(await readBody(req));
    if (!body.required_skills || !Array.isArray(body.required_skills)) {
      json(res, 400, { error: "required_skills array is required" });
      return true;
    }
    const minScore = body.min_score ?? 0;
    const matches = profileManager.findMatchingPeers(body.required_skills, minScore);
    json(res, 200, { matches });
    return true;
  }

  if (req.method === "GET" && path === "/peers/profiles") {
    json(res, 200, { profiles: profileManager.getAllPeerProfiles() });
    return true;
  }

  return false;
}

import { json, readBody } from "../http-util";
import { getSigningKey } from "../signing";
import type { DaemonContext, RequestContext } from "../context";
import type { AgentId, ExecutionProof } from "../../types/protocol";

export async function handleVerification(ctx: DaemonContext, rc: RequestContext): Promise<boolean> {
  const { agent, reputation, verifier } = ctx;
  const { req, res, url, path } = rc;

  if (req.method === "POST" && path === "/verification/challenge") {
    const body = JSON.parse(await readBody(req));
    const challenge = verifier.createChallenge(body.task_id, body.ttl_ms);
    json(res, 200, challenge);
    return true;
  }

  if (req.method === "POST" && path === "/verification/prove") {
    const body = JSON.parse(await readBody(req));
    const privateKey = await getSigningKey(agent);
    const keyId = agent.getKeyId() || "unknown";
    const proof = verifier.createProof(
      body.task_id,
      body.input,
      body.output,
      privateKey,
      keyId,
      body.challenge
    );
    json(res, 200, proof);
    return true;
  }

  if (req.method === "POST" && path === "/verification/verify") {
    const body = JSON.parse(await readBody(req));
    const proof = body.proof as ExecutionProof;
    const workerPubKey = (await import("../../lib/crypto/keys")).fromBase64(body.worker_public_key);
    const result = verifier.verifyProof(proof, body.expected_input, body.received_output, workerPubKey);
    // Update reputation based on verification
    if (proof.signature?.key_id) {
      const workerAgentId = body.worker_agent_id as AgentId;
      if (workerAgentId) {
        if (result.valid) {
          reputation.recordVerifiedProof(workerAgentId);
        }
      }
    }
    json(res, 200, result);
    return true;
  }

  if (req.method === "GET" && path === "/verification/proof") {
    const taskId = url.searchParams.get("task_id");
    if (taskId) {
      const proof = verifier.getProof(taskId);
      json(res, proof ? 200 : 404, proof || { error: "No proof found" });
    } else {
      json(res, 200, { proofs: verifier.listProofs() });
    }
    return true;
  }

  return false;
}

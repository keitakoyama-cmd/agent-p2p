import type { P2PAgent } from "../agent/core";

export async function getSigningKey(agent: P2PAgent): Promise<Uint8Array> {
  return (await import("../lib/crypto/keys")).fromBase64(agent.getPrivateKey());
}

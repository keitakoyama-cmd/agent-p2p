import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, sign, toBase64 } from "../src/lib/crypto/keys";
import { buildHandshakeSigInput, evaluateHandshake } from "../src/lib/p2p/swarm";
import type { AgentId } from "../src/types/protocol";

// ============================================================
// evaluateHandshake — app-layer Ed25519 handshake authentication
// (swarm.ts marks a peer verified only when this returns verified=true)
// ============================================================

const NOW = 1_700_000_000_000; // fixed clock for deterministic freshness checks
const RECIPIENT_NOISE = "a".repeat(64); // our own Noise transport key (hex)
const ALICE = "agent:org1:alice" as AgentId;

/** Produce the handshake input a well-behaved sender would emit. */
function signedHandshake(
  kp: { privateKey: Uint8Array; publicKey: Uint8Array },
  agentId: AgentId,
  recipientNoiseHex: string,
  challenge: string,
) {
  const sig = sign(buildHandshakeSigInput(agentId, recipientNoiseHex, challenge), kp.privateKey);
  return { agentId, challenge, signature: toBase64(sig), publicKey: toBase64(kp.publicKey) };
}

describe("evaluateHandshake", () => {
  it("accepts a valid signed handshake and returns the key to pin (TOFU)", () => {
    const kp = generateKeyPair();
    const input = signedHandshake(kp, ALICE, RECIPIENT_NOISE, String(NOW));
    const r = evaluateHandshake(input, { recipientNoiseKeyHex: RECIPIENT_NOISE, now: NOW });
    assert.equal(r.verified, true);
    assert.equal(r.pinnedKey, toBase64(kp.publicKey));
  });

  it("accepts when the presented key matches the previously pinned key", () => {
    const kp = generateKeyPair();
    const input = signedHandshake(kp, ALICE, RECIPIENT_NOISE, String(NOW));
    const r = evaluateHandshake(input, {
      recipientNoiseKeyHex: RECIPIENT_NOISE,
      now: NOW,
      pinnedKey: toBase64(kp.publicKey),
    });
    assert.equal(r.verified, true);
  });

  it("rejects a key that differs from the pinned key (impersonation)", () => {
    const attacker = generateKeyPair();
    // Attacker controls a valid signature for ITS OWN key, but Alice's key is pinned.
    const input = signedHandshake(attacker, ALICE, RECIPIENT_NOISE, String(NOW));
    const pinned = toBase64(generateKeyPair().publicKey); // Alice's real, different key
    const r = evaluateHandshake(input, {
      recipientNoiseKeyHex: RECIPIENT_NOISE,
      now: NOW,
      pinnedKey: pinned,
    });
    assert.equal(r.verified, false);
  });

  it("rejects a tampered signature", () => {
    const kp = generateKeyPair();
    const input = signedHandshake(kp, ALICE, RECIPIENT_NOISE, String(NOW));
    input.signature = toBase64(sign(buildHandshakeSigInput(ALICE, RECIPIENT_NOISE, "999"), kp.privateKey));
    const r = evaluateHandshake(input, { recipientNoiseKeyHex: RECIPIENT_NOISE, now: NOW });
    assert.equal(r.verified, false);
  });

  it("rejects a signature bound to a different recipient (replay defense)", () => {
    const kp = generateKeyPair();
    // Signature was produced for some OTHER peer's Noise key; replaying it here must fail.
    const input = signedHandshake(kp, ALICE, "b".repeat(64), String(NOW));
    const r = evaluateHandshake(input, { recipientNoiseKeyHex: RECIPIENT_NOISE, now: NOW });
    assert.equal(r.verified, false);
  });

  it("rejects a stale challenge outside the freshness window", () => {
    const kp = generateKeyPair();
    const staleChallenge = String(NOW - 10 * 60_000); // 10 min old, window is 5 min
    const input = signedHandshake(kp, ALICE, RECIPIENT_NOISE, staleChallenge);
    const r = evaluateHandshake(input, { recipientNoiseKeyHex: RECIPIENT_NOISE, now: NOW });
    assert.equal(r.verified, false);
  });

  it("rejects a signature made for a different claimed agent id", () => {
    const kp = generateKeyPair();
    // Signed as bob, but the handshake claims to be alice.
    const input = signedHandshake(kp, "agent:org1:bob" as AgentId, RECIPIENT_NOISE, String(NOW));
    input.agentId = ALICE;
    const r = evaluateHandshake(input, { recipientNoiseKeyHex: RECIPIENT_NOISE, now: NOW });
    assert.equal(r.verified, false);
  });

  it("accepts an unsigned handshake by default (legacy compatibility)", () => {
    const r = evaluateHandshake({ agentId: ALICE, challenge: String(NOW) }, {
      recipientNoiseKeyHex: RECIPIENT_NOISE,
      now: NOW,
    });
    assert.equal(r.verified, true);
    assert.equal(r.reason, "unsigned-legacy");
  });

  it("rejects an unsigned handshake from an agent whose key is already pinned (no downgrade)", () => {
    // Alice signed before, so her key is pinned. An attacker must not impersonate
    // her by simply omitting the signature and falling back to the legacy path.
    const r = evaluateHandshake({ agentId: ALICE, challenge: String(NOW) }, {
      recipientNoiseKeyHex: RECIPIENT_NOISE,
      now: NOW,
      pinnedKey: toBase64(generateKeyPair().publicKey),
    });
    assert.equal(r.verified, false);
    assert.equal(r.reason, "downgrade-pinned");
  });

  it("rejects an unsigned handshake when requireSignedHandshake is set", () => {
    const r = evaluateHandshake({ agentId: ALICE, challenge: String(NOW) }, {
      recipientNoiseKeyHex: RECIPIENT_NOISE,
      now: NOW,
      requireSignedHandshake: true,
    });
    assert.equal(r.verified, false);
  });

  it("treats a partial handshake (signature without public key) as unsigned", () => {
    const kp = generateKeyPair();
    const full = signedHandshake(kp, ALICE, RECIPIENT_NOISE, String(NOW));
    const r = evaluateHandshake(
      { agentId: ALICE, challenge: full.challenge, signature: full.signature },
      { recipientNoiseKeyHex: RECIPIENT_NOISE, now: NOW, requireSignedHandshake: true },
    );
    assert.equal(r.verified, false);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSignedEnvelope, type BuildEnvelopeParams } from "../src/lib/protocol/envelope";
import { computePayloadHash, generateKeyPair, verifyEnvelope } from "../src/lib/crypto";
import type { AgentId } from "../src/types/protocol";

const FROM = "agent:protocol:sender" as AgentId;
const TO = "agent:protocol:receiver" as AgentId;

function makeParams(
  overrides: Partial<BuildEnvelopeParams> = {}
): BuildEnvelopeParams {
  return {
    from: FROM,
    to: TO,
    messageType: "invoice.ack",
    threadId: "thread-protocol-1",
    idempotencyKey: "idem-protocol-1",
    ...overrides,
  };
}

function makeAckPayload(): unknown {
  return {
    meta: { invoice_id: "inv-protocol-1", currency: "JPY" },
    data: {
      ack_type: "received",
      received_at: "2026-01-01T00:00:00.000Z",
      processing_status: "received",
    },
  };
}

function circularPayload(): Record<string, unknown> {
  const payload: Record<string, unknown> = { invoice_id: "inv-circular" };
  payload.self = payload;
  return payload;
}

describe("buildSignedEnvelope", () => {
  it("populates required envelope fields and produces a verifiable signature", () => {
    const { privateKey, publicKey } = generateKeyPair();
    const payload = makeAckPayload();

    const envelope = buildSignedEnvelope(
      makeParams(),
      payload,
      privateKey,
      "key-protocol-1"
    );

    assert.match(envelope.message_id, /^msg_[0-9a-f]{32}$/);
    assert.equal(envelope.thread_id, "thread-protocol-1");
    assert.equal(envelope.from, FROM);
    assert.equal(envelope.to, TO);
    assert.equal(envelope.message_type, "invoice.ack");
    assert.equal(envelope.schema_version, "0.1.0");
    assert.match(envelope.created_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(envelope.idempotency_key, "idem-protocol-1");
    assert.equal(envelope.correlation_id, null);
    assert.equal(envelope.reply_to_message_id, null);
    assert.equal(envelope.expires_at, null);
    assert.equal(envelope.payload_hash, computePayloadHash(payload));
    assert.equal(envelope.signature.algorithm, "Ed25519");
    assert.equal(envelope.signature.key_id, "key-protocol-1");
    assert.ok(envelope.signature.value.length > 0);
    assert.equal(verifyEnvelope(envelope, publicKey), true);
  });

  it("keeps payload hashes deterministic for equivalent object key ordering", () => {
    const { privateKey } = generateKeyPair();
    const left = { z: 1, a: { c: [3, 4], b: 2 } };
    const right = { a: { b: 2, c: [3, 4] }, z: 1 };

    const leftEnvelope = buildSignedEnvelope(
      makeParams({ idempotencyKey: "idem-left" }),
      left,
      privateKey,
      "key-left"
    );
    const rightEnvelope = buildSignedEnvelope(
      makeParams({ idempotencyKey: "idem-right" }),
      right,
      privateKey,
      "key-right"
    );

    assert.equal(leftEnvelope.payload_hash, rightEnvelope.payload_hash);
    assert.equal(leftEnvelope.payload_hash, computePayloadHash(right));
  });

  it("preserves explicit optional envelope fields", () => {
    const { privateKey } = generateKeyPair();
    const expiresAt = "2026-02-01T00:00:00.000Z";

    const envelope = buildSignedEnvelope(
      makeParams({
        correlationId: "corr-1",
        replyToMessageId: "msg_original",
        expiresAt,
      }),
      makeAckPayload(),
      privateKey,
      "key-protocol-optional"
    );

    assert.equal(envelope.correlation_id, "corr-1");
    assert.equal(envelope.reply_to_message_id, "msg_original");
    assert.equal(envelope.expires_at, expiresAt);
  });

  it("changes signature verification when a signed required field is mutated", () => {
    const { privateKey, publicKey } = generateKeyPair();
    const envelope = buildSignedEnvelope(
      makeParams(),
      makeAckPayload(),
      privateKey,
      "key-protocol-mutate"
    );

    const mutated = { ...envelope, thread_id: "thread-mutated" };

    assert.equal(verifyEnvelope(envelope, publicKey), true);
    assert.equal(verifyEnvelope(mutated, publicKey), false);
  });

  it("throws before signing when payload cannot be canonicalized", () => {
    const { privateKey } = generateKeyPair();

    assert.throws(
      () => buildSignedEnvelope(makeParams(), circularPayload(), privateKey, "key-circular"),
      TypeError
    );
    assert.throws(
      () => buildSignedEnvelope(makeParams(), undefined, privateKey, "key-undefined"),
      TypeError
    );
  });

  it("throws when the private key is invalid for Ed25519 signing", () => {
    const invalidPrivateKey = new Uint8Array(31);

    assert.throws(() =>
      buildSignedEnvelope(
        makeParams(),
        makeAckPayload(),
        invalidPrivateKey,
        "key-invalid"
      )
    );
  });
});

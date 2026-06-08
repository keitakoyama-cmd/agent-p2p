import { createHash } from "crypto";
import type { Envelope, Signature } from "../../types/protocol";
import { sign, verify, toBase64, fromBase64 } from "./keys";

/**
 * Canonical JSON: sorted keys, no whitespace.
 * This ensures deterministic serialization for signing.
 */
export function canonicalJson(obj: unknown): string {
  const canonical = stringifyCanonical(obj, new WeakSet<object>());
  if (canonical === undefined) {
    throw new TypeError("Cannot canonicalize value as JSON");
  }
  return canonical;
}

function stringifyCanonical(value: unknown, seen: WeakSet<object>): string | undefined {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (hasToJson(value)) {
    return stringifyCanonical(value.toJSON(), seen);
  }

  if (seen.has(value)) {
    throw new TypeError("Cannot canonicalize circular structure");
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stringifyCanonical(item, seen) ?? "null").join(",")}]`;
    }
    return stringifyObject(value, seen);
  } finally {
    seen.delete(value);
  }
}

function stringifyObject(value: object, seen: WeakSet<object>): string {
  const fields = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined && typeof entry !== "function")
    .filter(([, entry]) => typeof entry !== "symbol")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const body = fields
    .map(([key, entry]) => `${JSON.stringify(key)}:${stringifyCanonical(entry, seen)}`)
    .join(",");
  return `{${body}}`;
}

function hasToJson(value: object): value is { toJSON: () => unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === "function";
}

/**
 * Compute SHA-256 hash of canonical JSON payload.
 * Returns "sha256:<hex>"
 */
export function computePayloadHash(payload: unknown): string {
  const canonical = canonicalJson(payload);
  const hash = createHash("sha256").update(canonical).digest("hex");
  return `sha256:${hash}`;
}

/**
 * Build the signing input from an envelope (excluding the signature field).
 * This is what gets signed / verified.
 */
function buildSigningInput(envelope: Envelope): string {
  const signingFields = {
    message_id: envelope.message_id,
    thread_id: envelope.thread_id,
    from: envelope.from,
    to: envelope.to,
    message_type: envelope.message_type,
    schema_version: envelope.schema_version,
    created_at: envelope.created_at,
    idempotency_key: envelope.idempotency_key,
    correlation_id: envelope.correlation_id ?? null,
    reply_to_message_id: envelope.reply_to_message_id ?? null,
    expires_at: envelope.expires_at ?? null,
    payload_hash: envelope.payload_hash,
  };
  return canonicalJson(signingFields);
}

/**
 * Sign an envelope with Ed25519 private key.
 * Returns a Signature object.
 */
export function signEnvelope(
  envelope: Envelope,
  privateKey: Uint8Array,
  keyId: string
): Signature {
  const input = buildSigningInput(envelope);
  const inputBytes = new TextEncoder().encode(input);
  const sig = sign(inputBytes, privateKey);
  return {
    algorithm: "Ed25519",
    key_id: keyId,
    value: toBase64(sig),
  };
}

/**
 * Verify an envelope signature against a public key.
 */
export function verifyEnvelope(
  envelope: Envelope,
  publicKey: Uint8Array
): boolean {
  const input = buildSigningInput(envelope);
  const inputBytes = new TextEncoder().encode(input);
  const sigBytes = fromBase64(envelope.signature.value);
  return verify(sigBytes, inputBytes, publicKey);
}

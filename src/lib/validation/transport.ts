import type { Envelope, AgentRegistryEntry } from "../../types/protocol";
import { verifyEnvelope } from "../crypto";
import { fromBase64 } from "../crypto";

export interface TransportValidationResult {
  valid: boolean;
  error?: string;
  errorCode?: string;
}

const CREATED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Layer 1: Transport validation.
 * - Signature verification
 * - Expiry check
 * - Sender registry lookup
 * - Capability check
 */
export function validateTransport(
  envelope: Envelope,
  senderEntry: AgentRegistryEntry | null
): TransportValidationResult {
  // Check sender exists in registry
  if (!senderEntry) {
    return {
      valid: false,
      error: `Unknown sender: ${envelope.from}`,
      errorCode: "unknown_sender",
    };
  }

  // Check sender is active
  if (senderEntry.status !== "active") {
    return {
      valid: false,
      error: `Sender ${envelope.from} is ${senderEntry.status}`,
      errorCode: "unknown_sender",
    };
  }

  // Check capability
  if (!senderEntry.capabilities.includes(envelope.message_type)) {
    return {
      valid: false,
      error: `Sender lacks capability: ${envelope.message_type}`,
      errorCode: "unauthorized_capability",
    };
  }

  const createdAt = parseIsoTimestamp(envelope.created_at);
  if (!createdAt) {
    return {
      valid: false,
      error: "Invalid creation timestamp",
      errorCode: "invalid_schema",
    };
  }
  if (createdAt.getTime() - Date.now() > CREATED_AT_FUTURE_SKEW_MS) {
    return {
      valid: false,
      error: "Message creation timestamp is in the future",
      errorCode: "invalid_schema",
    };
  }

  // Check expiry
  if (envelope.expires_at) {
    const expiresAt = new Date(envelope.expires_at);
    if (Number.isNaN(expiresAt.getTime())) {
      return {
        valid: false,
        error: "Invalid expiry timestamp",
        errorCode: "invalid_schema",
      };
    }
    if (expiresAt < new Date()) {
      return {
        valid: false,
        error: "Message has expired",
        errorCode: "expired_message",
      };
    }
  }

  // Verify signature
  const publicKey = fromBase64(senderEntry.public_key);
  const signatureValid = verifyEnvelope(envelope, publicKey);
  if (!signatureValid) {
    return {
      valid: false,
      error: "Invalid signature",
      errorCode: "invalid_signature",
    };
  }

  return { valid: true };
}

function parseIsoTimestamp(value: string): Date | null {
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match || !hasValidDateParts(match)) {
    return null;
  }

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }

  return timestamp;
}

function hasValidDateParts(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

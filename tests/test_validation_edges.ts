import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validatePayload } from "../src/lib/validation/schemas";
import { validateBusinessRules } from "../src/lib/validation/business";
import { validateTransport } from "../src/lib/validation/transport";
import { computePayloadHash, generateKeyPair, signEnvelope, toBase64 } from "../src/lib/crypto";
import type {
  AgentId,
  AgentRegistryEntry,
  Envelope,
  InvoiceIssuePayload,
  LineItem,
  MessageType,
  OrgId,
  Party,
} from "../src/types/protocol";

const FROM = "agent:org1:sender" as AgentId;
const TO = "agent:org2:receiver" as AgentId;
const ORG = "org:org1" as OrgId;

function makeParty(name: string, email: string): Party {
  return {
    org_id: ORG,
    name,
    tax_id: `${name}-tax`,
    address: `${name} address`,
    email,
  };
}

function makeLine(overrides: Partial<LineItem> = {}): LineItem {
  return {
    line_id: "line-1",
    description: "Implementation",
    quantity: 1,
    unit: "hour",
    unit_price: 1000,
    tax_rate: 0.1,
    amount_excluding_tax: 1000,
    tax_amount: 100,
    amount_including_tax: 1100,
    ...overrides,
  };
}

function makeInvoiceIssuePayload(): InvoiceIssuePayload {
  return {
    meta: { invoice_id: "inv-edge-1", currency: "JPY" },
    data: {
      invoice_number: "INV-EDGE-1",
      issue_date: "2026-01-01",
      due_date: "2026-01-31",
      seller: makeParty("seller", "seller@example.com"),
      buyer: makeParty("buyer", "buyer@example.com"),
      line_items: [makeLine()],
      subtotal: 1000,
      tax_total: 100,
      total: 1100,
      payment_terms: {
        method: "bank_transfer",
        terms_text: "Due end of month",
      },
    },
  };
}

function makeSignedEnvelope(
  messageType: MessageType,
  privateKey: Uint8Array,
  expiresAt: string | null
): Envelope {
  const payload = { ok: true };
  const unsigned: Envelope = {
    message_id: "msg-edge-1",
    thread_id: "thread-edge-1",
    from: FROM,
    to: TO,
    message_type: messageType,
    schema_version: "1.0.0",
    created_at: "2026-01-01T00:00:00.000Z",
    idempotency_key: "idem-edge-1",
    expires_at: expiresAt,
    payload_hash: computePayloadHash(payload),
    signature: {
      algorithm: "Ed25519",
      key_id: "key-edge-1",
      value: "",
    },
  };
  return {
    ...unsigned,
    signature: signEnvelope(unsigned, privateKey, "key-edge-1"),
  };
}

function makeRegistry(
  publicKey: Uint8Array,
  capabilities: MessageType[],
  status: AgentRegistryEntry["status"] = "active"
): AgentRegistryEntry {
  return {
    agent_id: FROM,
    org_id: ORG,
    public_key: toBase64(publicKey),
    algorithm: "Ed25519",
    endpoint: "http://127.0.0.1:9999",
    capabilities,
    status,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("validatePayload edge cases", () => {
  it("accepts zero-value invoice line boundaries allowed by schema", () => {
    const payload = makeInvoiceIssuePayload();
    payload.data.line_items = [
      makeLine({
        quantity: 0,
        unit_price: 0,
        tax_rate: 1,
        amount_excluding_tax: 0,
        tax_amount: 0,
        amount_including_tax: 0,
      }),
    ];
    payload.data.subtotal = 0;
    payload.data.tax_total = 0;
    payload.data.total = 0;

    const result = validatePayload("invoice.issue", payload);

    assert.equal(result.valid, true);
  });

  it("rejects empty invoice line_items", () => {
    const payload = makeInvoiceIssuePayload();
    payload.data.line_items = [];

    const result = validatePayload("invoice.issue", payload);

    assert.equal(result.valid, false);
    assert.ok(result.errors?.some((error) => error.includes("must NOT have fewer")));
  });

  it("rejects invalid date, email, and tax_rate boundaries", () => {
    const payload = makeInvoiceIssuePayload();
    payload.data.issue_date = "2026-02-30";
    payload.data.seller.email = "not-an-email";
    payload.data.line_items[0].tax_rate = 1.01;

    const result = validatePayload("invoice.issue", payload);

    assert.equal(result.valid, false);
    assert.ok(result.errors?.some((error) => error.includes("format")));
    assert.ok(result.errors?.some((error) => error.includes("must be <= 1")));
  });

  it("rejects empty request_fix issues", () => {
    const result = validatePayload("invoice.request_fix", {
      meta: { invoice_id: "inv-edge-1", currency: "JPY" },
      data: {
        requested_at: "2026-01-01T00:00:00.000Z",
        issues: [],
        suggested_action: "Fix the invoice",
      },
    });

    assert.equal(result.valid, false);
  });

  it("accepts zero payment amount but rejects negative payment amount", () => {
    const base = {
      meta: { invoice_id: "inv-edge-1", currency: "JPY" },
      data: {
        paid_at: "2026-01-01T00:00:00.000Z",
        amount_paid: 0,
        payment_method: "bank_transfer",
        payment_reference: "pay-edge-1",
        settlement_status: "partial",
      },
    };

    const zero = validatePayload("payment.notice", base);
    const negative = validatePayload("payment.notice", {
      ...base,
      data: { ...base.data, amount_paid: -1 },
    });

    assert.equal(zero.valid, true);
    assert.equal(negative.valid, false);
  });

  it("reports valid message types that have no registered schema", () => {
    const result = validatePayload("system.error", {
      meta: { invoice_id: "inv-edge-1", currency: "JPY" },
      data: { error_code: "x", message: "x", retryable: false },
    });

    assert.equal(result.valid, false);
    assert.ok(result.errors?.some((error) => error.includes("No schema registered")));
  });
});

describe("validateBusinessRules edge cases", () => {
  it("allows one yen line-tax rounding differences", () => {
    const payload = makeInvoiceIssuePayload();
    payload.data.line_items = [makeLine({ amount_excluding_tax: 333, tax_amount: 32 })];
    payload.data.subtotal = 333;
    payload.data.tax_total = 32;
    payload.data.total = 365;

    const result = validateBusinessRules(payload);

    assert.equal(result.valid, true);
    assert.equal(result.fixableIssues.length, 0);
  });

  it("rejects due_date equal to issue_date", () => {
    const payload = makeInvoiceIssuePayload();
    payload.data.due_date = payload.data.issue_date;

    const result = validateBusinessRules(payload);

    assert.equal(result.valid, false);
    assert.ok(result.fixableIssues.some((issue) => issue.code === "invalid_due_date"));
  });

  it("reports subtotal, tax total, and total mismatches together", () => {
    const payload = makeInvoiceIssuePayload();
    payload.data.subtotal = 999;
    payload.data.tax_total = 99;
    payload.data.total = 1200;

    const result = validateBusinessRules(payload);
    const codes = result.fixableIssues.map((issue) => issue.code);

    assert.equal(result.valid, false);
    assert.ok(codes.includes("subtotal_mismatch"));
    assert.ok(codes.includes("tax_amount_inconsistent"));
    assert.ok(codes.includes("total_mismatch"));
  });
});

describe("validateTransport edge cases", () => {
  it("rejects unknown senders before signature validation", () => {
    const { privateKey } = generateKeyPair();
    const envelope = makeSignedEnvelope("invoice.issue", privateKey, null);

    const result = validateTransport(envelope, null);

    assert.equal(result.valid, false);
    assert.equal(result.errorCode, "unknown_sender");
  });

  it("rejects inactive senders", () => {
    const { privateKey, publicKey } = generateKeyPair();
    const envelope = makeSignedEnvelope("invoice.issue", privateKey, null);
    const sender = makeRegistry(publicKey, ["invoice.issue"], "suspended");

    const result = validateTransport(envelope, sender);

    assert.equal(result.valid, false);
    assert.equal(result.errorCode, "unknown_sender");
  });

  it("rejects missing capabilities", () => {
    const { privateKey, publicKey } = generateKeyPair();
    const envelope = makeSignedEnvelope("invoice.accept", privateKey, null);
    const sender = makeRegistry(publicKey, ["invoice.issue"]);

    const result = validateTransport(envelope, sender);

    assert.equal(result.valid, false);
    assert.equal(result.errorCode, "unauthorized_capability");
  });

  it("rejects expired and invalid expires_at values", () => {
    const { privateKey, publicKey } = generateKeyPair();
    const expired = makeSignedEnvelope(
      "invoice.issue",
      privateKey,
      "2000-01-01T00:00:00.000Z"
    );
    const invalid = makeSignedEnvelope("invoice.issue", privateKey, "not-a-date");
    const sender = makeRegistry(publicKey, ["invoice.issue"]);

    const expiredResult = validateTransport(expired, sender);
    const invalidResult = validateTransport(invalid, sender);

    assert.equal(expiredResult.valid, false);
    assert.equal(expiredResult.errorCode, "expired_message");
    assert.equal(invalidResult.valid, false);
    assert.equal(invalidResult.errorCode, "invalid_schema");
  });

  it("accepts active senders with capability, future expiry, and valid signature", () => {
    const { privateKey, publicKey } = generateKeyPair();
    const future = new Date(Date.now() + 60_000).toISOString();
    const envelope = makeSignedEnvelope("invoice.issue", privateKey, future);
    const sender = makeRegistry(publicKey, ["invoice.issue"]);

    const result = validateTransport(envelope, sender);

    assert.equal(result.valid, true);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processIncomingMessage } from "../src/lib/relay/processor";
import { buildSignedEnvelope } from "../src/lib/protocol/envelope";
import { signEnvelope } from "../src/lib/crypto";
import {
  getAuditLog,
  getInvoiceState,
  registerAgent,
  setInvoiceState,
} from "../src/lib/db/store";
import { generateKeyPair, toBase64 } from "../src/lib/crypto";
import type {
  AgentId,
  AgentRegistryEntry,
  InvoiceIssuePayload,
  LineItem,
  MessageType,
  OrgId,
  Party,
  SignedMessage,
} from "../src/types/protocol";

const ORG = "org:relay" as OrgId;
const RECEIVER = "agent:relay:receiver" as AgentId;

interface SenderContext {
  from: AgentId;
  to: AgentId;
  privateKey: Uint8Array;
  keyId: string;
}

let sequence = 0;

function nextName(label: string): string {
  sequence += 1;
  return `${label}-${sequence}`;
}

function makeAgentId(label: string): AgentId {
  return `agent:relay:${nextName(label)}` as AgentId;
}

function makeRegistry(
  sender: SenderContext,
  publicKey: Uint8Array,
  capabilities: MessageType[]
): AgentRegistryEntry {
  return {
    agent_id: sender.from,
    org_id: ORG,
    public_key: toBase64(publicKey),
    algorithm: "Ed25519",
    endpoint: "http://127.0.0.1:0",
    capabilities,
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function registerSender(capabilities: MessageType[]): SenderContext {
  const { privateKey, publicKey } = generateKeyPair();
  const sender = {
    from: makeAgentId("sender"),
    to: RECEIVER,
    privateKey,
    keyId: nextName("key"),
  };
  registerAgent(makeRegistry(sender, publicKey, capabilities));
  return sender;
}

function makeParty(kind: string): Party {
  return {
    org_id: ORG,
    name: `${kind} Inc.`,
    tax_id: `${kind}-tax`,
    address: `${kind} address`,
    email: `${kind}@example.com`,
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

function makeInvoiceIssuePayload(invoiceId: string): InvoiceIssuePayload {
  return {
    meta: { invoice_id: invoiceId, currency: "JPY" },
    data: {
      invoice_number: `INV-${invoiceId}`,
      issue_date: "2026-01-01",
      due_date: "2026-01-31",
      seller: makeParty("seller"),
      buyer: makeParty("buyer"),
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

function makeSignedMessage(
  sender: SenderContext,
  messageType: MessageType,
  payload: unknown
): SignedMessage {
  const envelope = buildSignedEnvelope(
    {
      from: sender.from,
      to: sender.to,
      messageType,
      threadId: nextName("thread"),
      idempotencyKey: nextName("idem"),
    },
    payload,
    sender.privateKey,
    sender.keyId
  );
  return { envelope, payload };
}

function responsePayload(value: unknown): {
  meta: Record<string, unknown>;
  data: Record<string, unknown>;
} {
  const payload = asRecord(value);
  return {
    meta: asRecord(payload.meta),
    data: asRecord(payload.data),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

function issueCodes(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value.map((issue) => asRecord(issue).code);
}

describe("relay processIncomingMessage validation pipeline", () => {
  it("rejects unknown senders at transport validation", () => {
    const { privateKey } = generateKeyPair();
    const sender: SenderContext = {
      from: makeAgentId("unknown"),
      to: RECEIVER,
      privateKey,
      keyId: nextName("key"),
    };
    const payload = makeInvoiceIssuePayload(nextName("invoice"));

    const result = processIncomingMessage(
      makeSignedMessage(sender, "invoice.issue", payload)
    );
    const rejection = responsePayload(result.responsePayload);

    assert.equal(result.accepted, false);
    assert.equal(result.responseType, "invoice.reject");
    assert.equal(rejection.meta.invoice_id, payload.meta.invoice_id);
    assert.equal(rejection.data.reason_code, "unknown_sender");
    assert.equal(rejection.data.retryable, false);
  });

  it("rejects senders without the message capability", () => {
    const sender = registerSender(["invoice.ack"]);
    const payload = makeInvoiceIssuePayload(nextName("invoice"));

    const result = processIncomingMessage(
      makeSignedMessage(sender, "invoice.issue", payload)
    );
    const rejection = responsePayload(result.responsePayload);

    assert.equal(result.accepted, false);
    assert.equal(result.responseType, "invoice.reject");
    assert.equal(rejection.data.reason_code, "unauthorized_capability");
    assert.equal(rejection.data.retryable, false);
  });

  it("rejects invalid signatures before schema validation", () => {
    const sender = registerSender(["invoice.issue"]);
    const wrongKey = generateKeyPair();
    const payload = makeInvoiceIssuePayload(nextName("invoice"));
    const message = makeSignedMessage(sender, "invoice.issue", payload);
    const envelope = {
      ...message.envelope,
      signature: signEnvelope(message.envelope, wrongKey.privateKey, "wrong-key"),
    };

    const result = processIncomingMessage({ envelope, payload });
    const rejection = responsePayload(result.responsePayload);

    assert.equal(result.accepted, false);
    assert.equal(result.responseType, "invoice.reject");
    assert.equal(rejection.data.reason_code, "invalid_signature");
    assert.equal(rejection.data.retryable, false);
  });

  it("rejects payload hash mismatches after transport validation", () => {
    const sender = registerSender(["invoice.issue"]);
    const original = makeInvoiceIssuePayload(nextName("invoice"));
    const changed = makeInvoiceIssuePayload(original.meta.invoice_id);
    changed.data.total = 1101;
    const message = makeSignedMessage(sender, "invoice.issue", original);

    const result = processIncomingMessage({
      envelope: message.envelope,
      payload: changed,
    });

    assert.equal(result.accepted, false);
    assert.equal(result.responseType, "invoice.reject");
    assert.equal(result.error, "Payload hash mismatch");
    assert.equal(result.responsePayload, undefined);
  });

  it("rejects invalid invoice.issue payloads at schema validation", () => {
    const sender = registerSender(["invoice.issue"]);
    const invoiceId = nextName("invoice");
    const payload = {
      meta: { invoice_id: invoiceId, currency: "JPY" },
      data: {
        invoice_number: `INV-${invoiceId}`,
        issue_date: "2026-01-01",
      },
    };

    const result = processIncomingMessage(
      makeSignedMessage(sender, "invoice.issue", payload)
    );
    const rejection = responsePayload(result.responsePayload);

    assert.equal(result.accepted, false);
    assert.equal(result.responseType, "invoice.reject");
    assert.equal(rejection.meta.invoice_id, invoiceId);
    assert.equal(rejection.data.reason_code, "invalid_schema");
    assert.equal(rejection.data.retryable, true);
    assert.match(String(result.error), /required property/);
    assert.equal(getInvoiceState(invoiceId), null);
  });

  it("rejects registered message types that have no payload schema", () => {
    const sender = registerSender(["system.ping"]);
    const payload = { meta: { invoice_id: nextName("invoice"), currency: "JPY" } };

    const result = processIncomingMessage(
      makeSignedMessage(sender, "system.ping", payload)
    );
    const rejection = responsePayload(result.responsePayload);

    assert.equal(result.accepted, false);
    assert.equal(result.responseType, "invoice.reject");
    assert.equal(rejection.data.reason_code, "invalid_schema");
    assert.match(String(rejection.data.reason_message), /No schema registered/);
  });

  it("requests a fix when business validation finds fixable issues", () => {
    const sender = registerSender(["invoice.issue"]);
    const invoiceId = nextName("invoice");
    const payload = makeInvoiceIssuePayload(invoiceId);
    payload.data.due_date = payload.data.issue_date;

    const result = processIncomingMessage(
      makeSignedMessage(sender, "invoice.issue", payload)
    );
    const requestFix = responsePayload(result.responsePayload);
    const state = getInvoiceState(invoiceId);

    assert.equal(result.accepted, false);
    assert.equal(result.responseType, "invoice.request_fix");
    assert.ok(issueCodes(requestFix.data.issues).includes("invalid_due_date"));
    assert.equal(state?.current_state, "fix_requested");
    assert.equal(getAuditLog(invoiceId).at(-1)?.event_type, "invoice.request_fix");
  });

  it("accepts valid invoice.issue payloads through all validation layers", () => {
    const sender = registerSender(["invoice.issue"]);
    const invoiceId = nextName("invoice");
    const payload = makeInvoiceIssuePayload(invoiceId);

    const result = processIncomingMessage(
      makeSignedMessage(sender, "invoice.issue", payload)
    );
    const accepted = responsePayload(result.responsePayload);
    const state = getInvoiceState(invoiceId);

    assert.equal(result.accepted, true);
    assert.equal(result.responseType, "invoice.accept");
    assert.equal(accepted.meta.invoice_id, invoiceId);
    assert.equal(accepted.data.accepted_by_agent, RECEIVER);
    assert.equal(accepted.data.payment_status, "scheduled");
    assert.equal(state?.current_state, "accepted");
    assert.equal(getAuditLog(invoiceId).at(-1)?.event_type, "invoice.accepted");
  });

  it("rejects duplicate invoice.issue messages after an invoice is accepted", () => {
    const sender = registerSender(["invoice.issue"]);
    const invoiceId = nextName("invoice");
    const first = makeInvoiceIssuePayload(invoiceId);
    const second = makeInvoiceIssuePayload(invoiceId);

    processIncomingMessage(makeSignedMessage(sender, "invoice.issue", first));
    const result = processIncomingMessage(
      makeSignedMessage(sender, "invoice.issue", second)
    );
    const rejection = responsePayload(result.responsePayload);

    assert.equal(result.accepted, false);
    assert.equal(result.responseType, "invoice.reject");
    assert.equal(rejection.data.reason_code, "duplicate_invoice");
    assert.equal(rejection.data.retryable, false);
    assert.equal(getInvoiceState(invoiceId)?.current_state, "accepted");
  });

  it("allows a corrected invoice.issue when the invoice is in fix_requested", () => {
    const sender = registerSender(["invoice.issue"]);
    const invoiceId = nextName("invoice");
    setInvoiceState(invoiceId, "fix_requested", "seed-message", {
      seller_org_id: ORG,
      buyer_org_id: ORG,
      total_amount: 1100,
      currency: "JPY",
    });

    const result = processIncomingMessage(
      makeSignedMessage(sender, "invoice.issue", makeInvoiceIssuePayload(invoiceId))
    );

    assert.equal(result.accepted, true);
    assert.equal(result.responseType, "invoice.accept");
    assert.equal(getInvoiceState(invoiceId)?.current_state, "accepted");
  });

  it("applies state transitions for non-issue messages after validation", () => {
    const sender = registerSender(["payment.schedule"]);
    const invoiceId = nextName("invoice");
    setInvoiceState(invoiceId, "accepted", "seed-message", {
      seller_org_id: ORG,
      buyer_org_id: ORG,
      total_amount: 1100,
      currency: "JPY",
    });
    const payload = {
      meta: { invoice_id: invoiceId, currency: "JPY" },
      data: {
        scheduled_payment_date: "2026-02-01",
        amount_scheduled: 1100,
      },
    };

    const result = processIncomingMessage(
      makeSignedMessage(sender, "payment.schedule", payload)
    );

    assert.equal(result.accepted, true);
    assert.equal(result.responseType, "invoice.ack");
    assert.equal(getInvoiceState(invoiceId)?.current_state, "scheduled_for_payment");
    assert.equal(getAuditLog(invoiceId).at(-1)?.event_type, "payment.schedule");
  });

  it("rejects duplicate idempotency keys before validation", () => {
    const sender = registerSender(["invoice.issue"]);
    const invoiceId = nextName("invoice");
    const message = makeSignedMessage(
      sender,
      "invoice.issue",
      makeInvoiceIssuePayload(invoiceId)
    );

    processIncomingMessage(message);
    const duplicate = processIncomingMessage(message);

    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.responseType, "invoice.reject");
    assert.equal(duplicate.error, "duplicate_message");
    assert.equal(duplicate.responsePayload, undefined);
  });
});

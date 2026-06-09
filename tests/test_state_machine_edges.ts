import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTerminal, transition } from "../src/lib/state/machine";
import type { InvoiceState, MessageType } from "../src/types/protocol";

const ALL_MESSAGES: MessageType[] = [
  "invoice.issue",
  "invoice.ack",
  "invoice.reject",
  "invoice.request_fix",
  "invoice.accept",
  "invoice.cancel",
  "payment.schedule",
  "payment.notice",
  "system.error",
  "system.ping",
];

describe("invoice state machine edge cases", () => {
  it("allows expected payment transitions after acceptance", () => {
    const scheduled = transition("accepted", "payment.schedule");
    const paidDirectly = transition("accepted", "payment.notice");
    const paidFromSchedule = transition("scheduled_for_payment", "payment.notice");

    assert.deepEqual(scheduled, { ok: true, nextState: "scheduled_for_payment" });
    assert.deepEqual(paidDirectly, { ok: true, nextState: "paid" });
    assert.deepEqual(paidFromSchedule, { ok: true, nextState: "paid" });
  });

  it("rejects messages that are not valid from the current state", () => {
    const fromDraft = transition("draft", "invoice.accept");
    const fromAccepted = transition("accepted", "invoice.reject");
    const fromIssued = transition("issued", "system.ping");

    assert.equal(fromDraft.ok, false);
    assert.match(fromDraft.error ?? "", /Transition not allowed/);
    assert.equal(fromDraft.nextState, undefined);
    assert.equal(fromAccepted.ok, false);
    assert.equal(fromIssued.ok, false);
  });

  it("rejects all messages from terminal states", () => {
    const terminalStates: InvoiceState[] = ["paid", "rejected", "cancelled"];

    for (const state of terminalStates) {
      assert.equal(isTerminal(state), true);
      for (const message of ALL_MESSAGES) {
        const result = transition(state, message);
        assert.equal(result.ok, false, `${state} should reject ${message}`);
        assert.equal(result.nextState, undefined);
      }
    }
  });

  it("reports unknown states defensively", () => {
    const unknownState = "archived" as InvoiceState;
    const result = transition(unknownState, "invoice.issue");

    assert.equal(result.ok, false);
    assert.equal(result.error, "Unknown state: archived");
  });

  it("identifies only paid, rejected, and cancelled as terminal", () => {
    const nonTerminalStates: InvoiceState[] = [
      "draft",
      "issued",
      "received",
      "parsed",
      "validated",
      "fix_requested",
      "accepted",
      "scheduled_for_payment",
    ];

    for (const state of nonTerminalStates) {
      assert.equal(isTerminal(state), false, `${state} should not be terminal`);
    }
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, computePayloadHash } from "../src/lib/crypto/signing";

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    const left = { z: { b: 2, a: 1 }, a: [{ d: 4, c: 3 }] };
    const right = { a: [{ c: 3, d: 4 }], z: { a: 1, b: 2 } };

    assert.equal(canonicalJson(left), canonicalJson(right));
    assert.equal(canonicalJson(left), '{"a":[{"c":3,"d":4}],"z":{"a":1,"b":2}}');
  });

  it("includes nested values in payload hashes", () => {
    const base = { task: { input: { prompt: "hello", options: { temperature: 0.1 } } } };
    const changed = { task: { input: { prompt: "hello", options: { temperature: 0.9 } } } };

    assert.notEqual(computePayloadHash(base), computePayloadHash(changed));
  });

  it("keeps JSON array semantics for undefined entries", () => {
    assert.equal(canonicalJson({ values: [1, undefined, 3] }), '{"values":[1,null,3]}');
  });

  it("rejects circular structures", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    assert.throws(() => canonicalJson(circular), /circular structure/);
  });
});

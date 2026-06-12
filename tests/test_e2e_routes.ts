/**
 * E2E Route Invariant Pin Tests (PR3a Step 0)
 *
 * Pins the daemon HTTP behaviors most likely to break when the giant
 * createDaemonApi if-chain is carved into route modules:
 *   - list/:id shadowing order (task / plan / auction / project)
 *   - billing plugin fallthrough (disabled → 404 文言 / enabled → 往復)
 *   - malformed JSON → 500 (NOT 400; outer try/catch swallows SyntaxError)
 *   - auth gating, queue/dequeue 204-on-empty, webhooks DELETE, validation 400s
 *
 * Runs fully offline against freshly spawned daemons. Auction sub-routes that
 * require a connected peer are intentionally out of scope (see design §6).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "child_process";
import { readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

const PORT_NOBILL = 7720;
const PORT_BILL = 7721;
const DATA_NOBILL = "/tmp/agent-p2p-e2e-routes-nobill";
const DATA_BILL = "/tmp/agent-p2p-e2e-routes-bill";
const AGENT_NOBILL = "agent:e2e:routes-nobill";
const AGENT_BILL = "agent:e2e:routes-bill";
const NAMESPACE = "e2e-test-routes";

let procNoBill: ChildProcess;
let procBill: ChildProcess;
let tokenNoBill: string;
let tokenBill: string;

// Returns full {status, body} so status codes (204/401/404/500) can be pinned.
async function req(
  port: number,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  rawBody?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const opts: RequestInit = { method, headers };
  if (rawBody !== undefined) opts.body = rawBody;
  else if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, opts);
  const text = await res.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { _raw: text }; }
  return { status: res.status, body: parsed };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function waitForDaemon(port: number, maxMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`Daemon on port ${port} did not start within ${maxMs}ms`);
}

function startDaemon(agentId: string, port: number, dataDir: string, extraArgs: string[] = []): ChildProcess {
  const proc = spawn(process.execPath, [
    "--import", "tsx",
    "src/daemon/server.ts",
    "--agent-id", agentId,
    "--org-id", "org:e2e",
    "--namespace", NAMESPACE,
    "--data-dir", dataDir,
    "--port", String(port),
    ...extraArgs,
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENT_P2P_PASSPHRASE: "e2e-test" },
  });
  proc.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) process.stderr.write(`[${agentId}] ${line}\n`);
  });
  return proc;
}

describe("E2E Route Invariants (PR3a pin tests)", () => {
  before(async () => {
    for (const d of [DATA_NOBILL, DATA_BILL]) if (existsSync(d)) rmSync(d, { recursive: true });
    procNoBill = startDaemon(AGENT_NOBILL, PORT_NOBILL, DATA_NOBILL);
    procBill = startDaemon(AGENT_BILL, PORT_BILL, DATA_BILL, ["--enable-billing"]);
    await Promise.all([waitForDaemon(PORT_NOBILL), waitForDaemon(PORT_BILL)]);
    tokenNoBill = readFileSync(join(DATA_NOBILL, "api-token"), "utf8").trim();
    tokenBill = readFileSync(join(DATA_BILL, "api-token"), "utf8").trim();
  });

  after(() => {
    procNoBill?.kill("SIGTERM");
    procBill?.kill("SIGTERM");
    for (const d of [DATA_NOBILL, DATA_BILL]) if (existsSync(d)) rmSync(d, { recursive: true });
  });

  // Bound to the no-billing daemon (the common case).
  const A = (method: string, path: string, body?: unknown, rawBody?: string) =>
    req(PORT_NOBILL, tokenNoBill, method, path, body, rawBody);

  // --- Auth gating ---
  it("/health is reachable without auth", async () => {
    const r = await req(PORT_NOBILL, null, "GET", "/health");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "ok");
    assert.equal(r.body.billing_enabled, false);
  });

  it("protected route without token → 401", async () => {
    const r = await req(PORT_NOBILL, null, "GET", "/info");
    assert.equal(r.status, 401);
  });

  // --- Shadowing group 1: /task/list must not be eaten by /task/:id ---
  it("/task/list resolves to list handler", async () => {
    const r = await A("GET", "/task/list");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.tasks));
  });
  it("/task/:id unknown → 404 Task not found", async () => {
    const r = await A("GET", "/task/does-not-exist");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "Task not found");
  });

  // --- Shadowing group 2: /plan/list vs /plan/:id ---
  it("/plan/list resolves to list handler", async () => {
    const r = await A("GET", "/plan/list");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.plans));
  });
  it("/plan/:id unknown → 404 Plan not found", async () => {
    const r = await A("GET", "/plan/does-not-exist");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "Plan not found");
  });

  // --- Shadowing group 3: /auction/list vs /auction/:id ---
  it("/auction/list resolves to list handler", async () => {
    const r = await A("GET", "/auction/list");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.auctions));
  });
  it("/auction/:id unknown → 404", async () => {
    const r = await A("GET", "/auction/does-not-exist");
    assert.equal(r.status, 404);
  });

  // --- Shadowing group 4: /project/list & /project/distribute vs /project/:id ---
  it("/project/list resolves to list handler", async () => {
    const r = await A("GET", "/project/list");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.projects));
  });
  it("/project/distribute without project_id → 400 (not :id catch-all)", async () => {
    const r = await A("GET", "/project/distribute");
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "project_id required");
  });
  it("/project/:id unknown → 404 Not found", async () => {
    const r = await A("GET", "/project/does-not-exist");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "Not found");
  });

  // --- Billing fallthrough: disabled → 404 with exact message ---
  it("billing disabled: /audit → 404 disabled message", async () => {
    const r = await A("GET", "/audit");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "Billing plugin is disabled");
  });
  it("billing disabled: /invoices → 404 disabled message", async () => {
    const r = await A("GET", "/invoices");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "Billing plugin is disabled");
  });
  it("billing disabled: /invoices/<id> → 404 disabled message", async () => {
    const r = await A("GET", "/invoices/whatever");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "Billing plugin is disabled");
  });

  // --- Billing fallthrough: enabled → request flows through to handler ---
  it("billing enabled: GET /invoices → 200 list", async () => {
    const r = await req(PORT_BILL, tokenBill, "GET", "/invoices");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  // --- Malformed JSON → 500 (NOT 400) ---
  it("malformed JSON body → 500", async () => {
    const r = await A("POST", "/reputation/policy", undefined, "{not valid json");
    assert.equal(r.status, 500);
  });

  // --- Queue endpoints incl. 204-on-empty dequeue (runs before any enqueue) ---
  it("dequeue on empty queue → 204", async () => {
    const r = await A("POST", "/queue/dequeue", {});
    assert.equal(r.status, 204);
  });
  it("enqueue → 200 and queue length reflects it", async () => {
    const enq = await A("POST", "/queue/enqueue", { type: "generic", description: "pin", input: {} });
    assert.equal(enq.status, 200);
    const q = await A("GET", "/queue");
    assert.equal(q.status, 200);
    assert.ok(q.body.length >= 1);
    assert.ok(Array.isArray(q.body.tasks));
  });

  // --- peers/config GET + POST ---
  it("GET /peers/config → 200 peers array", async () => {
    const r = await A("GET", "/peers/config");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.peers));
  });
  it("POST /peers/config → 200", async () => {
    const r = await A("POST", "/peers/config", { agent_id: "agent:e2e:peer", mode: "restricted" });
    assert.equal(r.status, 200);
  });

  // --- heartbeat ---
  it("GET /heartbeat → 200 with status string", async () => {
    const r = await A("GET", "/heartbeat");
    assert.equal(r.status, 200);
    assert.ok(typeof r.body.status === "string");
  });

  // --- invite/pending ---
  it("GET /invite/pending → 200 invites array", async () => {
    const r = await A("GET", "/invite/pending");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.invites));
  });

  // --- policy GET ---
  it("GET /policy → 200", async () => {
    const r = await A("GET", "/policy");
    assert.equal(r.status, 200);
  });

  // --- webhooks lifecycle: create → list → delete (+ 404 on unknown) ---
  it("webhooks create→list→delete, unknown delete → 404", async () => {
    const created = await A("POST", "/webhooks", { url: "http://example.com/hook", events: ["task"] });
    assert.equal(created.status, 200);
    assert.ok(created.body.id);

    const list = await A("GET", "/webhooks");
    assert.equal(list.status, 200);
    assert.ok(list.body.webhooks.some((w: any) => w.id === created.body.id));

    const delUnknown = await A("DELETE", "/webhooks/wh_nonexistent");
    assert.equal(delUnknown.status, 404);
    assert.equal(delUnknown.body.error, "Webhook not found");

    const del = await A("DELETE", `/webhooks/${created.body.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.deleted, created.body.id);
  });

  // --- Validation 400s (network-free early returns) ---
  it("POST /webhooks missing fields → 400", async () => {
    const r = await A("POST", "/webhooks", { url: "http://x" });
    assert.equal(r.status, 400);
  });
  it("POST /pumpfun/launch missing fields → 400", async () => {
    const r = await A("POST", "/pumpfun/launch", { name: "X" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "name, symbol, and description required");
  });
  it("POST /auction/create missing fields → 400", async () => {
    const r = await A("POST", "/auction/create", {});
    assert.equal(r.status, 400);
    assert.ok(/Missing required fields/.test(r.body.error));
  });
});

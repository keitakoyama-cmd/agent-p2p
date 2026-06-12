#!/usr/bin/env node

/**
 * P2P Agent Daemon — long-running process independent of Claude Code sessions.
 *
 * Responsibilities:
 *   - Maintains Hyperswarm P2P connections
 *   - Manages agent state and message flows
 *   - Queues outbound messages for offline peers
 *   - Retries delivery on reconnection
 *   - Exposes a local HTTP API on localhost for MCP server to connect to
 *
 * Lifecycle:
 *   - Started via systemd or manually
 *   - Persists state to disk
 *   - Survives Claude Code session restarts
 *
 * Usage:
 *   node dist/daemon/server.js \
 *     --agent-id agent:mindaxis:worker-a \
 *     --org-id org:mindaxis \
 *     --namespace marketplace-2026 \
 *     --data-dir ~/.agent-p2p/worker-a \
 *     --port 7700
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { join } from "path";
import { P2PAgent } from "../agent/core";
import { BillingPlugin } from "../agent/billing";
import { DiscoveryClient, type ConnectionRequest } from "../lib/discovery/client";
import { InviteManager, type InviteConnectionEvent } from "../lib/invite/manager";
import { AuctionManager } from "../lib/marketplace/auction";
import { TaskManager } from "../lib/task/manager";
import { TaskPlanner, type PlanCompleted, type PlanStepEnqueued } from "../lib/task/planner";
import { ReputationManager, type ReputationModeSuggestion } from "../lib/reputation/manager";
import { ExecutionVerifier } from "../lib/verification/prover";
import { EconomicManager, type TransferEvent } from "../lib/economic/wallet";
import type {
  PeerConnection,
  SwarmPayloadEvent,
  SwarmTaskEvent,
  SwarmTaskPollEvent,
  SwarmTaskPollResponseEvent,
} from "../lib/p2p/swarm";
import { ProfileManager } from "../lib/matching/profile";
import { WorkspaceIntrospector } from "../lib/matching/introspect";
import { TaskPolicyManager } from "../lib/security/policy";
import { SolanaClient } from "../lib/chain/solana";
import { PumpFunClient } from "../lib/chain/pumpfun";
import { ProjectManager, type Project, type ProjectInvestmentEvent } from "../lib/project/manager";
import { checkBearerAuth, json, loadOrCreateApiToken } from "./http-util";
import { loadEconomicState, saveEconomicState } from "./economic-state";
import { handleAuction } from "./routes/auction";
import { handleBilling } from "./routes/billing";
import { handleCore } from "./routes/core";
import { addDiscoveryRoutes } from "./routes/discovery";
import { handleEconomic } from "./routes/economic";
import { handleInvite } from "./routes/invite";
import { handleMessaging } from "./routes/messaging";
import { handlePeers } from "./routes/peers";
import { handlePolicy } from "./routes/policy";
import { handleProfile } from "./routes/profile";
import { handleProject } from "./routes/project";
import { handlePumpfun } from "./routes/pumpfun";
import { handleReputation } from "./routes/reputation";
import { handleSolana } from "./routes/solana";
import { handleTasks } from "./routes/tasks";
import { handleVerification } from "./routes/verification";
import { handleWebhooks } from "./routes/webhooks";
import type { DaemonContext, RequestContext } from "./context";
import type {
  AgentId,
  EscrowRecord,
  Heartbeat,
  LedgerEntry,
  OrgId,
  SignedMessage,
  TaskAccept,
  TaskAward,
  TaskBid,
  TaskBroadcast,
  TaskCancel,
  TaskError,
  TaskReject,
  TaskRequest,
  TaskResult,
} from "../types/protocol";

// --- Parse CLI args ---

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string): string => {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length) {
      if (fallback !== undefined) return fallback;
      console.error(`Missing required argument: ${flag}`);
      process.exit(1);
    }
    return args[idx + 1];
  };
  const has = (flag: string): boolean => args.includes(flag);

  return {
    agentId: get("--agent-id") as AgentId,
    orgId: get("--org-id") as OrgId,
    namespace: get("--namespace"),
    dataDir: get("--data-dir"),
    port: parseInt(get("--port", "7700"), 10),
    discoveryUrl: get("--discovery-url", ""),
    description: get("--description", ""),
    enableBilling: has("--enable-billing"),
    solanaNetwork: get("--solana-network", "devnet") as "devnet" | "mainnet-beta",
    solanaRpcUrl: get("--solana-rpc-url", ""),
  };
}

function createDaemonApi(ctx: DaemonContext) {
  const {
    agent, port, apiToken, billing,
  } = ctx;
  const server = createServer(async (req, res) => {
    // Only accept from localhost
    const remoteAddr = req.socket.remoteAddress;
    if (remoteAddr !== "127.0.0.1" && remoteAddr !== "::1" && remoteAddr !== "::ffff:127.0.0.1") {
      json(res, 403, { error: "Daemon API is localhost-only" });
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;
    const rc: RequestContext = { req, res, url, path };

    // Allow /health without auth (for monitoring)
    if (req.method === "GET" && path === "/health") {
      json(res, 200, {
        status: "ok",
        agent_id: agent.getAgentInfo().agent_id,
        uptime: process.uptime(),
        billing_enabled: billing !== null,
      });
      return;
    }

    // Require Bearer token for all other endpoints
    if (!checkBearerAuth(req, apiToken)) {
      json(res, 401, { error: "Unauthorized — include Authorization: Bearer <token> header" });
      return;
    }

    try {
      // --- Routes ---

      if (await handleCore(ctx, rc)) return;

      if (await handleBilling(ctx, rc)) return;

      if (await handleMessaging(ctx, rc)) return;

      if (await handleInvite(ctx, rc)) return;

      if (await handleTasks(ctx, rc)) return;

      if (await handlePeers(ctx, rc)) return;

      // ============================================================
      // Reputation routes
      // ============================================================

      if (await handleReputation(ctx, rc)) return;

      // ============================================================
      // Execution Verification routes
      // ============================================================

      if (await handleVerification(ctx, rc)) return;

      // ============================================================
      // Economic routes
      // ============================================================

      if (await handleEconomic(ctx, rc)) return;

      if (await handleSolana(ctx, rc)) return;

      // ============================================================
      // Project (Virtual Company) routes
      // ============================================================

      if (await handleProject(ctx, rc)) return;

      // ============================================================
      // Webhook routes
      // ============================================================

      if (await handleWebhooks(ctx, rc)) return;

      if (await handlePumpfun(ctx, rc)) return;

      // ============================================================
      // Security Policy routes
      // ============================================================

      if (await handlePolicy(ctx, rc)) return;

      // ============================================================
      // Profile & Matching routes
      // ============================================================

      if (await handleProfile(ctx, rc)) return;

      // ============================================================
      // Auction routes
      // ============================================================

      if (await handleAuction(ctx, rc)) return;

      json(res, 404, { error: "Not found" });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.error(`[Daemon] API listening on http://127.0.0.1:${port}`);
  });

  return server;
}

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

// --- Main ---

async function main() {
  const config = parseArgs();

  console.error(`[Daemon] Starting agent: ${config.agentId}`);
  console.error(`[Daemon] Data dir: ${config.dataDir}`);
  console.error(`[Daemon] Namespace: ${config.namespace}`);

  const agent = new P2PAgent({
    agentId: config.agentId,
    orgId: config.orgId,
    namespace: config.namespace,
    dataDir: config.dataDir,
  });

  await agent.start();
  const billing = config.enableBilling ? new BillingPlugin(agent) : null;
  billing?.start();
  const inviteManager = new InviteManager(config.agentId);
  const taskManager = new TaskManager(config.agentId, ["generic", "code_review", "run_tests", "transform"], 5);
  const reputation = new ReputationManager();
  const verifier = new ExecutionVerifier();
  const economic = new EconomicManager(config.agentId);
  loadEconomicState(config.dataDir, economic);
  const profileManager = new ProfileManager(config.agentId, reputation);

  // Auto-detect skills from workspace
  const detectedSkills = WorkspaceIntrospector.scanDirectory(process.cwd());
  if (detectedSkills.length > 0) {
    profileManager.updateSkills(detectedSkills);
    console.error(`[Profile] Auto-detected ${detectedSkills.length} skills: ${detectedSkills.map(s => s.skill).join(", ")}`);
  }

  const auction = new AuctionManager({
    agentId: config.agentId,
    reputation,
    economic,
    verifier,
    profileManager,
  });
  const auctionOrigins = new Map<string, AgentId>();
  const taskPolicy = new TaskPolicyManager(config.agentId);

  // --- Solana on-chain setup ---
  const solana = new SolanaClient({
    network: config.solanaNetwork,
    rpcUrl: config.solanaRpcUrl || undefined,
  });
  // Derive Solana keypair from agent's Ed25519 private key (same key type)
  const solanaKeypair = solana.keypairFromPrivateKey(agent.getPrivateKey());
  console.error(`[Solana] Network: ${config.solanaNetwork}`);
  console.error(`[Solana] Wallet: ${solanaKeypair.publicKey.toBase58()}`);
  console.error(`[Solana] Explorer: ${solana.explorerUrl("address", solanaKeypair.publicKey.toBase58())}`);

  // --- Pump.fun setup ---
  // --- Project Manager setup ---
  const projectManager = new ProjectManager();

  // --- Webhook system ---
  const webhooks: Array<{ id: string; url: string; events: string[]; created_at: string }> = [];
  async function fireWebhook(event: string, data: unknown) {
    for (const wh of webhooks) {
      if (wh.events.includes(event) || wh.events.includes("*")) {
        try {
          await fetch(wh.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event, data, timestamp: new Date().toISOString() }),
          });
        } catch (err) {
          console.error(`[Webhook] Failed to notify ${wh.url}: ${(err as Error).message}`);
        }
      }
    }
  }

  const pumpfun = new PumpFunClient({
    rpcUrl: config.solanaRpcUrl || undefined,
  });

  // Auto-set default peer config when a peer connects (if not already set via invite)
  agent.getSwarm().on("peer:identified", (peer: PeerConnection) => {
    if (peer.agentId && !taskManager.getPeerConfig(peer.agentId)) {
      taskManager.setPeerConfig(peer.agentId, "restricted");
      console.error(`[Daemon] Auto-configured peer ${peer.agentId} as restricted`);
    }
  });

  // Wire up P2P task/heartbeat events to task manager
  agent.getSwarm().on("task", (event: SwarmTaskEvent) => {
    // Swarm only re-emits task messages from verified peers, so the sender ID is asserted once here.
    const from = event.from as AgentId;
    const { type, payload } = event;
    console.error(`[Task] ${type} from ${from}: ${(payload as { task_id?: string }).task_id || ""}`);
    if (type === "task_broadcast") {
      const broadcast = payload as TaskBroadcast;
      // Security scan broadcast before registering
      const broadcastScan = taskPolicy.checkTask(from, {
        task_id: broadcast.task_id,
        type: broadcast.type,
        description: broadcast.description,
        input: broadcast.input,
      });
      if (!broadcastScan.allowed) {
        console.error(`[Security] BLOCKED broadcast ${broadcast.task_id} from ${from}: ${broadcastScan.reason}`);
        return;
      }
      auction.registerBroadcast(broadcast);
      auctionOrigins.set(broadcast.task_id, from);
    } else if (type === "task_bid") {
      const bidPayload = payload as {
        task_id: string;
        price: TaskBid["price"];
        estimated_duration_ms: number;
        reputation_score?: number;
        message?: string;
        capabilities?: string[];
      };

      if ((auctionOrigins.get(bidPayload.task_id) ?? config.agentId) !== config.agentId) {
        console.error(`[Auction] Ignored bid for non-local auction ${bidPayload.task_id} from ${from}`);
        return;
      }

      const result = auction.submitBid(bidPayload.task_id, {
        task_id: bidPayload.task_id,
        bidder: from,
        price: bidPayload.price,
        estimated_duration_ms: bidPayload.estimated_duration_ms,
        reputation_score: bidPayload.reputation_score ?? reputation.getScore(from),
        message: bidPayload.message,
        capabilities: bidPayload.capabilities ?? [],
      });

      if (!result.success) {
        console.error(`[Auction] Rejected bid for ${bidPayload.task_id} from ${from}: ${result.error}`);
      }
    } else if (type === "task_award") {
      const award = payload as TaskAward;
      const updated = auction.applyAward(award);
      if (!updated) {
        console.error(`[Auction] Ignored award for unknown task ${award.task_id}`);
      }
    } else if (type === "task_request") {
      const request = payload as TaskRequest;
      const perm = taskManager.checkPermission(from, "task", "send");
      if (!perm.allowed) {
        agent.getSwarm().sendTaskMessage(from, "task_reject", { task_id: request.task_id, reason: "Not permitted" });
        return;
      }
      // Security scan before accepting
      const scanResult = taskPolicy.checkTask(from, request);
      if (!scanResult.allowed) {
        console.error(`[Security] BLOCKED task ${request.task_id} from ${from}: ${scanResult.reason}`);
        agent.getSwarm().sendTaskMessage(from, "task_reject", {
          task_id: request.task_id,
          reason: `Security policy violation: ${scanResult.reason}`,
        });
        return;
      }
      if (scanResult.scan_only && scanResult.threats && scanResult.threats.length > 0) {
        console.error(`[Security] AUDIT task ${request.task_id} from ${from}: ${scanResult.threats.map((t) => t.pattern).join(", ")}`);
      }
      // Store incoming task (preserve original task_id)
      const task = taskManager.storeIncoming(from, request);
      if (perm.needsApproval) {
        console.error(`[Task] Task ${task.task_id} needs approval`);
        taskManager.emit("task:approval_needed", task);
        fireWebhook("task:received", { task_id: task.task_id, from, type: request.type, description: request.description, needs_approval: true });
      } else {
        taskManager.updateTaskStatus(task.task_id, "accepted");
        agent.getSwarm().sendTaskMessage(from, "task_accept", { task_id: task.task_id });
        taskManager.emit("task:auto_accepted", task);
        fireWebhook("task:received", { task_id: task.task_id, from, type: request.type, description: request.description });
      }
    } else if (type === "task_accept") {
      taskManager.updateTaskStatus((payload as TaskAccept).task_id, "accepted");
    } else if (type === "task_reject") {
      taskManager.updateTaskStatus((payload as TaskReject).task_id, "cancelled");
    } else if (type === "task_result") {
      const result = payload as TaskResult;
      const task = taskManager.getTask(result.task_id);
      taskManager.updateTaskStatus(result.task_id, result.status === "completed" ? "completed" : "failed", result);
      // Update reputation based on task outcome
      if (task) {
        const responseMs = task.updated_at - task.created_at;
        const executionMs = result.duration_ms || 0;
        if (result.status === "completed") {
          reputation.recordTaskCompleted(from, responseMs, executionMs);
        } else {
          reputation.recordTaskFailed(from);
        }
      }
    } else if (type === "task_error") {
      taskManager.updateTaskStatus((payload as TaskError).task_id, "failed");
      reputation.recordTaskFailed(from);
    } else if (type === "task_cancel") {
      taskManager.updateTaskStatus((payload as TaskCancel).task_id, "cancelled");
      reputation.recordTaskCancelled(from);
    }
  });

  // Wire webhooks to events
  projectManager.on("project:created", (p: Project) => fireWebhook("project:created", p));
  projectManager.on("project:funded", (p: Project) => fireWebhook("project:funded", p));
  projectManager.on("project:completed", (p: Project) => fireWebhook("project:completed", p));
  projectManager.on("project:investment", (d: ProjectInvestmentEvent) => fireWebhook("project:investment", d));
  economic.on("transfer:completed", (d: TransferEvent) => fireWebhook("transfer:completed", d));
  economic.on("transfer:received", (d: TransferEvent) => fireWebhook("transfer:received", d));
  economic.on("escrow:locked", (d: EscrowRecord) => fireWebhook("escrow:locked", d));
  economic.on("escrow:released", (d: EscrowRecord) => fireWebhook("escrow:released", d));

  // Handle incoming P2P project broadcasts
  agent.getSwarm().on("project_broadcast", ({ from, payload }: SwarmPayloadEvent) => {
    // Wire payload mirrors ProjectManager.toBroadcast(), which returns Record<string, unknown>.
    const broadcast = payload as Record<string, unknown>;
    console.error(`[Project] Received broadcast from ${from}: ${broadcast.name} (${broadcast.project_id})`);
    fireWebhook("project:broadcast", { from, ...broadcast });
  });

  // Handle incoming P2P token transfers
  agent.getSwarm().on("token_transfer", ({ from, payload }: SwarmPayloadEvent) => {
    // Shape matches the "token_transfer" send site in routes/economic.ts (/token/transfer).
    const transfer = payload as {
      from: AgentId;
      to: AgentId;
      token_id: string;
      amount: number;
      ledger_entry?: LedgerEntry;
    };
    console.error(`[Economic] Received token transfer from ${from}: ${transfer.amount} of ${transfer.token_id}`);
    // Verify the transfer is addressed to us
    if (transfer.to !== config.agentId) {
      console.error(`[Economic] Ignoring transfer not addressed to us (to: ${transfer.to})`);
      return;
    }
    // Credit our wallet with the received tokens
    // First, ensure token is registered locally (as external reference)
    if (!economic.getToken(transfer.token_id)) {
      economic.registerExternalToken(
        transfer.token_id,
        transfer.token_id, // name = id as fallback
        transfer.token_id.split(":").pop()?.split("-")[0] || "???",
        18,
        "custom"
      );
    }
    // Credit via the receive method
    economic.receiveTransfer(transfer.from, transfer.token_id, transfer.amount, transfer.ledger_entry);
    saveEconomicState(config.dataDir, economic);
    console.error(`[Economic] Credited ${transfer.amount} of ${transfer.token_id} from ${from}`);
  });

  agent.getSwarm().on("heartbeat", ({ from, payload }: SwarmPayloadEvent) => {
    // Heartbeats are built as Heartbeat on the sender side (TaskManager.startHeartbeat).
    const hb = payload as Heartbeat;
    taskManager.emit("heartbeat:received", { from, ...hb });
    // Cache peer profile from heartbeat
    if (hb.profile) {
      profileManager.updatePeerProfile(hb.profile);
    }
  });

  // Handle task_poll from workers: dequeue a task and send it
  agent.getSwarm().on("task_poll", ({ from, capabilities }: SwarmTaskPollEvent) => {
    // Senders (routes/tasks.ts /worker/start) poll with { capabilities: string[] }.
    const task = taskManager.dequeue(from as AgentId, capabilities as string[] | undefined);
    agent.getSwarm().sendTaskMessage(from as AgentId, "task_poll_response", task || null);
  });

  // Handle task_poll_response (we're the worker, received a task)
  agent.getSwarm().on("task_poll_response", ({ from, task }: SwarmTaskPollResponseEvent) => {
    if (task) {
      taskManager.emit("worker:task_received", { from, task });
    }
  });

  // Auto-adjust peer permissions based on reputation
  reputation.on("reputation:mode_suggestion", ({ agent_id, score, suggested_mode, reason }: ReputationModeSuggestion) => {
    const current = taskManager.getPeerConfig(agent_id);
    if (current && current.mode !== suggested_mode) {
      console.error(`[Reputation] ${agent_id} score=${score.toFixed(3)}: ${reason} → adjusting to ${suggested_mode}`);
      taskManager.setPeerConfig(agent_id, suggested_mode);
    }
  });

  // Start heartbeat + task queue poll every 30s (attach profile for skill matching)
  taskManager.startHeartbeat(30_000, (hb: Heartbeat) => {
    hb.profile = profileManager.getLocalProfile();
    agent.getSwarm().broadcastHeartbeat(hb);
  });

  // Auto-set peer config on invite success — each side sets its own mode
  inviteManager.on("invite:accepted", ({ code, peerAgentId, peerMode, myMode, sharedNamespace }: InviteConnectionEvent) => {
    console.error(`[Invite] Peer ${peerAgentId} connected via ${code} (my mode: ${myMode}, peer mode: ${peerMode})`);
    if (sharedNamespace) {
      agent.joinNamespace(sharedNamespace);
      console.error(`[Invite] Joined shared namespace: ${sharedNamespace.slice(0, 16)}...`);
    }
    // Set what THIS peer is allowed to do on OUR side (their mode toward us).
    // peerAgentId is the peer's self-reported ID from the invite handshake; trusted as AgentId.
    taskManager.setPeerConfig(peerAgentId as AgentId, peerMode || "restricted", sharedNamespace);
  });
  inviteManager.on("invite:connected", ({ code, peerAgentId, peerMode, myMode, sharedNamespace }: InviteConnectionEvent) => {
    console.error(`[Invite] Connected to ${peerAgentId} via ${code} (my mode: ${myMode}, peer mode: ${peerMode})`);
    if (sharedNamespace) {
      agent.joinNamespace(sharedNamespace);
      console.error(`[Invite] Joined shared namespace: ${sharedNamespace.slice(0, 16)}...`);
    }
    // Set what THIS peer is allowed to do on OUR side (their mode toward us)
    taskManager.setPeerConfig(peerAgentId as AgentId, peerMode || "restricted", sharedNamespace);
  });

  // Load or create API auth token
  const apiToken = loadOrCreateApiToken(config.dataDir);
  console.error(`[Daemon] Auth token file: ${join(config.dataDir, "api-token")}`);

  const planner = new TaskPlanner(taskManager);

  planner.on("step:enqueued", ({ planId, stepId, taskId }: PlanStepEnqueued) => {
    console.error(`[Plan] ${planId} step ${stepId} enqueued as ${taskId}`);
  });
  planner.on("plan:completed", ({ planId, status }: PlanCompleted) => {
    console.error(`[Plan] ${planId} ${status}`);
  });

  const httpServer = createDaemonApi({
    agent,
    port: config.port,
    inviteManager,
    apiToken,
    taskManager,
    planner,
    reputation,
    verifier,
    economic,
    auction,
    auctionOrigins,
    billing,
    profileManager,
    taskPolicy,
    dataDir: config.dataDir,
    solana,
    solanaKeypair,
    pumpfun,
    projectManager,
    webhooks,
  });

  // Discovery site integration
  let discovery: DiscoveryClient | null = null;
  const pendingRequests: ConnectionRequest[] = [];

  if (config.discoveryUrl) {
    const agentInfo = agent.getAgentInfo();
    discovery = new DiscoveryClient({
      discoveryUrl: config.discoveryUrl,
      agentId: config.agentId,
      orgId: config.orgId,
      publicKey: agentInfo.public_key,
      privateKey: agent.getPrivateKey(),
      capabilities: ["data.transfer", "task.execute", "task.bid", "file.send"],
      description: config.description,
    });

    // Register as public
    try {
      await discovery.register();
      console.error(`[Discovery] Registered as public on ${config.discoveryUrl}`);
    } catch (err) {
      console.error(`[Discovery] Registration failed: ${(err as Error).message}`);
    }

    // Poll every 60s for connection requests
    discovery.startPolling(60_000, (req) => {
      pendingRequests.push(req);
      console.error(`[Discovery] New connection request from ${req.from_name || req.from_agent_id || 'anonymous'}: ${req.message || '(no message)'}`);
    });

    // Add discovery routes to the HTTP server
    const { handleDiscoveryRoute } = addDiscoveryRoutes(agent, discovery, pendingRequests, inviteManager);
    const originalListeners = httpServer.listeners('request') as RequestListener[];
    httpServer.removeAllListeners('request');
    httpServer.on('request', async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://localhost:${config.port}`);
      if (url.pathname.startsWith('/discovery/')) {
        const handled = await handleDiscoveryRoute(req, res, url.pathname);
        if (handled) return;
      }
      // Fall through to original handler
      for (const listener of originalListeners) {
        listener(req, res);
      }
    });
  }

  // Fallback: /discovery/agents works even without --discovery-url
  if (!discovery) {
    const originalListeners2 = httpServer.listeners('request') as RequestListener[];
    httpServer.removeAllListeners('request');
    httpServer.on('request', async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://localhost:${config.port}`);
      if (req.method === "GET" && url.pathname === "/discovery/agents") {
        // Check auth
        if (!checkBearerAuth(req, apiToken)) {
          json(res, 401, { error: "Unauthorized" });
          return;
        }
        try {
          const resp = await fetch("https://agent-p2p-discovery.pages.dev/api/agents");
          const data = await resp.json();
          json(res, 200, data);
        } catch (err) {
          json(res, 502, { error: `Discovery fetch failed: ${(err as Error).message}` });
        }
        return;
      }
      for (const listener of originalListeners2) listener(req, res);
    });
  }

  // Log new inbox messages
  agent.on("inbox:new", (msg: SignedMessage) => {
    console.error(
      `[Daemon] New message: ${msg.envelope.message_type} from ${msg.envelope.from}`
    );
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.error("[Daemon] Shutting down...");
    saveEconomicState(config.dataDir, economic);
    discovery?.stopPolling();
    planner.destroy();
    taskManager.destroy();
    auction.destroy();
    reputation.destroy();
    verifier.destroy();
    economic.destroy();
    billing?.stop();
    await inviteManager.destroy();
    httpServer.close();
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[Daemon] Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

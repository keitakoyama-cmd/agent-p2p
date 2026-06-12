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
import { InviteManager, type InviteResult } from "../lib/invite/manager";
import { AuctionManager } from "../lib/marketplace/auction";
import { TaskManager } from "../lib/task/manager";
import { TaskPlanner } from "../lib/task/planner";
import { ReputationManager } from "../lib/reputation/manager";
import { ExecutionVerifier } from "../lib/verification/prover";
import { EconomicManager } from "../lib/economic/wallet";
import { ProfileManager } from "../lib/matching/profile";
import { WorkspaceIntrospector } from "../lib/matching/introspect";
import { TaskPolicyManager } from "../lib/security/policy";
import { SolanaClient } from "../lib/chain/solana";
import { PumpFunClient } from "../lib/chain/pumpfun";
import { ProjectManager } from "../lib/project/manager";
import { checkBearerAuth, json, loadOrCreateApiToken, readBody } from "./http-util";
import { loadEconomicState, saveEconomicState } from "./economic-state";
import { getSigningKey } from "./signing";
import { handleAuction } from "./routes/auction";
import { handleCore } from "./routes/core";
import { handleEconomic } from "./routes/economic";
import { handleInvite } from "./routes/invite";
import { handleMessaging } from "./routes/messaging";
import { handlePeers } from "./routes/peers";
import { handlePolicy } from "./routes/policy";
import { handleProfile } from "./routes/profile";
import { handleProject } from "./routes/project";
import { handleReputation } from "./routes/reputation";
import { handleTasks } from "./routes/tasks";
import { handleVerification } from "./routes/verification";
import { handleWebhooks } from "./routes/webhooks";
import type { DaemonContext, RequestContext } from "./context";
import type {
  AgentId,
  Heartbeat,
  InvoiceIssuePayload,
  OrgId,
  SignedMessage,
  TaskAward,
  TaskBid,
  TaskBroadcast,
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
    agent, port, apiToken, economic, billing, dataDir, solana, solanaKeypair, pumpfun,
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

      // --- Billing (legacy, optional plugin) routes ---

      if (path === "/audit" || path === "/invoices" || path.startsWith("/invoices/")) {
        if (!billing) {
          json(res, 404, { error: "Billing plugin is disabled" });
          return;
        }

        if (req.method === "GET" && path === "/invoices") {
          const invoiceId = url.searchParams.get("invoice_id");
          if (invoiceId) {
            const invoice = billing.getInvoice(invoiceId);
            const audit = billing.getAuditLog(invoiceId);
            json(res, invoice ? 200 : 404, { invoice, audit });
          } else {
            json(res, 200, billing.listInvoices());
          }
          return;
        }

        if (req.method === "POST" && path === "/invoices/issue") {
          const body = JSON.parse(await readBody(req));
          const result = billing.issueInvoice(
            body.target_agent_id as AgentId,
            body.invoice as InvoiceIssuePayload
          );
          json(res, result.success ? 200 : 422, result);
          return;
        }

        if (req.method === "POST" && path === "/invoices/accept") {
          const body = JSON.parse(await readBody(req));
          const result = billing.acceptInvoice(
            body.invoice_id,
            body.scheduled_payment_date
          );
          json(res, result.success ? 200 : 422, result);
          return;
        }

        if (req.method === "POST" && path === "/invoices/reject") {
          const body = JSON.parse(await readBody(req));
          const result = billing.rejectInvoice(
            body.invoice_id,
            body.reason_code,
            body.reason_message
          );
          json(res, result.success ? 200 : 422, result);
          return;
        }

        if (req.method === "GET" && path === "/audit") {
          const invoiceId = url.searchParams.get("invoice_id") ?? undefined;
          json(res, 200, billing.getAuditLog(invoiceId));
          return;
        }
      }

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

      // ============================================================
      // Solana on-chain routes
      // ============================================================

      if (req.method === "GET" && path === "/solana/wallet") {
        const address = solanaKeypair.publicKey.toBase58();
        try {
          const balance = await solana.getSOLBalance(address);
          json(res, 200, {
            address,
            network: solana.getNetwork(),
            sol_balance: balance / 1e9,
            sol_balance_lamports: balance,
            explorer_url: solana.explorerUrl("address", address),
          });
        } catch {
          json(res, 200, {
            address,
            network: solana.getNetwork(),
            sol_balance: 0,
            explorer_url: solana.explorerUrl("address", address),
          });
        }
        return;
      }

      if (req.method === "POST" && path === "/solana/airdrop") {
        try {
          const body = JSON.parse(await readBody(req));
          const amount = body.amount || 1;
          const sig = await solana.airdrop(solanaKeypair.publicKey.toBase58(), amount);
          json(res, 200, {
            success: true,
            amount,
            tx_signature: sig,
            explorer_url: solana.explorerUrl("tx", sig),
          });
        } catch (err) {
          json(res, 422, { success: false, error: (err as Error).message });
        }
        return;
      }

      if (req.method === "POST" && path === "/solana/token/create") {
        try {
          const body = JSON.parse(await readBody(req));
          const decimals = body.decimals ?? 9;
          const result = await solana.createToken(solanaKeypair, decimals);

          // Also mint initial supply if specified
          let mintResult = null;
          if (body.initial_supply && body.initial_supply > 0) {
            mintResult = await solana.mintTokens(
              solanaKeypair,
              result.mintAddress,
              body.initial_supply,
              decimals
            );
          }

          // Register in local economic state too
          const tokenId = `sol:${result.mintAddress}`;
          economic.registerExternalToken(
            tokenId,
            body.name || "SPL Token",
            body.symbol || "SPL",
            decimals,
            "solana",
            result.mintAddress
          );
          saveEconomicState(dataDir, economic);

          json(res, 200, {
            success: true,
            token_id: tokenId,
            mint_address: result.mintAddress,
            decimals,
            initial_supply: body.initial_supply || 0,
            mint_tx: mintResult?.txSignature || null,
            explorer_url: result.explorerUrl,
            mint_explorer_url: mintResult?.explorerUrl || null,
          });
        } catch (err) {
          json(res, 422, { success: false, error: (err as Error).message });
        }
        return;
      }

      if (req.method === "POST" && path === "/solana/token/mint") {
        try {
          const body = JSON.parse(await readBody(req));
          const { mint_address, amount, decimals } = body;
          if (!mint_address || !amount) {
            json(res, 400, { error: "mint_address and amount required" });
            return;
          }
          const result = await solana.mintTokens(
            solanaKeypair,
            mint_address,
            amount,
            decimals ?? 9
          );
          json(res, 200, {
            success: true,
            tx_signature: result.txSignature,
            explorer_url: result.explorerUrl,
          });
        } catch (err) {
          json(res, 422, { success: false, error: (err as Error).message });
        }
        return;
      }

      if (req.method === "POST" && path === "/solana/token/transfer") {
        try {
          const body = JSON.parse(await readBody(req));
          const { mint_address, to_address, amount, decimals } = body;
          if (!mint_address || !to_address || !amount) {
            json(res, 400, { error: "mint_address, to_address, and amount required" });
            return;
          }
          const result = await solana.transferTokens(
            solanaKeypair,
            mint_address,
            to_address,
            amount,
            decimals ?? 9
          );

          // Record in local ledger
          const tokenId = `sol:${mint_address}`;
          const privateKey = await getSigningKey(agent);
          const keyId = agent.getKeyId() || "unknown";
          // TODO(PR3d): model on-chain recipients separately from AgentId-backed local ledger entries.
          economic.transfer(
            `solana:${to_address}` as AgentId,
            tokenId,
            amount,
            privateKey,
            keyId
          );
          saveEconomicState(dataDir, economic);

          json(res, 200, {
            success: true,
            tx_signature: result.txSignature,
            explorer_url: result.explorerUrl,
          });
        } catch (err) {
          json(res, 422, { success: false, error: (err as Error).message });
        }
        return;
      }

      if (req.method === "GET" && path === "/solana/token/balance") {
        try {
          const mintAddress = url.searchParams.get("mint_address");
          const ownerAddress = url.searchParams.get("owner_address") || solanaKeypair.publicKey.toBase58();
          if (!mintAddress) {
            json(res, 400, { error: "mint_address required" });
            return;
          }
          const balance = await solana.getTokenBalance(ownerAddress, mintAddress);
          json(res, 200, {
            owner: ownerAddress,
            mint_address: mintAddress,
            ...balance,
            explorer_url: solana.explorerUrl("address", ownerAddress),
          });
        } catch (err) {
          json(res, 422, { error: (err as Error).message });
        }
        return;
      }

      if (req.method === "GET" && path === "/solana/token/info") {
        try {
          const mintAddress = url.searchParams.get("mint_address");
          if (!mintAddress) {
            json(res, 400, { error: "mint_address required" });
            return;
          }
          const info = await solana.getTokenInfo(mintAddress);
          json(res, 200, {
            mint_address: mintAddress,
            ...info,
            explorer_url: solana.explorerUrl("address", mintAddress),
          });
        } catch (err) {
          json(res, 422, { error: (err as Error).message });
        }
        return;
      }

      // ============================================================
      // Project (Virtual Company) routes
      // ============================================================

      if (await handleProject(ctx, rc)) return;

      // ============================================================
      // Webhook routes
      // ============================================================

      if (await handleWebhooks(ctx, rc)) return;

      // ============================================================
      // Pump.fun routes
      // ============================================================

      if (req.method === "POST" && path === "/pumpfun/launch") {
        try {
          const body = JSON.parse(await readBody(req));
          const { name, symbol, description, image_base64, initial_buy_sol, twitter, telegram, website } = body;
          if (!name || !symbol || !description) {
            json(res, 400, { error: "name, symbol, and description required" });
            return;
          }
          // Image: accept base64 or use a default 1x1 pixel PNG
          const imageBuffer = image_base64
            ? Buffer.from(image_base64, "base64")
            : Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

          const result = await pumpfun.launch(
            solanaKeypair,
            name,
            symbol,
            description,
            imageBuffer,
            "token.png",
            initial_buy_sol || 0,
            { twitter, telegram, website }
          );

          if (result.success && result.mintAddress) {
            // Register in local economic state
            const tokenId = `pumpfun:${result.mintAddress}`;
            economic.registerExternalToken(
              tokenId, name, symbol, 6, "solana", result.mintAddress
            );
            saveEconomicState(dataDir, economic);
          }

          json(res, result.success ? 200 : 422, result);
        } catch (err) {
          json(res, 500, { error: (err as Error).message });
        }
        return;
      }

      if (req.method === "POST" && path === "/pumpfun/buy") {
        try {
          const body = JSON.parse(await readBody(req));
          const { mint_address, sol_amount, slippage_bps } = body;
          if (!mint_address || !sol_amount) {
            json(res, 400, { error: "mint_address and sol_amount required" });
            return;
          }
          const result = await pumpfun.buy(
            solanaKeypair, mint_address, sol_amount, slippage_bps || 500
          );
          json(res, result.success ? 200 : 422, result);
        } catch (err) {
          json(res, 500, { error: (err as Error).message });
        }
        return;
      }

      if (req.method === "POST" && path === "/pumpfun/sell") {
        try {
          const body = JSON.parse(await readBody(req));
          const { mint_address, token_amount, slippage_bps } = body;
          if (!mint_address || !token_amount) {
            json(res, 400, { error: "mint_address and token_amount required" });
            return;
          }
          const result = await pumpfun.sell(
            solanaKeypair, mint_address, token_amount, slippage_bps || 500
          );
          json(res, result.success ? 200 : 422, result);
        } catch (err) {
          json(res, 500, { error: (err as Error).message });
        }
        return;
      }

      if (req.method === "POST" && path === "/pumpfun/collect-fees") {
        try {
          const result = await pumpfun.collectCreatorFees(solanaKeypair);
          json(res, result.success ? 200 : 422, result);
        } catch (err) {
          json(res, 500, { error: (err as Error).message });
        }
        return;
      }

      if (req.method === "GET" && path === "/pumpfun/creator-vault") {
        try {
          const result = await pumpfun.getCreatorVaultBalance(solanaKeypair.publicKey.toBase58());
          json(res, 200, result);
        } catch (err) {
          json(res, 500, { error: (err as Error).message });
        }
        return;
      }

      if (req.method === "GET" && path === "/pumpfun/curve") {
        try {
          const mintAddress = url.searchParams.get("mint_address");
          if (!mintAddress) {
            json(res, 400, { error: "mint_address required" });
            return;
          }
          const curve = await pumpfun.getBondingCurve(mintAddress);
          json(res, 200, { mint_address: mintAddress, ...curve });
        } catch (err) {
          json(res, 500, { error: (err as Error).message });
        }
        return;
      }

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

// --- Discovery routes (added to existing server) ---

function addDiscoveryRoutes(
  agent: P2PAgent,
  discovery: DiscoveryClient,
  pendingRequests: ConnectionRequest[],
  inviteManager: InviteManager
) {
  return {
    handleDiscoveryRoute: async (
      req: IncomingMessage,
      res: ServerResponse,
      path: string
    ): Promise<boolean> => {
      if (req.method === "POST" && path === "/discovery/register") {
        const result = await discovery.register();
        json(res, 200, result);
        return true;
      }

      if (req.method === "POST" && path === "/discovery/unregister") {
        discovery.stopPolling();
        const result = await discovery.unregister();
        json(res, 200, result);
        return true;
      }

      if (req.method === "GET" && path === "/discovery/requests") {
        json(res, 200, { requests: pendingRequests });
        return true;
      }

      if (req.method === "POST" && path.startsWith("/discovery/requests/")) {
        const parts = path.split("/");
        const requestId = parts[3];
        const action = parts[4]; // accept or reject
        if (action === "accept" || action === "reject") {
          // Find the request before removing it
          const request = pendingRequests.find(r => r.id === requestId);
          const result = await discovery.ackRequest(requestId, action);
          // Remove from pending
          const idx = pendingRequests.findIndex(r => r.id === requestId);
          if (idx !== -1) pendingRequests.splice(idx, 1);

          // On accept: auto-connect via invite code
          if (action === "accept" && request?.from_agent_id) {
            const inviteCode = request.invite_code;
            if (inviteCode) {
              console.error(`[Discovery] Accepted ${request.from_agent_id} — connecting via invite code ${inviteCode}`);
              // Accept the invite to establish P2P connection
              inviteManager.accept(inviteCode).then((r: InviteResult) => {
                  if (r.success) {
                    console.error(`[Discovery] P2P connected to ${r.peerAgentId} via invite`);
                  } else {
                    console.error(`[Discovery] Invite accept failed: ${r.error}`);
                  }
                }).catch((e: Error) => {
                  console.error(`[Discovery] Invite accept error: ${e.message}`);
                });
            } else {
              console.error(`[Discovery] Accepted ${request.from_agent_id} — no invite code, manual connection needed`);
            }
          }

          json(res, 200, result);
          return true;
        }
      }

      if (req.method === "GET" && path === "/discovery/agents") {
        try {
          const data = await discovery.listAgents();
          json(res, 200, data);
        } catch (err) {
          json(res, 502, { error: `Discovery fetch failed: ${(err as Error).message}` });
        }
        return true;
      }

      return false;
    },
  };
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
  agent.getSwarm().on("peer:identified", (peer: any) => {
    if (peer.agentId && !taskManager.getPeerConfig(peer.agentId)) {
      taskManager.setPeerConfig(peer.agentId, "restricted");
      console.error(`[Daemon] Auto-configured peer ${peer.agentId} as restricted`);
    }
  });

  // Wire up P2P task/heartbeat events to task manager
  agent.getSwarm().on("task", ({ from, type, payload }: any) => {
    console.error(`[Task] ${type} from ${from}: ${payload.task_id || ""}`);
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
      const perm = taskManager.checkPermission(from, "task", "send");
      if (!perm.allowed) {
        agent.getSwarm().sendTaskMessage(from, "task_reject", { task_id: payload.task_id, reason: "Not permitted" });
        return;
      }
      // Security scan before accepting
      const scanResult = taskPolicy.checkTask(from, payload);
      if (!scanResult.allowed) {
        console.error(`[Security] BLOCKED task ${payload.task_id} from ${from}: ${scanResult.reason}`);
        agent.getSwarm().sendTaskMessage(from, "task_reject", {
          task_id: payload.task_id,
          reason: `Security policy violation: ${scanResult.reason}`,
        });
        return;
      }
      if (scanResult.scan_only && scanResult.threats && scanResult.threats.length > 0) {
        console.error(`[Security] AUDIT task ${payload.task_id} from ${from}: ${scanResult.threats.map((t: any) => t.pattern).join(", ")}`);
      }
      // Store incoming task (preserve original task_id)
      const task = taskManager.storeIncoming(from, payload);
      if (perm.needsApproval) {
        console.error(`[Task] Task ${task.task_id} needs approval`);
        taskManager.emit("task:approval_needed", task);
        fireWebhook("task:received", { task_id: task.task_id, from, type: payload.type, description: payload.description, needs_approval: true });
      } else {
        taskManager.updateTaskStatus(task.task_id, "accepted");
        agent.getSwarm().sendTaskMessage(from, "task_accept", { task_id: task.task_id });
        taskManager.emit("task:auto_accepted", task);
        fireWebhook("task:received", { task_id: task.task_id, from, type: payload.type, description: payload.description });
      }
    } else if (type === "task_accept") {
      taskManager.updateTaskStatus(payload.task_id, "accepted");
    } else if (type === "task_reject") {
      taskManager.updateTaskStatus(payload.task_id, "cancelled");
    } else if (type === "task_result") {
      const task = taskManager.getTask(payload.task_id);
      taskManager.updateTaskStatus(payload.task_id, payload.status === "completed" ? "completed" : "failed", payload);
      // Update reputation based on task outcome
      if (task) {
        const responseMs = task.updated_at - task.created_at;
        const executionMs = payload.duration_ms || 0;
        if (payload.status === "completed") {
          reputation.recordTaskCompleted(from, responseMs, executionMs);
        } else {
          reputation.recordTaskFailed(from);
        }
      }
    } else if (type === "task_error") {
      taskManager.updateTaskStatus(payload.task_id, "failed");
      reputation.recordTaskFailed(from);
    } else if (type === "task_cancel") {
      taskManager.updateTaskStatus(payload.task_id, "cancelled");
      reputation.recordTaskCancelled(from);
    }
  });

  // Wire webhooks to events
  projectManager.on("project:created", (p: any) => fireWebhook("project:created", p));
  projectManager.on("project:funded", (p: any) => fireWebhook("project:funded", p));
  projectManager.on("project:completed", (p: any) => fireWebhook("project:completed", p));
  projectManager.on("project:investment", (d: any) => fireWebhook("project:investment", d));
  economic.on("transfer:completed", (d: any) => fireWebhook("transfer:completed", d));
  economic.on("transfer:received", (d: any) => fireWebhook("transfer:received", d));
  economic.on("escrow:locked", (d: any) => fireWebhook("escrow:locked", d));
  economic.on("escrow:released", (d: any) => fireWebhook("escrow:released", d));

  // Handle incoming P2P project broadcasts
  agent.getSwarm().on("project_broadcast", ({ from, payload }: any) => {
    console.error(`[Project] Received broadcast from ${from}: ${payload.name} (${payload.project_id})`);
    fireWebhook("project:broadcast", { from, ...payload });
  });

  // Handle incoming P2P token transfers
  agent.getSwarm().on("token_transfer", ({ from, payload }: any) => {
    console.error(`[Economic] Received token transfer from ${from}: ${payload.amount} of ${payload.token_id}`);
    const transfer = payload as {
      from: AgentId;
      to: AgentId;
      token_id: string;
      amount: number;
      ledger_entry: any;
    };
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

  agent.getSwarm().on("heartbeat", ({ from, payload }: any) => {
    taskManager.emit("heartbeat:received", { from, ...payload });
    // Cache peer profile from heartbeat
    if (payload.profile) {
      profileManager.updatePeerProfile(payload.profile);
    }
  });

  // Handle task_poll from workers: dequeue a task and send it
  agent.getSwarm().on("task_poll", ({ from, capabilities }: any) => {
    const task = taskManager.dequeue(from, capabilities);
    agent.getSwarm().sendTaskMessage(from, "task_poll_response", task || null);
  });

  // Handle task_poll_response (we're the worker, received a task)
  agent.getSwarm().on("task_poll_response", ({ from, task }: any) => {
    if (task) {
      taskManager.emit("worker:task_received", { from, task });
    }
  });

  // Auto-adjust peer permissions based on reputation
  reputation.on("reputation:mode_suggestion", ({ agent_id, score, suggested_mode, reason }: any) => {
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
  inviteManager.on("invite:accepted", ({ code, peerAgentId, peerMode, myMode, sharedNamespace }: any) => {
    console.error(`[Invite] Peer ${peerAgentId} connected via ${code} (my mode: ${myMode}, peer mode: ${peerMode})`);
    if (sharedNamespace) {
      agent.joinNamespace(sharedNamespace);
      console.error(`[Invite] Joined shared namespace: ${sharedNamespace.slice(0, 16)}...`);
    }
    // Set what THIS peer is allowed to do on OUR side (their mode toward us)
    taskManager.setPeerConfig(peerAgentId, peerMode || "restricted", sharedNamespace);
  });
  inviteManager.on("invite:connected", ({ code, peerAgentId, peerMode, myMode, sharedNamespace }: any) => {
    console.error(`[Invite] Connected to ${peerAgentId} via ${code} (my mode: ${myMode}, peer mode: ${peerMode})`);
    if (sharedNamespace) {
      agent.joinNamespace(sharedNamespace);
      console.error(`[Invite] Joined shared namespace: ${sharedNamespace.slice(0, 16)}...`);
    }
    // Set what THIS peer is allowed to do on OUR side (their mode toward us)
    taskManager.setPeerConfig(peerAgentId, peerMode || "restricted", sharedNamespace);
  });

  // Load or create API auth token
  const apiToken = loadOrCreateApiToken(config.dataDir);
  console.error(`[Daemon] Auth token file: ${join(config.dataDir, "api-token")}`);

  const planner = new TaskPlanner(taskManager);

  planner.on("step:enqueued", ({ planId, stepId, taskId }: any) => {
    console.error(`[Plan] ${planId} step ${stepId} enqueued as ${taskId}`);
  });
  planner.on("plan:completed", ({ planId, status }: any) => {
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

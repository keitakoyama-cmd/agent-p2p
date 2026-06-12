import type { IncomingMessage, ServerResponse } from "node:http";
import type { P2PAgent } from "../agent/core";
import type { BillingPlugin } from "../agent/billing";
import type { InviteManager } from "../lib/invite/manager";
import type { AuctionManager } from "../lib/marketplace/auction";
import type { TaskManager } from "../lib/task/manager";
import type { TaskPlanner } from "../lib/task/planner";
import type { ReputationManager } from "../lib/reputation/manager";
import type { ExecutionVerifier } from "../lib/verification/prover";
import type { EconomicManager } from "../lib/economic/wallet";
import type { ProfileManager } from "../lib/matching/profile";
import type { TaskPolicyManager } from "../lib/security/policy";
import type { SolanaClient } from "../lib/chain/solana";
import type { PumpFunClient } from "../lib/chain/pumpfun";
import type { ProjectManager } from "../lib/project/manager";
import type { AgentId } from "../types/protocol";

export interface DaemonContext {
  agent: P2PAgent;
  port: number;
  inviteManager: InviteManager;
  apiToken: string;
  taskManager: TaskManager;
  planner: TaskPlanner;
  reputation: ReputationManager;
  verifier: ExecutionVerifier;
  economic: EconomicManager;
  auction: AuctionManager;
  auctionOrigins: Map<string, AgentId>;
  billing: BillingPlugin | null;
  profileManager: ProfileManager;
  taskPolicy: TaskPolicyManager;
  dataDir: string;
  solana: SolanaClient;
  solanaKeypair: import("@solana/web3.js").Keypair;
  pumpfun: PumpFunClient;
  projectManager: ProjectManager;
  webhooks: Array<{ id: string; url: string; events: string[]; created_at: string }>;
}

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
}

export type RouteGroup = (ctx: DaemonContext, rc: RequestContext) => Promise<boolean>;

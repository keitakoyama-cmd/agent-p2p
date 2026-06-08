/**
 * TaskPolicyManager — worker-side task access control.
 *
 * Combines:
 *   1. Policy check: is the task type allowed? Is the peer permitted?
 *   2. Content scan: does the task contain dangerous patterns?
 *
 * Supports:
 *   - Global default policy
 *   - Per-peer policy overrides (trusted peers get more access)
 *   - scan_only mode (audit mode — log but don't block)
 */

import { EventEmitter } from "events";
import { TaskScanner } from "./scanner";
import type {
  AgentId,
  TaskPolicy,
  TaskRequest,
  TaskCheckResult,
  ThreatEntry,
} from "../../types/protocol";

const DEFAULT_POLICY: TaskPolicy = {
  allowed_types: ["code_review", "generate", "run_tests", "transform", "report", "diagnose", "monitor", "deploy"],
  blocked_paths: [
    "~/.ssh",
    "~/.aws",
    "~/.gnupg",
    "~/.kube",
    "~/.docker/config",
    "~/.config/gcloud",
    "~/.azure",
    "/etc/shadow",
    "/etc/gshadow",
    ".env",
    ".env.local",
    ".env.production",
  ],
  blocked_env_patterns: [
    "*KEY*",
    "*SECRET*",
    "*TOKEN*",
    "*PASSWORD*",
    "*CREDENTIAL*",
  ],
  allow_outbound_network: false,
  max_output_bytes: 1_048_576, // 1MB
  scan_only: false,
};

function clonePolicy(policy: TaskPolicy): TaskPolicy {
  return {
    ...policy,
    allowed_types: [...policy.allowed_types],
    blocked_paths: [...policy.blocked_paths],
    blocked_env_patterns: [...policy.blocked_env_patterns],
  };
}

function clonePolicyUpdate(update: Partial<TaskPolicy>): Partial<TaskPolicy> {
  const cloned = { ...update };
  if (update.allowed_types) cloned.allowed_types = [...update.allowed_types];
  if (update.blocked_paths) cloned.blocked_paths = [...update.blocked_paths];
  if (update.blocked_env_patterns) {
    cloned.blocked_env_patterns = [...update.blocked_env_patterns];
  }
  return cloned;
}

function mergePolicy(
  policy: TaskPolicy,
  update?: Partial<TaskPolicy>
): TaskPolicy {
  return clonePolicy({ ...policy, ...clonePolicyUpdate(update ?? {}) });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globPatternMatches(value: string, pattern: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => escapeRegExp(part))
    .join(".*");
  return new RegExp(`^${source}$`).test(value);
}

function isEnvContainerKey(key: string): boolean {
  const normalized = key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return ["env", "envs", "environment", "environmentvariables", "envvars"].includes(normalized);
}

function extractEnvName(value: string): string | null {
  const match = value.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match?.[1] ?? null;
}

function isLikelyEnvName(value: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(value);
}

function isSensitiveEnvName(value: string): boolean {
  const name = value.toUpperCase();
  if (name.startsWith("AWS_")) return true;
  if (name === "DATABASE_URL" || name === "PGPASSWORD") return true;
  if (/(^|_)TOKEN($|_)/.test(name) || name.endsWith("TOKEN")) return true;
  if (/(^|_)PASSWORD($|_)/.test(name) || name.endsWith("PASSWORD")) return true;
  if (/(^|_)SECRET($|_)/.test(name) || name.endsWith("SECRET")) return true;
  if (/(^|_)CREDENTIALS?($|_)/.test(name) || name.endsWith("CREDENTIALS")) return true;
  if (name.includes("PUBLIC_KEY")) return false;
  return /(^|_)(API|ACCESS|PRIVATE|SECRET)_KEY($|_)/.test(name);
}

export class TaskPolicyManager extends EventEmitter {
  private agentId: AgentId;
  private policy: TaskPolicy;
  private peerOverrides = new Map<string, Partial<TaskPolicy>>();
  private scanner = new TaskScanner();

  constructor(agentId: AgentId, policy?: Partial<TaskPolicy>) {
    super();
    this.agentId = agentId;
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  // ============================================================
  // Policy Management
  // ============================================================

  getPolicy(): TaskPolicy {
    return clonePolicy(this.policy);
  }

  updatePolicy(update: Partial<TaskPolicy>): void {
    this.policy = mergePolicy(this.policy, update);
    this.emit("policy:updated", this.getPolicy());
  }

  setPeerOverride(peerId: AgentId, override: Partial<TaskPolicy>): void {
    this.peerOverrides.set(peerId, clonePolicyUpdate(override));
  }

  removePeerOverride(peerId: AgentId): void {
    this.peerOverrides.delete(peerId);
  }

  /** Get effective policy for a specific peer (default + override) */
  getPolicyForPeer(peerId: AgentId): TaskPolicy {
    const override = this.peerOverrides.get(peerId);
    if (!override) return this.getPolicy();
    return mergePolicy(this.policy, override);
  }

  // ============================================================
  // Task Checking
  // ============================================================

  /**
   * Check whether a task from a peer should be accepted.
   * Performs both policy check and content scan.
   */
  checkTask(from: AgentId, task: TaskRequest): TaskCheckResult {
    const policy = this.getPolicyForPeer(from);
    const threats: ThreatEntry[] = [];

    // 1. Check task type
    if (!policy.allowed_types.includes(task.type)) {
      const result: TaskCheckResult = {
        allowed: false,
        reason: `Task type "${task.type}" not in allowed types: [${policy.allowed_types.join(", ")}]`,
        threats: [],
      };
      this.emit("policy:rejected", { from, task, result });
      return result;
    }

    // 2. Scan task content for threats
    const scanResult = this.scanner.scan(task);
    threats.push(...scanResult.threats);

    // 3. Check blocked paths in input
    const pathThreats = this.checkBlockedPaths(task.input, policy.blocked_paths, "input");
    threats.push(...pathThreats);

    // 4. Check blocked env names in env-like task input
    const envThreats = this.checkBlockedEnvPatterns(
      task.input,
      policy.blocked_env_patterns,
      "input",
      false
    );
    threats.push(...envThreats);

    // Decision
    if (threats.length > 0) {
      if (policy.scan_only) {
        // Audit mode: allow but report
        const result: TaskCheckResult = {
          allowed: true,
          threats,
          scan_only: true,
        };
        this.emit("policy:audit", { from, task, result });
        return result;
      }

      const result: TaskCheckResult = {
        allowed: false,
        reason: `Security scan detected ${threats.length} threat(s): ${threats.map(t => t.pattern).join(", ")}`,
        threats,
      };
      this.emit("policy:rejected", { from, task, result });
      return result;
    }

    return { allowed: true, threats: [] };
  }

  // ============================================================
  // Helpers
  // ============================================================

  /** Check if any string in the input contains a blocked path */
  private checkBlockedPaths(
    value: unknown,
    blockedPaths: string[],
    path: string
  ): ThreatEntry[] {
    const threats: ThreatEntry[] = [];

    if (typeof value === "string") {
      for (const blocked of blockedPaths) {
        if (this.containsBlockedPath(value, blocked)) {
          threats.push({
            category: "credential_access",
            pattern: `blocked path: ${blocked}`,
            matched_text: value.slice(0, 100),
            location: path,
          });
        }
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        threats.push(...this.checkBlockedPaths(value[i], blockedPaths, `${path}[${i}]`));
      }
    } else if (value && typeof value === "object") {
      for (const [key, val] of Object.entries(value)) {
        threats.push(...this.checkBlockedPaths(val, blockedPaths, `${path}.${key}`));
      }
    }

    return threats;
  }

  private containsBlockedPath(value: string, blocked: string): boolean {
    if (blocked.length === 0) return false;

    const escaped = escapeRegExp(blocked);
    const boundary = String.raw`(?:^|[\s"'=,:;])`;
    const pathEnd = String.raw`(?=$|[\/\s"'=,:;])`;

    if (blocked.startsWith(".")) {
      const segmentBoundary = String.raw`(?:^|[\/\s"'=,:;])`;
      return new RegExp(`${segmentBoundary}${escaped}${pathEnd}`).test(value);
    }

    return new RegExp(`${boundary}${escaped}${pathEnd}`).test(value);
  }

  private checkBlockedEnvPatterns(
    value: unknown,
    blockedPatterns: string[],
    path: string,
    inEnvContext: boolean
  ): ThreatEntry[] {
    const threats: ThreatEntry[] = [];

    if (typeof value === "string") {
      const envName = inEnvContext ? extractEnvName(value) : null;
      if (envName) threats.push(...this.checkBlockedEnvName(envName, blockedPatterns, path));
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        threats.push(...this.checkBlockedEnvPatterns(value[i], blockedPatterns, `${path}[${i}]`, inEnvContext));
      }
    } else if (value && typeof value === "object") {
      for (const [key, val] of Object.entries(value)) {
        const keyPath = `${path}.${key}`;
        const keyIsEnvName = inEnvContext || isLikelyEnvName(key);
        const nextEnvContext = inEnvContext || isEnvContainerKey(key);
        if (keyIsEnvName) threats.push(...this.checkBlockedEnvName(key, blockedPatterns, keyPath));
        threats.push(...this.checkBlockedEnvPatterns(val, blockedPatterns, keyPath, nextEnvContext));
      }
    }

    return threats;
  }

  private checkBlockedEnvName(
    envName: string,
    blockedPatterns: string[],
    path: string
  ): ThreatEntry[] {
    if (!isSensitiveEnvName(envName)) return [];

    const normalized = envName.toUpperCase();
    return blockedPatterns
      .filter((pattern) => globPatternMatches(normalized, pattern.toUpperCase()))
      .map((pattern) => ({
        category: "credential_access" as const,
        pattern: `blocked env: ${pattern}`,
        matched_text: envName,
        location: path,
      }));
  }

  // ============================================================
  // Serialization
  // ============================================================

  serialize(): { policy: TaskPolicy; overrides: Record<string, Partial<TaskPolicy>> } {
    const overrides: Record<string, Partial<TaskPolicy>> = {};
    for (const [k, v] of this.peerOverrides) {
      overrides[k] = clonePolicyUpdate(v);
    }
    return { policy: this.getPolicy(), overrides };
  }

  load(data: { policy?: TaskPolicy; overrides?: Record<string, Partial<TaskPolicy>> }): void {
    if (data.policy) this.policy = mergePolicy(DEFAULT_POLICY, data.policy);
    if (data.overrides) {
      for (const [k, v] of Object.entries(data.overrides)) {
        this.peerOverrides.set(k, clonePolicyUpdate(v));
      }
    }
  }

  destroy(): void {
    this.peerOverrides.clear();
    this.removeAllListeners();
  }
}

/**
 * Hyperswarm P2P layer.
 *
 * NAT traversal: Hyperswarm uses UDP hole punching through its DHT.
 * No ports need to be opened on either side.
 *
 * Security model:
 *   - Topic = sha256(namespace) — only agents in the same namespace discover each other
 *   - Hyperswarm Noise protocol encrypts the transport
 *   - App-layer handshake with Ed25519 signature verifies agent identity
 *   - All protocol messages are individually signed
 *
 * Offline handling:
 *   - Outbound messages are queued if peer is offline
 *   - On reconnection, queued messages are flushed
 */

import Hyperswarm, { type HyperswarmPeerInfo } from "hyperswarm";
import { createHash } from "crypto";
import { EventEmitter } from "events";
import type { SignedMessage, AgentId } from "../../types/protocol";
import { sign, verify, toBase64, fromBase64 } from "../crypto/keys";

export interface PeerConnection {
  remotePublicKey: string; // hex (Hyperswarm Noise key)
  agentId?: AgentId;
  stream: NodeJS.ReadWriteStream;
  connected: boolean;
  verified: boolean; // handshake signature verified
  ed25519PublicKey?: string; // base64, set once a signed handshake verifies the peer
}

export interface SwarmConfig {
  agentId: AgentId;
  namespace: string;
  seed?: Buffer;
  signingKey?: Uint8Array; // Ed25519 private key used to sign the handshake
  publicKey?: Uint8Array; // Ed25519 public key advertised in the handshake
  /** Returns the Ed25519 public key (base64) previously pinned for an agent, if any (TOFU). */
  resolvePinnedKey?: (agentId: AgentId) => string | undefined;
  /** When true, peers sending an unsigned handshake are not marked verified (no legacy fallback). */
  requireSignedHandshake?: boolean;
}

interface QueuedMessage {
  targetAgentId: AgentId;
  message: SignedMessage;
  queuedAt: number;
  retries: number;
}

export interface P2PMessageEvent {
  from?: AgentId;
  remoteKey: string;
  message: SignedMessage;
}

export interface P2PFileEvent {
  from?: AgentId;
  filename: string;
  data: string;
  size: number;
  mime: string;
}

/**
 * Re-emitted wire events (handlePeerMessage). `from` is the peer's
 * self-reported agent ID from the handshake and may be absent.
 * Wire payload fields are untrusted JSON, hence `unknown`.
 */
export interface SwarmTaskEvent {
  from?: AgentId;
  type: string;
  payload: unknown;
}

/** "task_poll" event payload. */
export interface SwarmTaskPollEvent {
  from?: AgentId;
  capabilities: unknown;
}

/** "task_poll_response" event payload. */
export interface SwarmTaskPollResponseEvent {
  from?: AgentId;
  task: unknown;
}

/** "token_transfer" / "project_broadcast" / "heartbeat" event payload. */
export interface SwarmPayloadEvent {
  from?: AgentId;
  payload: unknown;
}

interface HandshakeMessage {
  type: "handshake";
  agent_id: AgentId;
  challenge: string;
  signature?: string;
  public_key?: string; // base64 Ed25519 public key of the sender
}

/** Max clock skew (ms) tolerated between the handshake challenge timestamp and now. */
const HANDSHAKE_MAX_SKEW_MS = 5 * 60_000;

/**
 * Build the byte string signed during the handshake. It binds the signature to
 * the recipient's Noise transport key (channel binding) so a signature captured
 * on one connection cannot be replayed onto a different peer-to-peer session.
 */
export function buildHandshakeSigInput(
  agentId: AgentId,
  recipientNoiseKeyHex: string,
  challenge: string,
): Uint8Array {
  return new TextEncoder().encode(`handshake:${agentId}:${recipientNoiseKeyHex}:${challenge}`);
}

export interface HandshakeInput {
  agentId?: AgentId;
  challenge?: string;
  signature?: string; // base64
  publicKey?: string; // base64
}

export interface HandshakeContext {
  recipientNoiseKeyHex: string; // our own Noise key — channel binding
  now: number;
  pinnedKey?: string; // base64 Ed25519 key previously pinned for this agentId (TOFU)
  requireSignedHandshake?: boolean;
}

export interface HandshakeResult {
  verified: boolean;
  pinnedKey?: string; // base64 key to pin when verified via a valid signature
  reason: string;
}

/**
 * Decide whether a handshake authenticates the peer. Pure so it can be unit-tested
 * without a live swarm.
 *   - signed + valid signature + fresh challenge + key matches any existing pin
 *     → verified (and the key is returned for TOFU pinning)
 *   - signed but invalid / stale / key-mismatch → rejected (hard fail, no fallback)
 *   - unsigned → legacy-accepted unless requireSignedHandshake is set
 * A mismatch against a previously pinned key is always rejected: a different key
 * for a known agent is the signature of an impersonation attempt.
 */
export function evaluateHandshake(input: HandshakeInput, ctx: HandshakeContext): HandshakeResult {
  const { agentId, challenge, signature, publicKey } = input;
  if (signature && publicKey && challenge && agentId) {
    const ts = Number(challenge);
    const fresh = Number.isFinite(ts) && Math.abs(ctx.now - ts) <= HANDSHAKE_MAX_SKEW_MS;
    const pinOk = !ctx.pinnedKey || ctx.pinnedKey === publicKey;
    let sigOk = false;
    try {
      sigOk = verify(
        fromBase64(signature),
        buildHandshakeSigInput(agentId, ctx.recipientNoiseKeyHex, challenge),
        fromBase64(publicKey),
      );
    } catch {
      sigOk = false;
    }
    if (sigOk && fresh && pinOk) {
      return { verified: true, pinnedKey: publicKey, reason: "signed" };
    }
    return { verified: false, reason: `rejected sig=${sigOk} fresh=${fresh} pin=${pinOk}` };
  }
  if (ctx.pinnedKey) {
    // This agent has presented a signed handshake before (its key is pinned).
    // Refuse a downgrade to an unsigned handshake, which would otherwise bypass
    // the pin and let anyone impersonate the agent by simply omitting a signature.
    return { verified: false, reason: "downgrade-pinned" };
  }
  if (ctx.requireSignedHandshake) {
    return { verified: false, reason: "unsigned-rejected" };
  }
  return { verified: true, reason: "unsigned-legacy" };
}

interface PeerWireMessage extends Record<string, unknown> {
  type: string;
}

function isPeerWireMessage(value: unknown): value is PeerWireMessage {
  return (
    typeof value === "object"
    && value !== null
    && typeof (value as { type?: unknown }).type === "string"
  );
}

export class P2PSwarm extends EventEmitter {
  private swarm!: Hyperswarm;
  private topic: Buffer;
  private peers: Map<string, PeerConnection> = new Map();
  private outboundQueue: QueuedMessage[] = [];
  private retryTimer?: ReturnType<typeof setInterval>;
  private myNoiseKeyHex = ""; // our own Noise transport key (hex), for handshake channel binding
  public agentId: AgentId;

  constructor(private config: SwarmConfig) {
    super();
    this.agentId = config.agentId;
    this.topic = createHash("sha256")
      .update(`agent-p2p:${config.namespace}`)
      .digest();
  }

  async start(): Promise<void> {
    const opts: { seed?: Buffer } = {};
    if (this.config.seed) opts.seed = this.config.seed;

    this.swarm = new Hyperswarm(opts);
    this.myNoiseKeyHex = Buffer.from(this.swarm.keyPair.publicKey).toString("hex");

    this.swarm.on("connection", (socket: NodeJS.ReadWriteStream, peerInfo: HyperswarmPeerInfo) => {
      const remoteKey = peerInfo.publicKey.toString("hex");
      console.error(`[P2P] Peer connected: ${remoteKey.slice(0, 12)}...`);

      const peer: PeerConnection = {
        remotePublicKey: remoteKey,
        stream: socket,
        connected: true,
        verified: false,
      };
      this.peers.set(remoteKey, peer);

      // Send handshake with a signed, channel-bound challenge. `remoteKey` is the
      // recipient's Noise key, binding the signature to this specific connection.
      const challenge = Date.now().toString();
      const handshake: HandshakeMessage = {
        type: "handshake",
        agent_id: this.agentId,
        challenge,
      };
      if (this.config.signingKey && this.config.publicKey) {
        const sigInput = buildHandshakeSigInput(this.agentId, remoteKey, challenge);
        handshake.signature = toBase64(sign(sigInput, this.config.signingKey));
        handshake.public_key = toBase64(this.config.publicKey);
      }

      this.sendRaw(socket, handshake);

      // Handle incoming data (newline-delimited JSON)
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          const nlIndex = buffer.indexOf(0x0a);
          if (nlIndex === -1) break;
          const line = buffer.subarray(0, nlIndex);
          buffer = buffer.subarray(nlIndex + 1);
          try {
            const msg: unknown = JSON.parse(line.toString("utf8"));
            this.handlePeerMessage(remoteKey, msg);
          } catch (err) {
            console.error(
              `[P2P] Parse error from ${remoteKey.slice(0, 12)}: ${err}`
            );
          }
        }
      });

      socket.on("error", (err: Error) => {
        console.error(
          `[P2P] Error ${remoteKey.slice(0, 12)}: ${err.message}`
        );
      });

      socket.on("close", () => {
        console.error(
          `[P2P] Disconnected: ${remoteKey.slice(0, 12)} (${peer.agentId ?? "?"})`
        );
        peer.connected = false;
        this.peers.delete(remoteKey);
        this.emit("peer:disconnected", peer);
      });

      this.emit("peer:connected", peer);
    });

    // Join as both server and client
    const discovery = this.swarm.join(this.topic, {
      server: true,
      client: true,
    });

    // Don't block on DHT flush — it can take a while or hang if bootstrap unreachable.
    // Start the retry timer immediately so the daemon is usable right away.
    discovery.flushed().then(() => {
      console.error(
        `[P2P] DHT flush complete for topic: ${this.topic.toString("hex").slice(0, 16)}...`
      );
    }).catch((err: Error) => {
      console.error(`[P2P] DHT flush error (will retry): ${err.message}`);
    });

    // Start retry timer for queued messages
    this.retryTimer = setInterval(() => this.flushQueue(), 15_000);

    console.error(
      `[P2P] Joining topic: ${this.topic.toString("hex").slice(0, 16)}... as ${this.agentId}`
    );
  }

  /** Join an additional namespace topic */
  joinNamespace(namespace: string): void {
    const topic = createHash("sha256").update(`agent-p2p:${namespace}`).digest();
    this.swarm.join(topic, { server: true, client: true });
    console.error(`[P2P] Joined additional namespace: ${namespace.slice(0, 16)}...`);
  }

  /** Send to a specific agent. Returns false if not connected (queued). */
  sendMessage(targetAgentId: AgentId, message: SignedMessage): boolean {
    for (const peer of this.peers.values()) {
      if (peer.agentId === targetAgentId && peer.connected && peer.verified) {
        return this.sendRaw(peer.stream, {
          type: "protocol_message",
          payload: message,
        });
      }
    }

    // Queue for later delivery
    this.outboundQueue.push({
      targetAgentId,
      message,
      queuedAt: Date.now(),
      retries: 0,
    });
    console.error(
      `[P2P] Peer ${targetAgentId} offline. Queued (${this.outboundQueue.length} pending).`
    );
    return false;
  }

  /** Send a file to a specific agent */
  sendFile(targetAgentId: AgentId, filename: string, data: string, size: number, mime: string): boolean {
    for (const peer of this.peers.values()) {
      if (peer.agentId === targetAgentId && peer.connected && peer.verified) {
        return this.sendRaw(peer.stream, {
          type: "file_transfer",
          filename,
          data,
          size,
          mime,
        });
      }
    }
    console.error(`[P2P] Peer ${targetAgentId} not connected — cannot send file`);
    return false;
  }

  /** Send a task message to a specific agent */
  sendTaskMessage(targetAgentId: AgentId, type: string, payload: unknown): boolean {
    for (const peer of this.peers.values()) {
      if (peer.agentId === targetAgentId && peer.connected && peer.verified) {
        return this.sendRaw(peer.stream, { type, payload });
      }
    }
    return false;
  }

  /** Broadcast heartbeat to all connected peers */
  broadcastHeartbeat(payload: unknown): number {
    let sent = 0;
    for (const peer of this.peers.values()) {
      if (peer.connected && peer.verified) {
        this.sendRaw(peer.stream, { type: "heartbeat", payload });
        sent++;
      }
    }
    return sent;
  }

  /** Broadcast a task auction to all connected peers */
  broadcastTask(payload: unknown): number {
    let sent = 0;
    for (const peer of this.peers.values()) {
      if (peer.connected && peer.verified && peer.agentId) {
        if (this.sendRaw(peer.stream, { type: "task_broadcast", payload })) {
          sent++;
        }
      }
    }
    return sent;
  }

  /** Broadcast to all connected peers */
  broadcast(message: SignedMessage): number {
    let sent = 0;
    for (const peer of this.peers.values()) {
      if (peer.connected && peer.verified) {
        this.sendRaw(peer.stream, {
          type: "protocol_message",
          payload: message,
        });
        sent++;
      }
    }
    return sent;
  }

  getConnectedPeers(): PeerConnection[] {
    return Array.from(this.peers.values()).filter((p) => p.connected);
  }

  getQueueSize(): number {
    return this.outboundQueue.length;
  }

  async stop(): Promise<void> {
    if (this.retryTimer) clearInterval(this.retryTimer);
    if (this.swarm) await this.swarm.destroy();
    this.peers.clear();
    console.error("[P2P] Swarm stopped");
  }

  // --- Internal ---

  /** Flush queued messages to now-connected peers */
  private flushQueue(): void {
    if (this.outboundQueue.length === 0) return;

    const remaining: QueuedMessage[] = [];
    for (const item of this.outboundQueue) {
      let sent = false;
      for (const peer of this.peers.values()) {
        if (peer.agentId === item.targetAgentId && peer.connected && peer.verified) {
          this.sendRaw(peer.stream, {
            type: "protocol_message",
            payload: item.message,
          });
          sent = true;
          console.error(
            `[P2P] Flushed queued message to ${item.targetAgentId}`
          );
          break;
        }
      }
      if (!sent) {
        item.retries++;
        // Drop after 24h or 100 retries
        if (Date.now() - item.queuedAt < 86_400_000 && item.retries < 100) {
          remaining.push(item);
        } else {
          console.error(
            `[P2P] Dropped queued message to ${item.targetAgentId} after ${item.retries} retries`
          );
        }
      }
    }
    this.outboundQueue = remaining;
  }

  private sendRaw(stream: NodeJS.WritableStream, data: unknown): boolean {
    try {
      stream.write(JSON.stringify(data) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /** Apply handshake verification to a peer, pinning its key on success. */
  private applyHandshake(peer: PeerConnection, msg: PeerWireMessage, claimedId: AgentId | undefined): boolean {
    const result = evaluateHandshake(
      {
        agentId: claimedId,
        challenge: typeof msg.challenge === "string" ? msg.challenge : undefined,
        signature: typeof msg.signature === "string" ? msg.signature : undefined,
        publicKey: typeof msg.public_key === "string" ? msg.public_key : undefined,
      },
      {
        recipientNoiseKeyHex: this.myNoiseKeyHex,
        now: Date.now(),
        pinnedKey: claimedId ? this.config.resolvePinnedKey?.(claimedId) : undefined,
        requireSignedHandshake: this.config.requireSignedHandshake,
      },
    );
    if (result.verified && result.pinnedKey) {
      peer.ed25519PublicKey = result.pinnedKey;
    }
    if (!result.verified) {
      console.error(`[P2P] Handshake ${result.reason} from ${claimedId ?? "?"}`);
    }
    return result.verified;
  }

  private handlePeerMessage(remoteKey: string, msg: unknown): void {
    const peer = this.peers.get(remoteKey);
    if (!peer) return;
    if (!isPeerWireMessage(msg)) {
      console.error(`[P2P] Unknown message from ${remoteKey.slice(0, 12)}`);
      return;
    }

    switch (msg.type) {
      case "handshake": {
        const claimedId = typeof msg.agent_id === "string" ? (msg.agent_id as AgentId) : undefined;
        // Only bind the claimed agent id to the peer once it is verified, so an
        // unverified peer can never be selected as a directed-send target.
        peer.verified = this.applyHandshake(peer, msg, claimedId);
        if (peer.verified) {
          if (claimedId) peer.agentId = claimedId;
          console.error(`[P2P] Peer identified: ${claimedId}`);
          this.emit("peer:identified", peer);
          // Flush any queued messages for this peer
          setTimeout(() => this.flushQueue(), 100);
        } else if (this.config.requireSignedHandshake) {
          // Hardened mode: drop the connection to a peer we could not verify.
          peer.connected = false;
          peer.stream.end();
        }
        break;
      }

      case "protocol_message":
        if (!peer.verified) {
          console.error(
            `[P2P] Dropping message from unverified peer ${remoteKey.slice(0, 12)}`
          );
          return;
        }
        this.emit("message", {
          from: peer.agentId,
          remoteKey,
          message: msg.payload as SignedMessage,
        } satisfies P2PMessageEvent);
        break;

      case "file_transfer":
        if (!peer.verified) return;
        this.emit("file", {
          from: peer.agentId,
          filename: msg.filename as string,
          data: msg.data as string,
          size: msg.size as number,
          mime: msg.mime as string,
        } satisfies P2PFileEvent);
        break;

      case "task_request":
      case "task_accept":
      case "task_reject":
      case "task_result":
      case "task_error":
      case "task_cancel":
      case "task_broadcast":
      case "task_bid":
      case "task_award":
        if (!peer.verified) return;
        this.emit("task", { from: peer.agentId, type: msg.type, payload: msg.payload } satisfies SwarmTaskEvent);
        break;

      case "task_poll":
        if (!peer.verified) return;
        this.emit("task_poll", { from: peer.agentId, capabilities: msg.capabilities } satisfies SwarmTaskPollEvent);
        break;

      case "task_poll_response":
        if (!peer.verified) return;
        this.emit("task_poll_response", { from: peer.agentId, task: msg.task } satisfies SwarmTaskPollResponseEvent);
        break;

      case "token_transfer":
        if (!peer.verified) return;
        this.emit("token_transfer", { from: peer.agentId, payload: msg.payload } satisfies SwarmPayloadEvent);
        break;

      case "project_broadcast":
        if (!peer.verified) return;
        this.emit("project_broadcast", { from: peer.agentId, payload: msg.payload } satisfies SwarmPayloadEvent);
        break;

      case "heartbeat":
        if (!peer.verified) return;
        this.emit("heartbeat", { from: peer.agentId, payload: msg.payload } satisfies SwarmPayloadEvent);
        break;

      default:
        console.error(`[P2P] Unknown message type: ${msg.type}`);
    }
  }
}

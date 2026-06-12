declare interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

declare interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

declare interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

declare type PagesFunction<Env = unknown> = (context: {
  request: Request;
  env: Env;
  params: Record<string, string>;
  waitUntil: ExecutionContext["waitUntil"];
  next: () => Promise<Response>;
  data: unknown;
}) => Response | Promise<Response>;

declare interface ExportedHandler<Env = unknown> {
  fetch?: (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;
}

declare module "hyperswarm" {
  export interface HyperswarmOptions {
    seed?: Uint8Array | Buffer;
    keyPair?: { publicKey: Uint8Array; secretKey: Uint8Array };
    maxPeers?: number;
    maxClientConnections?: number;
    maxServerConnections?: number;
    maxParallel?: number;
    bootstrap?: string[];
    nodes?: unknown[];
    port?: number;
    firewall?: (remotePublicKey: Uint8Array) => boolean;
    dht?: unknown;
    relayThrough?: unknown;
    deferRandomPunch?: boolean;
    randomPunchInterval?: number;
    handshakeClearWait?: number;
    backoffs?: number[];
    jitter?: number;
  }

  export interface HyperswarmJoinOptions {
    server?: boolean;
    client?: boolean;
    limit?: number;
  }

  export interface HyperswarmPeerDiscovery {
    flushed(): Promise<void>;
    refresh(options?: HyperswarmJoinOptions): Promise<void>;
    destroy(): Promise<void>;
  }

  export interface HyperswarmPeerInfo {
    publicKey: Buffer;
    topics: Buffer[];
    client: boolean;
    readonly server: boolean;
    readonly prioritized: boolean;
    ban(value?: boolean): void;
  }

  export default class Hyperswarm extends import("events").EventEmitter {
    constructor(options?: HyperswarmOptions);
    connecting: number;
    connections: Set<NodeJS.ReadWriteStream>;
    peers: Map<string, HyperswarmPeerInfo>;
    destroyed: boolean;
    join(topic: Buffer, options?: HyperswarmJoinOptions): HyperswarmPeerDiscovery;
    leave(topic: Buffer): Promise<void>;
    joinPeer(noisePublicKey: Buffer): HyperswarmPeerDiscovery;
    leavePeer(noisePublicKey: Buffer): Promise<void>;
    flush(): Promise<void>;
    listen(): Promise<void>;
    destroy(): Promise<void>;
    on(
      event: "connection",
      listener: (socket: NodeJS.ReadWriteStream, peerInfo: HyperswarmPeerInfo) => void
    ): this;
    on(event: "update", listener: () => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  }
}

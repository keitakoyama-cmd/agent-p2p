import type { IncomingMessage, ServerResponse } from "http";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function loadOrCreateApiToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const tokenFile = join(dataDir, "api-token");

  if (existsSync(tokenFile)) {
    const token = readFileSync(tokenFile, "utf8").trim();
    if (token.length > 0) return token;
  }

  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  return token;
}

export function checkBearerAuth(req: IncomingMessage, expectedToken: string): boolean {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return false;
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return false;
  return parts[1] === expectedToken;
}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return JSON.parse(await readBody(req)) as T;
}

export async function readJsonBodyOrEmpty<T>(req: IncomingMessage): Promise<T> {
  const body = await readBody(req);
  return (body ? JSON.parse(body) : {}) as T;
}

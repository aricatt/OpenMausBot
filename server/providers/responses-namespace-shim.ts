// Codex refuses any function_call that carries no `namespace`, and a Responses provider that
// flattens namespace tools (vLLM's `mcp__<server>__<tool>`) restores it only on an exact flat-name
// match; any other emitted name arrives bare and is refused (docs/findings-codex-mcp-namespace.md).
// OMB_NAMESPACE_SHIM=1 points the routed provider's base_url at this loopback shim instead of the
// endpoint. The real upstream rides in the codex child's environment and reaches the shim as the
// x-omb-upstream request header (`env_http_headers`), so it never lands in argv; the shim injects
// the dropped namespace only when the emitted name resolves to exactly one mounted namespace.
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { once } from "node:events";
import type { Socket } from "node:net";

import { IDLE_HTTP_SERVER } from "../due-timer.ts";

/** `OMB_NAMESPACE_SHIM=1` routes codex's Responses traffic through this shim; unset it stays off. */
export const NAMESPACE_SHIM_ENV = "OMB_NAMESPACE_SHIM";
/** The codex child's variable holding this provider's real base URL. */
export const NAMESPACE_SHIM_UPSTREAM_ENV = "OMB_NAMESPACE_SHIM_UPSTREAM";
/** Header `env_http_headers` maps that variable onto; stripped before forwarding. */
export const NAMESPACE_SHIM_UPSTREAM_HEADER = "x-omb-upstream";

export function namespaceShimEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[NAMESPACE_SHIM_ENV] === "1";
}

// A turn's request can carry inlined images; beyond this the body is refused rather than held whole.
const REQUEST_BODY_CAP_BYTES = 64 * 1024 * 1024;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const EVENT_BOUNDARY = /\r?\n\r?\n/;

/** What the request's `tools` specs let an emitted name resolve to. */
export interface NamespaceResolver {
  resolve(name: unknown): string | undefined;
}

/** `tools` as codex posts them: `{"type":"namespace","name":"mcp__x","tools":[...]}` specs plus
 * ordinary tools. A bare emitted name resolves only through exactly one namespace's tool list. */
export function namespaceResolver(tools: unknown): NamespaceResolver {
  const flat = new Map<string, string>();
  const bare = new Map<string, Set<string>>();
  const topLevel = new Set<string>();
  if (Array.isArray(tools)) {
    for (const spec of tools) {
      if (!spec || typeof spec !== "object") continue;
      const { type, name, tools: nested } = spec as { type?: unknown; name?: unknown; tools?: unknown };
      if (type === "namespace" && typeof name === "string" && name && Array.isArray(nested)) {
        for (const tool of nested) {
          const toolName = (tool as { name?: unknown } | null)?.name;
          if (typeof toolName !== "string" || !toolName) continue;
          flat.set(`${name}__${toolName}`, name);
          const namespaces = bare.get(toolName) ?? new Set<string>();
          bare.set(toolName, namespaces.add(name));
        }
      } else if (typeof name === "string" && name) {
        topLevel.add(name);
      }
    }
  }
  return {
    resolve(emitted) {
      if (typeof emitted !== "string" || !emitted) return undefined;
      const hit = flat.get(emitted);
      if (hit) return hit;
      if (topLevel.has(emitted)) return undefined;
      const namespaces = bare.get(emitted);
      return namespaces?.size === 1 ? [...namespaces][0] : undefined;
    },
  };
}

/** Sets `namespace` on every function_call that lacks one and resolves; anything else is left,
 * including ambiguous names, so codex's "unsupported call" diagnostic still reports them. */
function injectNamespaces(value: unknown, resolver: NamespaceResolver, found: { hit: boolean }): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) injectNamespaces(item, resolver, found);
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "function_call" && !record.namespace) {
    const namespace = resolver.resolve(record.name);
    if (namespace) {
      record.namespace = namespace;
      found.hit = true;
    }
  }
  for (const child of Object.values(record)) injectNamespaces(child, resolver, found);
}

/** One complete SSE event block, verbatim unless a `data:` payload needed a namespace. */
export function rewriteNamespaceEventBlock(block: string, resolver: NamespaceResolver): string {
  let changed = false;
  const lines = block.split("\n").map((line) => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    const suffix = line.endsWith("\r") ? "\r" : "";
    const data = text.startsWith("data:") ? text.slice(5).trim() : "";
    if (!data.startsWith("{")) return line;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return line;
    }
    const found = { hit: false };
    injectNamespaces(value, resolver, found);
    if (!found.hit) return line;
    changed = true;
    return `data: ${JSON.stringify(value)}${suffix}`;
  });
  return changed ? lines.join("\n") : block;
}

/** Streams the upstream response body, rewriting complete event blocks only; a torn tail goes as-is. */
async function pipeEventStream(upstream: IncomingMessage, res: ServerResponse, resolver: NamespaceResolver): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = "";
  const emit = async (block: string) => {
    if (res.write(rewriteNamespaceEventBlock(block, resolver))) return;
    await Promise.race([once(res, "drain"), once(res, "close")]);
    if (res.destroyed) throw new Error("client gone");
  };
  try {
    for await (const chunk of upstream) {
      buffered += decoder.decode(chunk as Buffer, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = EVENT_BOUNDARY.exec(buffered))) {
        const end = boundary.index + boundary[0].length;
        await emit(buffered.slice(0, end));
        buffered = buffered.slice(end);
      }
    }
    buffered += decoder.decode();
    if (buffered) await emit(buffered);
  } finally {
    res.end();
  }
}

export interface NamespaceShim {
  /** The base_url a routed provider is pointed at while this runs. */
  url: string;
  /** Adds a base URL the shim will proxy; a header asking for any other is refused. */
  allowUpstream(url: string): void;
  close(): Promise<void>;
}

function requestHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || name === "host" || name === NAMESPACE_SHIM_UPSTREAM_HEADER) continue;
    out[name] = value;
  }
  out["accept-encoding"] = "identity";
  return out;
}

function responseHeaders(headers: IncomingMessage["headers"], rewritten: boolean): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || (rewritten && name === "content-length")) continue;
    out[name] = value;
  }
  return out;
}

/** Starts the loopback proxy on an ephemeral port. Only `x-omb-upstream` values registered through
 * `allowUpstream` are proxied, so the listener is never an open forward proxy. */
export async function startNamespaceShim(): Promise<NamespaceShim> {
  const upstreams = new Set<string>();
  const sockets = new Set<Socket>();

  const readBody = async (req: IncomingMessage): Promise<Buffer | null> => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > REQUEST_BODY_CAP_BYTES) return null;
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const header = req.headers[NAMESPACE_SHIM_UPSTREAM_HEADER];
    const base = (Array.isArray(header) ? header[0] : header) ?? "";
    let upstream: URL | null = null;
    if (upstreams.has(base)) {
      try {
        upstream = new URL(`${base.replace(/\/+$/, "")}${req.url ?? "/"}`);
      } catch {
        upstream = null;
      }
    }
    if (!upstream || (upstream.protocol !== "http:" && upstream.protocol !== "https:")) {
      req.resume();
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "refused: not an upstream this shim serves" }));
      return;
    }
    const rewriting = req.method === "POST" && (req.url ?? "").split("?")[0] === "/responses";
    const body = rewriting ? await readBody(req) : null;
    if (rewriting && body === null) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "request body too large" }));
      return;
    }
    let resolver = namespaceResolver(undefined);
    if (body) {
      try {
        resolver = namespaceResolver((JSON.parse(body.toString("utf8")) as { tools?: unknown }).tools);
      } catch {
        // An unreadable body still goes upstream; nothing can be resolved for it.
      }
    }
    const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
    const proxy = send(upstream, { method: req.method, headers: requestHeaders(req.headers) });
    proxy.on("response", (reply) => {
      const rewrite = rewriting && (reply.headers["content-type"] ?? "").includes("text/event-stream") && !reply.headers["content-encoding"];
      res.writeHead(reply.statusCode ?? 502, responseHeaders(reply.headers, rewrite));
      if (!rewrite) {
        reply.on("error", () => res.destroy());
        reply.pipe(res);
        return;
      }
      void pipeEventStream(reply, res, resolver);
    });
    proxy.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "upstream unreachable" }));
      } else res.destroy();
    });
    req.on("error", () => proxy.destroy());
    if (body) proxy.end(body);
    else req.pipe(proxy);
  };

  const server = createServer(IDLE_HTTP_SERVER, (req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address !== "object") {
    server.close();
    throw new Error("namespace shim could not bind a loopback port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    allowUpstream: (url) => {
      upstreams.add(url);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let singleton: NamespaceShim | null = null;

/** The running shim's base URL; null while the flag is off or it has not started. */
export function runningNamespaceShim(): NamespaceShim | null {
  return singleton;
}

/** Starts the one shim the server's routed codex providers share; a no-op unless OMB_NAMESPACE_SHIM=1. */
export async function startCodexNamespaceShim(): Promise<void> {
  if (singleton || !namespaceShimEnabled()) return;
  singleton = await startNamespaceShim();
}

export async function closeCodexNamespaceShim(): Promise<void> {
  const shim = singleton;
  singleton = null;
  await shim?.close();
}

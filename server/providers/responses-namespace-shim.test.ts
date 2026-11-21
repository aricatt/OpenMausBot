import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { endpointCodexArgs } from "../drivers/codex-endpoint-config.ts";
import {
  NAMESPACE_SHIM_ENV,
  NAMESPACE_SHIM_UPSTREAM_ENV,
  NAMESPACE_SHIM_UPSTREAM_HEADER,
  closeCodexNamespaceShim,
  namespaceResolver,
  rewriteNamespaceEventBlock,
  runningNamespaceShim,
  startCodexNamespaceShim,
  startNamespaceShim,
} from "./responses-namespace-shim.ts";

// What codex 0.169 posts for two mounted MCP servers plus one built-in tool: the
// bare name `shared_probe` is exposed by both namespaces, so only codex can tell.
const TOOLS = [
  { type: "namespace", name: "mcp__computer", tools: [{ type: "function", name: "get_window_state" }, { type: "function", name: "browser_open" }] },
  { type: "namespace", name: "mcp__browser", tools: [{ type: "function", name: "agent_browser_click" }, { type: "function", name: "shared_probe" }] },
  { type: "namespace", name: "mcp__agents", tools: [{ type: "function", name: "shared_probe" }] },
  { type: "function", name: "shell" },
];

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const dataOf = (block: string) => JSON.parse(block.split("\n").find((line) => line.startsWith("data:"))!.slice(5).trim());
const callDone = (name: string, extra: Record<string, unknown> = {}) =>
  sse("response.output_item.done", { type: "response.output_item.done", item: { type: "function_call", name, arguments: "{}", call_id: "c1", ...extra } });

describe("rewriteNamespaceEventBlock", () => {
  const resolver = () => namespaceResolver(TOOLS);

  it("injects the namespace a bare, unique tool name belongs to", () => {
    const rewritten = dataOf(rewriteNamespaceEventBlock(callDone("get_window_state"), resolver()));
    expect(rewritten.item).toMatchObject({ name: "get_window_state", namespace: "mcp__computer", arguments: "{}", call_id: "c1" });
  });

  it("injects on a flat mcp__<server>__<tool> name too", () => {
    const rewritten = dataOf(rewriteNamespaceEventBlock(callDone("mcp__browser__agent_browser_click"), resolver()));
    expect(rewritten.item).toMatchObject({ name: "mcp__browser__agent_browser_click", namespace: "mcp__browser" });
  });

  it("injects inside response.completed's output array", () => {
    const block = sse("response.completed", {
      type: "response.completed",
      response: { output: [
        { type: "message", content: [{ type: "output_text", text: "hi" }] },
        { type: "function_call", name: "get_window_state", arguments: "{}", call_id: "c9" },
      ] },
    });
    const rewritten = dataOf(rewriteNamespaceEventBlock(block, resolver()));
    expect(rewritten.response.output[1]).toMatchObject({ namespace: "mcp__computer" });
    expect(rewritten.response.output[0]).toMatchObject({ type: "message" });
  });

  it.each([
    ["an ambiguous bare name", callDone("shared_probe")],
    ["a name no namespace exposes", callDone("no_such_tool")],
    ["a top-level tool's name", callDone("shell")],
    ["an already-namespaced call", callDone("shared_probe", { namespace: "mcp__agents" })],
    ["a text delta", sse("response.output_text.delta", { type: "response.output_text.delta", delta: "hi" })],
    ["a stream terminator", "data: [DONE]\n\n"],
    ["a comment line", ": keepalive\n\n"],
  ])("leaves %s untouched", (_label, block) => {
    expect(rewriteNamespaceEventBlock(block, resolver())).toBe(block);
  });
});

describe("shim HTTP proxy", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  const listen = async (server: Server): Promise<number> => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0 }, resolve);
    });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return (server.address() as AddressInfo).port;
  };

  const readBody = async (req: NodeJS.ReadableStream): Promise<string> => {
    let body = "";
    for await (const chunk of req) body += chunk;
    return body;
  };

  it("proxies POST /responses, injecting only resolvable namespaces", async () => {
    const seen: { method?: string; url?: string; headers?: Record<string, unknown>; body?: string } = {};
    const deltaBlock = sse("response.output_text.delta", { type: "response.output_text.delta", delta: "hi" });
    const uniqueBlock = callDone("get_window_state");
    const ambiguousBlock = callDone("shared_probe");
    const stream = deltaBlock + uniqueBlock + ambiguousBlock + "data: [DONE]\n\n";
    const upstream = createServer((req, res) => {
      void readBody(req).then((body) => {
        Object.assign(seen, { method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(200, { "content-type": "text/event-stream" });
        // A block torn across two writes: the shim must wait for the boundary before rewriting.
        res.write(stream.slice(0, stream.indexOf("shared_probe")));
        res.end(stream.slice(stream.indexOf("shared_probe")));
      });
    });
    const port = await listen(upstream);
    const upstreamUrl = `http://127.0.0.1:${port}/v1`;
    const shim = await startNamespaceShim();
    cleanups.push(() => shim.close());
    shim.allowUpstream(upstreamUrl);

    const requestBody = JSON.stringify({ model: "m", stream: true, tools: TOOLS });
    const response = await fetch(`${shim.url}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer synthetic-key", [NAMESPACE_SHIM_UPSTREAM_HEADER]: upstreamUrl },
      body: requestBody,
    });
    expect(response.status).toBe(200);
    const text = await response.text();

    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/v1/responses");
    expect(seen.body).toBe(requestBody);
    expect(seen.headers?.authorization).toBe("Bearer synthetic-key");
    expect(seen.headers?.[NAMESPACE_SHIM_UPSTREAM_HEADER]).toBeUndefined();
    expect(text).toContain(deltaBlock);
    expect(text).toContain(ambiguousBlock);
    expect(text).toContain("data: [DONE]\n\n");
    const calls = [...text.matchAll(/^data: (\{.*\})$/gm)].map((match) => JSON.parse(match[1]!));
    expect(calls.find((event) => event.item?.type === "function_call" && event.item.name === "get_window_state")?.item)
      .toMatchObject({ namespace: "mcp__computer" });
    expect(calls.find((event) => event.item?.name === "shared_probe")?.item).not.toHaveProperty("namespace");
  });

  it("passes non-/responses traffic through byte-for-byte", async () => {
    const payload = '{"data":[{"id":"m"}],"odd":[0,1,2]}';
    const upstream = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`${req.method} ${req.url} ${payload}`);
    });
    const port = await listen(upstream);
    const upstreamUrl = `http://127.0.0.1:${port}/v1`;
    const shim = await startNamespaceShim();
    cleanups.push(() => shim.close());
    shim.allowUpstream(upstreamUrl);

    const response = await fetch(`${shim.url}/models?limit=1`, { headers: { [NAMESPACE_SHIM_UPSTREAM_HEADER]: upstreamUrl } });
    expect(await response.text()).toBe(`GET /v1/models?limit=1 ${payload}`);
  });

  it("refuses requests whose upstream header is missing or unregistered", async () => {
    const shim = await startNamespaceShim();
    cleanups.push(() => shim.close());
    shim.allowUpstream("http://127.0.0.1:1/v1");

    const missing = await fetch(`${shim.url}/responses`, { method: "POST", body: "{}" });
    expect(missing.status).toBe(403);
    const unregistered = await fetch(`${shim.url}/responses`, { method: "POST", headers: { [NAMESPACE_SHIM_UPSTREAM_HEADER]: "http://127.0.0.1:2/v1" }, body: "{}" });
    expect(unregistered.status).toBe(403);
  });
});

describe("OMB_NAMESPACE_SHIM flag", () => {
  afterEach(async () => {
    delete process.env[NAMESPACE_SHIM_ENV];
    await closeCodexNamespaceShim();
  });

  it("starts no listener and changes no args while the flag is off", async () => {
    await startCodexNamespaceShim();
    expect(runningNamespaceShim()).toBeNull();
    const args = endpointCodexArgs({ url: "http://127.0.0.1:9/v1", models: ["m"] });
    expect(args).toContain('model_providers.openmaus_endpoint.base_url="http://127.0.0.1:9/v1"');
    expect(args.join("\n")).not.toContain("env_http_headers");
  });

  it("points the provider at the shim and hands the endpoint to it through env", async () => {
    process.env[NAMESPACE_SHIM_ENV] = "1";
    await startCodexNamespaceShim();
    const shim = runningNamespaceShim();
    expect(shim).not.toBeNull();
    const args = endpointCodexArgs({ url: "http://127.0.0.1:9/v1", models: ["m"] });
    expect(args).toContain(`model_providers.openmaus_endpoint.base_url=${JSON.stringify(shim!.url)}`);
    expect(args).toContain(`model_providers.openmaus_endpoint.env_http_headers.${NAMESPACE_SHIM_UPSTREAM_HEADER}=${JSON.stringify(NAMESPACE_SHIM_UPSTREAM_ENV)}`);
    expect(args).toContain("model_providers.openmaus_endpoint.supports_websockets=false");
    expect(args.join("\n")).not.toContain("127.0.0.1:9/v1");
  });
});

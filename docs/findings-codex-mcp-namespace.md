# Findings: Codex MCP calls refused when the provider drops `namespace`

Symptom: a bot on the `codex` driver against a vLLM OpenAI-compatible endpoint
refuses computer tools with `unsupported call: <tool>` while the built-in
browser is mounted, but the same calls succeed with `bot.browser = false`
(codex-cli 0.169.0, macOS).

## What was verified

Against codex-cli 0.169.0 itself, with a fake MCP server and a fake
`/v1/responses` endpoint:

- Codex advertises every MCP server's tools to the model as a
  `{"type":"namespace","name":"mcp__<server>","tools":[...]}` spec
  (observed: `mcp__computer`, `mcp__browser`, plus its internal
  `multi_agent_v1`).
- A `function_call` carrying `{name, namespace:"mcp__computer"}` routes.
- A `function_call` with the bare `name` is refused
  (`unsupported call: get_window_state`) even when that name is unique across
  all mounted servers.
- A `function_call` with the flattened `mcp__computer__get_window_state` and
  no `namespace` is refused the same way. Namespace-less calls never reach an
  MCP tool under codex 0.169.0.

Against vLLM (`vllm/entrypoints/responses_utils.py`, current):

- vLLM flattens each namespace's functions to `mcp__<server>__<tool>` for the
  model and restores `{name, namespace}` only on an exact flat-name match
  (`build_responses_tool_call_name_map` / `resolve_responses_tool_call_name`).
- Any other emitted name — e.g. the bare `get_window_state` — is returned
  without a namespace, which codex then refuses. The refusal therefore means
  the model emitted a name other than the flat form, not that routing is
  ambiguous.

## Why none of the three candidate fixes is viable

1. **Codex mount-time qualification/renaming.** Probed `-c` keys on 0.169.0:
   `mcp_servers.<name>.enabled_tools` / `.disabled_tools` are accepted (tool
   filters only); `tool_name_prefix`, `prefix`, `tools={...}` and
   `prefix_mcp_tool_names` are ignored as unrecognized. `wire_api="chat"`,
   which would expose flat function names, was removed upstream. There is no
   setting that renames tools or relaxes the namespace requirement.
2. **Not mounting overlapping servers.** The `browser` mount lists only
   `agent_browser_*` plus `restart_browser`
   (`server/browser/tools.ts` `TOOL_LIST`); the `computer` mount lists the
   Cua driver's `get_*_state`, `browser_*` and screen tools. The two lists
   share no tool name — there is no overlap to remove. Skipping `browser`
   does not make a namespace-less call routable; it only removes capability
   (and it happened to change the model's name emission in the observed
   run, which is model behaviour, not routing).
3. **Dropping colliding tool names.** Same reason: no two mounted servers
   expose the same tool name, so there is nothing deterministic to drop.

## Possible future fix (deliberately not implemented here)

The only deterministic repair is on the codex↔provider boundary: a localhost
shim in `model_providers.<p>.base_url` (OMB already writes this for
`endpoint`/`managed` configs) that learns each request's `type:"namespace"`
tool specs and injects `namespace` into namespace-less `function_call` items
when the emitted name resolves to exactly one namespace — flat
`mcp__x__tool` names and unique bare names both become routable; ambiguous
names still surface through the existing `unsupported call` diagnostic in
`server/drivers/codex-unsupported-calls.ts`. That is a new streaming proxy in
the request path, larger than the intended scope of this fix.

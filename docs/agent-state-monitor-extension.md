# Agent State Monitor Extension

This document describes the recommended way to monitor coarse runtime states for the coding-agent UI:

- `idle`
- `working`
- `pending_review`
- `need_question`

Use an **extension**, not the legacy hook subsystem. The default CLI runtime initializes the extension runner; `--hook` is currently treated as an alias for `--extension`, and tool/lifecycle interception goes through `ExtensionRunner`.

## State model

The runtime does not expose one native `state` enum with these exact values. Build it as a derived state machine from extension events and context helpers.

| State | Meaning | Primary signal | Clear signal |
| --- | --- | --- | --- |
| `idle` | Agent is not streaming and has no queued work | `ctx.isIdle() === true` and `ctx.hasPendingMessages() === false` | `agent_start`, `turn_start`, or queued message |
| `working` | Agent is actively processing a prompt/tool turn | `agent_start`, `turn_start`, `message_start`, `tool_execution_start` | `agent_end` / `turn_end` if no blocking state |
| `need_question` | Agent is waiting for user input from the `ask` tool | `tool_call` or `tool_execution_start` where `toolName === "ask"` | `tool_result` or `tool_execution_end` for `ask` |
| `pending_review` | Agent finished a work cycle that changed code and should be reviewed | `agent_end` after write/edit/exec-changing tools ran | explicit user command such as `/state-reviewed`, new prompt, or new working cycle |

`pending_review` is a policy state, not a built-in runtime state. Decide what counts as review-worthy. A practical default is: any successful turn that used `write`, `edit`, `ast_edit`, `bash`, `task`, or another mutating custom tool.

## Recommended implementation surface

Create a TypeScript extension module in one of these locations:

- project-local: `.omp/extensions/state-monitor.ts`
- user-global: `~/.omp/agent/extensions/state-monitor.ts`

Extensions are loaded at session startup. Restart `omp` after changing the extension file or config.

## Minimal extension

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

type AgentUiState = "idle" | "working" | "pending_review" | "need_question";

interface MonitorState {
  value: AgentUiState;
  dirty: boolean;
  activeQuestion: boolean;
  lastReason: string;
  updatedAt: number;
}

const CUSTOM_TYPE = "agent-state-monitor";
const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "ast_edit",
  "bash",
  "task",
]);

export default function stateMonitor(pi: ExtensionAPI): void {
  let state: MonitorState = {
    value: "idle",
    dirty: false,
    activeQuestion: false,
    lastReason: "session initialized",
    updatedAt: Date.now(),
  };

  function setState(value: AgentUiState, reason: string, ctx?: { ui?: { setStatus?: (key: string, text: string | undefined) => void } }) {
    state = { ...state, value, lastReason: reason, updatedAt: Date.now() };
    ctx?.ui?.setStatus?.("agent-state", `state: ${value}`);
    pi.appendEntry(CUSTOM_TYPE, state);
  }

  pi.on("session_start", async (_event, ctx) => {
    // Restore the latest persisted state if this session is resumed.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
        state = entry.data as MonitorState;
      }
    }

    const value = ctx.isIdle() && !ctx.hasPendingMessages() ? "idle" : "working";
    setState(value, "session_start", ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    state.dirty = false;
    state.activeQuestion = false;
    setState("working", "agent_start", ctx);
  });

  pi.on("turn_start", async (_event, ctx) => {
    setState("working", "turn_start", ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "ask") {
      state.activeQuestion = true;
      setState("need_question", "ask tool waiting for user input", ctx);
      return;
    }

    if (MUTATING_TOOLS.has(event.toolName)) {
      state.dirty = true;
    }

    if (!state.activeQuestion) {
      setState("working", `tool_call:${event.toolName}`, ctx);
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "ask") {
      state.activeQuestion = false;
      setState("working", "ask answered", ctx);
      return;
    }

    if (MUTATING_TOOLS.has(event.toolName) && !event.isError) {
      state.dirty = true;
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (state.activeQuestion) {
      setState("need_question", "agent ended while ask was active", ctx);
      return;
    }

    if (state.dirty) {
      setState("pending_review", "agent changed state that requires review", ctx);
      return;
    }

    const value = ctx.isIdle() && !ctx.hasPendingMessages() ? "idle" : "working";
    setState(value, "agent_end", ctx);
  });

  pi.registerCommand("state", {
    description: "Show current derived agent state",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`${state.value}: ${state.lastReason}`, "info");
    },
  });

  pi.registerCommand("state-reviewed", {
    description: "Mark pending review state as reviewed",
    handler: async (_args, ctx) => {
      state.dirty = false;
      state.activeQuestion = false;
      const value = ctx.isIdle() && !ctx.hasPendingMessages() ? "idle" : "working";
      setState(value, "review acknowledged", ctx);
    },
  });
}
```

## UI behavior

The extension above uses:

```ts
ctx.ui.setStatus("agent-state", `state: ${value}`)
```

This adds a small status segment to the interactive UI. Keep the status string short; it is shown in a constrained terminal area.

For a more visible monitor, use a widget instead:

```ts
ctx.ui.setWidget("agent-state", [`Agent state: ${value}`], { placement: "aboveEditor" });
```

Use one or the other by default. Do not spam notifications on every transition.

## State transition rules

Recommended transition policy:

```text
session_start
  -> idle if ctx.isIdle() && !ctx.hasPendingMessages()
  -> working otherwise

agent_start / turn_start
  -> working
  -> clear dirty=false only at agent_start

tool_call ask
  -> need_question
  -> activeQuestion=true

tool_result ask
  -> working
  -> activeQuestion=false

tool_call/tool_result mutating tool
  -> dirty=true
  -> stay working unless ask is active

agent_end
  -> need_question if activeQuestion
  -> pending_review if dirty
  -> idle if ctx.isIdle() && !ctx.hasPendingMessages()
  -> working otherwise

/state-reviewed
  -> clear dirty
  -> idle or working based on ctx helpers
```

## Choosing mutating tools

Start conservative:

```ts
const MUTATING_TOOLS = new Set(["write", "edit", "ast_edit", "bash", "task"]);
```

Then adjust:

- Include `browser` if browser actions are meaningful state changes for your workflow.
- Include MCP tools that write external state, e.g. names matching `mcp__.*__(create|update|delete).*`.
- Exclude `bash` only if you parse command content and can prove it is read-only. Treating all `bash` as mutating is safer.

## Persisting monitor state

Use `pi.appendEntry(customType, data)` for durable state. On `session_start`, rebuild from `ctx.sessionManager.getBranch()` by scanning for your `customType` and keeping the latest entry.

Do not store secrets or large payloads. Store only compact structured state:

```ts
{
  value: "pending_review",
  dirty: true,
  activeQuestion: false,
  lastReason: "tool_call:edit",
  updatedAt: 1779999999999
}
```

## Exporting state to external monitors

If another process needs to monitor state, write a small JSON file from the extension:

```ts
await Bun.write(
  `${ctx.cwd}/.omp/state-monitor.json`,
  JSON.stringify(state, null, 2),
);
```

Prefer project-local `.omp/state-monitor.json` for dashboards. Avoid writing into arbitrary global paths unless the user configured the destination.

## Failure behavior

State monitoring should be observability-only:

- Do not block tools from `tool_call` unless this extension is also enforcing policy.
- Catch and log non-critical write/export failures.
- Never let a monitor failure break coding-agent execution.

Example safe export wrapper:

```ts
async function exportState(ctx: { cwd: string }, state: MonitorState) {
  try {
    await Bun.write(`${ctx.cwd}/.omp/state-monitor.json`, JSON.stringify(state));
  } catch (error) {
    pi.logger.warn("State monitor export failed", { error: String(error) });
  }
}
```

## Testing checklist

After adding the extension, restart `omp` and verify:

1. Startup shows `state: idle`.
2. Submit a normal prompt; state changes to `working`.
3. Trigger an `ask` tool; state changes to `need_question` while the selector/input is open.
4. Answer the question; state returns to `working`.
5. Run an edit-producing task; after completion state becomes `pending_review`.
6. Run `/state-reviewed`; state returns to `idle` if no work is queued.
7. Resume the session; state restores from the latest persisted custom entry.

## Notes

- Hooks/extensions load at startup. Restart after editing extension files.
- `pending_review` is intentionally explicit and sticky. Do not auto-clear it on `agent_end`; require `/state-reviewed` or a clear user action.
- If the monitor is meant for subagents too, also observe `task` tool details or the shared subagent event bus. For top-level UI state, the lifecycle events above are sufficient.

## Context GC Discipline

You have access to context garbage-collection tools such as `context_inventory`, `context_unload`, `context_recall`, and `context_pin` when they are available. Use them to keep the working context small without losing task-critical information.

At every meaningful transition point, pause briefly and review whether previous context is still needed. Meaningful transition points include:
- after completing a phase, plan, step, subtask, investigation, implementation block, test/debug cycle, or file-writing phase;
- before switching from planning to implementation, implementation to testing, testing to debugging, debugging to finalization, or one skill/tooling mode to another;
- after receiving large tool outputs such as file reads, searches, bash/test logs, stack traces, generated plans, or task results;
- when context usage is high or older artifacts are unlikely to be needed in full.

When a context review is warranted, prefer this process:
1. Identify large or stale context items that are no longer needed in full.
2. Decide whether each item should be kept, pinned, unloaded, or recalled later if needed.
3. If unloading is safe, call `context_unload` with a concise but sufficient summary.
4. If exact details from an unloaded item are needed later, call `context_recall` before relying on them.
5. After using recalled content, consider unloading it again if it is no longer needed.

Unload context when all of the following are true:
- the item has served its immediate purpose;
- the next step does not require its exact raw content;
- a compact summary, file path, artifact id, verdict, or recall handle is enough to continue;
- unloading will not remove active instructions, unresolved decisions, or data needed for the next edit/test/action.

Good unload candidates include:
- completed plans that have already been written to a file or fully reflected in the current task state;
- old file reads whose exact line anchors are no longer needed;
- search results after the relevant facts, URLs, or decisions have been extracted;
- bash/test logs after preserving the verdict, failing command, failing lines, and next debugging action;
- debug traces after the bug has been fixed or the relevant cause has been summarized;
- tool outputs from completed subtasks;
- skills or skill instructions that no longer apply to the next phase;
- duplicate or superseded outputs;
- generated artifacts whose important path, purpose, and status have been preserved.

Do not unload:
- system, developer, safety, policy, AGENTS, repository, or user instructions;
- the latest user request or constraints;
- active plans, active TODOs, pending approvals, unresolved questions, or current acceptance criteria;
- context needed for the next immediate action;
- current file snippets, line numbers, diffs, or diagnostics needed for an imminent edit;
- unresolved error output, failing tests, stack traces, or logs that are still being investigated;
- active skill instructions still required for the current task;
- credentials, security-relevant constraints, compliance requirements, or environment assumptions;
- anything whose removal would force guessing.

When unloading, the summary must preserve enough information to continue safely. Include, as applicable:
- what the item contained;
- final decision or verdict;
- key facts and constraints;
- file paths, symbols, APIs, commands, test names, error names, and line references;
- what was changed or concluded;
- unresolved risks or follow-up actions;
- how to recall the full content if needed.

Use the `preserve` option appropriately:
- `facts` for extracted factual information, search results, completed analysis, and file-read summaries;
- `instructions` for non-active but potentially reusable procedural guidance;
- `debug-trace` for logs, stack traces, test output, and debugging history.

Use `context_pin` for items that must remain available because they are active, risky to summarize, or likely needed exactly in the next step.

Use `context_recall` conservatively:
- prefer bounded selectors such as ranges or search selectors;
- use raw/full recall only when exact full content is necessary;
- never rely on details from an unloaded item unless they are present in the retained summary or have been recalled.

Do not call context GC tools mechanically after every tiny action. Use them at meaningful boundaries or when there are large candidates. If the next response is the final answer and no further work will be done, do not spend extra steps unloading unless context pressure is harming the final answer.

Do not mention internal context GC activity to the user unless it directly affects the result or the user asks about it.

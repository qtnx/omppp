---
name: rtk
description: Use during implementation to transparently compress Bash command output without changing command semantics.
license: Apache-2.0
---

# RTK

RTK transparently reduces Bash output during implementation. Write normal Bash commands.
NEVER add an `rtk` prefix manually. The Bash tool rewrites supported commands
when `rtk.enabled` is true.

- Dedicated OMPx tools remain mandatory when a dedicated tool exists; do not replace them with Bash.
- When `rtk.enabled` is off, the `rtk` binary is missing, or rewriting fails, the original command runs.
- RTK changes output volume, not task semantics, command intent, exit behavior, or required verification.
- Read and act on compressed output exactly as you would read ordinary Bash output.

**Attribution:** Adapted from [rtk-ai/rtk](https://github.com/rtk-ai/rtk), Apache-2.0 licensed.

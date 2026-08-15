# secrets

> List the managed secrets available to the current session without revealing plaintext values.

## Source
- Entry: `packages/coding-agent/src/tools/secrets.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/secrets.md`
- Vault contract: `packages/coding-agent/src/secrets/vault.ts`
- Registration: `packages/coding-agent/src/tools/index.ts`
- Bash injection: `packages/coding-agent/src/tools/bash.ts`

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "essential"`.
- `SecretsTool.createIf(...)` registers the tool only when the session has an open secret vault.
- The tool is agent-facing and intentionally supports listing only. Adding, reading, copying, and removing values remain user-only CLI or `/secrets` operations.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `op` | `"list"` | Yes | List stored secret metadata. |

## Outputs
- `content[0].text` contains one line per secret with its name, mask, length, source, and creation time.
- `details.secrets` contains the same metadata as `VaultSecretMeta[]`.
- An empty vault returns `No secrets are stored. Add a secret with /secrets add <NAME> <VALUE>.`
- Plaintext secret values are never included in either output surface.

## Flow
1. `SecretsTool.createIf(session)` checks for `session.secretVault`.
2. `execute(...)` re-checks the vault and throws `Secrets are not available in this session.` if it disappeared.
3. `vault.list()` returns metadata only; the tool formats it for the model and TUI.
4. The response tells the model that each secret is exported to bash as an environment variable with the same name.

## Security Boundary
- The agent can reference a secret in bash as `$NAME`; the bash tool injects the value through the child-process environment rather than command text.
- Secret values are encrypted at rest by the vault and are masked in agent-facing listings.
- Tool results are passed through the session secret obfuscator before provider replay or transcript persistence, so echoed values become keyed placeholders.
- The tool has no operation that returns, copies, updates, or deletes plaintext secrets.

## Side Effects
- None. Listing does not mutate the vault, environment, session, or filesystem.

## Related Surfaces
- `ompx secrets` provides user-owned list/get/copy/add/remove operations. Plaintext output requires the explicit `get <NAME> --reveal` command.
- `/secrets` provides masked management inside the TUI while keeping secret-bearing command text out of recallable slash-command history.

Legacy compatibility tool for the active goal-mode objective.

Prefer get_goal, create_goal, and update_goal when they are available. Use this tool only when the legacy single-tool surface is the only goal tool exposed.

Single `op` field:
- `create`: starts goal; enables goal mode. Requires `objective`; optional positive `token_budget`. Only when no goal exists and none is paused.
- `get`: returns current active/paused goal and remaining token budget.
- `resume`: re-activates paused goal for continued work.
- `complete`: marks goal complete only when actually done and every deliverable verified against current evidence. NEVER because budget low or turn ending.
- `drop`: discards current goal without completing it.

Paused goal from `get` → MUST `resume` before continuing work.

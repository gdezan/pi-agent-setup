# Prewalk

A pi extension implementing the Stencil prewalk workflow: the current (frontier) model explores and creates a short todo list, then pi temporarily switches to a cheaper executor after a successful `todo` checklist and the first successful `edit` or `write`. When the agent run settles, pi restores the original guide model and automatically arms prewalk for the next user task. The handoff and restoration are recorded visibly in the transcript, and the active executor appears in Pi's status area while it is running.

## Usage

```sh
pi --prewalk --prewalk-into provider/model
```

Or from an interactive session. Omitting the model opens a live-searchable model picker, matching pi's `/model` search behavior:

```text
/prewalk                         # select executor model, then thinking level
/prewalk Fix the bug in ...
/prewalk provider/model Fix the bug in ...
/prewalk off
```

When `/prewalk` opens the executor model picker, choosing a model is followed by a thinking-level picker. Available levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The guide model's original thinking level is restored when prewalk completes.

### Commands

Prewalk stays armed across handoffs and automatically starts another cycle after restoring the guide model. Use `/prewalk off` (also `disarm`, `disable`, or `cancel`) to turn it off. If a handoff is already active, disarming also attempts to restore the original guide model.

If no executor is configured, prewalk still guides the exploration, leaves the current model in place after the first edit, shows a warning, and remains armed for the next task. The handoff is evaluated at `turn_end`, so a turn containing both the checklist and first edit is handled together.

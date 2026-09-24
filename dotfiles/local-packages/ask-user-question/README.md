# Private ask-user-question extension

This package replaces `@juicesharp/rpiv-ask-user-question` in the local Pi installation.

## Runtime behavior

- Registers the sequential `ask_user_question` tool.
- Prompts the agent to explain decision context and trade-offs before opening a questionnaire, and to make each question self-contained.
- Supports one to eight questions, single-select, multi-select, freeform answers, explicit Skip, review/submit for multi-question prompts, and RPC dialogs.
- Emits `herdr:blocked` while a questionnaire is waiting for input and clears it in `finally`.
- Escape cancels the entire questionnaire and returns a terminating tool result.
- Uses runtime validation with repairable field paths and generous safety limits rather than presentation-length schema limits.
- Registers `/answer`, which extracts questions from the latest eligible assistant message using the active session model at its lowest supported reasoning level, then immediately sends the collected answers as a user message.

## Optional configuration

Create `~/.pi/agent/ask-user-question.json`:

```json
{
  "collapseKey": "ctrl+]",
  "promptSnippet": "Ask the user structured questions when decisions are needed",
  "promptGuidelines": [
    "Use ask_user_question when requirements are ambiguous."
  ]
}
```

Set `collapseKey` to `"off"` to disable the overlay toggle.

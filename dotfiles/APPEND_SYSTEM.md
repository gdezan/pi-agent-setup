## Scope and completion

- **Intent:** Infer the intended outcome from the request, conversation, and project context. My
  prompts are often dictated; follow their meaning despite rough wording.
- **Authorization:** An exploratory question calls for an explanation and a proposed change, not an
  edit. Wait for the go-ahead, however small the fix. A request for a named change, such as "can you
  fix…", is that go-ahead.
- **Follow-ups:** After completion, offer one concrete next action when it follows naturally from my
  goal or addresses a consequential issue you observed. Explain why it matters and ask whether to
  proceed. Already-authorized work belongs in the task, not in a follow-up offer. Otherwise, end
  with the result.

## Communication

- **Plain language:** Lead with the answer, outcome, or recommendation. Use direct, concrete
  sentences about what something does, what changes, and why it matters. Omit preambles, repetition,
  closing filler, decorative metaphors, mannered prose, and praise or defense of your own approach.
- **Readability:** Group related information in short paragraphs and number sequential steps. Pick
  the smallest view that makes the key point clear.
- **Visuals:** Use a mermaid diagram, file layout, snippet, pseudocode, or diff when it explains the
  relevant structure, behavior, or change better than prose. Let it replace explanation rather than
  duplicate it.
- **Copy:** No em dashes in generated content such as emails or app copy.

## Engineering

- **Precedent:** Read the relevant code and look for a working sibling before designing an approach.
  Follow suitable project patterns. Make the smallest change that fully meets the requirement
- **Reuse:** Use existing dependencies before writing custom code or adding packages. Check their
  documentation and types before concluding they lack a capability. Prefer established, maintained
  and performant libraries when they reduce overall complexity, improve performance, or improve
  reliability. Don't reivent the wheel.
- **Comments:** Default to adding no code comments; improve code clarity instead. Add a brief
  comment only for an essential, non-obvious technical constraint or failure risk the code cannot
  reasonably express. Explain why the current code is necessary, not what it does or the
  conversation, request, or decision history.

## Research

- **Third-party behavior:** Consult official documentation for the version in use. When it leaves a
  gap or observed behavior differs, check local types/source and the relevant public issue tracker.
  Cite sources that materially support the conclusion.
- **Public-web search:** Use the provider's native web search first, then the `ketch` MCP if native
  search is unavailable or persistently failing. Use `agent_browser` for search only when neither is
  usable. This order does not restrict interactive browsing or web-interface verification.

## Verification

- **Focused checks:** Run cheap, focused checks during implementation. An early runtime probe must
  answer a concrete question cheaper checks cannot settle. Reserve expensive browser, emulator, and
  full-suite acceptance for the stable candidate after simplification and any required review.
- **Simplification:** After code implementation and before final verification, use the `simplify`
  skill to remove unnecessary complexity from the working diff without changing behavior. Keep
  unrelated code out of scope and already-lean code intact. If the skill is unavailable, perform an
  equivalent focused pass and disclose it.
- **Acceptance:** Keep the candidate stable while collecting all discoverable in-scope issues.
  Continue safe independent checks after a failure and mark dependent coverage blocked. Stop early
  only when continuing is unsafe or no meaningful checks remain. Fix collected issues together, then
  rerun failed, blocked, and plausibly affected coverage. Restart full acceptance only when changes
  invalidate that scope.
- **Visual work:** Inspect the actual output in its intended context, including relevant states and
  interactions. Perform a visual taste pass; a build or code review alone cannot verify appearance
  or interaction behavior. Use contact sheets to review images in batches and avoid reading each
  image individually.
- **Performance:** Measure the actual bottleneck before changing it. Compare the same workload
  before and after, report measurements and trade-offs, and preserve behavior.

### Tests

- Tautological tests considered harmful.
- Prefer a small number of high-value E2E tests of real workflows and observable outcomes. Add an
  isolated test only for an important failure mode E2E cannot practically verify. Unit tests are not
  the default; add tests for meaningful failure modes, not coverage for its own sake.
- Before implementing or fixing behavior that needs an isolated test, identify the relevant failure
  cases, write the failing tests, and confirm they fail for the expected reason.
- Make E2E verification reproducible: record the command, required setup or inputs, and result.
  Retain relevant reports, traces, or screenshots through existing tooling rather than creating a
  separate reporting mechanism.

# Scope and completion

- **Intent:** Infer the intended outcome from the request, conversation, and project context. My
  prompts are often dictated; follow their meaning despite rough wording. If something is unclear, ask.
- **Authorization:** An exploratory question calls for an explanation and a proposed change, not an
  edit. Wait for the go-ahead, however small the fix. A request for a named change, such as "can you
  fix…", is that go-ahead.
- **Follow-ups:** After completion, offer one concrete next action when it follows naturally from my
  goal or addresses a consequential issue you observed. Explain why it matters and ask whether to
  proceed. Already-authorized work belongs in the task, not in a follow-up offer. Otherwise, end
  with the result.

# Communicating clearly

Write for an intelligent but low-context reader. The person reading has not seen your tool calls,
your reasoning or the files you opened, and may be switching in from other work. Messages should
generally be self-contained: the reader should understand what you mean without having to dig for
other context. Put the key points in the first few sentences. Practice progressive disclosure in
your sentence order, and do not use undefined references and ideas in line 1 that won't make sense
until the reader reaches line 12.

Use plain words, and write in clear, understandable full sentences. Do not use a term or
abbreviation that you made up during the work. Say what the thing is in a way any reader would
understand. Write mostly in the style of ASD-STE100 Simplified Technical English: short sentences,
one idea per sentence, active voice, and consistently using the same word for the same thing. Use a
paragraph of flowing prose where ideas connect, and keep bullets for lists of separate items. Leave
out unnecessary details unless the reader asks and practice concision, but do ensure that your
messages have the key context. Aim to make your user-facing text as human-readable and clear as
possible.

If there are any blockers or decisions that need to be made, explicitly mention them. The reader shouldn't need
to decipher what's the next step. Make it clear what is it
that you need to keep going.

# Engineering

- **Reuse:** Use existing dependencies before writing custom code or adding packages. Check their
  documentation and types before concluding they lack a capability. Prefer established, maintained
  and performant libraries when they reduce overall complexity, improve performance, or improve
  reliability. Don't reivent the wheel.
- **Comments:** Default to adding no code comments; improve code clarity instead. Add a brief
  comment only for an essential, non-obvious technical constraint or failure risk the code cannot
  reasonably express. Explain why the current code is necessary, not what it does or the
  conversation, request, or decision history.

# Research

- **Third-party behavior:** Consult official documentation for the version in use. When it leaves a
  gap or observed behavior differs, check local types/source and the relevant public issue tracker.
  Cite sources that materially support the conclusion.

# Verification

- **Focused checks:** Run cheap, focused checks during implementation. An early runtime probe must
  answer a concrete question cheaper checks cannot settle. Reserve expensive browser, emulator, and
  full-suite acceptance for when a verification pass is explicitly asked.
- **Visual work:** Use contact sheets to review images in batches and avoid reading each image
  individually.
- **Performance:** Measure the actual bottleneck before changing it. Compare the same workload
  before and after, report measurements and trade-offs, and preserve behavior.

# Tests

- Tautological tests considered harmful.
- Add an isolated test only for an important failure mode E2E cannot practically verify.
- Unit tests are to be avoided.
- Before implementing or fixing behavior that needs an isolated test, identify the relevant failure
  cases, write the failing tests, and confirm they fail for the expected reason.
- Make E2E verification reproducible: record the command, required setup or inputs, and result.
  Retain relevant reports, traces, or screenshots through existing tooling rather than creating a
  separate reporting mechanism.

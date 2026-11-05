// Pi reports its built-in dialogs over OSC 7501 itself, but this questionnaire is a
// custom TUI overlay that reporter never sees. Report it the same way so a terminal
// (Herdr Core, and Scoutr through it) shows the session as waiting for an answer.
// Pi sends reports only after the terminal confirms support, which an extension cannot
// observe; Herdr Core supports the protocol, and PI_PROGRAM_STATUS=1 forces reports.

const QUESTION_BLOCKED = "\x1b]7501;state=blocked:app=pi:kind=question\x1b\\";
const IDLE = "\x1b]7501;state=idle:app=pi\x1b\\";
const WORKING = "\x1b]7501;state=working:app=pi\x1b\\";

export function questionStatusReport(
  active: boolean,
  idle: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.PI_PROGRAM_STATUS === "0") return;
  if (env.PI_PROGRAM_STATUS !== "1" && !env.HC_TERMINAL_ID) return;
  if (active) return QUESTION_BLOCKED;
  return idle ? IDLE : WORKING;
}

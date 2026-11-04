import {
  MAX_FIELD_LENGTH,
  SKIP_LABEL,
  TYPE_SOMETHING_LABEL,
  type AskQuestion,
  type AskQuestionAnswer,
  type AskQuestionnaire,
  type QuestionnaireRunResult,
} from "./ask-user-types.ts";

export type DialogUI = {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
};

/** Return whether an RPC host exposes the native select/input dialog primitives. */
export function hasAskUserDialogUI(ui: unknown): ui is DialogUI {
  const value = ui as Partial<DialogUI> | undefined;
  return typeof value?.select === "function" && typeof value?.input === "function";
}

/** Walk a questionnaire through Pi's native RPC dialogs. Escape cancels everything. */
export async function runRpcQuestionnaire(
  ui: DialogUI,
  questionnaire: AskQuestionnaire,
): Promise<QuestionnaireRunResult> {
  const answers: AskQuestionAnswer[] = [];
  for (const question of questionnaire.questions) {
    const answer = question.multiSelect
      ? await askRpcMultiSelect(ui, question)
      : await askRpcSingleSelect(ui, question);
    if (!answer) return { answers: [], cancelled: true };
    answers.push(answer);
  }
  return { answers, cancelled: false };
}

async function askRpcSingleSelect(
  ui: DialogUI,
  question: AskQuestion,
): Promise<AskQuestionAnswer | undefined> {
  const options = [
    ...question.options.map(
      (option, index) => `${index + 1}. ${option.label} — ${option.description}`,
    ),
    `${question.options.length + 1}. ${TYPE_SOMETHING_LABEL}`,
    `${question.options.length + 2}. ${SKIP_LABEL}`,
  ];
  const selected = await ui.select(`[${question.header}] ${question.question}`, options);
  if (selected === undefined) return undefined;
  const index = parseDialogIndex(selected, options.length);
  if (index === null) return undefined;
  if (index < question.options.length) {
    if (question.freeformOnly)
      return index === 0 ? askRpcCustomAnswer(ui, question) : skippedAnswer(question);
    const option = question.options[index];
    return {
      questionId: question.id,
      question: question.question,
      kind: "option",
      answer: option.label,
    };
  }
  if (index === question.options.length) return askRpcCustomAnswer(ui, question);
  return skippedAnswer(question);
}

async function askRpcMultiSelect(
  ui: DialogUI,
  question: AskQuestion,
): Promise<AskQuestionAnswer | undefined> {
  const optionList = question.options
    .map((option, index) => `${index + 1}. ${option.label} — ${option.description}`)
    .join("\n");
  const typed = await ui.input(
    `[${question.header}] ${question.question}\n\n${optionList}\n\nEnter comma-separated numbers, ${TYPE_SOMETHING_LABEL}, or ${SKIP_LABEL}.`,
    "1,2",
  );
  if (typed === undefined) return undefined;
  const value = typed.trim();
  if (value.toLowerCase() === SKIP_LABEL.toLowerCase()) return skippedAnswer(question);
  if (value.toLowerCase() === TYPE_SOMETHING_LABEL.toLowerCase())
    return askRpcCustomAnswer(ui, question);
  const indices = value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((token) => parseDialogIndex(token, question.options.length));
  if (indices.length === 0 || indices.some((index): index is null => index === null)) {
    return value.length <= MAX_FIELD_LENGTH
      ? { questionId: question.id, question: question.question, kind: "custom", answer: value }
      : undefined;
  }
  const selected = [...new Set(indices.map((index) => question.options[index as number].label))];
  return {
    questionId: question.id,
    question: question.question,
    kind: "multi",
    answer: null,
    selected,
  };
}

async function askRpcCustomAnswer(
  ui: DialogUI,
  question: AskQuestion,
): Promise<AskQuestionAnswer | undefined> {
  let title = `[${question.header}] ${TYPE_SOMETHING_LABEL}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const typed = await ui.input(title, "Type your answer");
    if (typed === undefined || typed.trim().length === 0) return undefined;
    const answer = typed.trim();
    if (answer.length <= MAX_FIELD_LENGTH) {
      return { questionId: question.id, question: question.question, kind: "custom", answer };
    }
    title = `[${question.header}] Answer is too long; use at most ${MAX_FIELD_LENGTH} characters.`;
  }
  return undefined;
}

function skippedAnswer(question: AskQuestion): AskQuestionAnswer {
  return {
    questionId: question.id,
    question: question.question,
    kind: "skipped",
    answer: null,
  };
}

function parseDialogIndex(value: string, count: number): number | null {
  const parsed = Number.parseInt(value, 10) - 1;
  return parsed >= 0 && parsed < count ? parsed : null;
}

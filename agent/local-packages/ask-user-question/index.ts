import { completeSimple, getSupportedThinkingLevels, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadAskUserConfig, resolveAskUserCollapseKey } from "./ask-user-config.js";
import { hasAskUserDialogUI, runRpcQuestionnaire } from "./ask-user-dialog.js";
import {
	buildFreeformFallbackQuestionnaire,
	parseExtractedQuestionnaire,
	type ExtractionResult,
} from "./ask-user-extraction.js";
import { buildAnswerMessage, buildAskUserToolResult } from "./ask-user-response.js";
import { AskUserQuestionParamsSchema } from "./ask-user-schema.js";
import type {
	AskQuestionnaire,
	AskQuestionnaireDetails,
	AskQuestionnaireInput,
	QuestionnaireRunResult,
} from "./ask-user-types.js";
import { validateAskQuestionnaire } from "./ask-user-validation.js";
import { runTuiQuestionnaire } from "./ask-user-ui.js";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
export const ANSWER_COMMAND_NAME = "answer";
export const HERDR_BLOCKED_EVENT = "herdr:blocked";

const TOOL_DESCRIPTION = `Ask the user one or more structured questions during execution. Use this when you need concrete decisions before continuing.

Ask one to four questions in a single call. Each question needs two to four authored options, and every question also gets Type something and Skip actions automatically. Use multiSelect when more than one authored option can be selected. Escape cancels the entire questionnaire and stops the current agent run.`;

const DEFAULT_PROMPT_SNIPPET = "Ask the user up to 4 structured questions when requirements are ambiguous";
const DEFAULT_PROMPT_GUIDELINES = [
	"Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions.",
	"Group related clarifying questions into one call. Ask one to four questions, with two to four distinct options per question.",
	"Every option requires a useful description. Do not author Type something or Skip options; those actions are added automatically.",
	"Use multiSelect when multiple authored options may be selected. Treat cancellation as a hard stop and do not guess the user's answer.",
];

const EXTRACTION_SYSTEM_PROMPT = `You extract actionable questions from a completed assistant message.
Return JSON only, with this exact shape:
{"questions":[{"id":"q1","header":"Short label","question":"Question text?","multiSelect":false,"options":[{"label":"Choice","description":"What choosing it means."}]}]}
Rules:
- Extract only questions or decisions that still need a user answer.
- Keep questions in their original order and make them concise without changing their meaning.
- Return at most four questions.
- Every question must have two to four distinct concrete options and a useful description for each option.
- For open-ended questions, include reasonable choices plus a freeform path; do not author options named Other, Next, Type something, or Skip.
- Use stable IDs such as q1, q2. Use multiSelect only when multiple choices may be selected.
- If there are no questions that need an answer, return {"questions":[]}.
Do not wrap the JSON in Markdown fences and do not include commentary.`;

/** Register the replacement ask_user_question tool and the manual /answer command. */
export default function registerAskUserQuestion(pi: ExtensionAPI): void {
	const config = loadAskUserConfig();
	const promptSnippet = config.promptSnippet || DEFAULT_PROMPT_SNIPPET;
	const promptGuidelines = config.promptGuidelines?.length ? config.promptGuidelines : DEFAULT_PROMPT_GUIDELINES;

	pi.registerTool({
		name: ASK_USER_QUESTION_TOOL_NAME,
		label: "Ask User Questions",
		description: TOOL_DESCRIPTION,
		promptSnippet,
		promptGuidelines,
		parameters: AskUserQuestionParamsSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const input = params as unknown as AskQuestionnaireInput;
			const validation = validateAskQuestionnaire(input);
			if (!validation.ok) {
				return {
					content: [{ type: "text", text: validation.message }],
					details: { questions: [], answers: [], cancelled: true, error: validation.error } satisfies AskQuestionnaireDetails,
				};
			}
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Ask user could not show the questions: this run has no UI (no_ui). The user did not decline; ask the questions as normal chat text instead." }],
					details: { questions: validation.questionnaire.questions, answers: [], cancelled: true, error: "no_ui" } satisfies AskQuestionnaireDetails,
				};
			}

			const collected = await collectQuestionnaire(pi, ctx, validation.questionnaire);
			if (collected.kind === "error") {
				return {
					content: [{ type: "text", text: collected.message }],
					details: { questions: validation.questionnaire.questions, answers: [], cancelled: true, error: collected.error } satisfies AskQuestionnaireDetails,
				};
			}

			const result = buildAskUserToolResult(validation.questionnaire, collected.result);
			if (collected.result.cancelled) ctx.abort();
			return result;
		},
		renderCall(args, theme) {
			const count = Array.isArray(args.questions) ? args.questions.length : 0;
			return new Text(theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`), 0, 0);
		},
		renderResult(result, _options, theme, _context) {
			const details = result.details as AskQuestionnaireDetails | undefined;
			if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
			if (details.error) return new Text(theme.fg("warning", `Not shown (${details.error})`), 0, 0);
			if (details.cancelled) return new Text(theme.fg("warning", "Cancelled — agent stopped"), 0, 0);
			const lines = details.answers.map((answer) => {
				const value = answer.kind === "skipped"
					? "Skipped explicitly"
					: answer.kind === "multi"
						? answer.selected?.join(", ") || "No options selected"
						: answer.answer || "";
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.questionId)}: ${theme.fg("muted", value)}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerCommand(ANSWER_COMMAND_NAME, {
		description: "Extract questions from the last assistant message and answer them",
		handler: async (_args, ctx) => {
			await answerLastAssistantMessage(pi, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const registered = pi.getAllTools().find((tool) => tool.name === ASK_USER_QUESTION_TOOL_NAME);
		if (registered && registered.description !== TOOL_DESCRIPTION) {
			ctx.ui.notify("ask_user_question has another owner. Disable the conflicting extension; this replacement will not silently override it.", "error");
			ctx.shutdown();
		}
	});
}

async function collectQuestionnaire(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	questionnaire: AskQuestionnaire,
): Promise<{ kind: "result"; result: QuestionnaireRunResult } | { kind: "error"; error: string; message: string }> {
	if (ctx.mode === "rpc" && hasAskUserDialogUI(ctx.ui)) {
		return withHerdrBlocked(pi, "Waiting for your answer", async () => ({
			kind: "result",
			result: await runRpcQuestionnaire(ctx.ui, questionnaire),
		}));
	}
	if (ctx.mode === "tui") {
		return withHerdrBlocked(pi, "Waiting for your answer", async () => {
			const result = await runTuiQuestionnaire(ctx.ui, questionnaire, resolveAskUserCollapseKey(loadAskUserConfig()));
			if (result) return { kind: "result", result };
			return {
				kind: "error" as const,
				error: "no_custom_ui",
				message: "Ask user could not render its questionnaire UI. The user did not see the questions; ask them as normal chat text instead.",
			};
		});
	}
	if (ctx.mode === "rpc") {
		return {
			kind: "error",
			error: "no_custom_ui",
			message: "Ask user could not render questionnaire dialogs in this RPC host. The user did not see the questions; ask them as normal chat text instead.",
		};
	}
	return {
		kind: "error",
		error: "no_ui",
		message: "Ask user could not show the questions in this run. The user did not decline; ask the questions as normal chat text instead.",
	};
}

async function withHerdrBlocked<T>(pi: ExtensionAPI, label: string, operation: () => Promise<T>): Promise<T> {
	pi.events.emit(HERDR_BLOCKED_EVENT, { active: true, label });
	try {
		return await operation();
	} finally {
		pi.events.emit(HERDR_BLOCKED_EVENT, { active: false, label });
	}
}

async function answerLastAssistantMessage(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/answer requires a UI so you can answer the extracted questions.", "error");
		return;
	}
	const branch = ctx.sessionManager.getBranch();
	const lastUserIndex = findLastUserMessageIndex(branch);
	const assistant = findLastAssistantMessage(branch, lastUserIndex);
	if (!assistant) {
		ctx.ui.notify("No assistant message is available to answer.", "error");
		return;
	}
	if (hasSuccessfulAskUserResultForAssistant(branch, assistant)) {
		ctx.ui.notify("The latest assistant question was already answered with ask_user_question.", "info");
		return;
	}
	if (assistant.message.stopReason !== "stop") {
		ctx.ui.notify(`The latest assistant message is incomplete (${assistant.message.stopReason}).`, "error");
		return;
	}
	const assistantText = assistantTextContent(assistant.message);
	if (!assistantText.trim()) {
		ctx.ui.notify("The latest assistant message has no text to extract questions from.", "info");
		return;
	}
	if (!ctx.model) {
		ctx.ui.notify("No model is selected for question extraction.", "error");
		return;
	}

	ctx.ui.notify(`Extracting questions with ${ctx.model.id} at the lowest available reasoning effort…`, "info");
	let extraction: ExtractionResult;
	try {
		extraction = await extractQuestionsWithCurrentModel(ctx, assistantText);
	} catch (error) {
		ctx.ui.notify(`Question extraction failed (${error instanceof Error ? error.message : String(error)}); showing one freeform fallback question.`, "warning");
		extraction = { kind: "invalid" };
	}
	if (extraction.kind === "none") {
		ctx.ui.notify("No unanswered questions were found in the latest assistant message.", "info");
		return;
	}
	const questionnaire = extraction.kind === "questions" ? extraction.questionnaire : buildFreeformFallbackQuestionnaire(assistantText);
	const collected = await collectQuestionnaire(pi, ctx, questionnaire);
	if (collected.kind === "error") {
		ctx.ui.notify(collected.message, "error");
		return;
	}
	if (collected.result.cancelled) {
		ctx.ui.notify("Answer cancelled; nothing was sent to the agent.", "info");
		return;
	}
	if (ctx.isIdle()) pi.sendUserMessage(buildAnswerMessage(questionnaire, collected.result.answers));
	else pi.sendUserMessage(buildAnswerMessage(questionnaire, collected.result.answers), { deliverAs: "followUp" });
}

async function extractQuestionsWithCurrentModel(ctx: ExtensionCommandContext, assistantText: string): Promise<ExtractionResult> {
	const model = ctx.model;
	if (!model) throw new Error("No model is selected");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	const message: UserMessage = {
		role: "user",
		content: [{ type: "text", text: assistantText.slice(-60000) }],
		timestamp: Date.now(),
	};
	const lowest = getSupportedThinkingLevels(model)[0] ?? "off";
	const extractionModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
	const response = await completeSimple(
		extractionModel,
		{ systemPrompt: EXTRACTION_SYSTEM_PROMPT, messages: [message] },
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			maxTokens: 4096,
			reasoning: lowest === "off" ? undefined : lowest,
		},
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage || `Nested model stopped with ${response.stopReason}`);
	}
	return parseExtractedQuestionnaire(assistantTextContent(response));
}

function findLastUserMessageIndex(branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>): number {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "user") return index;
	}
	return -1;
}

function hasSuccessfulAskUserResultForAssistant(
	branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
	assistant: { index: number; message: { content: unknown[] } },
): boolean {
	const askedQuestion = assistant.message.content.some(
		(part) => part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall" && (part as { name?: unknown }).name === ASK_USER_QUESTION_TOOL_NAME,
	);
	if (!askedQuestion) return false;
	for (let index = assistant.index + 1; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "user") return false;
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === ASK_USER_QUESTION_TOOL_NAME && !entry.message.isError) {
			const details = entry.message.details as { cancelled?: unknown } | undefined;
			if (details?.cancelled !== true) return true;
		}
	}
	return false;
}

function findLastAssistantMessage(branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>, afterIndex: number) {
	for (let index = branch.length - 1; index > afterIndex; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "assistant") return { index, message: entry.message };
	}
	return undefined;
}

function assistantTextContent(message: { content: unknown[] }): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"))
		.map((part) => part.text)
		.join("\n");
}

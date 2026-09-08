import { Type } from "typebox";

/** Broad structural schema for ask_user_question; semantic limits are checked in execute(). */
export const AskOptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.String({ description: "What this option means and its trade-offs" }),
});

export const AskQuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable question ID; generated when omitted" })),
	question: Type.String({ description: "The complete question to ask the user" }),
	header: Type.String({ description: "Short label shown in the question tabs" }),
	options: Type.Array(AskOptionSchema, { description: "Two to four authored choices" }),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple authored choices" })),
});

export const AskUserQuestionParamsSchema = Type.Object({
	questions: Type.Array(AskQuestionSchema, { description: "One to four questions" }),
});

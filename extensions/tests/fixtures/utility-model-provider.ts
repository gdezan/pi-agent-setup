import { appendFileSync } from "node:fs";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function utilityModelTestProvider(pi: ExtensionAPI): void {
  pi.registerProvider("utility-test", {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "test-only",
    api: "utility-test-api",
    models: ["conversation", "utility", "alternate"].map((id) => ({
      id,
      name: `Fixture ${id}`,
      reasoning: true,
      input: ["text"],
      contextWindow: 32_000,
      maxTokens: 2_000,
      cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    })),
    streamSimple: (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      const system = getCurrentSystemPrompt(context.messages);
      const kind = system.includes("Predict the next message")
        ? "suggestion"
        : system.includes("display names")
          ? "naming"
          : "conversation";
      const text =
        kind === "suggestion"
          ? "Yes, implement the fix"
          : kind === "naming"
            ? "Utility model fixture session"
            : "I can implement the fix and verify it. Shall I proceed?";
      const message: AssistantMessage = {
        role: "assistant",
        provider: model.provider,
        model: model.id,
        api: model.api,
        timestamp: Date.now(),
        stopReason: "stop",
        content: [],
        usage: {
          input: 100,
          output: 25,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 125,
          cost: {
            input: 0.00001,
            output: 0.0000125,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.0000225,
          },
        },
      };
      const record = (phase: string) => {
        if (process.env.PI_UTILITY_TEST_LOG)
          appendFileSync(
            process.env.PI_UTILITY_TEST_LOG,
            `${JSON.stringify({ kind, phase, model: model.id, reasoning: options?.reasoning, maxTokens: options?.maxTokens })}\n`,
          );
      };
      record("started");
      const timer = setTimeout(
        () => {
          stream.push({ type: "start", partial: message });
          message.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          message.content[0] = { type: "text", text };
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
          record("finished");
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        },
        kind === "suggestion" ? 700 : 30,
      );
      options?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          message.stopReason = "aborted";
          message.errorMessage = "Fixture request cancelled";
          record("aborted");
          stream.push({ type: "error", reason: "aborted", error: message });
          stream.end();
        },
        { once: true },
      );
      return stream;
    },
  });
}

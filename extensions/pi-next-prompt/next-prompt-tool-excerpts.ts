import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

const MAX_RESULTS = 8;
const SCAN_EDGE_CHARS = 8_000;
const MAX_LINE_CHARS = 300;
const DIAGNOSTIC =
  /^(?:FAIL(?:ED)?\s+\S|[^\s:]+:\d+(?::\d+)?(?::\s*(?:error|warning)\b|\s+MD\d+\b))|\b(?:lint error|\d+\s+failed)\b/iu;
const SENSITIVE_LINE =
  /(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|private[-_ ]?key|password|authorization|(?:^|[\s"'._-])(?:secret|token))["']?\s*[:=]|\b(?:Bearer\s+\S|BEGIN [A-Z ]*PRIVATE KEY)\b/iu;
const COMMON_WORDS = new Set(
  "about after again also and are before can check could does done find fix for from has have here how into just like make need not one only other out please result results run same see setting should some than that the their them then there these they this those through tool use using want was were what when where which while will with work would you your".split(
    " ",
  ),
);

function terms(text: string): Set<string> {
  const words = text
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .match(/[\p{L}][\p{L}\p{N}]{2,}/gu);
  return new Set(words?.filter((word) => !COMMON_WORDS.has(word)));
}

function linesToScan(text: string): string[] {
  if (text.length <= SCAN_EDGE_CHARS * 2) return text.split("\n");
  return [
    ...text.slice(0, SCAN_EDGE_CHARS).split("\n").slice(0, -1),
    ...text.slice(-SCAN_EDGE_CHARS).split("\n").slice(1),
  ];
}

export function selectNextPromptToolExcerpts(
  entries: readonly ProjectedSessionEntry[],
  user: string,
  assistant: string,
): string[] {
  const latestReply = entries.findLastIndex(
    ({ sourceEntry }) => sourceEntry.type === "message" && sourceEntry.message.role === "assistant",
  );
  const candidates = new Map<string, number>();
  const userTerms = terms(user);
  const assistantTerms = terms(assistant);
  const reply = assistant.toLowerCase();
  let results = 0;

  for (let i = latestReply - 1; i >= 0 && results < MAX_RESULTS; i--) {
    const { sourceEntry, messages } = entries[i];
    if (sourceEntry.type !== "message") continue;
    if (sourceEntry.message.role === "user") break;
    const result = messages[0];
    if (sourceEntry.message.role !== "toolResult" || result?.role !== "toolResult") continue;
    results++;
    for (const block of result.content) {
      if (block.type !== "text") continue;
      for (const raw of linesToScan(block.text)) {
        if (raw.length > MAX_LINE_CHARS * 2) continue;
        const line = stripTerminalSequences(raw).trim().replace(/\t/gu, " ");
        if (
          !line ||
          line.length > MAX_LINE_CHARS ||
          /[\p{Cc}\p{Zl}\p{Zp}]/u.test(line) ||
          SENSITIVE_LINE.test(line) ||
          reply.includes(line.toLowerCase()) ||
          candidates.has(line)
        )
          continue;
        let score = DIAGNOSTIC.test(line) ? 4 : 0;
        for (const term of terms(line)) {
          if (userTerms.has(term)) score += 3;
          else if (assistantTerms.has(term)) score += 2;
        }
        if (score >= 3) candidates.set(line, score);
      }
    }
  }

  return [...candidates]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([line]) => line);
}

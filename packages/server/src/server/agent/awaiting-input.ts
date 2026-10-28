const FENCED_CODE_BLOCK = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_SPAN = /`[^`\n]*`/g;
const SENTENCE_ENDING_QUESTION_MARK = /\?(?:$|[\s)*_"'])/;
const NEXT_YOU_LINE =
  /^\s*(?:[-*]\s+)?(?:\*\*|__)?Next(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*(?:you|your)\b/i;
const TAIL_LINE_COUNT = 3;

/**
 * True when an assistant message ends by handing the next step to the user: a question in
 * one of its last three non-empty lines, or a closing "Next: you ..." line. Code blocks and
 * inline code are ignored so `a ? b : c` and URL query strings do not count.
 */
export function endsWithQuestionToUser(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }
  const prose = text.replace(FENCED_CODE_BLOCK, "\n").replace(INLINE_CODE_SPAN, "");
  const tail = prose
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-TAIL_LINE_COUNT);
  return tail.some((line) => SENTENCE_ENDING_QUESTION_MARK.test(line) || NEXT_YOU_LINE.test(line));
}

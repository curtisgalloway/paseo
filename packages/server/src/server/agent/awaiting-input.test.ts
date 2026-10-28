import { describe, expect, it } from "vitest";
import { endsWithQuestionToUser } from "./awaiting-input.js";

describe("endsWithQuestionToUser", () => {
  it("detects a closing question", () => {
    expect(endsWithQuestionToUser("Should I go ahead?")).toBe(true);
  });

  it("detects a question wrapped in markdown emphasis or quotes", () => {
    expect(endsWithQuestionToUser("Plan is ready.\n\n**Want me to start?**")).toBe(true);
    expect(endsWithQuestionToUser('Shall I use "main"?')).toBe(true);
    expect(endsWithQuestionToUser("Ship it (yes?)")).toBe(true);
  });

  it("is false for a plain statement", () => {
    expect(endsWithQuestionToUser("Done. All tests pass.")).toBe(false);
  });

  it("treats a closing Next: you line as a handoff", () => {
    expect(endsWithQuestionToUser('**Next:** you say "go". Then: I start step 1.')).toBe(true);
    expect(endsWithQuestionToUser("Summary.\n- Next: your call on the schema")).toBe(true);
  });

  it("does not treat a Next line about the agent as a handoff", () => {
    expect(endsWithQuestionToUser("**Next:** I run the tests. **Last step.**")).toBe(false);
  });

  it("ignores a question mark inside a code fence", () => {
    expect(endsWithQuestionToUser("Here is the code:\n```js\nconst x = a ? b : c?\n```")).toBe(
      false,
    );
  });

  it("ignores a question mark inside inline code", () => {
    expect(endsWithQuestionToUser("The operator is `a ?` in this grammar.")).toBe(false);
  });

  it("ignores a question mark in a URL query string", () => {
    expect(endsWithQuestionToUser("see https://x.test/a?b=1 for details.")).toBe(false);
  });

  it("ignores a question outside the last three non-empty lines", () => {
    const text = "Should I go ahead?\n\nI already did.\n\nAll tests pass.\nCommitted.";
    expect(endsWithQuestionToUser(text)).toBe(false);
  });

  it("finds a question within the last three non-empty lines", () => {
    const text = "Done with the refactor.\n\nOne decision left.\n\nKeep the old API?\n";
    expect(endsWithQuestionToUser(text)).toBe(true);
  });

  it("is false for empty or missing text", () => {
    expect(endsWithQuestionToUser("")).toBe(false);
    expect(endsWithQuestionToUser(null)).toBe(false);
    expect(endsWithQuestionToUser(undefined)).toBe(false);
  });
});

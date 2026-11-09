import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseResult } from "./dispatch.ts";
import {
  classifyEnd,
  endReason,
  exhaustedResetAt,
  formatResetAt,
  pauseUntil,
} from "./session-end.ts";
import { type Activity, emptyActivity, foldEvent } from "./stream.ts";

const now = "2026-11-09T21:34:00.000Z";

/** A recorded session: the activity foreman folds from its stream, and the parsed result line. */
function session(name: string) {
  const text = readFileSync(join(import.meta.dirname, `../test/fixtures/${name}.jsonl`), "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  let activity: Activity = emptyActivity();
  for (const l of lines) activity = foldEvent(activity, l, now, "/work/794").activity;
  return { activity, result: parseResult(text, false) };
}

describe("classifyEnd", () => {
  it("names a usage limit and takes the reset time from the rate-limit event", () => {
    const { activity, result } = session("refusal-usage-limit");
    expect(result.subtype).toBe("success");
    expect(classifyEnd(result, activity)).toEqual({
      cause: "usage_limit",
      requestId: null,
      resetsAt: "2026-11-09T22:50:00.000Z",
    });
  });

  it("names a usage limit from the text alone, with no rate-limit event", () => {
    const end = classifyEnd(
      { resultText: "You've hit your session limit · resets 6:40pm", stderr: "" },
      emptyActivity(),
    );
    expect(end.cause).toBe("usage_limit");
    expect(end.resetsAt).toBeNull();
  });

  it("names a usage limit from a spent window alone, whatever the text says", () => {
    const activity: Activity = {
      ...emptyActivity(),
      rateLimit: {
        fiveHour: 0.5,
        sevenDay: 1,
        resetsAt: "2026-11-09T22:50:00.000Z",
        sevenDayResetsAt: "2026-11-13T00:00:00.000Z",
      },
    };
    expect(classifyEnd({ resultText: null, stderr: "" }, activity)).toEqual({
      cause: "usage_limit",
      requestId: null,
      resetsAt: "2026-11-13T00:00:00.000Z",
    });
  });

  it("names a safeguard flag and pulls out its request id", () => {
    const { activity, result } = session("refusal-safeguard");
    expect(result.subtype).toBe("success");
    expect(classifyEnd(result, activity)).toEqual({
      cause: "safeguard",
      requestId: "req_011Cgt4qVTW9B5dwTGegArfo",
      resetsAt: null,
    });
  });

  it("finds a safeguard flag in the streamed text when the result carries none", () => {
    const { activity } = session("refusal-safeguard");
    expect(classifyEnd({ resultText: null, stderr: "" }, activity).cause).toBe("safeguard");
  });

  it("calls a session that ends with neither text, and no spent window, other", () => {
    const { activity, result } = session("refusal-none");
    expect(classifyEnd(result, activity)).toEqual({
      cause: "other",
      requestId: null,
      resetsAt: null,
    });
    expect(classifyEnd({ resultText: null, stderr: "" }, emptyActivity()).cause).toBe("other");
  });
});

describe("exhaustedResetAt", () => {
  it("is the reset of the spent window, and null while every window has room", () => {
    expect(exhaustedResetAt(session("refusal-usage-limit").activity)).toBe(
      "2026-11-09T22:50:00.000Z",
    );
    expect(exhaustedResetAt(session("refusal-none").activity)).toBeNull();
    expect(exhaustedResetAt(emptyActivity())).toBeNull();
  });
});

describe("pauseUntil", () => {
  it("adds a small margin to a reset time still ahead", () => {
    expect(pauseUntil("2026-11-09T22:50:00.000Z", now)).toBe("2026-11-09T22:52:00.000Z");
  });
  it("falls back to a fixed pause when the reset time is unknown or already past", () => {
    expect(pauseUntil(null, now)).toBe("2026-11-09T22:04:00.000Z");
    expect(pauseUntil("2026-11-09T20:00:00.000Z", now)).toBe("2026-11-09T22:04:00.000Z");
  });
});

describe("formatResetAt", () => {
  it("is a clock time within a day and a dated time beyond", () => {
    expect(formatResetAt("2026-11-09T22:52:00.000Z", now)).toBe("22:52Z");
    expect(formatResetAt("2026-11-13T00:02:00.000Z", now)).toBe("2026-11-13 00:02Z");
  });
});

describe("endReason", () => {
  const base = { timedOut: false, subtype: "success" };
  it("keeps today's wording when the cause is other", () => {
    expect(endReason({ ...base, end: undefined })).toBe("success after retries");
    expect(endReason({ ...base, timedOut: true, end: undefined })).toBe("timed out after retries");
    expect(endReason({ ...base, end: { cause: "other", requestId: null, resetsAt: null } })).toBe(
      "success after retries",
    );
  });
  it("names a safeguard flag, how many sessions it stopped, and the request ids", () => {
    expect(
      endReason({
        ...base,
        end: { cause: "safeguard", requestId: "req_b", resetsAt: null },
        flagged: ["req_a", "req_b"],
      }),
    ).toBe("safeguard flag on 2 sessions (req_a, req_b)");
    expect(
      endReason({
        ...base,
        end: { cause: "safeguard", requestId: null, resetsAt: null },
        flagged: [null],
      }),
    ).toBe("safeguard flag on 1 session");
  });
  it("names a usage limit", () => {
    expect(
      endReason({
        ...base,
        end: { cause: "usage_limit", requestId: null, resetsAt: "2026-11-09T22:50:00.000Z" },
      }),
    ).toBe("usage limit");
  });
});

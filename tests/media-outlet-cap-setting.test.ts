import { describe, expect, test } from "bun:test";
import { MEDIA_OUTLET_DAILY_ATTEMPTS_ENV, outletDailyAttemptCap } from "../src/lib/media-outlet-access";

describe("outlet daily attempt cap setting", () => {
  test("defaults to 30 attempts per outlet per UTC day", () => {
    expect(outletDailyAttemptCap({})).toBe(30);
  });

  test("a positive whole number in the setting replaces the default", () => {
    expect(outletDailyAttemptCap({ [MEDIA_OUTLET_DAILY_ATTEMPTS_ENV]: "120" })).toBe(120);
  });

  test.each(["", "0", "-5", "12.5", "abc", "1e3"])("an invalid value %p keeps the default", (value) => {
    expect(outletDailyAttemptCap({ [MEDIA_OUTLET_DAILY_ATTEMPTS_ENV]: value })).toBe(30);
  });
});

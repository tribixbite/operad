import { describe, test, expect } from "bun:test";
import { runChecks, type CheckResult } from "../doctor.js";

describe("doctor checks", () => {
  test("all checks return a result with name, status, and message", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r).toHaveProperty("name");
      expect(r).toHaveProperty("status");
      expect(["ok", "warn", "fail"]).toContain(r.status);
      expect(r).toHaveProperty("message");
    }
  });

  test("check names are unique", async () => {
    const results = await runChecks({ skipSlowChecks: true });
    const names = results.map(r => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// Usage overview custom range: day-bounded stats + chart buckets from the
// same usageDaily source, plus 400s on invalid input.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

function dayKey(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function noonISO(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-chart-custom-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("getUsageStats custom range", () => {
  it("scopes totals to the requested days", async () => {
    await db.saveRequestUsage({ timestamp: noonISO(-5), provider: "openai", model: "gpt-4", connectionId: "c1", tokens: { prompt_tokens: 100, completion_tokens: 50 }, status: "ok" });
    await db.saveRequestUsage({ timestamp: noonISO(-1), provider: "anthropic", model: "claude", connectionId: "c2", tokens: { prompt_tokens: 10, completion_tokens: 5 }, status: "ok" });
    await db.saveRequestUsage({ provider: "anthropic", model: "claude", connectionId: "c2", tokens: { prompt_tokens: 20, completion_tokens: 7 }, status: "ok" });

    const onlyOld = await db.getUsageStats("custom", { startDate: dayKey(-5), endDate: dayKey(-5) });
    expect(onlyOld.totalRequests).toBe(1);
    expect(onlyOld.totalPromptTokens).toBe(100);
    expect(onlyOld.byProvider.openai.requests).toBe(1);
    expect(onlyOld.byProvider.anthropic).toBeUndefined();

    const recent = await db.getUsageStats("custom", { startDate: dayKey(-1), endDate: dayKey(0) });
    expect(recent.totalRequests).toBe(2);
    expect(recent.byProvider.anthropic.requests).toBe(2);
    expect(recent.byProvider.openai).toBeUndefined();
  });

  it("rejects missing, malformed, inverted, and oversized ranges", async () => {
    await expect(db.getUsageStats("custom", {})).rejects.toThrow();
    await expect(db.getUsageStats("custom", { startDate: "not-a-date", endDate: dayKey(0) })).rejects.toThrow();
    await expect(db.getUsageStats("custom", { startDate: "2026-02-31", endDate: "2026-03-01" })).rejects.toThrow();
    await expect(db.getUsageStats("custom", { startDate: dayKey(0), endDate: dayKey(-1) })).rejects.toThrow();
    await expect(db.getUsageStats("custom", { startDate: "2024-01-01", endDate: "2026-06-01" })).rejects.toThrow();
  });
});

describe("getChartData custom range", () => {
  it("returns one bucket per day with matching request counts", async () => {
    const data = await db.getChartData("custom", { startDate: dayKey(-5), endDate: dayKey(0) });
    expect(data).toHaveLength(6);
    expect(data.every((d) => typeof d.requests === "number")).toBe(true);
    expect(data[0].requests).toBe(1);
    expect(data.reduce((sum, d) => sum + d.requests, 0)).toBe(3);
    // Buckets agree with the stats totals over the same range.
    const stats = await db.getUsageStats("custom", { startDate: dayKey(-5), endDate: dayKey(0) });
    expect(stats.totalRequests).toBe(3);
  });

  it("rejects invalid input", async () => {
    await expect(db.getChartData("custom", {})).rejects.toThrow();
    await expect(db.getChartData("custom", { startDate: dayKey(0), endDate: dayKey(-2) })).rejects.toThrow();
  });
});

describe("GET /api/usage/stats + /api/usage/chart", () => {
  it("custom: 200 on a valid range, 400 without dates or with start > end", async () => {
    const { GET: getStats } = await import("../../src/app/api/usage/stats/route.js");
    const ok = await getStats(new Request(`http://localhost/api/usage/stats?period=custom&startDate=${dayKey(-5)}&endDate=${dayKey(0)}`));
    expect(ok.status).toBe(200);
    const stats = await ok.json();
    expect(stats.totalRequests).toBe(3);

    const missing = await getStats(new Request("http://localhost/api/usage/stats?period=custom"));
    expect(missing.status).toBe(400);

    const inverted = await getStats(new Request(`http://localhost/api/usage/stats?period=custom&startDate=${dayKey(0)}&endDate=${dayKey(-5)}`));
    expect(inverted.status).toBe(400);

    const { GET: getChart } = await import("../../src/app/api/usage/chart/route.js");
    const chartOk = await getChart(new Request(`http://localhost/api/usage/chart?period=custom&startDate=${dayKey(-5)}&endDate=${dayKey(0)}`));
    expect(chartOk.status).toBe(200);
    const buckets = await chartOk.json();
    expect(buckets).toHaveLength(6);

    const chartBad = await getChart(new Request("http://localhost/api/usage/chart?period=custom&startDate=x&endDate=y"));
    expect(chartBad.status).toBe(400);
  });
});

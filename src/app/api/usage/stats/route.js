import { NextResponse } from "next/server";
import { getUsageStats, parseCustomRange } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all", "custom"]);

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    let range = {};
    if (period === "custom") {
      // parseCustomRange throws on missing/malformed input → 400 below.
      try {
        range = parseCustomRange(searchParams.get("startDate"), searchParams.get("endDate"));
      } catch (e) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
    }

    const stats = await getUsageStats(period, { startDate: range.startKey, endDate: range.endKey });
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API] Failed to get usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}

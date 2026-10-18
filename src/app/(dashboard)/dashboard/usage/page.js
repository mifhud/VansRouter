"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { RequestLogger, CardSkeleton, SegmentedControl } from "@/shared/components";
import UsageStats from "@/shared/components/UsageStats";
import RequestDetailsTab from "./components/RequestDetailsTab";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
  { value: "all", label: "All" },
  { value: "custom", label: "Custom" },
];

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function UsagePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <UsageContent />
    </Suspense>
  );
}

function UsageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [period, setPeriod] = useState("today");
  const [customRange, setCustomRange] = useState(() => {
    const t = todayKey();
    return { startDate: t, endDate: t };
  });

  const tabFromUrl = searchParams.get("tab");
  const activeTab = tabFromUrl && ["overview", "logs", "details"].includes(tabFromUrl)
    ? tabFromUrl
    : "overview";

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    const params = new URLSearchParams(searchParams);
    params.set("tab", value);
    router.push(`/dashboard/usage?${params.toString()}`, { scroll: false });
  };

  const customInvalid = period === "custom" && (!customRange.startDate || !customRange.endDate || customRange.startDate > customRange.endDate);

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Tabs + period selector on same row */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          options={[
            { value: "overview", label: "Overview" },
            { value: "details", label: "Details" },
          ]}
          value={activeTab}
          onChange={handleTabChange}
          className="w-full sm:w-auto"
        />
        {activeTab === "overview" && (
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <SegmentedControl
              options={PERIODS}
              value={period}
              onChange={setPeriod}
              size="sm"
              className="w-full sm:w-auto"
            />
            {period === "custom" && (
              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  aria-label="Custom range start date"
                  value={customRange.startDate}
                  max={customRange.endDate || todayKey()}
                  onChange={(e) => setCustomRange((r) => ({ ...r, startDate: e.target.value }))}
                  className="h-7 rounded-lg border border-border bg-surface px-2 text-xs text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
                  style={{ colorScheme: "auto" }}
                />
                <span className="text-xs text-text-muted">→</span>
                <input
                  type="date"
                  aria-label="Custom range end date"
                  value={customRange.endDate}
                  min={customRange.startDate}
                  max={todayKey()}
                  onChange={(e) => setCustomRange((r) => ({ ...r, endDate: e.target.value }))}
                  className="h-7 rounded-lg border border-border bg-surface px-2 text-xs text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
                  style={{ colorScheme: "auto" }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {activeTab === "overview" && (
        <Suspense fallback={<CardSkeleton />}>
          <UsageStats period={period} setPeriod={setPeriod} hidePeriodSelector customRange={customRange} customInvalid={customInvalid} />
        </Suspense>
      )}
      {activeTab === "logs" && <RequestLogger />}
      {activeTab === "details" && <RequestDetailsTab />}
    </div>
  );
}

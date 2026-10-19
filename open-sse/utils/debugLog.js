// Debug logging utility.
// Verbose traces are on in dev, or when DEBUG / STREAM_DEBUG is set in the
// environment (production included) — mirrors the toggles documented in .env.
// Outputs are tagged with [DBG:tag] for easy grep/filter.
const isDev = process.env.NODE_ENV !== "production";
const envTruthy = (name) => {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
};
const DEBUG_ENABLED = isDev || envTruthy("DEBUG") || envTruthy("STREAM_DEBUG");

function ts() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function dbg(tag, msg) {
  if (!DEBUG_ENABLED) return;
  console.log(`[${ts()}] 🐛 [DBG:${tag}] ${msg}`);
}

export const isDebugEnabled = DEBUG_ENABLED;

// Stream lifecycle tracer — emitted in BOTH dev and production so the dashboard
// console-log can be used to diagnose mid-stream stops (truncation, stall,
// abort, early EOF, client disconnect). Distinct [FLOW] tag keeps it greppable.
// Opt out with STREAM_LOG=off when the extra lines are not wanted.
const STREAM_LOG_ENABLED = String(process.env.STREAM_LOG ?? "").trim().toLowerCase() !== "off";

export function trace(tag, msg) {
  if (!STREAM_LOG_ENABLED) return;
  console.log(`[${ts()}] 🌊 [FLOW:${tag}] ${msg}`);
}

export const isStreamLogEnabled = STREAM_LOG_ENABLED;

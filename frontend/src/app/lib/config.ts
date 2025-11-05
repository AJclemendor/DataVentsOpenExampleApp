export function getBaseUrl(): string {
  const base = process.env.NEXT_PUBLIC_DATAVENTS_BASE_URL || "http://localhost:8000";
  return base.replace(/\/$/, "");
}

export function getWsUrl(): string {
  const explicit = (process.env.NEXT_PUBLIC_DATAVENTS_WS_URL || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const base = getBaseUrl();
  if (base.startsWith("ws://") || base.startsWith("wss://")) return `${base}/api/ws/dv`;
  if (base.startsWith("https://")) return base.replace(/^https:\/\//, "wss://") + "/api/ws/dv";
  if (base.startsWith("http://")) return base.replace(/^http:\/\//, "ws://") + "/api/ws/dv";
  return `ws://${base}/api/ws/dv`;
}


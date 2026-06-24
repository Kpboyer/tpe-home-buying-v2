// netlify/functions/analyze.js
// Non-streaming Anthropic proxy. Each call from the tool is now small enough
// (the analysis is split into two parallel halves) to finish well under the
// Netlify function time limit. The key lives in ANTHROPIC_API_KEY and never
// reaches the browser.

const { connectLambda, getStore } = require("@netlify/blobs");

const ipHits = new Map();
function tooManyPerIp(ip, perMin) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  ipHits.set(ip, arr);
  return arr.length > perMin;
}
function todayKey() { return "count-" + new Date().toISOString().slice(0, 10); }

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify({ error: "Method not allowed" }) };

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY)
    return { statusCode: 500, headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Server is missing ANTHROPIC_API_KEY. Set it in Netlify > Environment variables." }) };

  const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "400", 10); // 2 calls per analysis now
  const PER_IP_PER_MIN = parseInt(process.env.PER_IP_PER_MIN || "10", 10);

  const ip = event.headers["x-nf-client-connection-ip"] ||
    (event.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";

  if (tooManyPerIp(ip, PER_IP_PER_MIN))
    return { statusCode: 429, headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "You're going a little fast - please wait a moment and try again." }) };

  let store = null, dayCount = 0;
  try {
    connectLambda(event);
    store = getStore({ name: "tpe-rate-limit", consistency: "strong" });
    const existing = await store.get(todayKey(), { type: "json" });
    dayCount = (existing && typeof existing.n === "number") ? existing.n : 0;
  } catch (e) { store = null; }

  if (store && dayCount >= DAILY_LIMIT)
    return { statusCode: 429, headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "The daily limit for AI analyses has been reached. Please try again tomorrow." }) };

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify({ error: "Invalid JSON in request body." }) }; }

  const { system, messages, max_tokens } = payload;
  if (!messages || !Array.isArray(messages))
    return { statusCode: 400, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify({ error: "Request must include a messages array." }) };

  const model = payload.model || "claude-haiku-4-5-20251001";

  // Abort safety net at 22s so we return clean JSON, never an HTML platform error.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 24000);
  let data, status;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: max_tokens || 1100, ...(system ? { system } : {}), messages }),
      signal: ctrl.signal,
    });
    status = resp.status;
    data = await resp.json();
  } catch (err) {
    clearTimeout(timer);
    const aborted = err.name === "AbortError";
    return { statusCode: aborted ? 504 : 502, headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ error: aborted ? "The AI analysis took too long and timed out. Please try again." : "Failed to reach Anthropic API: " + (err.message || "unknown error") }) };
  }
  clearTimeout(timer);

  if (store && status >= 200 && status < 300) {
    try { await store.setJSON(todayKey(), { n: dayCount + 1, updated: new Date().toISOString() }); } catch (e) {}
  }

  return { statusCode: status, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(data) };
};

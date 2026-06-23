// netlify/functions/analyze.js
// Secure Anthropic proxy with TWO layers of rate limiting:
//   1. In-memory  — instant burst protection within a warm function instance.
//   2. Netlify Blobs — a persistent GLOBAL daily cap that survives cold starts.
//
// The Anthropic key lives in the ANTHROPIC_API_KEY environment variable and
// never reaches the browser.
//
// Tunable caps (override with environment variables if you like):
//   DAILY_LIMIT      total AI calls allowed per day across everyone (default 200)
//   PER_IP_PER_MIN   calls allowed per visitor per minute        (default 5)

const { connectLambda, getStore } = require("@netlify/blobs");

// ---- in-memory layer (per warm instance) ----
const ipHits = new Map(); // ip -> [timestamps]

function tooManyPerIp(ip, perMin) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const arr = (ipHits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  ipHits.set(ip, arr);
  return arr.length > perMin;
}

function todayKey() {
  // UTC day bucket, e.g. "count-2026-06-23"
  return "count-" + new Date().toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Method not allowed" }) };

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY)
    return { statusCode: 500, headers: cors,
      body: JSON.stringify({ error: "Server is missing ANTHROPIC_API_KEY. Set it in Netlify > Environment variables." }) };

  const DAILY_LIMIT    = parseInt(process.env.DAILY_LIMIT || "200", 10);
  const PER_IP_PER_MIN = parseInt(process.env.PER_IP_PER_MIN || "5", 10);

  // visitor IP (Netlify forwards it here)
  const ip =
    (event.headers["x-nf-client-connection-ip"]) ||
    (event.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    "unknown";

  // ---- LAYER 1: in-memory per-IP burst guard ----
  if (tooManyPerIp(ip, PER_IP_PER_MIN)) {
    return { statusCode: 429, headers: cors,
      body: JSON.stringify({ error: "You're going a little fast - please wait a moment and try again." }) };
  }

  // ---- LAYER 2: persistent global daily cap via Netlify Blobs ----
  let store = null;
  let dayCount = 0;
  try {
    connectLambda(event); // required in Lambda-compat mode before getStore
    store = getStore({ name: "tpe-rate-limit", consistency: "strong" });
    const existing = await store.get(todayKey(), { type: "json" });
    dayCount = (existing && typeof existing.n === "number") ? existing.n : 0;
  } catch (e) {
    // If Blobs isn't available, we DON'T hard-fail - layer 1 still applies.
    // (Set FAIL_CLOSED=true in env if you'd rather block when Blobs is down.)
    if (process.env.FAIL_CLOSED === "true") {
      return { statusCode: 503, headers: cors,
        body: JSON.stringify({ error: "Rate-limit store unavailable; request blocked." }) };
    }
    store = null;
  }

  if (store && dayCount >= DAILY_LIMIT) {
    return { statusCode: 429, headers: cors,
      body: JSON.stringify({ error: "The daily limit for AI analyses has been reached. Please try again tomorrow." }) };
  }

  // ---- parse + validate request ----
  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Invalid JSON in request body." }) }; }

  const { system, messages, max_tokens } = payload;
  if (!messages || !Array.isArray(messages))
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Request must include a messages array." }) };

  const model = payload.model || "claude-sonnet-4-6";

  // ---- call Anthropic ----
  let data, status;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: max_tokens || 1500, ...(system ? { system } : {}), messages }),
    });
    status = resp.status;
    data = await resp.json();
  } catch (err) {
    return { statusCode: 502, headers: cors,
      body: JSON.stringify({ error: "Failed to reach Anthropic API: " + (err.message || "unknown error") }) };
  }

  // ---- only count SUCCESSFUL, billable calls toward the daily cap ----
  if (store && status >= 200 && status < 300) {
    try {
      await store.setJSON(todayKey(), { n: dayCount + 1, updated: new Date().toISOString() });
    } catch (e) { /* non-fatal: a missed increment just means a slightly looser cap */ }
  }

  return { statusCode: status, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(data) };
};

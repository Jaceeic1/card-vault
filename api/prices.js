// Card Vault price lookup: runs on Vercel at /api/prices.
// Uses the Anthropic API's web search to find the most recent SOLD prices
// for one exact card, then averages the last few sales.

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const HOW_MANY = 3; // how many of the newest sales to average

function buildPrompt(card, today) {
  const year = today.slice(0, 4);
  const grade = card.condition === "graded"
    ? `${card.grader || ""} ${card.grade || ""}`.trim()
    : `raw (ungraded${card.rawCondition ? ", " + card.rawCondition : ""})`;
  return `Today's date is ${today}. Find the NEWEST completed sales (final sold prices, not asking prices or active listings) of this exact sports card, ideally from the last 90 days:

Card: ${card.query}
Condition: ${grade}

Search eBay sold/completed listings (ebay.com, and 130point.com which shows eBay sold prices including accepted best offers) and Fanatics Collect (fanaticscollect.com, which now includes PWCC). Use only those sources.
Work hard to find the latest sales, up to today (${today}). Include the current year (${year}) and words like "sold" in some of your searches, and check pages that list sales newest-first (130point and eBay sold listings sorted by most recent). Do not stop at older results from previous years if newer ones exist. Read each sale's actual sold date; never guess a date.
Only count sales of the SAME card: same year, set, card number, parallel/serial numbering and the same grade${card.condition === "graded" ? " from the same grading company" : " (ungraded copies only)"}.
Do not include lots, reprints, different parallels, or different grades. Never invent a sale; only list sales you actually found in the search results.

Return ONLY a JSON object, no other text:
{"sales":[{"date":"YYYY-MM-DD" or "" if unknown,"price":number (USD, the final sold price),"source":"eBay"|"Fanatics Collect"|"130point","title":string (the listing title, short),"url":string (link to the sale, or "")}],
"note":string (one short sentence, e.g. how sure you are these match)}
List up to 10 sales, newest first, with real sold dates. If you find none, return {"sales":[],"note":"..."}.`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const { SUPABASE_URL, SUPABASE_ANON_KEY, ANTHROPIC_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "The price lookup isn’t set up yet (missing settings on the server)." });
  }

  // Only logged-in users.
  const base = SUPABASE_URL.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  const who = await fetch(`${base}/auth/v1/user`, {
    headers: { Authorization: req.headers.authorization || "", apikey: SUPABASE_ANON_KEY },
  });
  if (!who.ok) return res.status(401).json({ error: "Please log in again." });

  const today = new Date().toISOString().slice(0, 10);
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const card = body.card || {};
  if (!card.query || typeof card.query !== "string" || card.query.length > 300) {
    return res.status(400).json({ error: "Not enough card details to look up sales." });
  }

  let ai;
  try {
    ai = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 7 }],
        messages: [{ role: "user", content: buildPrompt(card, today) }],
      }),
    });
  } catch {
    return res.status(502).json({ error: "Couldn’t reach the price lookup. Try again in a minute." });
  }
  if (!ai.ok) {
    const detail = await ai.text().catch(() => "");
    console.error("Anthropic API error (prices)", ai.status, detail);
    let msg = ""; try { msg = JSON.parse(detail)?.error?.message || ""; } catch {}
    let help = "The price lookup had a problem.";
    if (/web search/i.test(msg)) help = "Web search is turned off for your Anthropic account. Turn it on in the Anthropic Console settings.";
    else if (/credit|balance|billing/i.test(msg)) help = "Out of Anthropic credits. Add credits on the Spending page.";
    else if (ai.status === 401) help = "Scanner key is wrong. Re-paste ANTHROPIC_API_KEY in Vercel, then Redeploy.";
    else if (ai.status === 429) help = "Too many lookups at once. Wait a minute and try again.";
    return res.status(502).json({ error: `${help} (code ${ai.status}${msg ? ": " + msg : ""})` });
  }

  const data = await ai.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); }
  catch { return res.status(200).json({ sales: [], average: null, used: 0, note: "Couldn’t read the sales results this time. Try again." }); }

  // Clean up, newest first, then average the newest few (preferring the last 12 months).
  const now = Date.parse(today);
  const days = d => d ? Math.round((now - Date.parse(d)) / 86400000) : null;
  const sales = (Array.isArray(parsed.sales) ? parsed.sales : [])
    .map(s => ({
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(s.date || "")) ? s.date : "",
      price: Number(String(s.price).replace(/[$,]/g, "")),
      source: String(s.source || "Other").slice(0, 40),
      title: String(s.title || "").slice(0, 160),
      url: /^https?:\/\//.test(String(s.url || "")) ? String(s.url) : "",
    }))
    .filter(s => isFinite(s.price) && s.price > 0)
    .filter(s => !s.date || days(s.date) >= -1) // drop impossible future dates
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .slice(0, 10);

  const dated = sales.filter(s => s.date);
  const lastYear = dated.filter(s => days(s.date) <= 365);
  const pool = lastYear.length ? lastYear : (dated.length ? dated : sales);
  const recent = pool.slice(0, HOW_MANY);
  const average = recent.length ? Math.round(recent.reduce((t, s) => t + s.price, 0) / recent.length * 100) / 100 : null;
  // Mark which sales were used (they are the first ones in the list when pool === sales order)
  const usedSet = new Set(recent);
  const ordered = [...recent, ...sales.filter(s => !usedSet.has(s))];

  let note = String(parsed.note || "").slice(0, 300);
  const newest = dated[0];
  if (newest && days(newest.date) > 180) {
    note = `Heads up: the newest sale found is from ${newest.date}, so today's price may be different. ${note}`.trim();
  }
  return res.status(200).json({
    sales: ordered,
    average,
    used: recent.length,
    low: recent.length ? Math.min(...recent.map(s => s.price)) : null,
    high: recent.length ? Math.max(...recent.map(s => s.price)) : null,
    note,
  });
};

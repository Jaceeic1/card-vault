// Card Vault cert lookup: runs on Vercel at /api/cert.
// Finds a graded card's details from its certification number (PSA, BGS, SGC, CGC)
// using the Anthropic API's web search.

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const LOOKUP = {
  PSA: c => `https://www.psacard.com/cert/${c}`,
  SGC: c => `https://gosgc.com/cert-code-lookup (cert ${c})`,
  BGS: c => `https://www.beckett.com/grading/card-lookup (serial ${c})`,
  CGC: c => `https://www.cgccards.com/certlookup/${c}/`,
};

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const { SUPABASE_URL, SUPABASE_ANON_KEY, ANTHROPIC_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "The cert lookup isn’t set up yet (missing settings on the server)." });
  }
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: req.headers.authorization || "", apikey: SUPABASE_ANON_KEY },
  });
  if (!who.ok) return res.status(401).json({ error: "Please log in again." });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const cert = String(body.cert || "").replace(/[^0-9A-Za-z]/g, "");
  const grader = ["PSA", "BGS", "SGC", "CGC"].includes(body.grader) ? body.grader : "PSA";
  if (cert.length < 5 || cert.length > 16) return res.status(400).json({ error: "That doesn’t look like a cert number. Check the number on the slab label." });

  // 1) PSA's official cert API (most reliable). Needs PSA_API_TOKEN in Vercel.
  if (grader === "PSA" && process.env.PSA_API_TOKEN) {
    try {
      const r = await fetch(`https://api.psacard.com/publicapi/cert/GetByCertNumber/${encodeURIComponent(cert)}`, {
        headers: { Authorization: `bearer ${process.env.PSA_API_TOKEN.trim()}`, Accept: "application/json" },
      });
      const j = await r.json().catch(() => null);
      const p = j && (j.PSACert || j.psaCert);
      if (r.status === 401 || r.status === 403) {
        return res.status(502).json({ error: "PSA rejected the API token. Re-copy PSA_API_TOKEN into Vercel, then Redeploy." });
      }
      if (r.status === 429) {
        return res.status(429).json({ error: "PSA's free cert lookups are used up for today. Try again tomorrow, or scan a photo." });
      }
      if (p && (p.Subject || p.subject)) {
        const g = (k) => p[k] ?? p[k.charAt(0).toLowerCase() + k.slice(1)] ?? "";
        const title = (t) => String(t || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bPsa\b/g, "PSA");
        const gradeText = String(g("CardGrade") || g("GradeDescription"));
        const gradeNum = (gradeText.match(/(\d+(?:\.\d)?)\s*$/) || gradeText.match(/(\d+(?:\.\d)?)/) || [])[1] || gradeText;
        const cat = String(g("Category")).toUpperCase();
        const sport = /BASEBALL/.test(cat) ? "Baseball" : /BASKETBALL/.test(cat) ? "Basketball" : /FOOTBALL/.test(cat) ? "Football"
          : /HOCKEY/.test(cat) ? "Hockey" : /SOCCER/.test(cat) ? "Soccer" : /GOLF/.test(cat) ? "Golf" : /RACING/.test(cat) ? "Racing"
          : /WRESTLING/.test(cat) ? "Wrestling" : "Other";
        const player = title(g("Subject")), set = title(g("Brand")), variant = title(g("Variety"));
        const number = String(g("CardNumber") || "").replace(/^#/, "");
        const year = String(g("Year") || "");
        const searchQuery = [year, set, player, number, variant, "PSA", gradeNum].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
        return res.status(200).json({
          found: true, player, year, set, number, variant, sport,
          condition: "graded", grader: "PSA", grade: String(gradeNum), cert,
          description: `${year} ${set} ${player}${number ? " #" + number : ""}${variant ? ", " + variant : ""}, graded ${gradeText} by PSA.`.replace(/\s+/g, " ").trim(),
          searchQuery, confidence: "high", source: "PSA",
        });
      }
      if (r.ok) return res.status(404).json({ error: `PSA has no card with cert ${cert}. Double-check the number on the label.` });
    } catch (e) {
      console.error("PSA API error", e);
      // fall through to web search
    }
  }

  // 2) Fallback: search the web for the cert.
  const prompt = `Look up ${grader} certification number ${cert}. The official lookup is ${LOOKUP[grader](cert)}. Search for this exact cert number and read what card it is.
Only use results that clearly match cert number ${cert}. Never guess or invent a card.
Return ONLY a JSON object, no other text:
{"found":true or false,"player":string,"year":string,"set":string (brand and set),"number":string (card number, no #),"variant":string (parallel, auto, serial numbering; "" if base),
"sport":one of "Baseball","Basketball","Football","Hockey","Soccer","Golf","Racing","Wrestling","Other",
"grader":"${grader}","grade":string (e.g. "10" or "9.5"),"cert":"${cert}",
"description":string (1-2 short sentences for a collector: what the card is and why it matters; no prices),
"searchQuery":string (5-10 words a collector would type into eBay to find sold copies of this exact card and grade, e.g. "2022 Panini Prizm World Cup Lionel Messi 1 Silver PSA 10"; no # symbol),
"confidence":"high"|"medium"|"low"}
If you can't find this cert, return {"found":false}.`;

  let ai;
  try {
    ai = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1500,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return res.status(502).json({ error: "Couldn’t reach the cert lookup. Try again in a minute." });
  }
  if (!ai.ok) {
    const detail = await ai.text().catch(() => "");
    console.error("Anthropic API error (cert)", ai.status, detail);
    let msg = ""; try { msg = JSON.parse(detail)?.error?.message || ""; } catch {}
    let help = "The cert lookup had a problem.";
    if (/web search/i.test(msg)) help = "Web search is turned off for your Anthropic account. Turn it on in the Anthropic Console settings.";
    else if (/credit|balance|billing/i.test(msg)) help = "Out of Anthropic credits. Add credits on the Spending page.";
    else if (ai.status === 401) help = "Scanner key is wrong. Re-paste ANTHROPIC_API_KEY in Vercel, then Redeploy.";
    return res.status(502).json({ error: `${help} (code ${ai.status}${msg ? ": " + msg : ""})` });
  }
  const data = await ai.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  let card;
  try { card = JSON.parse(text.slice(start, end + 1)); } catch { card = { found: false }; }
  if (!card.found || !card.player) {
    return res.status(404).json({ error: grader === "PSA" && !process.env.PSA_API_TOKEN ? `Couldn’t find PSA cert ${cert} by searching the web. Add your free PSA API token in Vercel (PSA_API_TOKEN) for reliable cert lookups, or scan a photo.` : `Couldn’t find ${grader} cert ${cert}. Double-check the number, or scan a photo instead.` });
  }
  card.condition = "graded"; card.grader = grader; card.cert = cert;
  return res.status(200).json(card);
};

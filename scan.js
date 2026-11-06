// Card Vault scanner — runs on Vercel as a serverless function at /api/scan.
// It checks that the person is logged in, sends the card photo(s) to the
// Anthropic API, and returns the card details + estimate as JSON.
// Your API key stays here on the server and is never sent to the browser.

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

function buildPrompt(hasBack) {
  return `You are an expert sports card identifier. Identify the exact trading card in the photo${hasBack?"s. The first image is the FRONT and the second is the BACK of the same card; use the back's copyright year, card number, set name and checklist text to pin down the exact card":""}. If it is in a grading slab, read the label (company, grade, cert number).
Always determine the year, brand, set and card number. If they are not printed where you can see them, work them out from the card design, borders, logos, team uniform, player's career timeline and your knowledge of every major set's design, and give the most likely answer instead of leaving it blank. Mention in the description if the year or set is your best match rather than printed on the card.
Look very closely for serial numbering (e.g. /99, /25, 1/1), autographs, patches or relics, color refractor/prizm/parallel versions, short prints and rookie designations, and name the exact version you see.
Then estimate its current market value in USD for THIS exact version and grade/condition, based on recent sold prices you know of. These details can make a card worth 10x-100x the base version, and gem-mint grades of star rookies sell for many multiples of raw copies, so do not anchor on the base card.
Return ONLY a JSON object, no other text:
{"player":string,"year":string,"set":string (brand and set),"number":string (no #),"variant":string (exact parallel, auto, patch, serial numbering; "" if base),
"sport":one of "Baseball","Basketball","Football","Hockey","Soccer","Golf","Racing","Wrestling","Other",
"condition":"graded" or "raw","grader":string,"grade":string,"cert":string,
"rawCondition":for raw cards one of "Gem mint","Mint","Near mint","Excellent","Very good","Played", else "",
"description":string (1-2 short sentences for a collector: what the card is and why it matters, e.g. rookie card, short print. No prices. Do not mention AI or yourself),
"estimate":{"value":number,"low":number,"high":number},
"confidence":"high"|"medium"|"low",
"searchQuery":string (the words a collector would type into eBay to find sold copies of THIS exact card: year, brand/set as sellers write it in titles (2-3 words), player full name, card number, the key parallel words (e.g. "Gold Refractor /50", "Silver Prizm"), and grader + grade if slabbed (e.g. "PSA 10"). 5-10 words, no # symbol, no filler words)}
Use "" for anything unreadable. Never invent serial or cert numbers.`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  const { SUPABASE_URL, SUPABASE_ANON_KEY, ANTHROPIC_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "The scanner isn’t set up yet (missing settings on the server)." });
  }

  // 1. Only logged-in Card Vault users can scan.
  const auth = req.headers.authorization || "";
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: SUPABASE_ANON_KEY },
  });
  if (!who.ok) return res.status(401).json({ error: "Please log in again." });

  // 2. Read the photos (base64 JPEG, made small by the page before upload).
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { front, back } = body;
  if (!front || typeof front !== "string") return res.status(400).json({ error: "No photo received." });
  if (front.length > 3_000_000 || (back && back.length > 3_000_000)) {
    return res.status(413).json({ error: "That photo is too large. Try again." });
  }

  const content = [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: front } }];
  if (back) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: back } });
  content.push({ type: "text", text: buildPrompt(!!back) });

  // 3. Ask the model.
  let ai;
  try {
    ai = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages: [{ role: "user", content }] }),
    });
  } catch {
    return res.status(502).json({ error: "Couldn’t reach the scanner service. Try again in a minute." });
  }
  if (ai.status === 429) return res.status(429).json({ error: "Too many scans at once. Wait a minute and try again." });
  if (!ai.ok) {
    const detail = await ai.text().catch(() => "");
    console.error("Anthropic API error", ai.status, detail);
    return res.status(502).json({ error: "The scanner had a problem. Try again in a minute." });
  }

  // 4. Pull the JSON object out of the reply.
  const data = await ai.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  try {
    const card = JSON.parse(text.slice(start, end + 1));
    return res.status(200).json(card);
  } catch {
    return res.status(422).json({ error: "Couldn’t make out that card. Try a sharper, well-lit photo of the front." });
  }
};

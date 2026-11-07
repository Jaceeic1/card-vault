// Card Vault grade estimator: runs on Vercel at /api/grade.
// Looks at photos of the front, back and corners of a raw card and estimates
// how it might grade, the way a grader would check it.

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const SLOTS = ["front", "back", "topLeft", "topRight", "bottomLeft", "bottomRight"];
const LABEL = { front: "FRONT of the card", back: "BACK of the card", topLeft: "TOP-LEFT corner close-up", topRight: "TOP-RIGHT corner close-up", bottomLeft: "BOTTOM-LEFT corner close-up", bottomRight: "BOTTOM-RIGHT corner close-up" };

const PROMPT = `You are an experienced professional sports card grader using PSA's 1-10 scale. Examine the photos above (each is labeled) and estimate the grade this raw card would most likely receive.

Check, like a real grader:
- CENTERING: estimate the border ratios on the front (left/right and top/bottom, e.g. "55/45") and back. PSA 10 needs about 55/45 or better on the front and 75/25 on the back; PSA 9 about 60/40 front.
- CORNERS: sharpness, whitening, dings, rounding, fraying. Use the corner close-ups when provided.
- EDGES: chipping, whitening, roughness, nicks along all four edges, front and back.
- SURFACE: scratches, print lines, print dots, dimples, creases, stains, wax, indentations, loss of gloss.

Be realistic and strict, not generous: most modern pack-fresh cards grade 8-9, a 10 requires essentially flawless centering, corners, edges and surface, and any crease generally means 5 or lower. If the photos are blurry, glared, cropped, or a slab/sleeve hides detail, say so and lower your confidence.

Also identify the card from the front (and back) if you can.

Return ONLY a JSON object, no other text:
{"grade": number (most likely PSA grade, whole number 1-10),
"low": number, "high": number (realistic range),
"chance10": number (0-100, percent chance of a PSA 10),
"chance9plus": number (0-100, percent chance of PSA 9 or 10),
"subgrades": {
  "centering": {"score": number 1-10 (halves allowed), "frontLR": "55/45", "frontTB": "50/50", "backLR": "60/40", "backTB": "55/45", "note": string},
  "corners": {"score": number, "note": string},
  "edges": {"score": number, "note": string},
  "surface": {"score": number, "note": string}
},
"issues": [string] (specific flaws you can see, e.g. "Light whitening on the back top-left corner"; empty if none),
"photoTips": [string] (what better photos would help, if any; empty if photos were good),
"photoQuality": "good"|"ok"|"poor",
"confidence": "high"|"medium"|"low",
"card": {"player": string, "year": string, "set": string, "number": string, "variant": string, "sport": string, "searchQuery": string (5-10 words for eBay, without any grade)},
"summary": string (2 short sentences in plain English for a collector; no mention of AI)}`;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const { SUPABASE_URL, SUPABASE_ANON_KEY, ANTHROPIC_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "The grade estimator isn’t set up yet (missing settings on the server)." });
  }
  const base = SUPABASE_URL.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  const who = await fetch(`${base}/auth/v1/user`, { headers: { Authorization: req.headers.authorization || "", apikey: SUPABASE_ANON_KEY.trim() } });
  if (!who.ok) return res.status(401).json({ error: "Please log in again." });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const photos = body.photos || {};
  if (!photos.front || !photos.back) return res.status(400).json({ error: "Add at least the front and back photos." });

  const content = [];
  for (const k of SLOTS) {
    const b64 = photos[k];
    if (!b64) continue;
    if (typeof b64 !== "string" || b64.length > 1500000) return res.status(413).json({ error: "One of the photos is too large. Try again." });
    content.push({ type: "text", text: LABEL[k] + ":" });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } });
  }
  content.push({ type: "text", text: PROMPT });

  let ai;
  try {
    ai = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: [{ role: "user", content }] }),
    });
  } catch {
    return res.status(502).json({ error: "Couldn’t reach the grade estimator. Try again in a minute." });
  }
  if (!ai.ok) {
    const detail = await ai.text().catch(() => "");
    console.error("Anthropic API error (grade)", ai.status, detail);
    let msg = ""; try { msg = JSON.parse(detail)?.error?.message || ""; } catch {}
    let help = "The grade estimator had a problem.";
    if (/credit|balance|billing/i.test(msg)) help = "Out of Anthropic credits. Add credits on the Spending page.";
    else if (ai.status === 401) help = "Scanner key is wrong. Re-paste ANTHROPIC_API_KEY in Vercel, then Redeploy.";
    else if (ai.status === 413) help = "The photos are too large together. Try again with fewer corner photos.";
    else if (ai.status === 429) help = "Too many requests at once. Wait a minute and try again.";
    return res.status(502).json({ error: `${help} (code ${ai.status}${msg ? ": " + msg : ""})` });
  }
  const data = await ai.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  try {
    const out = JSON.parse(text.slice(s, e + 1));
    out.grade = Math.max(1, Math.min(10, Math.round(Number(out.grade) || 0)));
    return res.status(200).json(out);
  } catch {
    return res.status(422).json({ error: "Couldn’t read those photos clearly. Try brighter, sharper photos with no glare." });
  }
};

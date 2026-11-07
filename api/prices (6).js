// Card Vault price lookup: runs on Vercel at /api/prices.
// Reads eBay sold listings directly and web-searches other sales sites (any date),
// then averages the newest few sales of the exact card.

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const HOW_MANY = 3; // how many of the newest sales to average

function buildPrompt(card, today) {
  const grade = card.condition === "graded"
    ? `${card.grader || ""} ${card.grade || ""}`.trim()
    : `raw (ungraded${card.rawCondition ? ", " + card.rawCondition : ""})`;
  return `Today's date is ${today}. Find completed sales (final sold prices, not asking prices or active listings) of this exact sports card. Any date is fine, from all time, but always include the newest sales you can find.

Card: ${card.query}
Condition: ${grade}

Use any reliable source of real sold prices: for example eBay sold listings, 130point, Goldin, Fanatics Collect / PWCC, Heritage Auctions, PSA Auction Prices Realized, Card Ladder, Market Movers, SportsCardsPro, Alt, MySlabs, Probstein, Memory Lane, REA or other auction houses.
Search widely, including older sales from previous years, and also look for the latest ones up to today. Read each sale's actual sold date; never guess a date.
Only count sales of the SAME card: same year, set, card number, parallel/serial numbering and the same grade${card.condition === "graded" ? " from the same grading company" : " (ungraded copies only)"}.
Do not include lots, reprints, different parallels, or different grades. Never invent a sale; only list sales you actually found in the search results.

Return ONLY a JSON object, no other text:
{"sales":[{"date":"YYYY-MM-DD" or "" if unknown,"price":number (USD, the final sold price),"source":string (site or auction house name),"title":string (the listing title, short),"url":string (link to the sale, or "")}],
"note":string (one short sentence, e.g. how sure you are these match)}
List up to 15 sales, newest first. If you find none, return {"sales":[],"note":"..."}.`;
}


// ---------- eBay sold listings, read directly ----------
// Web search can't see most eBay sold listings, so we open eBay's own
// "Sold items" search page and read the sales straight from it.
const MONTHS = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
const decode = t => t.replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;|&#x27;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&nbsp;/g," ");
const strip = h => decode(String(h).replace(/<!--[\s\S]*?-->/g," ").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ")).replace(/\s+/g," ").trim();

function ebayUrl(q, raw) {
  const words = raw ? `${q} -psa -bgs -sgc -cgc -graded -slab` : q;
  return "https://www.ebay.com/sch/i.html?" + new URLSearchParams({ _nkw: words, LH_Sold: "1", LH_Complete: "1", _sop: "13", _ipg: "120", rt: "nc" });
}

function parseEbay(html) {
  // Ignore eBay's "results matching fewer words" section: those are other cards.
  const cut = html.search(/matching fewer words/i);
  if (cut > 0) html = html.slice(0, cut);
  const out = [], seen = new Set();
  for (const chunk of html.split(/<li\b/i)) {
    const idm = chunk.match(/\/itm\/(?:[^"'\/?\s]*\/)?(\d{9,15})/);
    if (!idm || seen.has(idm[1])) continue;
    const text = strip("<li" + chunk);
    const dm = text.match(/Sold\s+([A-Z][a-z]{2})\s+(\d{1,2}),?\s+(\d{4})/);
    if (!dm || !(dm[1] in MONTHS)) continue;
    const date = new Date(Date.UTC(+dm[3], MONTHS[dm[1]], +dm[2])).toISOString().slice(0, 10);
    let ptxt = "";
    const pm = chunk.match(/class="[^"]*(?:s-item__price|s-card__price)[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (pm) ptxt = strip(pm[1]);
    if (!ptxt) { const m = text.match(/\$\s?[\d,]+(?:\.\d{2})?/); ptxt = m ? m[0] : ""; }
    if (/\bto\b/i.test(ptxt)) continue; // price ranges are multi-item listings
    const price = Number((ptxt.match(/[\d,]+(?:\.\d{2})?/) || [""])[0].replace(/,/g, ""));
    if (!isFinite(price) || price <= 0) continue;
    const clean = t => t.replace(/^New Listing\s*/i, "").replace(/Opens in a new window or tab/gi, "").trim();
    let title = "";
    const tm = chunk.match(/class="[^"]*(?:s-item__title|s-card__title)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|h3)>/i);
    if (tm) title = clean(strip(tm[1]));
    if (!title) { const am = chunk.match(/alt="([^"]{8,})"/); if (am) title = clean(decode(am[1])); }
    if (!title || /^shop on ebay$/i.test(title)) continue;
    seen.add(idm[1]);
    out.push({ date, price, source: "eBay", title: title.slice(0, 160), url: `https://www.ebay.com/itm/${idm[1]}` });
  }
  return out;
}

async function fetchEbay(q, raw) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(ebayUrl(q, raw), {
      signal: ctl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!r.ok) { console.error("eBay status", r.status); return []; }
    const html = await r.text();
    const items = parseEbay(html);
    if (!items.length) console.error("eBay: no items parsed", html.length, /Pardon Our Interruption|captcha/i.test(html) ? "(blocked)" : "");
    return items;
  } catch (e) { console.error("eBay fetch failed", String(e)); return []; }
  finally { clearTimeout(timer); }
}

// Ask Claude (no web search, quick) which eBay listings are the exact same card + grade.
async function pickMatches(card, items, key) {
  const grade = card.condition === "graded" ? `${card.grader || ""} ${card.grade || ""}`.trim() + " (sellers usually write just the company and number, e.g. PSA 10)" : "raw / ungraded";
  const list = items.map((s, i) => `${i}. ${s.title}`).join("\n");
  const prompt = `Card: ${card.query}\nCondition: ${grade}\n\nBelow are sold eBay listing titles. Return the numbers of the listings that are this SAME card: same player, year, set, card number if given, same parallel/color/serial numbering, and ${card.condition === "graded" ? "the same grade from the same grading company" : "ungraded (not slabbed)"}. Exclude lots, reprints, different parallels, different grades, and autographs or patches unless the card itself is one. Be reasonable: sellers write titles differently, and a missing card number is fine if everything else matches.\n\n${list}\n\nReturn ONLY JSON: {"match":[numbers]}`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 600, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) { console.error("match step", r.status, await r.text().catch(() => "")); return null; }
    const d = await r.json();
    const t = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const j = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    return (j.match || []).map(Number).filter(n => Number.isInteger(n) && items[n]).map(n => items[n]);
  } catch (e) { console.error("match step failed", String(e)); return null; }
}

async function smartQueries(card, gradeTag, key) {
  const prompt = `A collector wants eBay sold listings for this card: "${card.query}"${gradeTag ? ` graded ${gradeTag}` : " (raw, ungraded)"}.
Write 2 short eBay search phrases (3-6 words each) the way sellers actually title these listings: year, common set name (expand slab-label abbreviations, e.g. "WC" = "World Cup", "CHR." = "Chrome", "UPD." = "Update"), player's last name or full name, and the parallel in one or two words. No card numbers, no cert numbers, no grade words${gradeTag ? `; end each phrase with "${gradeTag}"` : ""}. The second phrase should be broader than the first.
Return ONLY JSON: {"q":["...","..."]}`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 200, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) return [];
    const d = await r.json();
    const t = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const j = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    return (j.q || []).map(String).map(q => q.replace(/#/g, "").trim()).filter(q => q.length > 3 && q.length < 120).slice(0, 2);
  } catch { return []; }
}

function summarize(sales, today, note) {
  const now = Date.parse(today);
  const days = d => d ? Math.round((now - Date.parse(d)) / 86400000) : null;
  sales = sales
    .filter(s => isFinite(s.price) && s.price > 0)
    .filter(s => !s.date || days(s.date) >= -1)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .slice(0, 20);
  const dated = sales.filter(s => s.date);
  const pool = dated.length ? dated : sales; // newest sales first, from any year
  const recent = pool.slice(0, HOW_MANY);
  const average = recent.length ? Math.round(recent.reduce((t, s) => t + s.price, 0) / recent.length * 100) / 100 : null;
  const usedSet = new Set(recent);
  const ordered = [...recent, ...sales.filter(s => !usedSet.has(s))];
  note = String(note || "").slice(0, 300);
  const newest = dated[0];
  if (newest && days(newest.date) > 180) note = `Heads up: the newest sale found is from ${newest.date}, so today's price may be different. ${note}`.trim();
  return { sales: ordered, average, used: recent.length,
    low: recent.length ? Math.min(...recent.map(s => s.price)) : null,
    high: recent.length ? Math.max(...recent.map(s => s.price)) : null, note };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const { SUPABASE_URL, SUPABASE_ANON_KEY, ANTHROPIC_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "The price lookup isn’t set up yet (missing settings on the server)." });
  }
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

  // Step 1: eBay sold listings, straight from eBay.
  const raw = card.condition !== "graded";
  // Sellers write grades as "PSA 10", not "PSA GEM MT 10", so search that way.
  // Sellers write "PSA 10" / "BGS 9.5": never the label's long names or words.
  const graderName = String(card.grader || "").trim();
  const GRADERS = [[/psa|professional sports/i,"PSA"],[/bgs|beckett/i,"BGS"],[/sgc|sportscard guaranty/i,"SGC"],[/cgc/i,"CGC"],[/csg/i,"CSG"],[/hga/i,"HGA"],[/\btag\b/i,"TAG"]];
  const grader = (GRADERS.find(([re]) => re.test(graderName)) || [null, /^other$/i.test(graderName) ? "" : graderName.split(" ")[0]])[1];
  const gnum = /auth/i.test(card.grade || "") ? "Authentic" : (String(card.grade || "").match(/\d+(?:\.\d)?/) || [""])[0];
  const gradeTag = !raw && grader ? `${grader} ${gnum}`.trim() : "";
  const GRADE_WORDS = /\b(psa|bgs|sgc|cgc|csg|beckett|hga|gem|mint|mt|nm|nm-mt|near|pristine|black label|authentic|auth|graded|slab(?:bed)?|professional sports authenticator)\b/gi;
  const words = card.query
    .replace(/\b(cert(ificate)?|cert\s*#|no\.?)\s*:?\s*\d{5,}/gi, " ")   // "Cert 12345678"
    .replace(/\b\d{6,}\b/g, " ")                                        // any long number = cert number
    .replace(/\b\d{1,4}\s*\/\s*(\d{1,4})\b/g, "/$1")                    // "15/99" -> "/99" (any copy of the run)
    .replace(/[#(),]/g, " ").replace(GRADE_WORDS, " ")
    .replace(/(^|\s)(10|9\.5|9|8\.5|8|7\.5|7|6|5|4|3|2|1)(?=\s|$)/g, raw ? "$1$2" : " ")
    .replace(/\s+/g, " ").trim();
  const noNum = words.replace(/(^|\s)[A-Za-z]{0,4}-?\d{1,4}[A-Za-z]?(?=\s|$)/g, (m, sp) => /^\s?(19|20)\d{2}$/.test(m) ? m : sp).replace(/\s+/g, " ").trim();
  const nw = noNum.split(" "); // last words are usually the parallel; drop them as a last try
  const short = nw.length > 6 ? nw.slice(0, -2).join(" ") : noNum;
  const tries = [...new Set([words, noNum, short].filter(Boolean).map(w => `${w} ${gradeTag}`.trim()))];
  const webPromise = webSearchLookup({ ...card, query: tries[0] }, today, ANTHROPIC_API_KEY);
  let items = [];
  for (const q of tries) {
    const got = await fetchEbay(q, raw);
    console.log("eBay search:", q, "->", got.length);
    const ids = new Set(items.map(s => s.url));
    items = items.concat(got.filter(s => !ids.has(s.url)));
    if (items.length >= 8) break;
  }
  if (items.length < 5) {
    // Still almost nothing: have Claude rewrite the search the way eBay sellers title these cards.
    for (const q of await smartQueries(card, gradeTag, ANTHROPIC_API_KEY)) {
      const got = await fetchEbay(q, raw);
      console.log("eBay smart search:", q, "->", got.length);
      const ids = new Set(items.map(s => s.url));
      items = items.concat(got.filter(s => !ids.has(s.url)));
      if (items.length >= 8) break;
    }
  }
  let ebay = [];
  if (items.length) ebay = (await pickMatches(card, items.slice(0, 60), ANTHROPIC_API_KEY)) || [];

  // Step 2: web search of every other sales site (any date), run at the same time.
  const web = await webPromise;
  if (web.error && !ebay.length) return res.status(502).json({ error: web.error });

  // Merge, skipping the same sale found twice.
  const key = s => `${s.date}|${Math.round(s.price)}`;
  const have = new Set(ebay.map(key));
  const ebayIds = new Set(ebay.map(s => (s.url.match(/\/itm\/(\d+)/) || [])[1]).filter(Boolean));
  const extra = (web.sales || []).filter(s => {
    const id = (s.url.match(/\/itm\/(\d+)/) || [])[1];
    return !(id && ebayIds.has(id)) && !have.has(key(s));
  });
  const all = ebay.concat(extra);
  const note = ebay.length
    ? `${ebay.length} from eBay sold listings${extra.length ? `, ${extra.length} from other sites` : ""}.`
    : (web.note || "");
  return res.status(200).json(summarize(all, today, note));
};

async function webSearchLookup(card, today, ANTHROPIC_API_KEY) {
  let ai;
  try {
    ai = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
        messages: [{ role: "user", content: buildPrompt(card, today) }],
      }),
    });
  } catch {
    return { error: "Couldn’t reach the price lookup. Try again in a minute." };
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
    return { error: `${help} (code ${ai.status}${msg ? ": " + msg : ""})` };
  }

  const data = await ai.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); }
  catch { return { sales: [], note: "Couldn’t read the sales results this time. Try again." }; }

  const sales = (Array.isArray(parsed.sales) ? parsed.sales : []).map(s => ({
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(s.date || "")) ? s.date : "",
    price: Number(String(s.price).replace(/[$,]/g, "")),
    source: String(s.source || "Other").slice(0, 40),
    title: String(s.title || "").slice(0, 160),
    url: /^https?:\/\//.test(String(s.url || "")) ? String(s.url) : "",
  }));
  return { sales: sales.filter(s => isFinite(s.price) && s.price > 0), note: String(parsed.note || "") };
}

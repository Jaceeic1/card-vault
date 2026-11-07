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
FIRST find the newest sales: the last 30-60 days matter most (today is ${today}). Search with the current month and year in your words (e.g. "${new Date(today).toLocaleString("en-US",{month:"long",timeZone:"UTC"})} ${today.slice(0,4)}"), and use pages sorted newest-first such as 130point and eBay sold results. Do not stop at sales from a previous year if newer ones exist. After that, older sales from any year are fine too. Read each sale's actual sold date; never guess a date.
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

// Turn an eBay results page into plain text, keeping each listing's item number as [itm:123].
function pageText(html) {
  const cut = html.search(/matching fewer words/i);
  if (cut > 0) html = html.slice(0, cut);
  const body = html.slice(Math.max(0, html.search(/srp-results|s-item|s-card|<ul[^>]*results/i)));
  const t = body
    .replace(/<a\b[^>]*href="[^"]*\/itm\/(?:[^"\/?]*\/)?(\d{9,15})[^"]*"[^>]*>/gi, " [itm:$1] ")
    .replace(/<\/(li|div|h3|span)>/gi, "$& ");
  return strip(t).replace(/(\[itm:\d+\])(\s*\1)+/g, "$1").slice(0, 70000);
}

// Have Claude read eBay's sold page text and pick out sales of this exact card.
async function readSalesFromText(card, text, key, ms) {
  const grade = card.condition === "graded" ? `${card.grader || ""} ${card.grade || ""}`.trim() + " (sellers usually write just the company and number, e.g. PSA 10)" : "raw / ungraded";
  const prompt = `Below is the text of an eBay "sold items" search results page. Each listing's item number appears as [itm:NUMBER] near its title.
List the SOLD listings that are this exact card: ${card.query} (${grade}). Same player, year, set, card number if given, same parallel/serial numbering, and ${card.condition === "graded" ? "same grade from the same grading company" : "ungraded copies only"}. Skip lots, reprints, other parallels and other grades. Be reasonable: sellers write titles very differently (word order, "2018-19", "WC", missing card number, extra words like GEM MINT or RC), so include a listing whenever it is clearly this card in this grade. Use each listing's own "Sold" date and its sold price (not shipping).
Return ONLY JSON: {"sales":[{"date":"YYYY-MM-DD","price":number,"title":string,"itm":"NUMBER"}],"listings_on_page":number (how many sold listings of ANY card the page shows),"examples":[up to 3 listing titles from the page, exactly as written],"page_is":string (a few words: e.g. "eBay sold results", "eBay active listings", "blocked/verification page", "no results")}. Sales newest first, up to 20.

PAGE TEXT:
${text}`;
  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), Math.max(ms, 3000));
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctl.signal,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 3000, messages: [{ role: "user", content: prompt }] }),
    });
    clearTimeout(timer);
    if (!r.ok) { console.error("read page", r.status); return []; }
    const d = await r.json();
    const t = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const j = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    readSalesFromText.last = { count: Number(j.listings_on_page) || 0, examples: (j.examples || []).map(String).slice(0, 2), pageIs: String(j.page_is || "").slice(0, 60) };
    return (j.sales || []).map(s => ({
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(s.date || "")) ? s.date : "",
      price: Number(String(s.price).replace(/[$,]/g, "")), source: "eBay",
      title: String(s.title || "").slice(0, 160),
      url: /^\d{9,15}$/.test(String(s.itm || "")) ? `https://www.ebay.com/itm/${s.itm}` : "",
    })).filter(s => isFinite(s.price) && s.price > 0);
  } catch (e) { console.error("read page failed", String(e)); return []; }
}

let ebayProblem = ""; // why eBay returned nothing, shown in the note so it's easy to see
let useProxy = false;  // switches on after eBay blocks the server, for the rest of this lookup

// eBay often blocks requests from servers like Vercel's. If a SCRAPER_API_KEY is set in Vercel
// (free account at scraperapi.com), blocked requests are retried through ScraperAPI,
// which opens the page from ordinary home internet connections.
async function getEbayPage(q, raw, proxied) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), proxied ? 45000 : 7000);
  const target = ebayUrl(q, raw);
  const url = proxied
    ? "https://api.scraperapi.com/?" + new URLSearchParams({ api_key: process.env.SCRAPER_API_KEY.trim(), url: target })
    : target;
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: proxied ? {} : {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!r.ok) {
      console.error(proxied ? "ScraperAPI status" : "eBay status", r.status);
      return { items: [], problem: proxied ? (r.status === 401 || r.status === 403 ? "ScraperAPI key was rejected" : r.status === 429 ? "ScraperAPI free credits are used up" : `ScraperAPI couldn’t open eBay (code ${r.status})`) : `eBay refused (code ${r.status})`, blocked: !proxied };
    }
    const html = await r.text();
    const items = parseEbay(html);
    if (items.length) return { items, problem: "" };
    const blocked = html.length < 150000 && /Pardon Our Interruption|Checking your browser|verify you are a human|px-captcha|challenge-platform/i.test(html);
    console.error("eBay: no items parsed", proxied ? "(via ScraperAPI)" : "", html.length, blocked ? "(blocked)" : "");
    if (blocked) return { items: [], problem: proxied ? "eBay blocked the check even through ScraperAPI" : "eBay blocked the direct check", blocked: !proxied };
    if (html.length < 60000 || /signin\.ebay|Sign in or register|<title>[^<]*Sign in/i.test(html) && !/\/itm\/\d{9,}/.test(html))
      return { items: [], problem: "eBay showed a sign-in page instead of sold listings", blocked: !proxied };
    // A real page our reader couldn't understand (eBay changes its layout): hand its text to Claude.
    return { items: [], problem: "", text: pageText(html) };
  } catch (e) {
    console.error(proxied ? "ScraperAPI failed" : "eBay fetch failed", String(e));
    return { items: [], problem: proxied ? "ScraperAPI took too long" : "couldn’t reach eBay", blocked: !proxied };
  } finally { clearTimeout(timer); }
}

// ScraperAPI's own eBay reader (they keep it working when eBay changes things).
async function getEbayStructured(q, raw) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);
  const query = raw ? `${q} -psa -bgs -sgc -cgc -graded -slab` : q;
  const url = "https://api.scraperapi.com/structured/ebay/search?" + new URLSearchParams({
    api_key: process.env.SCRAPER_API_KEY.trim(), query, show_only: "sold_items", items_per_page: "120", tld: "com" });
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return { items: [], problem: `ScraperAPI's eBay reader failed (code ${r.status})` };
    const d = await r.json();
    const list = Array.isArray(d) ? d : (d.products || d.results || d.items || d.search_results || []);
    const items = [], seen = new Set();
    for (const p of list) {
      const all = JSON.stringify(p);
      const title = String(p.product_title || p.title || p.name || "").trim();
      const priceObj = p.item_price || p.price || {};
      const price = Number(typeof priceObj === "object" ? (priceObj.value ?? priceObj.from?.value) : String(priceObj).replace(/[$,]/g, ""));
      if (!title || !isFinite(price) || price <= 0 || (priceObj.from && priceObj.to)) continue;
      const dm = all.match(/Sold\s+([A-Z][a-z]{2})\s+(\d{1,2}),?\s+(\d{4})/) || all.match(/"(?:sold_date|date_sold|end_date|sold)"\s*:\s*"([A-Z][a-z]{2})\s+(\d{1,2}),?\s+(\d{4})/);
      const date = dm && dm[1] in MONTHS ? new Date(Date.UTC(+dm[3], MONTHS[dm[1]], +dm[2])).toISOString().slice(0, 10) : "";
      const purl = String(p.product_url || p.url || p.link || "");
      const id = (purl.match(/\/itm\/(?:[^"\/?]*\/)?(\d{9,15})/) || [])[1];
      const key = id || `${title}|${price}`;
      if (seen.has(key)) continue; seen.add(key);
      items.push({ date, price, source: "eBay", title: title.replace(/^New Listing\s*/i, "").slice(0, 160), url: id ? `https://www.ebay.com/itm/${id}` : "" });
    }
    return { items, problem: items.length ? "" : (list.length ? "ScraperAPI's eBay reader returned listings without prices" : "ScraperAPI's eBay reader found no sold listings for these words") };
  } catch (e) { return { items: [], problem: "ScraperAPI's eBay reader took too long" }; }
  finally { clearTimeout(timer); }
}

async function fetchEbay(q, raw) {
  const hasKey = !!(process.env.SCRAPER_API_KEY || "").trim();
  if (!useProxy) {
    const d = await getEbayPage(q, raw, false);
    if (!d.blocked || !hasKey) { if (d.problem) ebayProblem = d.problem; return d.items; }
    useProxy = true; // blocked: use ScraperAPI from now on
  }
  const p = await getEbayPage(q, raw, true);
  ebayProblem = p.problem || "";
  return p.items;
}

// Backup: have Claude open eBay's sold page itself (Anthropic's web fetch tool).
async function ebayViaClaude(card, q, raw, today, key) {
  const url = ebayUrl(q, raw);
  const grade = card.condition === "graded" ? `${card.grader || ""} ${card.grade || ""}`.trim() : "raw / ungraded";
  const prompt = `Today is ${today}. Open this eBay "sold items" page with the web_fetch tool: ${url}
List the SOLD listings on it that are this exact card: ${card.query} (${grade}). Same player, year, set, parallel and ${card.condition === "graded" ? "same grade from the same grading company" : "ungraded copies only"}; skip lots and different parallels or grades. Use each listing's real "Sold" date and sold price.
Return ONLY JSON: {"sales":[{"date":"YYYY-MM-DD","price":number,"title":string,"url":string}]}. Up to 15, newest first. If the page won't load, return {"sales":[],"blocked":true}.`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-beta": "web-fetch-2025-09-10", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 2500,
        tools: [{ type: "web_fetch_20250910", name: "web_fetch", max_uses: 2, allowed_domains: ["ebay.com", "www.ebay.com"], max_content_tokens: 60000 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) { console.error("eBay via Claude", r.status, await r.text().catch(() => "")); return []; }
    const d = await r.json();
    const t = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const j = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    readSalesFromText.last = { count: Number(j.listings_on_page) || 0, examples: (j.examples || []).map(String).slice(0, 2), pageIs: String(j.page_is || "").slice(0, 60) };
    return (j.sales || []).map(s => ({
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(s.date || "")) ? s.date : "",
      price: Number(String(s.price).replace(/[$,]/g, "")),
      source: "eBay", title: String(s.title || "").slice(0, 160),
      url: /^https?:\/\/(www\.)?ebay\.com\//.test(String(s.url || "")) ? String(s.url) : "",
    })).filter(s => isFinite(s.price) && s.price > 0);
  } catch (e) { console.error("eBay via Claude failed", String(e)); return []; }
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
  ebayProblem = ""; useProxy = false;
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const card = body.card || {};
  if (!card.query || typeof card.query !== "string" || card.query.length > 300) {
    return res.status(400).json({ error: "Not enough card details to look up sales." });
  }
  if (body.allGrades) return allGradesLookup(card, today, ANTHROPIC_API_KEY, res);
  if (body.active) return activeLookup(card, ANTHROPIC_API_KEY, res);

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
  // Everything must finish before the server's 60-second limit, or the page shows "took too long".
  const started = Date.now();
  const left = () => 52000 - (Date.now() - started);
  const within = (p, ms, fallback) => Promise.race([p, new Promise(r => setTimeout(() => r(fallback), Math.max(ms, 1000)))]);

  // Start the slow lookups right away, all at the same time.
  const estPromise = within(aiEstimate(card, today, ANTHROPIC_API_KEY), 45000, null);
  const webPromise = within(webSearchLookup({ ...card, query: tries[0] }, today, ANTHROPIC_API_KEY), 50000, { sales: [], note: "" });
  const viaPromise = (process.env.SCRAPER_API_KEY || "").trim() ? Promise.resolve([]) : within(ebayViaClaude(card, tries[1] || tries[0], raw, today, ANTHROPIC_API_KEY), 50000, []);

  // eBay sold listings.
  let items = [], pageRead = [];
  const searched = [];
  const hasKey = !!(process.env.SCRAPER_API_KEY || "").trim();
  if (hasKey) {
    // eBay blocks Vercel's servers, so go straight through ScraperAPI (it can be slow,
    // so run two searches at once: the broad one and the exact one).
    useProxy = true;
    const qs = [tries[1] || tries[0], tries[0]];
    const wait = Math.min(36000, left() - 14000);
    const results = await Promise.all([
      within(getEbayStructured(qs[0], raw), wait, { items: [], problem: "ScraperAPI's eBay reader took too long" }),
      within(getEbayPage(qs[1], raw, true), wait, { items: [], problem: "ScraperAPI took too long" }),
    ]);
    results.forEach((r, i) => {
      searched.push(`${qs[i]} (${r.items.length})`);
      const ids = new Set(items.map(s => s.url));
      items = items.concat(r.items.filter(s => !ids.has(s.url)));
    });
    if (!items.length) {
      const text = results.map(r => r.text || "").filter(Boolean).sort((a, b) => b.length - a.length)[0];
      if (text) {
        pageRead = await readSalesFromText(card, text, ANTHROPIC_API_KEY, Math.min(20000, left()));
        if (!pageRead.length) {
          const info = readSalesFromText.last || {};
          const itms = (text.match(/\[itm:\d+\]/g) || []).length;
          ebayProblem = `eBay's page was read but no matching sales were on it (page: ${info.pageIs || "?"}; ${info.count ?? "?"} listings, ${itms} item links, ${text.length} characters${info.examples && info.examples.length ? `; e.g. “${info.examples[0]}”` : ""})`;
        }
      } else ebayProblem = results.map(r => r.problem).find(Boolean) || "ScraperAPI found no eBay sales for these words";
    }
  } else {
    for (const q of tries) {
      if (left() < 30000) break;
      const got = await fetchEbay(q, raw);
      searched.push(`${q} (${got.length})`);
      const ids = new Set(items.map(s => s.url));
      items = items.concat(got.filter(s => !ids.has(s.url)));
      if (items.length >= 8 || ebayProblem) break; // blocked once = blocked every time
    }
    if (ebayProblem && /blocked|refused|unexpected/.test(ebayProblem)) ebayProblem += " (add a SCRAPER_API_KEY in Vercel to fix this)";
  }
  let ebay = pageRead.slice(), via = "";
  if (items.length) ebay = (await within(pickMatches(card, items.slice(0, 60), ANTHROPIC_API_KEY), Math.min(15000, left()), null)) || [];
  const viaSales = await within(viaPromise, left(), []);
  if (!ebay.length && viaSales.length) { ebay = viaSales; via = " (read by Claude)"; }
  else if (viaSales.length) {
    const ids = new Set(ebay.map(s => s.url));
    ebay = ebay.concat(viaSales.filter(s => !s.url || !ids.has(s.url)));
  }

  // Web search of every other sales site (any date).
  const web = await within(webPromise, left(), { sales: [], note: "" });
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
    ? `${ebay.length} from eBay sold listings${via}${hasKey ? " (via ScraperAPI)" : ""}${extra.length ? `, ${extra.length} from other sites` : ""}.`
    : `${ebayProblem ? (/^eBay/.test(ebayProblem) ? ebayProblem : ebayProblem.charAt(0).toUpperCase() + ebayProblem.slice(1)) + ", so these are from other sites. " : "No matching eBay sales found; these are from other sites. "}${web.note || ""}`.trim();
  const out = summarize(all, today, note);
  out.searched = searched.length ? `eBay searched: ${searched.join(" · ")}` : `eBay search words: ${tries[0]}`;
  if (!all.length) out.note = `${ebayProblem ? (/^eBay/.test(ebayProblem) ? ebayProblem : ebayProblem[0].toUpperCase() + ebayProblem.slice(1)) + "." : ""} ${out.searched}`.trim();
  if (out.average == null) out.estimate = await within(estPromise, left(), null);
  return res.status(200).json(out);
};

async function webSearchLookup(card, today, ANTHROPIC_API_KEY, promptText) {
  let ai;
  try {
    ai = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
        messages: [{ role: "user", content: promptText || buildPrompt(card, today) }],
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
    grade: String(s.grade || ""),
    url: /^https?:\/\//.test(String(s.url || "")) ? String(s.url) : "",
  }));
  return { sales: sales.filter(s => isFinite(s.price) && s.price > 0), note: String(parsed.note || "") };
}


// ---------- "See all grades": sales of this card in every grade from one company ----------
const GRADE_ORDER = ["10","9.5","9","8.5","8","7.5","7","6.5","6","5.5","5","4.5","4","3.5","3","2.5","2","1.5","1"];
function gradeFromTitle(title, grader) {
  const t = String(title || "").toUpperCase();
  const g = grader.toUpperCase();
  const m = t.match(new RegExp(`\\b${g}\\s*(?:GEM\\s*(?:MINT|MT)\\s*|MINT\\s*|NM-MT\\s*|NM\\s*|EX-MT\\s*|EX\\s*|VG-EX\\s*|VG\\s*|GOOD\\s*|PR\\s*|PRISTINE\\s*)?(10|[1-9](?:\\.5)?)\\b`));
  return m ? m[1] : "";
}

// Estimate when no sales turn up anywhere. Clearly labeled as an estimate on the page.
async function aiEstimate(card, today, key) {
  const grade = card.condition === "graded" ? `${card.grader || ""} ${card.grade || ""}`.trim() : `raw${card.rawCondition ? " (" + card.rawCondition + ")" : ""}`;
  const prompt = `Today is ${today}. Estimate the current market value in USD of this sports card: ${card.query}, condition: ${grade}.
No recent sales of this exact card were found, so base it on what you know: sales of this card in other grades, similar parallels and print runs, the player's current demand, and how much gem-mint grades of star rookies sell for compared with raw copies. Do not anchor on the base card if this is a parallel, numbered, autographed or high-grade copy.
Return ONLY JSON: {"value":number,"low":number,"high":number,"basis":string (one short sentence on what it's based on)}`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const t = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const j = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    const v = Number(j.value), lo = Number(j.low), hi = Number(j.high);
    if (!isFinite(v) || v <= 0) return null;
    return { value: Math.round(v), low: isFinite(lo) && lo > 0 ? Math.round(lo) : null, high: isFinite(hi) && hi > 0 ? Math.round(hi) : null, basis: String(j.basis || "").slice(0, 240) };
  } catch { return null; }
}

async function allGradesLookup(card, today, key, res) {
  const GR = [[/psa/i,"PSA"],[/bgs|beckett/i,"BGS"],[/sgc/i,"SGC"],[/cgc/i,"CGC"]];
  const grader = (GR.find(([re]) => re.test(card.grader || "")) || [null, "PSA"])[1];
  const GRADE_WORDS = /\b(psa|bgs|sgc|cgc|csg|beckett|hga|gem|mint|mt|nm|nm-mt|near|pristine|black label|authentic|auth|graded|slab(?:bed)?|raw)\b/gi;
  const words = card.query
    .replace(/\b(cert(ificate)?|cert\s*#|no\.?)\s*:?\s*\d{5,}/gi, " ").replace(/\b\d{6,}\b/g, " ")
    .replace(/\b\d{1,4}\s*\/\s*(\d{1,4})\b/g, "/$1").replace(/[#(),]/g, " ").replace(GRADE_WORDS, " ")
    .replace(/(^|\s)(10|9\.5|9|8\.5|8|7\.5|7|6|5|4|3|2|1)(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();
  const q = `${words} ${grader}`.trim();

  const started = Date.now();
  const left = () => 52000 - (Date.now() - started);
  const within = (p, ms, fb) => Promise.race([p, new Promise(r => setTimeout(() => r(fb), Math.max(ms, 1000)))]);

  const webPrompt = `Today's date is ${today}. Find completed sales (final sold prices) of this sports card in EVERY ${grader} grade: ${words}.
Use any reliable source of real sold prices (eBay sold listings, 130point, Goldin, Fanatics Collect/PWCC, Heritage, PSA Auction Prices Realized, Card Ladder and others). Look for the newest sales of each grade first (this month and last month matter most), then older ones from any year.
Only the SAME card: same year, set, card number and parallel. Only ${grader}-graded copies. Never invent a sale.
Return ONLY JSON: {"sales":[{"grade":"10" (just the ${grader} grade number),"date":"YYYY-MM-DD" or "","price":number,"source":string,"title":string,"url":string}],"note":string}
Up to 30 sales total, covering as many grades as you can find.`;
  const viaPrompt = `Today is ${today}. Open this eBay "sold items" page with the web_fetch tool: ${ebayUrl(q, false)}
List the SOLD listings that are this card: ${words}, graded by ${grader} (any grade). Same player, year, set and parallel; skip lots and other parallels. For each give the ${grader} grade number from the title, the real "Sold" date and the sold price.
Return ONLY JSON: {"sales":[{"grade":"10","date":"YYYY-MM-DD","price":number,"title":string,"url":string}]}. Up to 40, newest first.`;

  const webP = within(webSearchLookup({ ...card, query: words }, today, key, webPrompt), 50000, { sales: [] });
  const viaP = within((async () => {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-beta": "web-fetch-2025-09-10", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 4000,
          tools: [{ type: "web_fetch_20250910", name: "web_fetch", max_uses: 2, allowed_domains: ["ebay.com", "www.ebay.com"], max_content_tokens: 80000 }],
          messages: [{ role: "user", content: viaPrompt }] }),
      });
      if (!r.ok) return [];
      const d = await r.json();
      const t = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      const j = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
      readSalesFromText.last = { count: Number(j.listings_on_page) || 0, examples: (j.examples || []).map(String).slice(0, 2), pageIs: String(j.page_is || "").slice(0, 60) };
    return (j.sales || []).map(s => ({ grade: String(s.grade || ""), date: /^\d{4}-\d{2}-\d{2}$/.test(String(s.date || "")) ? s.date : "",
        price: Number(String(s.price).replace(/[$,]/g, "")), source: "eBay", title: String(s.title || "").slice(0, 160),
        url: /^https?:\/\/(www\.)?ebay\.com\//.test(String(s.url || "")) ? String(s.url) : "" }));
    } catch { return []; }
  })(), 50000, []);

  // Direct eBay check: one search for the card + company, then sort by the grade in each title.
  let direct = [];
  useProxy = !!(process.env.SCRAPER_API_KEY || "").trim();
  const items = await within(fetchEbay(q, false), 40000, []);
  if (items.length) {
    const prompt = `Card: ${words}\nBelow are sold eBay listing titles. Return the numbers of the listings that are this SAME card (same player, year, set, card number if given, and same parallel), graded by ${grader} in ANY grade. Exclude lots, reprints, other parallels, raw cards and other grading companies.\n\n${items.slice(0, 80).map((s, i) => `${i}. ${s.title}`).join("\n")}\n\nReturn ONLY JSON: {"match":[numbers]}`;
    try {
      const r = await within(fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 800, messages: [{ role: "user", content: prompt }] }),
      }), Math.min(15000, left()), null);
      if (r && r.ok) {
        const d = await r.json();
        const t = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
        const j = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
        direct = (j.match || []).map(Number).filter(n => items[n]).map(n => ({ ...items[n], grade: gradeFromTitle(items[n].title, grader) }));
      }
    } catch {}
  }

  const [via, web] = await Promise.all([within(viaP, left(), []), within(webP, left(), { sales: [] })]);
  const seen = new Set(), all = [];
  for (const s of [...direct, ...via, ...(web.sales || [])]) {
    const grade = (String(s.grade || "").match(/10|[1-9](?:\.5)?/) || [""])[0] || gradeFromTitle(s.title, grader);
    if (!grade || !isFinite(s.price) || s.price <= 0) continue;
    const id = (String(s.url || "").match(/\/itm\/(\d+)/) || [])[1];
    const k = id || `${grade}|${s.date}|${Math.round(s.price)}`;
    if (seen.has(k)) continue;
    seen.add(k); all.push({ ...s, grade });
  }
  const grades = GRADE_ORDER.map(g => {
    const list = all.filter(s => s.grade === g);
    if (!list.length) return null;
    const sum = summarize(list, today, "");
    return { grade: g, average: sum.average, used: sum.used, low: sum.low, high: sum.high, count: list.length,
      newest: (sum.sales.find(s => s.date) || {}).date || "", sales: sum.sales.slice(0, 8) };
  }).filter(Boolean);
  return res.status(200).json({ grader, grades,
    note: grades.length ? "" : `No ${grader} sales of this card turned up. ${ebayProblem ? ebayProblem + "." : ""} eBay search words: ${q}` });
}


// ---------- "Show active listings": cards for sale right now on eBay ----------
async function activeLookup(card, key, res) {
  if (!(process.env.SCRAPER_API_KEY || "").trim()) {
    return res.status(200).json({ listings: [], note: "Active eBay listings need the SCRAPER_API_KEY in Vercel. Use the links below to search each site." });
  }
  const raw = card.condition !== "graded";
  const GR = [[/psa/i,"PSA"],[/bgs|beckett/i,"BGS"],[/sgc/i,"SGC"],[/cgc/i,"CGC"]];
  const grader = (GR.find(([re]) => re.test(card.grader || "")) || [null, ""])[1];
  const gnum = (String(card.grade || "").match(/\d+(?:\.\d)?/) || [""])[0];
  const gradeTag = !raw && grader ? `${grader} ${gnum}`.trim() : "";
  const GRADE_WORDS = /\b(psa|bgs|sgc|cgc|csg|beckett|hga|gem|mint|mt|nm|nm-mt|pristine|authentic|graded|slab(?:bed)?)\b/gi;
  const words = card.query
    .replace(/\b\d{6,}\b/g, " ").replace(/\b\d{1,4}\s*\/\s*(\d{1,4})\b/g, "/$1").replace(/[#(),]/g, " ").replace(GRADE_WORDS, " ")
    .replace(/(^|\s)(10|9\.5|9|8\.5|8|7\.5|7|6|5|4|3|2|1)(?=\s|$)/g, raw ? "$1$2" : " ").replace(/\s+/g, " ").trim();
  const q = `${words} ${gradeTag}`.trim();
  const query = raw ? `${q} -psa -bgs -sgc -cgc -graded -slab` : q;

  let list = [];
  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 40000);
    const r = await fetch("https://api.scraperapi.com/structured/ebay/search?" + new URLSearchParams({
      api_key: process.env.SCRAPER_API_KEY.trim(), query, items_per_page: "60", tld: "com" }), { signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) return res.status(200).json({ listings: [], note: `Couldn’t load eBay listings right now (code ${r.status}). Use the links below.`, searched: q });
    const d = await r.json();
    list = Array.isArray(d) ? d : (d.products || d.results || d.items || []);
  } catch { return res.status(200).json({ listings: [], note: "eBay took too long. Try again, or use the links below.", searched: q }); }

  const items = [], seen = new Set();
  for (const x of list) {
    const title = String(x.product_title || x.title || x.name || "").replace(/^New Listing\s*/i, "").trim();
    const po = x.item_price || x.price || {};
    if (po.from && po.to) continue; // multi-item listings
    const price = Number(typeof po === "object" ? po.value : String(po).replace(/[$,]/g, ""));
    const url = String(x.product_url || x.url || x.link || "");
    const id = (url.match(/\/itm\/(?:[^"\/?]*\/)?(\d{9,15})/) || [])[1];
    if (!title || !id || seen.has(id) || !isFinite(price) || price <= 0 || /^shop on ebay$/i.test(title)) continue;
    seen.add(id);
    const extra = String(x.extra_info || x.buying_format || "");
    items.push({ title: title.slice(0, 160), price, url: `https://www.ebay.com/itm/${id}`,
      image: /^https:\/\//.test(String(x.image || x.thumbnail || "")) ? String(x.image || x.thumbnail) : "",
      type: /bid/i.test(extra) || /auction/i.test(extra) ? (extra.match(/\d+\s*bids?/i)?.[0] || "Auction") : /best offer/i.test(extra) ? "Buy It Now · Best Offer" : extra ? "Buy It Now" : "",
      source: "eBay" });
  }
  // Keep only this exact card in this grade.
  let keep = items;
  if (items.length) {
    const m = await pickMatches(card, items.slice(0, 60), key);
    if (m) keep = m;
  }
  keep.sort((a, b) => a.price - b.price);
  return res.status(200).json({ listings: keep.slice(0, 25), searched: q,
    note: keep.length ? "" : `No active eBay listings of this exact card right now. eBay search words: ${q}` });
}

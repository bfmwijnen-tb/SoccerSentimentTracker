# De Stemming — Eredivisie sentiment tracker

Tracks public sentiment about all 18 Eredivisie clubs by collecting Dutch football coverage
and fan reaction, scoring it with a Dutch-tuned sentiment analyzer, anchoring it to match
results, and serving an interactive dashboard.

---

## Easiest: don't install anything

**Just want to look at it?** Open `dist/stemming.html` in any browser. It is the entire
dashboard in one self-contained file — no install, no terminal, no server. Ask whoever set
this up for a copy, or produce one with `npm run export`.

**Want it to stay current, still without installing anything?** Fork this repo and let
GitHub run it for you:

1. Fork the repo on GitHub.
2. Go to **Settings → Pages** and set *Source* to **GitHub Actions**.
3. Go to **Actions**, pick *Collect and publish dashboard*, click **Run workflow**.

That's it. GitHub collects the data on its own machines every six hours and publishes the
dashboard at `https://<your-username>.github.io/SoccerSentimentTracker/`. Nothing runs on
your computer, ever. The workflow is `.github/workflows/publish.yml`.

The workflow enables Pages itself on the first run, so step 2 is usually unnecessary — but
some accounts and organisations do not allow that to happen automatically, in which case the
deploy step fails with:

```
Failed to create deployment (status: 404)
Ensure GitHub Pages has been enabled
```

That message means the collection worked and only publishing was blocked. Set
**Settings → Pages → Source: GitHub Actions** and re-run. Either way the dashboard is
attached to every run as a downloadable **dashboard** artifact, so you can always grab the
file from the Actions tab even if Pages never gets switched on.

Everything below is for running it locally instead.

---

## Run it locally

You need [Node.js 20 or newer](https://nodejs.org). Nothing else — no API keys, no database
to install, no accounts.

```bash
npm install
npm run setup     # fetches fixtures + the last 30 days of coverage (~1 min)
npm start         # then open http://localhost:8787
```

That's it. `npm run setup` is safe to re-run at any time.

**Keep it up to date** — there is a **Data verversen** button in the dashboard header that
collects on demand, so you never need a terminal once it is running. RSS feeds only carry a
day or two, so history builds forward from your first run; for unattended updates, cron:

```cron
*/30 * * * * cd /path/to/SoccerSentimentTracker && npm run collect >> collect.log 2>&1
0    6 * * * cd /path/to/SoccerSentimentTracker && npm run fixtures >> collect.log 2>&1
```

<details>
<summary><strong>Something went wrong?</strong></summary>

| Symptom | Fix |
|---|---|
| `command not found: npm` | Install Node.js 20+ from nodejs.org |
| `better-sqlite3` fails to build | `npm install` needs a C++ toolchain: `apt install build-essential` (Linux) or Xcode command line tools (macOS) |
| Port 8787 already in use | `PORT=9000 npm start` |
| Charts are empty | Run `npm run setup` first — the database starts empty |
| Opening `web/index.html` directly shows nothing | That file needs the API. Use `npm run export` for a standalone version |
| "Media versus fans" says no fan sources | Expected. See *Data sources* below |
| Match-anchored views are empty | Expected until fixtures and collected documents cover the same dates. The dashboard shows you both ranges |

Start over from scratch with `rm -rf data/ && npm run setup`.
</details>

### No server: a standalone HTML file

If you'd rather not keep Node running — to share the dashboard, mail it, drop it on a static
host, or just double-click it — export it as a single self-contained file:

```bash
npm run export        # writes dist/stemming.html (~1 MB)
```

Open that file directly in any browser. No server, no install, no network: the stylesheet,
the scripts and the data are all inlined, and every period and source filter still works
because each combination is precomputed at export time. Club filters and chart interactions
work as normal.

It is a **snapshot** — the page says so at the top, with the moment it was taken — so re-run
`npm run export` whenever you want fresh numbers. Collection itself still needs Node, since
that part has to fetch and score; only the viewing becomes portable.

```bash
npm run export -- --out ~/Desktop/stemming.html   # write it somewhere else
```

### Commands

```
npm run setup                   First run: fixtures + a 30-day window
npm run collect  [--days 7]     Fetch, score and store new documents
npm run fixtures                Refresh Eredivisie fixtures and results
npm run relex                   Re-run analysis over stored documents
npm run rescore  [--limit 200]  Re-score ambiguous documents with Claude
npm run stats    [--days 30]    Current standings in the terminal
npm run table    [--days 30]    League table with a sentiment column
npm run pressure [--days 30]    Manager pressure index
npm run alerts   [--dry-run]    Check sentiment alerts, fire webhooks
npm run export   [--out FILE]   Build a standalone single-file dashboard
npm start                       Serve the dashboard on :8787
npm test                        Run the test suite
```

---

## Is this actually possible?

Yes, with one caveat that shapes the whole design: **the platforms with the best fan
sentiment are the hardest to collect from, and the sources that are trivial to collect
measure something subtly different.**

| Source | Status | What it measures |
|---|---|---|
| Dutch football RSS (11 feeds) | ✅ **Works now, no credentials** | *Media tone* — how the press writes about a club |
| Eredivisie fixtures & results | ✅ **Works now, no credentials** | Match dates, scorelines, form |
| Reddit (r/Ajax, r/PSV, r/Feyenoord, r/Eredivisie) | 🔑 Free OAuth app | Genuine fan reaction. Skews English on club subs |
| YouTube comments | 🔑 Free API key | The most *Dutch* social source |
| Bluesky | ⚠️ Free, but IP-dependent | The practical X/Twitter replacement |
| X / Twitter | ❌ Not implemented | API starts around $200/month |

That last column is the most important thing to understand here. Press coverage is written
to be measured — edited, hedged, professionally neutral. Fan reaction is not. A club whose
press is calm while its fans are furious is in a completely different situation from one
where both agree, and the **Media versus fans** panel exists to surface exactly that gap.

Out of the box you only get the media half. That is a real limitation, stated plainly on the
dashboard rather than hidden.

### Why some sources need credentials

Reddit and Bluesky both refuse anonymous requests from datacenter IPs — an anti-bot measure
on their side, not something you can prompt your way around. From a home connection
Bluesky's public search works; from a VPS it returns 403. Reddit's OAuth app is free, takes
about two minutes, and is the reliable path everywhere.

There is a subtler one worth knowing: several large Dutch publishers (DPG Media's `ad.nl`
and `nu.nl`, plus `telegraaf.nl`) sit behind bot filters that fingerprint the **TLS
handshake** rather than the headers. Node's HTTP client gets a 403 no matter what
`User-Agent` it sends, while an ordinary `curl` of the same URL with the same identifying
User-Agent succeeds. `src/collectors/http.ts` retries through curl when that happens — same
identity, same politeness delay, different HTTP client.

### Legal and ethical position

- **Only public content.** No logins, no paywall circumvention, no private groups.
- **Only what the publisher syndicates.** RSS exists to be read by machines; the collector
  reads the feed, not the article behind it.
- **One request per host per 1.2s**, with an identifying User-Agent carrying a contact URL.
  Set a real one in `.env`.
- **Official APIs wherever they exist** (Reddit OAuth, YouTube Data API, Bluesky XRPC)
  rather than scraping HTML.
- **Author names are stored** for the feed view, but that is personal data under the GDPR.
  If you publish this or keep it long-term, drop or hash the `author` column — aggregate
  sentiment does not need it.
- **Player and manager views are aggregate opinion about public figures' professional
  performance**, and are framed that way. The pressure index in particular is a mood
  indicator built from public commentary, **not a prediction about anyone's job**.
- **Do not present any of this as fact about individuals.** It measures the tone of public
  posts.

---

## Why the sentiment analyzer is hand-built

The obvious approaches all fail:

- **English sentiment models score Dutch text near zero.** The failure is silent — you get a
  flat, neutral, meaningless chart that looks perfectly plausible.
- **General Dutch sentiment sets** (Pattern, DuOMan) are trained on product reviews. They
  score `dramatisch` and `kansloos` as mild, when in football they are the strongest
  negatives a fan uses.
- **Football inverts ordinary Dutch.** `hard` is praise for a defender. `makkelijk` is an
  insult. `rustig` compliments a keeper and criticises a midfield.

So `src/sentiment/lexicon.nl.ts` is a purpose-built Dutch football lexicon: ~250 weighted
terms, multi-word phrases (`om te janken`, `klasse apart`), intensifiers, diminishers,
negation, contrast markers, emoji, and the terrace register fans actually type. The analyzer
weights the clause after a contrast marker (`maar`, `helaas`) above the concession before
it, and normalises with `tanh` so scores stay open-ended instead of pinning at ±1.

Dutch inflection gets two special cases, because both are common in exactly these words:
consonant doubling (`zwak` → `zwakke`) and vowel shortening (`groot` → `grote`). Without
them, "zwakke wedstrijd" scores zero — the term is in the lexicon and the inflected form
never reaches it.

### The one thing a lexicon cannot do

Irony. Dutch football commentary runs on it, and *"geweldig hoor, weer zo'n briljante
wissel"* scores strongly positive on its face while being about the most negative thing a
fan can say.

The analyzer does not pretend to solve this. It **flags** what it cannot resolve — irony
markers, or high emotional magnitude with a near-zero net score — and only those go to
Claude for a second read:

```bash
ANTHROPIC_API_KEY=... npm run rescore
```

Typically under 10% of the corpus, which keeps it cheap while fixing the cases where the
lexicon is not merely imprecise but backwards. Flagged items are marked *"mogelijk
ironisch"* in the feed whether or not you run the pass.

Expect roughly 70–75% accuracy from the lexicon alone. Good enough for tracking movement and
direction, which is what the dashboard is for. Not good enough to quote a single document's
score as fact.

---

## What's on the dashboard

**Overzicht** — sentiment per club, the fluent timeline with match markers, topic breakdown,
media-versus-fans, live feed, source health.

**Competitie** — the league table with a sentiment column. The interesting row is the
mismatch: fourth place with a fanbase at −0.4 is a different situation from fourth at +0.3.

**Druk** — the **ontslagbarometer** (manager pressure), whether fans overreact (sentiment
swing per result), and whether pre-match mood predicts results at all.

**Spelers** — most-discussed players and transfer hype. Names are extracted from the text
rather than matched against a squad list, so loan targets and youth debutants appear the
moment they are written about.

**Derby's** — each rivalry's last meeting with both fanbases either side of kick-off.

**Records** — best and worst weeks on record, plus fired alerts.

---

## Design decisions worth knowing

**Clubs are not drawn in their own colours.** Ajax, PSV and Feyenoord all play in
red-and-white — three near-identical reds on one axis would be unreadable, and hopeless
under colour-vision deficiency. Chart series use a validated categorical palette
(orange / aqua / violet) and club identity is carried by crest chips and direct labels.

The club palette also deliberately avoids blue and red, because those two carry *sentiment
polarity* everywhere else on the page. Keeping the palettes disjoint means a colour never
means "Ajax" in one chart and "positive" in the next. Both are validated for CVD separation,
chroma, lightness band and contrast in light and dark mode.

**Only three clubs can be charted at once.** The validated palette carries exactly three
all-pairs-distinct slots; a fourth would put two confusable colours on one axis. The other
15 clubs appear in the league table and the barometer, which identify by name rather than
hue.

**Lines are smoothed, and gaps are bridged — but the tooltip never lies.** Daily sentiment
is genuinely spiky, so the timeline applies a centred rolling mean (togglable: raw / 3d / 7d)
and draws a monotone cubic curve, which cannot overshoot the ±1 the data can actually
occupy. Days with no coverage are interpolated so the line stays continuous, and the tooltip
says *"geen data"* for those days rather than reporting an inferred number as measured.

**Sentiment is weighted, not averaged.** `confidence × (1 + ln(1 + engagement))` — a
throwaway comment should not count the same as a widely-upvoted verdict, and a document the
analyzer barely understood should not count the same as one it read confidently. The
logarithm matters: engagement is power-law distributed, so a linear weight would let one
viral post dictate a club's daily mood.

**Thin data is never allowed to look like a finding.** The pressure index drops the trend
component below a coverage floor, the reactivity view requires documents on both sides of a
match, the predictive view reports its sample count, and the player board requires several
mentions before a name appears.

**A document about two clubs counts for both.** A Klassieker report genuinely is about Ajax
and Feyenoord; only the club named in the title is marked primary.

**Analysis is stored separately from documents**, so a lexicon, topic or extractor change
rolls out over the existing corpus without re-fetching (`npm run relex`).

---

## Layout

```
src/
  clubs.ts              18 clubs, alias matching, derbies, false-positive guards
  collectors/           One module per source; add a file, register it in index.ts
    fixtures.ts         Eredivisie results — the anchor for every match-based view
  sentiment/            Dutch lexicon, analyzer, topics, player names, Claude pass
  analysis/             Pressure, reactivity, predictive, derbies, records, players
  alerts.ts             Threshold checks + webhook delivery
  db/                   SQLite schema and the query layer behind the API
  server/               Static file server + JSON API
web/                    Dashboard (no build step — plain ES modules and CSS)
```

Adding a source means implementing the `Collector` interface in `src/types.ts` and
registering it. Everything downstream — club attribution, scoring, topics, player
extraction, storage, the API and the dashboard — picks it up automatically.

---

## Known limitations

- Out of the box this measures media tone, not fan sentiment. The dashboard says so.
- The lexicon is tuned for Dutch. English Reddit comments score weakly; language is recorded
  per document so you can filter.
- RSS carries roughly 24–48 hours, so history builds forward from your first run rather than
  backfilling. The 90-day and season views fill in over time.
- **Match-anchored views need fixtures and documents to cover the same dates.** Fixture data
  reaches back a full season while collection starts today, so early on the overlap is zero
  and those panels say so, showing you both date ranges.
- Google News items are title-only, which is why some feed entries score exactly 0.00 —
  not enough text to read.
- Player names are extracted heuristically. Prominent journalists occasionally appear
  alongside players; a minimum mention count keeps one-off noise off the board.
- Sarcasm is flagged, not solved, unless you enable the Claude pass.

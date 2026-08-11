# De Stemming — Eredivisie sentiment tracker

Tracks public sentiment about **Ajax**, **PSV** and **Feyenoord** by collecting Dutch
football coverage and fan reaction, scoring it with a Dutch-tuned sentiment analyzer, and
serving an interactive dashboard.

```bash
npm install
npm run seed      # collect the last 30 days (no credentials needed)
npm start         # http://localhost:8787
```

That works with an empty `.env`. Everything below is about making it better.

---

## Is this actually possible?

Yes, with one important caveat that shapes the whole design: **the platforms with the best
fan sentiment are the hardest to collect from, and the sources that are trivial to collect
measure something subtly different.**

| Source | Status | What it actually measures |
|---|---|---|
| Dutch football RSS (11 feeds) | ✅ **Works now, no credentials** | *Media tone* — how the press is writing about a club |
| Reddit (r/Ajax, r/PSV, r/Feyenoord, r/Eredivisie) | 🔑 Needs a free OAuth app | Genuine fan reaction, match-thread culture. Skews English on club subs |
| YouTube comments | 🔑 Needs a free API key | The most *Dutch* social source — comments under Eredivisie highlights |
| Bluesky | ⚠️ Free, but IP-dependent | Microblog reaction; the practical X/Twitter replacement |
| X / Twitter | ❌ Not implemented | API starts around $200/month — out of reach for a hobby project |

The distinction in that last column is the single most important thing to understand about
this project. Press coverage is written to be measured — it is edited, hedged, and
professionally neutral. Fan reaction is not. A club whose press is calm while its fans are
furious is in a completely different situation from one where both agree, and the dashboard
has a **Media versus fans** panel that exists to surface exactly that gap.

Out of the box you only get the media half. That is a real limitation, stated plainly on the
dashboard itself rather than hidden.

### Why some sources need credentials

Reddit and Bluesky both refuse anonymous requests from datacenter IPs. This is not a
blocker you can prompt your way around — it is an anti-bot measure on their side. From a
home connection Bluesky's public search works fine; from a VPS it returns 403. Reddit's
OAuth app is free and takes about two minutes to create, and it is the reliable path
everywhere.

There is also a subtler one worth knowing about: several large Dutch publishers (DPG Media's
`ad.nl` and `nu.nl`, plus `telegraaf.nl`) sit behind bot filters that fingerprint the **TLS
handshake** rather than the headers. Node's HTTP client gets a 403 no matter what
`User-Agent` it sends, while an ordinary `curl` of the same URL with the same identifying
User-Agent succeeds. `src/collectors/http.ts` retries through curl when that happens — same
identity, same politeness delay, just a different HTTP client.

### Legal and ethical position

This matters and is easy to get wrong.

- **Only public content is collected.** No logins, no paywall circumvention, no private groups.
- **Only what the publisher syndicates.** RSS feeds exist to be read by machines; the
  collector reads the feed, not the article body behind it.
- **One request per host per 1.2s**, with an identifying User-Agent carrying a contact URL.
  Set a real one in `.env`.
- **Official APIs are used wherever they exist** (Reddit OAuth, YouTube Data API, Bluesky
  XRPC) rather than scraping the HTML — this is both more robust and more respectful.
- **Author names are stored** because attribution matters for a feed view, but this is
  personal data under the GDPR. If you publish this or keep it long-term, drop the `author`
  column or hash it — and note that aggregate sentiment does not need it at all.
- **Do not present this as fact about individuals.** It measures the tone of public posts,
  not what any person believes.

If you deploy this publicly, read each platform's ToS yourself. Reddit and YouTube both
permit this kind of analysis under their API terms; scraping a forum that forbids it in its
robots.txt is a different matter, which is why no forum scraper ships here.

---

## Why the sentiment analyzer is hand-built

This is the part that most determines whether the numbers mean anything, and the obvious
approaches all fail:

- **English sentiment models score Dutch text near zero.** The failure is silent — you get a
  flat, neutral, entirely meaningless chart that looks perfectly plausible.
- **General Dutch sentiment sets** (Pattern, DuOMan) are trained on product reviews. They
  score `dramatisch` and `kansloos` as mild, when in football they are the strongest
  negatives a fan uses.
- **Football inverts ordinary Dutch.** `hard` is praise for a defender. `makkelijk` is an
  insult. `rustig` compliments a keeper and criticises a midfield.

So `src/sentiment/lexicon.nl.ts` is a purpose-built Dutch football lexicon: ~250 weighted
terms, multi-word phrases (`om te janken`, `klasse apart`), intensifiers, diminishers,
negation, contrast markers, emoji, and the terrace register that fans actually type. The
analyzer applies negation and intensifier lookback, weights the clause after a contrast
marker (`maar`, `helaas`) above the concession before it, and normalises with `tanh` so
scores stay open-ended instead of pinning at ±1.

Dutch inflection gets two special cases, because both are common in exactly these words:
consonant doubling (`zwak` → `zwakke`) and vowel shortening (`groot` → `grote`). Without
them, "zwakke wedstrijd" scores zero — the term is right there in the lexicon and the
inflected form never reaches it.

### The one thing a lexicon cannot do

Irony. Dutch football commentary runs on it, and *"geweldig hoor, weer zo'n briljante
wissel"* scores strongly positive on its face while being about the most negative thing a
fan can say.

The analyzer does not pretend to solve this. It **flags** documents it cannot resolve —
irony markers, or high emotional magnitude with a near-zero net score — and those are the
only ones sent to Claude for a second read:

```bash
ANTHROPIC_API_KEY=... npm run rescore
```

On a typical week that is well under 10% of the corpus, which keeps it cheap while fixing
the cases where the lexicon is not merely imprecise but actively backwards. Flagged items
are marked *"mogelijk ironisch"* in the feed whether or not you run the pass.

Expect roughly 70–75% accuracy from the lexicon alone, and appreciably better on the
flagged subset with the Claude pass. It is good enough for tracking *movement and
direction*, which is what the dashboard is for. It is not good enough to quote a single
document's score as fact.

---

## Design decisions worth knowing

**Clubs are not drawn in their own colours.** Ajax, PSV and Feyenoord all play in
red-and-white — three near-identical reds on one axis would be unreadable normally and
hopeless under colour-vision deficiency. Chart series use a validated categorical palette
(orange / aqua / violet) and club identity is carried by crest chips and direct labels.

The club palette also deliberately avoids blue and red, because those two carry *sentiment
polarity* everywhere else on the page. Keeping the two palettes disjoint means a colour
never means "Ajax" in one chart and "positive" in the next. Both palettes are validated for
CVD separation, chroma, lightness band and contrast in light and dark mode.

**Gaps in the timeline are left as gaps.** If nothing was published about a club on a given
day, the line breaks rather than interpolating. Drawing a straight line across a silent week
would invent sentiment that was never measured.

**Sentiment is weighted, not averaged.** `confidence × (1 + ln(1 + engagement))` — a
throwaway one-line comment should not count the same as a widely-upvoted verdict, and a
document the analyzer barely understood should not count the same as one it read
confidently. The logarithm matters: engagement is power-law distributed, so a linear weight
would let one viral post dictate a club's entire daily mood.

**A document about two clubs counts for both.** A Klassieker match report genuinely is about
Ajax and Feyenoord; only the club named in the title is marked primary, so "Ajax beat PSV"
does not read as PSV content.

**Sentiment is stored separately from documents**, so a lexicon change rolls out over the
existing corpus without re-fetching anything (`npm run relex`).

---

## Commands

```
npm run seed                    First run: collect a 30-day window
npm run collect  [--days 7]     Fetch, score and store new documents
npm run relex                   Re-apply the lexicon to stored documents
npm run rescore  [--limit 200]  Re-score ambiguous documents with Claude
npm run stats    [--days 30]    Print current standings in the terminal
npm start                       Serve the dashboard on :8787
npm test                        Run the analyzer/parser tests
```

Keep it current with a cron entry:

```cron
*/30 * * * * cd /path/to/SoccerSentimentTracker && npm run collect >> collect.log 2>&1
```

## Layout

```
src/
  clubs.ts              Club definitions, alias matching, false-positive guards
  collectors/           One module per source; add a file, register it in index.ts
  sentiment/            Dutch lexicon, analyzer, topic tagging, optional Claude pass
  db/                   SQLite schema and the query layer behind the API
  server/               Static file server + JSON API
web/                    Dashboard (no build step — plain ES modules and CSS)
```

Adding a source means implementing the `Collector` interface in `src/types.ts` and
registering it. Everything downstream — club attribution, scoring, topic tagging, storage,
the API and the dashboard — picks it up automatically.

---

## Ideas worth building next

Roughly in order of value-for-effort.

**1. Anchor sentiment to fixtures.** Right now you see a dip without knowing why. Pull the
Eredivisie fixture list, mark match days on the timeline, and every spike gets an
explanation. This is the single highest-value addition and makes almost everything below
possible.

**2. Ontslagbarometer (sack-o-meter).** Combine coach-topic sentiment, its trend, and recent
results into a manager-pressure index. Fanbases telegraph a sacking weeks ahead, and this is
the kind of number people actually share.

**3. Do fans overreact?** With fixtures in place, measure sentiment change against result
quality. Which fanbase swings hardest per goal conceded? The dashboard already computes a
volatility figure per club as a first step toward this.

**4. Player-level sentiment.** Extract player names and track individuals. "Who is the most
criticised player at each club this month" is a genuinely interesting question, and squad
lists make the extraction tractable. Handle this carefully — it is aggregate opinion about
public figures' professional performance, and should be framed that way.

**5. Transfer hype tracker.** Transfer topics are already tagged. Track rumour volume and
sentiment per target and you get a "how much do fans want this signing" meter — plus, over a
window, which outlets' rumours actually come true.

**6. Predictive signal.** Does pre-match fan sentiment carry information about results that
odds do not? Probably weak, possibly not zero, and a genuinely interesting thing to test
honestly.

**7. Derby mode.** Klassieker and Rotterdam-derby weeks have their own emotional physics.
A dedicated view — sentiment in the 72 hours either side, both fanbases side by side — is
the most shareable artefact here.

**8. Expand to all 18 Eredivisie clubs.** `src/clubs.ts` is already a list; the work is
aliases and disambiguation (`Go Ahead Eagles` and `NEC` are harder to match than `Feyenoord`).
The three-slot chart palette caps at three series, so this needs small multiples or a
league-table view rather than more lines.

**9. Alerting.** Webhook or email when a club's sentiment drops more than X in 24 hours.
Turns the dashboard from something you visit into something that tells you when to look.

**10. Historical leaderboards.** "Worst week in Ajax history" (since collection began) writes
its own headlines once you have a year of data.

Two things I would *not* build: a public leaderboard ranking fanbases by negativity (it
rewards the wrong thing and invites brigading), and anything that surfaces individual
non-public accounts. Aggregate is the right altitude for this.

---

## Known limitations

- Out of the box this measures media tone, not fan sentiment. The dashboard says so.
- The lexicon is tuned for Dutch. English-language Reddit comments score weakly; language is
  recorded per document so you can filter.
- RSS feeds carry roughly the last 24–48 hours, so history builds forward from your first
  run rather than backfilling. The 90-day view fills in over time.
- Google News items are title-only, which is why many feed entries score exactly 0.00 —
  there is not enough text to read. This is honest rather than hidden.
- Sarcasm is flagged, not solved, unless you enable the Claude pass.

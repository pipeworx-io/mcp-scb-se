# @pipeworx/scb-se

[Statistics Sweden (SCB)](https://www.scb.se) MCP — Swedish official statistics: figures from the
PxWeb statistical database, plus what SCB has just published and what it is scheduled to publish
next. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

**Figures and table navigation** (PxWeb API, `api.scb.se`)

- `subjects(path?)` — navigate the subject tree (root or sub-path)
- `table_meta(path)` — table definition (dimensions, valid values)
- `query_table(path, body)` — request data from a table; `body` is a PxWeb query (`{query: [{code, selection: ...}], response: {format: "json-stat2"}}`)
- `sweden_latest_figure(indicator, period?)` — a Swedish headline statistic as a number in one call.
  Covers `inflation` (CPI annual change, percent) and `cpi` (index, 2020=100). Pinned to `KPI2020M`,
  because the similarly-named `KPItotM` froze at 2025M12 and would hand back a year-old figure.

**Releases** (SCB website, `www.scb.se`)

- `scb_se_statistical_news(days?, from?, to?, lang?, limit?)` — statistical news releases
  (*statistiknyheter*) already published: headline, summary, date, statistical product, URL.
  Swedish by default; `lang: "en"` for English titles.
- `scb_se_publishing_calendar(period?, from?, to?, form?, subject_areas?, sort_field?, sort_order?, limit?)`
  — the official publishing calendar: which statistical products are released on which date, with
  product code, reference period and publishing form. The only way to answer "what is SCB publishing
  next week".

## Auth

None. No API key on any endpoint. `api.scb.se` reports `maxCallsPerTimeWindow: 30` per 10s window,
CORS enabled, licence **CC0**. `www.scb.se/robots.txt` is `User-agent: * / Disallow:` — fully
permissive.

## Notes and traps

- **The release tools scrape HTML, not an API.** `www.scb.se` serves both listings as HTML
  fragments; there is no documented contract, and the field shapes can change without notice. The
  tool descriptions say so rather than implying an API.
- **`www.scb.se` is a different host from `api.scb.se`** and sits behind an F5 BIG-IP. It is
  reached with a browser User-Agent.
- **The publishing calendar is a GET.** Four different POST body shapes all return HTTP 200 with a
  plausible 20-row table that silently ignores every parameter and serves the default "1 week
  ahead" — it passes a smoke test while answering the wrong question. The real contract is
  `?period=Custom&dateFrom=…&dateTo=…&form=3&subjectAreas=AM&sortOrder=1&sortField=2&paging=0`,
  and `dateFrom`/`dateTo` are honoured **only** with `period=Custom`.
- **`<h4>N hits</h4>` in the calendar is the count on the current page (max 20), not the total.**
  The total appears only as the high end of the last pagination range link.
- **The news `datetime` attribute differs by language path.** `/en/` stamps US `M/D/YYYY h:mm:ss AM`;
  the Swedish path stamps `YYYY-MM-DD HH:MM:SS`. Parsing only one yields an empty window, not an error.
- **News paging is 1-indexed** (`paging=0` → 404), 5 items per page, and the archive runs hundreds of
  pages deep, so the walk is bounded by the requested date window and a page cap.
- The Atom feed at `https://www.scb.se/Feed/statistiknyheter/` is well-formed but returns exactly 10
  entries (~9 days) and ignores `?lang=en`, so it is not used as the source.
- PxWeb **v2beta** (`https://api.scb.se/OV0104/v2beta/api/v2/tables?lang=en&pastDays=7`) answers
  "which tables got new data" and is a separate question from either tool here. It carries no
  `nextUpdate` field — forward-looking scheduling exists only in the calendar.

## Data sources

- PxWeb API — `https://api.scb.se/OV0104/v1/doris/en/ssd/`
- Statistical news — `https://www.scb.se/hitta-statistik/statistiknyheter/` · `https://www.scb.se/en/finding-statistics/statistical-news/`
- Publishing calendar — `https://www.scb.se/en/finding-statistics/publishing-calendar/`

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "scb-se": {
      "url": "https://gateway.pipeworx.io/scb-se/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/scb-se/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Scb Se data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/scb_se_subjects \
  -H 'Content-Type: application/json' \
  -d '{"path":""}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/scb_se_subjects`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

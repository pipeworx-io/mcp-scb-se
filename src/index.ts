interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Statistics Sweden PxWeb MCP.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Statistics Sweden PxWeb');
}

const BASE = 'https://api.scb.se/OV0104/v1/doris/en/ssd';
const UA = 'pipeworx-mcp-scb-se/1.0 (+https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  {
    name: 'subjects',
    description: 'CATALOGUE of what Statistics Sweden (SCB) publishes — the subject tree of Swedish official statistics, returned as a browsable list of subjects and table paths. Use when the question is which Swedish statistics exist or where a table lives, then scb_se_table_meta and scb_se_query_table to read figures from it. For a Swedish figure itself — inflation, CPI, and the value for a given month — sweden_latest_figure answers in one call. This listing carries no observations and no time period, so it cannot answer a question that names a month or a year. Sweden only: Canadian figures are statcan, Denmark dst-dk, Estonia stat-ee.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Sub-path under /ssd/ (default empty = root).' } },
    },
  },
  {
    name: 'table_meta',
    description: 'Dimension definitions and valid filter values for one Statistics Sweden (SCB) table of SWEDISH official statistics (e.g. "BE/BE0101/BE0101A/BefolkningNy"). Required before scb_se_query_table so you know which codes to pass. Find the table path with scb_se_subjects first.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'e.g. "BE/BE0101/BE0101A/BefolkningNy"' } },
      required: ['path'],
    },
  },
  {
    name: 'query_table',
    description: 'Pull data from a table. body is a PxWeb query object.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        body: { type: 'object', description: '{query: [{code, selection: {filter, values}}], response: {format: "json-stat2"}}' },
      },
      required: ['path', 'body'],
    },
  },
  {
    name: 'scb_se_statistical_news',
    description:
      'What Statistics Sweden (SCB) has JUST PUBLISHED \u2014 the statistical news releases (statistiknyheter) from the last few days, with headline, summary, publication date and the statistical product each belongs to. Answers "vilka statistiknyheter har SCB publicerat de senaste 3 dagarna", "what did Statistics Sweden publish this week", "senaste statistiknyheterna fr\u00e5n SCB". Swedish headlines by default; pass lang="en" for the English titles. For releases still to come rather than already out, use scb_se_publishing_calendar. Read from the SCB website listing, so the field shapes depend on SCB markup rather than a published API contract.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days back from today, e.g. 3 for "de senaste 3 dagarna". Default 7. Ignored when from/to are given.' },
        from: { type: 'string', description: 'Start of the window as YYYY-MM-DD, e.g. "2026-08-07".' },
        to: { type: 'string', description: 'End of the window as YYYY-MM-DD. Defaults to today.' },
        lang: { type: 'string', description: '"sv" (default) for Swedish headlines, "en" for English.' },
        limit: { type: 'number', description: 'Maximum news items to return. Default 50, max 200.' },
      },
    },
  },
  {
    name: 'scb_se_publishing_calendar',
    description:
      'What Statistics Sweden (SCB) is SCHEDULED to publish and when \u2014 the official publishing calendar (publiceringskalender), returning each upcoming release with its statistical product, product code, reference period, publishing form and publishing date. Answers "what is SCB releasing next week", "n\u00e4r publicerar SCB KPI", "which Swedish statistics come out in September". Also reads backwards over a date range you name, to list what was released between two dates. For the text of releases already out, use scb_se_statistical_news. Read from the SCB website calendar listing, so the field shapes depend on SCB markup rather than a published API contract.',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', description: 'Forward1Week (default), Forward1Month, Forward3Months, Forward6Months, Forward1Year, Previous1Week, or Custom. Plain phrasings like "next month" are understood.' },
        from: { type: 'string', description: 'Start date as YYYY-MM-DD. Supplying from/to selects the Custom period automatically; date ranges are honoured only in that mode.' },
        to: { type: 'string', description: 'End date as YYYY-MM-DD. Required together with "from".' },
        form: { type: 'string', description: 'Publishing form: 0 all (default), 1 Database, 2 Publication, 3 Statistical news, 4 Tables and graphs. Words work too, e.g. "statistical news".' },
        subject_areas: { type: 'string', description: 'Comma-separated two-letter SCB subject-area codes to restrict to, e.g. "AM" (labour market), "PR" (prices), "BE" (population), "NR" (national accounts).' },
        sort_field: { type: 'string', description: '1 product name, 2 publishing date (default), 3 publisher.' },
        sort_order: { type: 'string', description: '0 ascending (default), 1 descending.' },
        limit: { type: 'number', description: 'Maximum releases to return. Default 40, max 200.' },
      },
    },
  },
  {
    name: 'sweden_latest_figure',
    description:
      'A Swedish headline statistic as a NUMBER, for the latest month or for a month you name — "what is inflation in Sweden", "Swedish CPI in June 2026". One call — "what is inflation in Sweden", "Swedish CPI right now". Returns the figure, its unit, the exact month it refers to, and the SCB table it came from. Use this when the question asks for a number; use scb_se_subjects only when the question asks what statistics exist. Covers Swedish consumer prices today: inflation (CPI annual change) and the CPI index level.',
    inputSchema: {
      type: 'object',
      properties: {
        indicator: {
          type: 'string',
          description: 'Which figure: "inflation" for the CPI annual change in percent, or "cpi" for the CPI index level (2020=100). Common phrasings are understood — "inflation rate", "consumer prices", "kpi".',
        },
        period: {
          type: 'string',
          description: 'Optional month, as "2026M06" or "2026-06" or "June 2026". Omit for the most recent published month. If the month you name has not been published yet, the response says so and names the latest month that has.',
        },
      },
      required: ['indicator'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'subjects': {
      const path = (args.path as string | undefined)?.replace(/^\/+|\/+$/g, '') ?? '';
      return scbGet(path ? `/${path}` : '');
    }
    case 'table_meta':
      return scbGet(`/${reqStr(args, 'path', '"BE/BE0101/BE0101A/BefolkningNy"').replace(/^\/+|\/+$/g, '')}`);
    case 'query_table': {
      const path = reqStr(args, 'path', '"BE/BE0101/BE0101A/BefolkningNy"').replace(/^\/+|\/+$/g, '');
      const body = args.body;
      if (!body || typeof body !== 'object') throw new Error('body must be a PxWeb query object.');
      const res = await pwFetch(`${BASE}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`SCB: ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
      return res.json();
    }
    case 'sweden_latest_figure':
      return latestFigure(reqStr(args, 'indicator', '"inflation"'), args.period);
    case 'scb_se_statistical_news':
      return statisticalNews(args);
    case 'scb_se_publishing_calendar':
      return publishingCalendar(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}


/**
 * Headline figures that answer a question on their own.
 *
 * Everything in this pack before now was navigation — browse the subject tree,
 * read a table's dimensions, then compose a PxWeb query — so "what is inflation
 * in Sweden" came back as a subject tree rather than a number, and three calls
 * stood between the question and its answer.
 *
 * TABLE CHOICE MATTERS AND IS NOT OBVIOUS. SCB publishes KPItotM next to
 * KPI2020M; the first is labelled "no update after 2025M12" and the second runs
 * to the current month. Both look like "the CPI table". Reading the stale one
 * would hand back a year-old figure with a straight face, so the live table is
 * pinned here and the choice is written down.
 */
const INDICATORS: Record<string, { table: string; contents: string; measure: string; unit: string; sibling: string }> = {
  inflation: {
    table: 'PR/PR0101/PR0101A/KPI2020M',
    contents: '00000804',
    measure: 'CPI, annual change',
    unit: 'percent',
    sibling: 'cpi',
  },
  cpi: {
    table: 'PR/PR0101/PR0101A/KPI2020M',
    contents: '00000808',
    measure: 'CPI, fixed index numbers (2020=100)',
    unit: 'index, 2020=100',
    sibling: 'inflation',
  },
};

/** "inflation rate", "consumer prices", "kpi" all mean one of two things. */
function resolveIndicator(raw: string): keyof typeof INDICATORS | null {
  const q = raw.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/inflat|annual change|price change|deflat/.test(q)) return 'inflation';
  if (/\bcpi\b|consumer price|price index|\bkpi\b|price level/.test(q)) return 'cpi';
  return null;
}


const MONTH_NAMES: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Normalise a stated month to PxWeb's `YYYYMmm`.
 *
 * A question that names a month was previously answered by the subject tree,
 * which has no period concept at all — so "June 2026" came back as a catalogue
 * of tables whose titles happen to contain year ranges, and read as data. Any
 * period a caller states has to either select that month or be told plainly
 * that it is not published; silently returning a different month is the same
 * failure wearing a number.
 */
function normalisePeriod(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  const t = String(raw).trim().toLowerCase();
  let m = t.match(/^(\d{4})m(\d{1,2})$/);
  if (m) return `${m[1]}M${m[2].padStart(2, '0')}`;
  m = t.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m) return `${m[1]}M${m[2].padStart(2, '0')}`;
  m = t.match(/^([a-z]{3,})\.?\s+(\d{4})$/) || t.match(/^(\d{4})\s+([a-z]{3,})$/);
  if (m) {
    const [name, year] = /^\d{4}$/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    const mm = MONTH_NAMES[name.slice(0, 3)];
    if (mm) return `${year}M${mm}`;
  }
  throw new Error(`Could not read "${raw}" as a month. Use "2026M06", "2026-06" or "June 2026".`);
}

async function latestFigure(rawIndicator: string, rawPeriod?: unknown): Promise<unknown> {
  const wantPeriod = normalisePeriod(rawPeriod);
  const key = resolveIndicator(rawIndicator);
  if (!key) {
    return {
      found: false,
      reason: 'indicator_not_supported',
      requested: rawIndicator,
      supported: Object.keys(INDICATORS),
      // Absence of a shortcut is not absence of the data — SCB publishes far
      // more than this, it just needs the browse path rather than one call.
      hint: 'This one-call shortcut covers Swedish consumer prices. Statistics Sweden publishes much more; reach it with scb_se_subjects to find the table, then scb_se_table_meta and scb_se_query_table.',
    };
  }
  const spec = INDICATORS[key];
  const res = await pwFetch(`${BASE}/${spec.table}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      query: [
        { code: 'ContentsCode', selection: { filter: 'item', values: [spec.contents] } },
        // A named month is selected by item; otherwise take the newest few.
        // `top` is newest-LAST in PxWeb, so the final row is the current one and
        // the preceding rows give the caller context for free.
        wantPeriod
          ? { code: 'Tid', selection: { filter: 'item', values: [wantPeriod] } }
          : { code: 'Tid', selection: { filter: 'top', values: ['3'] } },
      ],
      response: { format: 'json' },
    }),
  });
  if (!res.ok) {
    // A month that is not IN the table is rejected upstream as HTTP 400, not
    // returned as an empty result — so the graceful branch below never ran and
    // an unpublished month surfaced as a tool error. Found by calling the live
    // API; the mocked test asserted an empty payload, which is not what SCB does.
    if (wantPeriod && res.status >= 400 && res.status < 500) {
      const latest = await latestPublishedPeriod(spec);
      return {
        found: false,
        reason: 'period_not_published',
        indicator: key,
        requested_period: wantPeriod,
        ...(latest ? { latest_published_period: latest.period, latest_published_value: latest.value } : {}),
        table: spec.table,
        hint: `Statistics Sweden has no ${wantPeriod} in this series${latest ? `; the most recent published month is ${latest.period}` : ''}. Ask again without a period to get the latest figure.`,
      };
    }
    throw new Error(`SCB: ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
  }
  const data = (await res.json()) as { data?: { key?: string[]; values?: string[] }[] };
  const rows = (data.data ?? []).filter((r) => r?.values?.[0] !== undefined && r.values[0] !== '..');
  const newest = rows[rows.length - 1];
  if (!newest) {
    // A month the caller named but SCB has not released. Naming the latest month
    // that DOES exist is the difference between an answer and a shrug — and it
    // stops the caller retrying the same unpublished month.
    const latest = wantPeriod ? await latestPublishedPeriod(spec) : null;
    return {
      found: false,
      reason: wantPeriod ? 'period_not_published' : 'no_published_value',
      indicator: key,
      ...(wantPeriod ? { requested_period: wantPeriod } : {}),
      ...(latest ? { latest_published_period: latest.period, latest_published_value: latest.value } : {}),
      table: spec.table,
      hint: wantPeriod
        ? `Statistics Sweden has not published ${wantPeriod} for this series yet${latest ? `; the most recent published month is ${latest.period}` : ''}. Ask again without a period to get the latest figure.`
        : 'SCB returned no published value for the most recent months. The series exists; the latest periods may not be released yet.',
    };
  }
  const value = Number(newest.values?.[0]);
  return {
    found: true,
    indicator: key,
    measure: spec.measure,
    value: Number.isFinite(value) ? value : newest.values?.[0],
    unit: spec.unit,
    // The period is the whole answer for a "latest" question — a number without
    // the month it belongs to cannot be checked or compared.
    period: newest.key?.[0] ?? null,
    ...(wantPeriod ? { requested_period: wantPeriod } : {}),
    recent: rows.map((r) => ({ period: r.key?.[0] ?? null, value: Number(r.values?.[0]) })),
    also_available: spec.sibling,
    source: 'Statistics Sweden (SCB)',
    table: spec.table,
    contents_code: spec.contents,
  };
}


/** The newest month SCB has actually published for a series. */
async function latestPublishedPeriod(spec: { table: string; contents: string }): Promise<{ period: string; value: number } | null> {
  try {
    const res = await pwFetch(`${BASE}/${spec.table}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        query: [
          { code: 'ContentsCode', selection: { filter: 'item', values: [spec.contents] } },
          { code: 'Tid', selection: { filter: 'top', values: ['3'] } },
        ],
        response: { format: 'json' },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { key?: string[]; values?: string[] }[] };
    const rows = (data.data ?? []).filter((r) => r?.values?.[0] !== undefined && r.values[0] !== '..');
    const last = rows[rows.length - 1];
    return last?.key?.[0] ? { period: last.key[0], value: Number(last.values?.[0]) } : null;
  } catch {
    return null;
  }
}

async function scbGet(path: string): Promise<unknown> {
  const res = await pwFetch(`${BASE}${path}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`SCB: ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
  return res.json();
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  return v;
}

/* ------------------------------------------------------------------ *
 * Statistical news + publishing calendar (www.scb.se)
 *
 * These two answer the question the PxWeb API structurally cannot:
 * "what did SCB just publish" and "what is SCB publishing next week".
 * v1 `table_meta` returns {title, variables} only — no `updated`, no
 * dates — so a whole class of Swedish-language questions came back as
 * no_match for as long as the pack has existed.
 *
 * Both endpoints are HTML fragments on www.scb.se, NOT an API. That is
 * a scraping dependency on markup that can change without notice, and
 * it is said so in the tool descriptions rather than implying a
 * contract SCB never offered. www.scb.se is also a DIFFERENT host from
 * api.scb.se (F5 BIG-IP in front of it), so its reachability from a
 * Worker is a separate fact from the rest of the pack working.
 * ------------------------------------------------------------------ */

const WWW = 'https://www.scb.se';
/** Statistical news list; Swedish and English are separate paths, not a ?lang. */
const NEWS_PATH: Record<'sv' | 'en', string> = {
  sv: '/hitta-statistik/statistiknyheter/UpdatePagingResult',
  en: '/en/finding-statistics/statistical-news/UpdatePagingResult',
};
const CALENDAR_PATH = '/en/finding-statistics/publishing-calendar/UpdateKalenderResults';

/** SCB fronts www with an F5 WAF; a browser UA is what it expects. */
const WWW_UA =
  'Mozilla/5.0 (compatible; pipeworx-mcp-scb-se/1.1; +https://pipeworx.io)';

async function scbHtml(url: string): Promise<string> {
  const res = await pwFetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': WWW_UA },
  });
  if (!res.ok) throw new Error(`SCB www: ${res.status} for ${url}`);
  return res.text();
}

/** The fragments are .NET-encoded: numeric, hex and the usual named entities. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * The two language paths stamp `datetime` DIFFERENTLY, which is the trap that
 * makes a news tool look like it works and then silently drop every item:
 *   /en/ → "8/21/2026 8:00:00 AM"   (US M/D/YYYY, 12-hour)
 *   /sv/ → "2026-08-21 08:01:30"    (ISO-ish, 24-hour)
 * Parsing only one of them yields an empty window rather than an error.
 */
function parseNewsDate(raw: string): string | null {
  const t = raw.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDays(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** "2026-08-07", "7 August 2026", "2026/08/07" → "2026-08-07". */
function normaliseDate(raw: unknown, label: string): string | null {
  if (raw == null || raw === '') return null;
  const t = String(raw).trim();
  let m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const parsed = Date.parse(t);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  throw new Error(`Could not read "${raw}" as a date for "${label}". Use YYYY-MM-DD, e.g. "2026-08-07".`);
}

interface NewsItem {
  headline: string;
  summary: string;
  published: string;
  subject: string | null;
  url: string;
}

/** One `<li><article>` per item; 5 items per page. */
function parseNewsPage(html: string, lang: 'sv' | 'en'): NewsItem[] {
  const out: NewsItem[] = [];
  for (const block of html.match(/<article>[\s\S]*?<\/article>/g) ?? []) {
    const link = block.match(/<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const time = block.match(/<time[^>]*datetime="([^"]+)"[^>]*>([\s\S]*?)<\/time>/);
    const published = time ? parseNewsDate(time[1]) : null;
    if (!published) continue;
    const summary = block.match(/<p>([\s\S]*?)<\/p>/);
    // The visible <time> text is "2026-08-21 • Labour Force Surveys (LFS)" —
    // the part after the bullet is the statistical product, which is what a
    // caller means by "which statistic is this".
    const tail = time ? stripTags(time[2]).split('•') : [];
    const href = link[1];
    out.push({
      headline: stripTags(link[2]),
      summary: summary ? stripTags(summary[1]) : '',
      published,
      subject: tail.length > 1 ? tail[1].trim() : null,
      url: href.startsWith('http') ? href : `${WWW}${href}`,
    });
  }
  void lang;
  return out;
}

async function statisticalNews(args: Record<string, unknown>): Promise<unknown> {
  const lang: 'sv' | 'en' = String(args.lang ?? 'sv').toLowerCase().startsWith('en') ? 'en' : 'sv';
  const from = normaliseDate(args.from, 'from');
  const to = normaliseDate(args.to, 'to');
  const days = args.days == null || args.days === '' ? null : Number(args.days);
  if (days != null && (!Number.isFinite(days) || days < 1)) {
    throw new Error('"days" must be a positive number of days, e.g. 3.');
  }
  const today = todayISO();
  const end = to ?? today;
  const start = from ?? shiftDays(end, -((days ?? 7) - 1));
  const limit = Math.min(Math.max(Number(args.limit ?? 50) || 50, 1), 200);

  // 5 items/page, 1-INDEXED — paging=0 is a 404, not an empty first page.
  // The archive runs hundreds of pages deep, so the walk is bounded by both
  // the date window and a hard page cap; without the cap a wide `from` would
  // sit there fetching until the request budget ran out.
  const items: NewsItem[] = [];
  let oldestSeen: string | null = null;
  let pages = 0;
  const MAX_PAGES = 24;
  for (let paging = 1; paging <= MAX_PAGES; paging++) {
    const page = parseNewsPage(await scbHtml(`${WWW}${NEWS_PATH[lang]}?paging=${paging}`), lang);
    pages = paging;
    if (!page.length) break;
    for (const it of page) {
      if (it.published >= start && it.published <= end) items.push(it);
    }
    oldestSeen = page[page.length - 1].published;
    if (oldestSeen < start) break;
    if (items.length >= limit) break;
  }
  const trimmed = items.slice(0, limit);

  if (!trimmed.length) {
    return {
      found: false,
      reason: 'no_news_in_window',
      from: start,
      to: end,
      language: lang,
      pages_walked: pages,
      oldest_seen: oldestSeen,
      hint:
        oldestSeen && oldestSeen > end
          ? `Statistics Sweden publishes statistical news most weekdays, but the walk did not reach back to ${end} within ${MAX_PAGES} pages. Narrow the window or pass "to" closer to today.`
          : 'No statistical news was published by Statistics Sweden in that window. Widen "days", or use scb_se_publishing_calendar for what is scheduled next.',
      source: 'Statistics Sweden (SCB) statistical news',
    };
  }

  return {
    found: true,
    from: start,
    to: end,
    language: lang,
    count: trimmed.length,
    pages_walked: pages,
    truncated: items.length > trimmed.length,
    items: trimmed,
    source: 'Statistics Sweden (SCB) statistical news',
    source_url: `${WWW}${lang === 'sv' ? '/hitta-statistik/statistiknyheter/' : '/en/finding-statistics/statistical-news/'}`,
    licence: 'CC0',
    also_available: 'scb_se_publishing_calendar for releases still to come',
  };
}


/* --- publishing calendar ------------------------------------------ */

const CAL_PERIODS = [
  'Forward1Week',
  'Forward1Month',
  'Forward3Months',
  'Forward6Months',
  'Forward1Year',
  'Previous1Week',
  'Custom',
] as const;

/** Callers say "statistical news" far more often than they say "3". */
const CAL_FORMS: Record<string, string> = {
  all: '0', any: '0', '0': '0',
  database: '1', '1': '1',
  publication: '2', '2': '2',
  'statistical news': '3', 'statistical-news': '3', news: '3', statisticalnews: '3', '3': '3',
  'tables and graphs': '4', tables: '4', graphs: '4', '4': '4',
};

function resolvePeriod(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  const t = String(raw).toLowerCase().replace(/[^a-z0-9]/g, '');
  const hit = CAL_PERIODS.find((p) => p.toLowerCase() === t);
  if (hit) return hit;
  if (/next.?week|1week|comingweek/.test(t)) return 'Forward1Week';
  if (/next.?month|1month/.test(t)) return 'Forward1Month';
  if (/3month|quarter/.test(t)) return 'Forward3Months';
  if (/6month|halfyear/.test(t)) return 'Forward6Months';
  if (/1year|nextyear/.test(t)) return 'Forward1Year';
  if (/lastweek|previousweek/.test(t)) return 'Previous1Week';
  if (t === 'custom') return 'Custom';
  throw new Error(`Unknown period "${raw}". Use one of ${CAL_PERIODS.join(', ')}, or pass from/to dates.`);
}

interface CalRow {
  product_code: string | null;
  product: string;
  reporting_round: string | null;
  reference_period: string;
  publishing_forms: string[];
  publishing_date: string;
  publisher: string;
  agency: string;
  url: string | null;
}

function parseCalendarPage(html: string): { rows: CalRow[]; hitsOnPage: number | null; total: number | null } {
  const rows: CalRow[] = [];
  for (const tr of html.match(/<tr class="(?:odd|even)"[\s\S]*?<\/tr>/g) ?? []) {
    const cells = (tr.match(/<td[\s\S]*?<\/td>/g) ?? []).map((c) => c);
    if (cells.length < 6) continue;
    const link = cells[0].match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const round = cells[0].match(/<span class="reportingRoundName">([\s\S]*?)<\/span>/);
    const url = link ? decodeEntities(link[1]) : null;
    // The product code is not a field — it only exists inside the href
    // ("https://www.scb.se/PR0301-en" → PR0301), and it is the identifier a
    // caller needs to join this back to a PxWeb table.
    const code = url ? url.match(/scb\.se\/([A-Z]{2}\d{4})(?:-en)?\/?$/)?.[1] ?? null : null;
    rows.push({
      product_code: code,
      product: link ? stripTags(link[2]) : stripTags(cells[0]),
      reporting_round: round ? stripTags(round[1]) : null,
      reference_period: stripTags(cells[1]),
      // The forms cell is a <br />-separated list, so it has to be split on the
      // break BEFORE tags are stripped; strip first and "Database Statistical
      // news Tables and graphs" arrives as one unusable string.
      publishing_forms: cells[2].split(/<br\s*\/?>/i).map((s) => stripTags(s)).filter(Boolean),
      publishing_date: stripTags(cells[3]),
      publisher: stripTags(cells[4]),
      agency: stripTags(cells[5]),
      url,
    });
  }
  const h4 = html.match(/<h4>\s*(\d+)\s*hits?\s*<\/h4>/i);
  // `<h4>N hits</h4>` is the count ON THIS PAGE (max 20), never the total —
  // reading it as the total makes a 131-row answer report itself as 20.
  // The real total is the high end of the LAST pagination range link.
  const ranges = [...html.matchAll(/>\s*\d+\s*-\s*(\d+)\s*<\/a>/g)].map((m) => Number(m[1]));
  const total = ranges.length ? Math.max(...ranges) : h4 ? Number(h4[1]) : null;
  return { rows, hitsOnPage: h4 ? Number(h4[1]) : null, total };
}

async function publishingCalendar(args: Record<string, unknown>): Promise<unknown> {
  const from = normaliseDate(args.from, 'from');
  const to = normaliseDate(args.to, 'to');
  let period = resolvePeriod(args.period);
  // dateFrom/dateTo are honoured ONLY with period=Custom; sent with any
  // Forward* period they are accepted, ignored, and answered with the default
  // window — a 200 full of the wrong dates.
  if (from || to) period = 'Custom';
  if (!period) period = 'Forward1Week';
  if (period === 'Custom' && !(from && to)) {
    throw new Error('period="Custom" needs both "from" and "to" as YYYY-MM-DD dates.');
  }

  const rawForm = args.form == null || args.form === '' ? '0' : String(args.form).toLowerCase().trim();
  const form = CAL_FORMS[rawForm];
  if (form === undefined) {
    throw new Error(`Unknown form "${args.form}". Use 0 (all), 1 (Database), 2 (Publication), 3 (Statistical news) or 4 (Tables and graphs).`);
  }
  const subjectAreas = args.subject_areas == null || args.subject_areas === ''
    ? null
    : String(args.subject_areas).toUpperCase().replace(/\s+/g, '');
  const limit = Math.min(Math.max(Number(args.limit ?? 40) || 40, 1), 200);

  const base = (paging: number) => {
    const p = new URLSearchParams({
      period,
      form,
      sortOrder: String(args.sort_order ?? '0'),
      sortField: String(args.sort_field ?? '2'),
      paging: String(paging),
    });
    if (period === 'Custom') {
      p.set('dateFrom', from as string);
      p.set('dateTo', to as string);
    }
    if (subjectAreas) p.set('subjectAreas', subjectAreas);
    // THIS IS A GET. Four POST body shapes all return 200 with a plausible
    // 20-row table that ignores every parameter and serves the default
    // "1 week ahead" — it passes a smoke test and answers the wrong question.
    return `${WWW}${CALENDAR_PATH}?${p.toString()}`;
  };

  const rows: CalRow[] = [];
  let total: number | null = null;
  const MAX_PAGES = 10; // 20 rows/page, 0-INDEXED
  for (let paging = 0; paging < MAX_PAGES; paging++) {
    const page = parseCalendarPage(await scbHtml(base(paging)));
    if (paging === 0) total = page.total;
    rows.push(...page.rows);
    if (page.rows.length < 20) break;
    if (rows.length >= limit) break;
    if (total != null && rows.length >= total) break;
  }
  const trimmed = rows.slice(0, limit);

  if (!trimmed.length) {
    return {
      found: false,
      reason: 'no_scheduled_releases',
      period,
      ...(period === 'Custom' ? { from, to } : {}),
      form,
      ...(subjectAreas ? { subject_areas: subjectAreas } : {}),
      hint: 'Statistics Sweden has nothing scheduled matching that window and form. Widen the period, or pass form=0 for every publishing form.',
      source: 'Statistics Sweden (SCB) publishing calendar',
    };
  }

  return {
    found: true,
    period,
    ...(period === 'Custom' ? { from, to } : {}),
    form,
    ...(subjectAreas ? { subject_areas: subjectAreas } : {}),
    count: trimmed.length,
    total_matching: total,
    truncated: total != null && total > trimmed.length,
    releases: trimmed,
    source: 'Statistics Sweden (SCB) publishing calendar',
    source_url: `${WWW}/en/finding-statistics/publishing-calendar/`,
    licence: 'CC0',
    also_available: 'scb_se_statistical_news for releases already published',
  };
}


export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

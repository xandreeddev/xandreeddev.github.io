---
title: 'Your model provider is already a search engine'
description: 'Agent web access with no extra key: server-side grounding for discovery, plain HTTP for reading.'
pubDate: 2026-07-13
tags: [ai, agents]
draft: true
---

Every agent tutorial reaches the same chapter: giving the model the web. And the recipe is weirdly uniform — sign up for a search API (Brave, SerpAPI, Tavily; Bing, until Microsoft retired its search API out from under everyone in 2025), wire the key into yet another env var, then bolt on a headless browser to scrape the result pages, because ten blue links are useless without their contents. Two new vendors, a Chromium fleet, and a scraping stack to maintain — for an agent that mostly wants to check what version of a library exists and then read one docs page.

[efferent](https://github.com/xandreeddev/efferent), the coding agent I'm building, ships both web tools and asks for none of that. The README line is this post's thesis: **"Web tools, no extra key."** Search rides the LLM credential you already have, because search is a capability your model provider already sells you. Fetching is plain HTTP plus an honest HTML-to-text pass — about a dozen lines of regex, not a browser. This post is the argument for why that's the right *default*, and it ends by being precise about where the default stops being enough.

## Two needs, not one

Start by splitting the requirement, because the scraping stack is what happens when you don't. An agent has two distinct web needs:

- **Discovery** — *"what's out there about X?"* The agent doesn't have a URL; it wants the lay of the land. What's the current major version of Vite? Is there a known issue with this flag? Where do the docs for this API live?
- **Reading** — *"give me THIS page as text."* The agent has a URL — from the user, from a search result, from an error message — and wants its content in a form a language model can use.

These look like one feature ("web access") and they are not. Discovery wants an answer with pointers. Reading wants one document, faithfully. Conflate them and each need gets answered with the wrong mechanism stretched over the other's job: a search API answers discovery with a list of links — which is really a stack of IOUs for *reading* — so now you need a fetcher for every result; modern pages need JavaScript to render, so the fetcher becomes a headless browser; and suddenly the answer to "what version is current?" involves scraping ten pages you didn't want. That pipeline isn't a design anyone chose. It's the compound interest on one missing distinction.

Name the two needs separately and each becomes small:

```ts
search_web({ query })  // discovery: a synthesized answer + source URLs
web_fetch({ url })     // reading: ONE page, reduced to readable text
```

Those are the two web tools in [efferent](https://github.com/xandreeddev/efferent)'s toolkit, and the rest of this post is one section per tool — plus the choreography between them.

## Discovery: search is a capability you already pay for

The reason you don't need a search API key is **server-side grounding**, and it's worth building up from first principles because the name undersells it.

In the bolt-on world, search is *client-side*: your code calls a search vendor, gets back structured results — titles, URLs, snippets — and it's your job to turn that into something useful. The model never touched the search engine; you're the middleman, and the middleman's job (fetch, render, extract, summarize) is the whole scraping stack.

Grounding inverts this. The major model providers run a search engine *next to the model*: you send an ordinary generation request with the provider's own search tool enabled, the provider executes the searches during generation, feeds the results into the model's context on their side, and what comes back is not a SERP — it's **synthesized text with citations**. (A SERP, "search engine results page," is the ten-blue-links artifact; the entire point is that you never see one.) The shape of the exchange, as a sketch:

```ts
const res = await generateText({
  model: provider.model('some-fast-model'),
  prompt: 'Search the web and answer: ' + query,
  tools: [provider.searchTool()], // executed BY the provider, not by you
})
res.text    // a grounded answer, already synthesized
res.sources // the URLs that answer rests on
```

No key beyond the model key. No results page to parse. No fetching to do *for the search itself* — the provider already read the pages and wrote you the summary. Google ships this as Search grounding on Gemini; OpenAI ships a web search tool on its API; Anthropic has a server-side `web_search` tool of its own. If you're running an agent at all, you are already paying at least one company that operates exactly this capability — discovery is included in a bill you're already paying.

The economic framing is the part I want to sell hardest. A Brave or SerpAPI subscription buys you raw search results, and then you spend engineering effort converting them into answers. Grounding buys the finished good: the conversion happens server-side, by a model, next to the index. Adding a search vendor to an agent that already has an LLM credential means paying twice for the half of the job that was already done.

## One port, grounding-only by design

Here's how [efferent](https://github.com/xandreeddev/efferent) wraps that capability. In its architecture, every external capability is a *port* — an interface declared in the core package with no implementation attached — and web search is one of the smallest:

```ts title="packages/core/src/ports/WebSearch.ts"
export class WebSearchError extends Data.TaggedError('WebSearchError')<{
  readonly message: string
}> {}

export interface WebSearchResult {
  /** A synthesized, grounded answer to the query. */
  readonly answer: string
  /** Citations backing the answer — pass a url to `web_fetch` to read it. */
  readonly sources: ReadonlyArray<{ title: string; url: string }>
}

export class WebSearch extends Context.Tag('@efferent/core/WebSearch')<
  WebSearch,
  {
    readonly search: (query: string) => Effect.Effect<WebSearchResult, WebSearchError> // [!code highlight]
  }
>() {}
```

(`Context.Tag` is Effect's way of declaring a service as a type plus an identifier — the deep dive on that machinery is a post of its own. Read it as: an interface the rest of the program can demand without knowing who implements it.) One method. The result type *is* the design: an `answer`, because grounding returns synthesized text, and `sources`, because the citations are the hand-off to the reading tool. There is no `results: Array<{ snippet }>` anywhere — the port refuses to model a SERP.

The doc comment on the real file calls the implementation **grounding-only**, and that phrase carries three precise commitments worth unpacking:

1. **It's a separate call, not the chat model's call.** Each `search` runs its own dedicated `generateText` request against a search-capable model — it is not the agent's conversation asking its own model to search mid-turn. The agent's chat model might be Anthropic while search grounds against Gemini; the two are configured independently.
2. **The request carries *only* the provider's search tool** — never the agent's function tools. That's not tidiness; it sidesteps a real provider constraint: Gemini won't combine Search grounding with function calling in one request. A dedicated call with exactly one tool in it can't trip that.
3. **It reuses the credential you already have.** The key is resolved per call from the same `AuthStore` the rest of the agent uses — no new vendor, no new secret. (How credentials from `:login` and env vars become a usable key is the provider-routing story, a post of its own.)

The adapter picks *which* provider to ground against with a fallback chain that ends at "whatever you're logged into":

```ts title="packages/adapters/src/llm/webSearch.ts"
const resolveSearchModel = (auth, settings) =>
  Effect.gen(function* () {
    // 1. an explicit pin wins: `:set searchModel openai:gpt-4o`
    // 2. then the env var: EFFERENT_SEARCH_MODEL
    // …
    // 3. otherwise: whichever provider you're logged into (Google preferred)
    if ((yield* auth.get('google')) !== undefined) {
      return { provider: 'google', modelId: 'gemini-3.5-flash' } // [!code highlight]
    }
    const openai = yield* auth.get('openai')
    if (openai?.type === 'api_key') {
      return { provider: 'openai', modelId: 'gpt-4o' }
    }
    return undefined
  })
```

Note the defaults are fast, cheap models — a grounded search call doesn't need the frontier model you reserved for the actual coding; it needs something quick that can read search results and write a paragraph. And the chosen branch is short enough to show whole. Here's Google's:

```ts title="packages/adapters/src/llm/webSearch.ts"
const client = yield* GoogleClient.make({ apiKey: key })
const svc = yield* GoogleLanguageModel.make({ model: sel.modelId }).pipe(
  Effect.provideService(GoogleClient.GoogleClient, client),
)
const res = yield* svc.generateText({
  prompt, // 'Search the web and answer with up-to-date, factual information…'
  toolkit: Toolkit.make(GoogleTool.GoogleSearch({})), // [!code highlight]
})
return { answer: res.text, sources: extractSources(res.content) }
```

The highlighted line is the entire integration with Google's search infrastructure. `GoogleTool.GoogleSearch` is a *provider-defined* tool from `@effect/ai-google` — it has no handler, because nothing runs on our side; it's a flag in the request saying "you do the searching." The OpenAI branch is the mirror image with `OpenAiTool.WebSearch`. And `extractSources` is a loop over the response's content parts collecting the URL-typed `source` parts — the citations grounding attaches — deduplicated by URL, order preserved. That's the whole adapter: resolve a model, make one call with one tool, read text and sources off the response.

If neither Google nor OpenAI is configured, `search` fails with a message telling you exactly that — and because every tool in the toolkit declares `failureMode: 'return'`, the failure goes back to the *model* as data rather than crashing the turn, so the agent can say "web search isn't configured here" and carry on.

## Reading: the boring half, done honestly

`web_fetch` is deliberately unglamorous, and its honesty is the feature. The capability underneath is another tiny port — `Http`, a single `get` — whose adapter is the runtime's `fetch` with two decisions baked in:

```ts title="packages/adapters/src/http/fetch.ts"
export const HttpLive = Layer.succeed(Http, {
  get: (url, options) =>
    Effect.tryPromise({
      try: async () => {
        const res = await fetch(url, {
          headers: { 'user-agent': 'xandreed-agent/0.1 (+https://xandreed.dev)' },
          redirect: 'follow', // [!code highlight]
        })
        const maxBytes = options?.maxBytes ?? 50_000
        const text = await res.text()
        return {
          status: res.status,
          contentType: res.headers.get('content-type') ?? '',
          body: text.length > maxBytes ? text.slice(0, maxBytes) : text,
        }
      },
      catch: (cause) => new HttpError({ url, message: String(cause) }),
    }),
})
```

Decision one: a non-2xx response is *returned*, not thrown — a 404 is information the model should see ("that docs URL moved"), and only transport failures (DNS, TLS, timeouts) become errors. Decision two: redirects are followed, which earns its highlight in the next section. The body is capped — `maxBytes`, defaulting to 50,000 — because a tool result is about to live in a context window that bills by the token.

The handler turns that raw body into something a model can read:

```ts title="packages/core/src/usecases/codingToolkit.ts"
web_fetch: ({ url, maxBytes }) =>
  Effect.gen(function* () {
    if (!/^https?:\/\//i.test(url)) {
      return yield* Effect.fail({
        error: 'InvalidUrl',
        message: 'url must be an absolute http:// or https:// URL',
      })
    }
    const cap = maxBytes ?? 50_000
    const res = yield* http.get(url, { maxBytes: cap })
    const text = res.contentType.includes('html')
      ? htmlToText(res.body) // [!code highlight]
      : res.body
    return { url, status: res.status, contentType: res.contentType, content: truncateOutput(text, cap) }
  })
```

And `htmlToText` — the part the scraping-stack reflex says needs a rendering engine — is this, in full:

```ts title="packages/core/src/usecases/codingToolkit.ts"
/** Reduce HTML to readable text — drop script/style/tags, decode common entities. */
const htmlToText = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ') // [!code highlight]
    .replace(/&nbsp;/g, ' ')
    // …decode &amp; &lt; &gt; &quot; &#39;
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
```

Strip scripts and styles, drop every tag, decode the five entities that actually occur, collapse the whitespace wreckage. It does not preserve tables, it does not respect semantic structure, it loses link targets. It is also a dozen lines that handle the case `web_fetch` exists for — documentation, READMEs, changelogs, blog posts — remarkably well, because the consumer is a language model, and language models are extremely good at reading slightly mangled text. Fidelity that would matter for a human-facing reader mode simply doesn't pay here. (Calling the tags-to-spaces regex "parsing HTML" would get you rightly yelled at on Stack Overflow; *reducing* HTML is exactly what it is, and the function name says so.)

The last line of the handler matters too: the readable text still passes through `truncateOutput`, the same head-plus-tail cap every tool's output gets — it keeps 70% from the front and 30% from the end, because long outputs tend to end in their conclusions, and marks the cut with a byte count. And when even a capped page is more than the conversation should carry, the context-compression layer downstream has the final say — what happens to oversized tool results in general is a post of its own. A fetched web page gets no special treatment: it's tool output, subject to the same budgets as a `grep` flood.

## The two-step the descriptions teach

So the model has a discovery tool and a reading tool. The interesting part is that the *choreography* between them isn't enforced by code — it's taught by the tool descriptions, which are prompts wearing a schema:

```ts title="packages/core/src/usecases/codingToolkit.ts"
export const WebSearchTool = Tool.make('search_web', {
  description:
    'Search the web for current information and get a short synthesized answer ' +
    'with source URLs. ' +
    // …'Use it to find things you don't know or that may have changed — library
    // versions, API docs, recent events — when you don't already have a URL.'…
    'It returns a summary plus its sources; ' +
    'call web_fetch on a source url to read that page in full.', // [!code highlight]
  parameters: { query: Schema.String },
  // success: { answer, sources: [{ title, url }] } · failure returned, not thrown
  // …
})
```

The last sentence is the hand-off, written where the model will read it on every turn. `web_fetch`'s description closes the loop from the other side — and the system prompt adds the guardrail: *use only URLs the user gave you or that a tool surfaced; don't guess URLs.* That single instruction kills the failure mode where a model hallucinates a plausible docs path and confidently reads a 404.

In practice the two-step looks like this: asked about an unfamiliar API, the agent calls `search_web` with a keyword query, gets back a paragraph-sized grounded answer plus three or four sources, picks the official docs URL from the sources, calls `web_fetch` on it, and quotes from the actual page in its reply. Discovery narrowed the world to one URL; reading made that URL quotable. Neither tool had to be good at the other's job.

Two field notes from making this real. First, the tool is named `search_web`, not `web_search` — Anthropic reserves the lowercase names `web_search`, `bash`, and `computer` for *its* provider-defined tools, and registering a handler-backed tool under a reserved name makes the SDK silently reroute the call to a built-in that isn't in the toolkit. The turn dies. Hence `search_web` (and, same story, a shell tool named `Bash` with a capital B). Second, Gemini's grounding citations aren't direct links — they're `vertexaisearch…` redirect URLs. That's why the `Http` adapter sets `redirect: 'follow'`: the two-step only works if reading a citation transparently lands on the real page.

## Where this stops being enough

The honest section. Choosing grounding plus plain HTTP is choosing a set of limits, and they're worth naming precisely, because each one marks the line where heavier machinery starts earning its cost.

**Grounding is a black box.** You hand the provider a query and receive an answer; everything in between — how the query was rewritten, how many searches ran, which results were selected, how they were weighed — is invisible and untunable. There's no `num_results`, no domain allowlist, no freshness window. When two providers ground the same query they return differently shaped answers of different quality, and you can't debug the difference, only switch providers. A search API gives you knobs; grounding gives you a finished answer and no say in how it was made.

**Citations can be partial.** The `sources` array is what the provider chose to attach, not a complete bibliography. Sometimes a claim in the answer has no corresponding source; sometimes a source has an empty title (the adapter falls back to showing the URL). The two-step mitigates this — anything that matters gets fetched and verified — but if you need auditable provenance for every sentence, grounding alone doesn't provide it.

**Coverage is your login.** "No extra key" really means "the keys you have, doubled as search keys." [efferent](https://github.com/xandreeddev/efferent) can ground against Google or OpenAI; if you're logged into neither — say you run Anthropic-only — `search_web` fails with a clear returned error and the agent works webless. (On the OpenAI side it specifically needs an API key; a subscription login doesn't carry search.) The capability is real but conditional on your provider mix, which a dedicated search vendor's key never is.

**Fetch can't run JavaScript.** `web_fetch` reads what the server sends. A docs site that server-renders — which is most of them, and essentially all of the ones worth reading — comes through fine. A client-rendered SPA comes back as a `<div id="root">` and a script tag: thin to the point of useless. No PDFs either, no pagination, no auth walls, and the regex reducer flattens tables into word soup.

When do these bite? At volume (an agent doing research as its job, not as a side errand), when you need structured SERPs or domain filtering, when provenance must be complete, or when your sources are JS-rendered apps. *That* is when a Brave or SerpAPI key — or even the headless browser — earns its place: as a deliberate upgrade with a named reason, sized to a limit you actually hit. The failure of the tutorial recipe isn't that the scraping stack is never right; it's that it installs the upgrade before the limit exists.

## Requirements should be earned

There's a general principle hiding under this small feature, and it's the one I'd carry to any agent design review: every credential, vendor, and subsystem in an agent's dependency list should trace back to a limit somebody actually hit, not to a tutorial's step three. The default posture is subtractive — what's the least machinery that serves the need? — and for web access the least machinery turns out to be almost none: discovery is a capability bundled with the model bill you already pay, and reading is the oldest protocol on the internet plus twelve lines of regex.

A search vendor and a browser fleet are real tools for real limits. But they're conclusions, not premises. Start from the credential you already have and the protocol that's already there; let the day you outgrow them be the day you add more. Most agents never have that day.

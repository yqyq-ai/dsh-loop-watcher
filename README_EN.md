# dsh-loop-watcher — the **notifier + counter + handover** for reasoning loops

**[中文说明 → README.md](README.md)**

> This plugin offers two kinds of capability, both serving one workflow —
> **a loop is followed by a handover**:
>
> | Capability | Where it appears |
> |---|---|
> | Banner notification, "Interrupted N times" badge | Above the composer, session title row |
> | One-click handover (opens a new session seeded with the old one's material) | Session "..." menu |

---

## 0. Relationship with the upstream guard (read this first)

This plugin does **not** detect or break reasoning loops. That is done by a separate upstream project:

| Project | License | Notes |
|---|---|---|
| [`@mrweicodes/dsh-loop-guard`](https://github.com/MrWeiCodes/dsh-loop-guard) | MIT | Copyright © 2026 argszero, MrWeiCodes and contributors |

- It hooks the Host-side `llm/stream` and cuts a degenerating model call from inside the stream.
  Each cut injects a `source.kind === 'loop-guard'` message; **this plugin only reads that message**.
- **This plugin is its companion**: without the upstream, the banner and the counter never appear
  (there is no data source for them). Handover, the settings page, and prefix injection
  **do not depend on the upstream** — they work either way.

> ⚠️ **Without the upstream, the banner and the counter show nothing.**
> Installing the upstream first is recommended:
>
> ```powershell
> dsh plugin --profile <profile> add @mrweicodes/dsh-loop-guard
> dsh plugin --profile <profile> add <this plugin's path>
> ```

---

## 1. What this is, and what it is not

**It does not detect. It does not cut.**

> Current behaviour: clicking Handover uses **hidden injection** — a blue "Handover armed"
> pill appears above the composer, and the handover instruction is prepended to your message
> on send. Your own input is sent as a separate paragraph headed by `用户追加：`, so the
> instruction and your words never blur together.

Upstream injects one `source.kind === 'loop-guard'` message per cut; this plugin only reads it.

---

## 2. What you will see

### ① Banner above the composer

An upstream cut is silent by default. This plugin turns it into a banner with action buttons:

```
⚠ A reasoning loop was detected and cut by the upstream guard                 ×
A line of your reasoning repeated 531 characters without progress, so the response was cut short.
        [Locate the loop] [Dismiss] [Draft handover*]
```

`*` The "Draft handover" button only appears when the export tool is configured (see section 4).

### ② Counter badge on the right of the session title

Right next to "N background jobs":

```
◉ No interruptions yet       ← 0 (neutral, green dot)
◉ 2 interruptions in this chat   ← 1–2 (amber outline)
◉ 4 interruptions in this chat   ← ≥3 (red outline)
```

- **0 is shown too**: so you can tell "healthy" from "the plugin is not doing anything"
- **Never decreases**: counted per session; scrolling history does not rewind it
- **Click to jump**: scrolls to the most recent break and flashes it
- Caps: 400 records per session, 30 sessions (bounded growth)

### ③ One-click handover (Session "..." menu)

A new "Hand over" row appears. It creates a new Session and shows a blue
**"Handover armed"** pill above the composer. You type your own prompt;
**on send, the handover instruction (prefix included) is prepended to your message**.
The instruction never enters the composer — it costs you zero space in the input box.

The pill disappears after the first send. It is restored from `localStorage` after a page
refresh, and injection still works.

**The sent message has two clearly separated paragraphs:**

1. **First** — the handover instruction (prefix + material section + method section);
2. **Second** — a `用户追加：` header followed by what you typed. The new session can tell
   at a glance which part is context and which part is the user's fresh request.

Attachments (images/files) keep their relative order after the text paragraphs. With
attachment-only or blank drafts, no empty `用户追加：` header is left behind.

The injected instruction has three parts:

1. **Prefix prompt** (editable in the settings page, see section 4) — puts the new session into takeover mode;
2. **Material section**: an export command when the export tool is configured, otherwise
   "find the context yourself from the working directory, artifacts and memory notes";
3. **Method section**: the five-point checklist plus working-style requirements.

> The "prefix prompt" in the settings page = **the whole text that gets injected** —
> not just the opening lines.

---

## 3. Install

```powershell
# 1) The upstream guard (detection + cutting)
dsh plugin --profile <profile> add @mrweicodes/dsh-loop-guard

# 2) This plugin
dsh plugin --profile <profile> add <repo root>
```

Their entry ids are `loop-guard` (upstream) and `loop-watcher` (this one) — no collision.

> **Why install from a local directory instead of `add dsh-loop-watcher`**:
> `package.json` carries `"private": true` on purpose — the plugin is distributed
> as source only and is not published to npm. Clone the repository and run
> `add <repo root>`; if you later want to publish, drop that
> `private` line and run `npm publish`.

---

## 4. Configuration: the settings page (handover prefix + export tool path)

Open **Sidebar → Settings → "Loop Watcher"**. Everything is saved immediately.

| Setting | Stored in | Notes |
|---|---|---|
| Handover prefix prompt | `localStorage` + memory | Toggle + text. On = the prefix is prepended to the instruction; cleared text = no injection (and it will not come back after a refresh) |
| Old-session export tool path | `localStorage` | Optional. When set, the instruction carries the export command; when empty, handover still works without it |

> The **default prefix** is the built-in takeover prompt (`PREFILL_TEXT_DEFAULT` in `lib/client.js`).
> Never touched = you keep using it. Cleared in the settings page = you explicitly want no prefix.

### The two older ways (still valid)

**Way 1** — run once in the page console (F12), then refresh:

```js
localStorage.setItem('dsh-loop-watcher:export-tool', 'D:\\your\\dir\\export-session.cmd')
localStorage.setItem('dsh-loop-watcher:prefill-enabled', '0')  // disable prefix injection
localStorage.setItem('dsh-loop-watcher:prefill-text', 'my custom prefix…')
```

**Way 2** — edit the constants `EXPORT_TOOL_DEFAULT` / `PREFILL_TEXT_DEFAULT` in `lib/client.js`.

> This repository **does not ship the export tool itself** (it is a separate tool that needs
> Python 3.14+ `compression.zstd`). Anything that can read DSH session records works —
> the upstream guard's `tools/analyze-session.mjs` is a ready-made Node option.

---

## 5. Can I still hand over without the export tool? (new users: read this first)

**Yes — and that is the default state.** This plugin ships without an export tool, so a fresh
install is "unconfigured" and the handover menu works anyway.

| | With the export tool | Without it (default) |
|---|---|---|
| In the instruction | A PowerShell "export old session" command | A paragraph: "find the context yourself from the working directory, artifacts and memory notes" |
| How the new session gets context | Run the command → read the material file | Browse the directory, read files, check memory notes |
| "Draft handover" button on the banner | Appears | Hidden (its whole semantics is a command-bearing instruction) |

**Without the export tool the new session can still take over** — it just has to reconstruct the
context itself, which is a bit slower.

### How to get better handovers without the export tool

#### 1. Hand over inside the project directory

If the new session's working directory is the original project, it can see artifacts, code and
existing docs — the strongest context there is.

#### 2. Tell the new session **what to dig for** (the important part)

The hardest problem for a new session is not "no material" but **not knowing where to look**.
A good handover covers five kinds of facts — spell them out in your own message too:

| What the material should carry | Why it matters | Without it |
|---|---|---|
| ① **The goal, in your own words** | The only source that cannot be misread | It can only guess |
| ② **How far it got / where the artifacts are** | Where to resume from | Redo work, or start over |
| ③ **Key files and paths** | Saves a wide search | Wasted time on irrelevant files |
| ④ **Pitfalls and verified conclusions** | They are often counter-intuitive and expensive | **Steps on the same rake again** |
| ⑤ **What is left, including open questions** | The unknowns are exactly what you must settle | It decides for you |

> ④ is the one most easily ignored and the most expensive: a "weird-looking" piece of code is
> often exactly what a previous pitfall bought. The `验证/` directory in this repository is an
> example — every assertion there maps to a problem that really failed once.
> Telling the new session "read the comments in there" beats letting it re-derive everything.
>
> One more caveat: **anything labelled "looping / degraded" in the history is not trustworthy**;
> treat it only as evidence of "what was tried", and let the new session judge what holds.

#### 3. Add one line of background yourself

The pill only means "instruction armed"; **your own words are the valuable part**. For example:

> Take over: last time we were building the handover-prefix feature of a DSH plugin.
> Hidden injection is done; the README and packaging are left. Key file:
> `lib/client.js`, start reading around line 2100.

#### 4. Keep a progress note

If your workflow has an `AGENTS.md` or a project handover doc, the new session reads it —
recording "current progress and next step" there beats any export.

---

## 5½. Using the upstream guard's `analyze-session.mjs` as the export tool (no Python)

Do not want Python 3.14? You can still get a command-line shortcut, as long as you installed
the upstream guard (it is a plain Node package that comes in with npm). It ships a script that
reads DSH session records:

```
node_modules/@mrweicodes/dsh-loop-guard/tools/analyze-session.mjs
```

It eats DSH session files directly (both `.jsonl` and `.v4.jsonl.zstd`, format detected from
the content) and needs no extra zstd CLI. Its job is **loop analysis** — replaying a real
session record through the guard's detector to answer "would this be cut, and where", not
producing handover material.

Measured on this machine (an 8.3 MB session with 1605 model calls):

```text
steps:   1605 model call(s)
  #   turn/step   reasonChars  textChars  chunks  verdict   fired  repeatedRun  cycleSpan ...
```

In JSON mode (`--json`) each step carries verdict fields such as `verdict / fired /
repeatedRun / cycleSpan / repeatedChars / wouldBreak`.

### How to run it

First find the session file you want to hand over. Session files live under the DSH data dir:

```powershell
# Windows: files are stored as 「working-dir-encoding\<sessionId>\session.v4.jsonl.zstd」
Get-ChildItem "$env:USERPROFILE\.dsh\sessions" -Recurse -Filter 'session.v4.jsonl.zstd' |
  Sort-Object LastWriteTime | Select-Object -Last 10 FullName, LastWriteTime
```

Then a trial run with that path:

```powershell
$node = 'node'   # or the absolute node path on your machine
$script = 'node_modules\@mrweicodes\dsh-loop-guard\tools\analyze-session.mjs'
$session = '<the .zstd path you found above>'

& $node $script $session --json | Out-File '.\loop-report.json' -Encoding utf8
```

### ⚠️ How it differs from a purpose-built export tool (read before adopting)

The upstream script's job is **loop analysis**, so its output **lacks** the three things a new
session needs most:

| | Upstream `analyze-session.mjs` | A purpose-built export tool |
|---|---|---|
| Loop statistics / where it fired | ✅ very detailed (the fields above) | usually none |
| List of files touched | ❌ | ✅ |
| Commands executed | ❌ | ✅ |
| The final conversation (most important for a handover) | ❌ | ✅ |
| Dependencies | Node only | Python 3.14 in this case |

**Bottom line**: with it you learn "how badly this session looped", not "how far the work got".
So the more practical use is **the reverse** — have the new session run it itself: add one line
like "first run the upstream guard's analyze-session.mjs on this session record" to your
message. That beats auto-generating a command that runs fine but returns the wrong content.

> For the full effect: session records live under `.dsh\sessions` and are already JSONL
> (optionally zstd-compressed), so picking out `user/message` and `assistant/message` events
> and joining them into Markdown gives you handover material. DSH ships no "decompress" CLI,
> but both Node and Python have zstd support available.

---

## 6. localStorage keys (delete to reset)

| Key | Contents |
|---|---|
| `dsh-loop-guard:count` | Per-session interruption counts (a seq set, **never decreasing**) |
| `dsh-loop-guard:alert` | Per-session banner currently pending |
| `dsh-loop-guard:dismissed` | Last dismissed notice seq per session |
| `dsh-loop-guard:self-test` | Drill switch (`guard` / `count` / `1`) |
| `dsh-loop-guard:log` | Own-detection hit log (only used when own detection is on) |
| `dsh-loop-guard:mode` | Own-detection "auto-stop" switch (default off) |
| `dsh-loop-watcher:export-tool` | **Export tool path** |
| `dsh-loop-watcher:prefill-enabled` | **Prefix toggle** (`'1'`/`'0'`; absent = on) |
| `dsh-loop-watcher:prefill-text` | **Prefix text** (absent = built-in default; blank = explicitly no injection) |
| `dsh-loop-watcher:pending-handover` | **Pending handover instruction** (latest one; cleared on send) |
| `dsh-loop-watcher:count-severe` | **Interruptions before the badge turns red** (positive integer, default 3; invalid values fall back to 3) |
| `dsh-loop-watcher:banner-draft` | **Whether the banner shows "Draft handover"** (`'1'`/`'0'`; absent = shown) |

> Why half the keys say `dsh-loop-guard:*` instead of the plugin name: **old key names are kept
> on purpose**. Renaming them would silently zero out already-accumulated counts — keeping the
> data beats tidier naming.

---

## 7. Drill mode (see it work without a real loop)

F12 → run one → refresh:

| Command | Which path it drills |
|---|---|
| `localStorage.setItem('dsh-loop-guard:self-test','guard')` | Banner path |
| `localStorage.setItem('dsh-loop-guard:self-test','count')` | Badge path (shows a demo value of 3) |
| `localStorage.setItem('dsh-loop-guard:self-test','1')` | Own-detection path (off by default) |

Then `localStorage.removeItem('dsh-loop-guard:self-test')` and refresh to restore.

---

## 8. Known limitations (stated plainly)

1. **Without the upstream, the banner and counter show nothing** (unless `OWN_DETECTION` is on).
2. **If the upstream ever changes `source.kind`**, this plugin silently stops noticing (no error).
3. **The counter only counts what it can see**: interruptions stored in the session file it cannot
   read; history not paged in yet is not counted (it is added after scrolling, and never decreases).
4. **"Locate" is DOM-level**: it finds rows by the `data-chat-*` attributes the chat area renders.
5. **Without the export tool**: the handover menu still works (no command in the instruction),
   but the banner's "Draft handover" button does not appear.
6. **If DSH renames a slot**, the matching UI disappears silently (no error).
7. **Both handover paths are now unified**: the banner's "Draft handover" and the Session menu's
   "Hand over" go through the same `runHandover`. The old banner-specific "write a handover doc"
   prompt was removed; `buildGuardDraftPrompt` still exists in the source but has **no call site**,
   and a regression assertion guards against it coming back.
8. **Title refinement depends on the session binding**: `session.rename()` can fail while the
   session is not live yet or the connection is not ready. It fails silently — the injected
   section header already makes the title fallback read `交接对话：<your words>`, and refinement
   only replaces it with `交接对话：<old title>`. Worst case the fallback title stays, which is fine.
9. **No API to open the settings page programmatically**; enter it from the sidebar Settings.
10. **Injection depends on the session binding**: if it is not ready when the pill mounts, it retries
    for ~2.4 s. In the worst case the injector never attaches and the instruction is simply not sent
    (your composer stays clean — no half-sent instruction).
11. After editing `lib/client.js`, **refresh the page**; restart DSH if something still does not apply.
12. **The two `.cmd` entries in `验证/` must not run concurrently**: each stage regenerates
    `验证/校准/core-from-client.mjs` from `client.js` before it starts, so two concurrent
    runs overwrite the same file. Run one at a time.
13. **`验证/` needs Node 22+**: the scripts look for node in `PATH`, then common install
    locations, then the node bundled with DSH
    (`~/.dsh/dsh-runtimes/*/dependencies/node/bin/`). Only when all three miss does it
    print "Node.js not found" and exit 1.

---

## 9. Verification

The repository ships a five-stage regression suite (`验证/verify.ps1`); all stages pass.

> **The assertion count is printed by the script — do not hard-code one here.**
> At the end of a run it prints:
>
> ```
> 第 2 段：N 条断言
> 第 3 段：N 条断言
> 第 4 段：N 条断言
> 第 5 段：N 条断言
> 合计：N 条断言
> ```
>
> That number **depends on whether the private corpora are present**:
> - with the corpora present: stage 3 = 114, stage 4 = 74, stage 5 = 104
>   → **292** total;
> - public clone (no corpora, stage 2 skipped): stage 3 drops to 107 → **285** total,
>   the missing 7 being exactly the assertions that need the real corpora.
>
> Why not write it down: the stages do not share one counter — stages 3 and 4 only
> print "all passed" without a count, and only stage 5 prints "N assertions passed".
> An earlier version of this README took stage 5's 104 as the whole-suite total,
> omitting stages 3 and 4 entirely — so the script now reports the breakdown itself
> and this document only explains how to read it.

| Stage | What it checks |
|---|---|
| 1 | Extracts the detection core from `client.js` (so the test runs the real code) |
| 2 | Loop-judgement regression on real session data (positive and negative samples) |
| 3 | Runtime logic (snapshot extraction / full chain / handover instruction / counting / config gating) |
| 4 | Badge runtime (executes `client.js` for real with a React stand-in) |
| 5 | Handover (wiring / menu item / instruction text / prefix tri-state / **injector end-to-end**: first-send merge, re-entry guard, deregistration / pill contract / settings registration / config gating) |

Run it with `powershell -File 验证\verify.ps1` (or double-click `验证\跑验证.cmd` for all five stages).

To run stage 5 (handover) on its own, use `验证\跑验证-handover.cmd`.

> Both `.cmd` files are deliberately **pure ASCII**: a `.cmd` is decoded with the
> console code page, so a Chinese literal inside it — even just a Chinese file
> name — reaches Node as mojibake. That is why they locate the script through the
> wildcard `for %%f in (*-handover.mjs)` instead of hard-coding the Chinese name.

> **Do not run both entries at the same time**: every stage regenerates
> `验证/校准/core-from-client.mjs` from `client.js` before it starts, so two
> concurrent runs write the same file and can read each other's half-written
> copy. Run one at a time.

> **Why stage 2 is skipped in the public repo**: it compares against real session
> corpora in `验证/校准/*.jsonl`, which contain full reasoning text, intranet IPs
> and local filesystem paths. Those files are deliberately excluded by
> `.gitignore`, so a fresh clone does not have them. The suite **does not crash**
> without them — it prints "stage skipped, this is a deliberate privacy decision"
> and runs the other four stages (exit code stays 0). To run stage 2 locally,
> supply corpora of the same shape (one `{turn, step, text}` object per line) and
> update `校准/python-baseline.json` accordingly.

---

## 10. Files

**The repository root *is* the plugin** — clone it and run `dsh plugin add <repo root>` directly.

```
.                          ← repo root = the plugin (has package.json)
├─ package.json          ← name / entry id / dsh.client.inject (union of three UI packages)
├─ cordis.patch.yml      ← one entry: loop-watcher
├─ lib/index.js          ← Host half: a shell (all behavior lives in the Client half)
├─ lib/client.js         ← all functionality (~3100 lines, split by #region)
├─ locale/{zh,en}.json   ← title and description on the plugin list page
├─ LICENSE               ← this plugin's MIT + the upstream's MIT notice
├─ README.md             ← 中文说明
├─ README_EN.md          ← this file
├─ .gitignore            ← keeps real corpora and dev notes out
└─ 验证/                 ← regression suite (not loaded by the plugin; safe to delete)
   ├─ verify.ps1         ← entry point, runs all five stages
   ├─ 跑验证.cmd / 跑验证-handover.cmd
   ├─ verify-{detect,runtime,badge}.mjs / 验证-handover.mjs / extract-core.mjs
   └─ 校准/              ← expected-value baseline and notice-shape sample (anonymised)
```

---

## 11. License and attribution

This plugin: **MIT** (see `LICENSE`).

Its upstream dependency [`@mrweicodes/dsh-loop-guard`](https://github.com/MrWeiCodes/dsh-loop-guard)
is also **MIT** (Copyright © 2026 argszero, MrWeiCodes and contributors); its copyright and
permission notice are preserved in the second part of `LICENSE`, as MIT requires.

Both are MIT and therefore compatible.

---

## 12. License

MIT

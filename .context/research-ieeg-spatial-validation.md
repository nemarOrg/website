# iEEG spatial panel: validation on real datasets and measured budgets (2026-11-18)

What the Brain panel (website ADR 0033, cards IS-C1 to IS-J1) showed on real public datasets in a headless browser, what it refused, what each budget of the plan (section 9, gates G3 and G4) measured, and what was not run.
Dataset ids, counts and measurements only.

## How it was run

- Suite: `e2e/ieeg-spatial-validation.spec.ts` (27 tests, the last of which fails a run that leaned on retries or started on a slow data plane), run against the local dev server with `PUBLIC_DATA_BASE_URL=https://data.nemar.org bun run test:e2e e2e/ieeg-spatial-validation.spec.ts`.
  Each test opens the embed route (the same viewer session the dataset dialog runs) on the dataset's first recording and reads the dataset's own sidecars and Zarr store from the public data plane; nothing is written anywhere.
- Browser: Chromium 148.0.7778.96, headless, Playwright 1.60.0, desktop viewport 1280 by 900 (360 by 900 where stated), software WebGL.
  Nothing is claimed for Firefox or Safari.
- Dataset versions read on 2026-11-18 equal the census versions (nm000454, nm000485, nm000376, nm000537, nm000377 at v1.0.2; on005522, on004100, on005415, on004473, on004642, on004624, on009081 at v1.0.0), so no check was dropped for a changed version.
- The data plane answers 500 now and then, and the dev server's own server-side read of a dataset's landing file sometimes fails.
  The suite reloads the embed page and presses Retry as a reader would, and counts both; a failure that outlasts them fails the test.
  Several runs met data plane trouble and are reported as such, not hidden: one run lost ten tests to a connectivity episode (21 server-side reads of the dev server failed with `network_error` within about five minutes), others met stretches in which the Zarr route answered each range request in 7 to 14 s and sidecar resolution took over a minute; the tests that failed for those reasons were rerun.
  The suite never reached all green in one run: the final full run of the 26-test version had 2 failed and 24 passed in 16.0 minutes, and both failures were outages; every test passed at least once, in some run.
  The suite now times the Zarr route before it starts (a median of three requests, recorded first), skips the long-task budget test with a visible reason while the route is slow, counts passing failures per test and fails its last test when the counts pass a stated allowance (3 embed reloads, 3 Retry presses, 10 server errors, 10 failed requests).
  Its tests run in order in one worker only when the file is run alone (the configuration runs spec files in parallel workers).
- The staging site check of `xx099902` is the manager's, after the epic is merged into staging; it was not run here.

## What the panel showed, per dataset

| Dataset | Frames offered | Located | What the panel showed |
| --- | --- | --- | --- |
| nm000454 | MNI152NLin2009cAsym | 48 of 125 | Surface drawn (0.170 of the canvas), label "Template brain (MNI152NLin2009cAsym), not this subject's anatomy" with no "approximate"; 77 unlocated channels listed by name (`DHAA01`, ...) with the cause |
| on005522 | MNI152NLin6ASym | 72 of 72 (88 contacts) | Surface drawn, label plus "approximate: MNI template variants differ by a few millimeters"; bipolar channels mark two contacts (`Channel LAF1-LAF2 (contacts LAF1, LAF2; midpoint)`); every join exact, so no tag, no rule note, status line without a "joined by name rules" part |
| on004100 | fsaverage | 38 of 59 | Label plus "approximate: MNI305 to MNI152 affine"; units "the file says m, scaled to millimeters"; the contacts land about 17 m from the origin and are off the canvas (0 contact pixels), the panel says "span N mm, wider than a head; the units may be wrong" (see Findings) |
| nm000485 | Other, Talairach | 136 of 138 | Opens on Talairach (the template frame), "approximate: Talairach to MNI affine"; each row says `recorded (8.000, -27.000, 33.000) mm, frame: Talairach` and below it `template (10.006, -24.504, 34.674) mm, approximate`; Other is listed and, when chosen, says "No template placement for Other" with no surface |
| nm000376 | IXI549Space | 190 of 190 | Surface drawn, "approximate: MNI template variants differ by a few millimeters"; recorded and template lines |
| on005415 | ACPC | 174 of 188 | Toggle enabled; status `joined by name rules: 174 suffix match`; rows `LTP1 (channel LTP1-20000) [suffix match]`; 14 unlocated channels listed by their original names (`LAMY2-20000`, ...); "No template placement for ACPC"; contacts only (0.040 of the canvas); no mesh and no outlines file requested, in 3D or in the 2D views; all 174 `recorded` lines equal the file's text (the file starts with a byte order mark, which the panel drops) |
| on004473 | ACPC, ScanRAS | 119 of 129 | Status `joined by name rules: 119 normalized match` (`LENT 1` for `LENT1`); 10 unlocated (`Event`, `LSTG 5`, ...); the file's `-7.589096499647889e-05` (contact `LAMY1`) is shown with its exponent, never as 0; the ScanRAS frame shows its own file's text (`7.239242608449814e-05` among them); neither frame is placed; no mesh and no outlines requested |
| nm000537 | none | 0 | Toggle disabled: "The electrodes file lists no usable x, y and z positions." |
| on004642 | none | 0 | Toggle disabled: "This recording has no electrodes file, so its contact positions are not known." |
| nm000377, on004624 | none | 0 | Toggle disabled: "None of this recording's channels match a contact in the electrodes file." The original channel names are not listed anywhere (see Findings) |
| on009081 (EEG) | not applicable | not applicable | No Brain toggle, no panel code requested, no electrodes file read, no mesh, no outlines |

Every panel state that was opened carried the credit link: address `https://rave.wiki` (written out in the suite, not only read from `credit.ts`), `target=_blank`, `rel` with `noopener`, the declared `aria-label`, in light and dark, at 360 px, without WebGL, and in a refusal with Retry.

## Exports on a template frame (nm000485, Talairach)

- The downloaded SVG parses with no error, holds the three views, 3 template outlines, 408 circles (136 contacts times 3 views) each with a title, and the label sentence, the "approximate: Talairach to MNI affine" sentence and the template notice; every title carries `recorded (...) mm, frame: Talairach; template (...) mm, approximate`; the last element of the document is the credit's link; 128,983 bytes.
- The 3D PNG (1920 by 1056) and the 2D PNG (1920 by 1124) hold the credit in the bottom-right corner (many colors and dark pixels) and the plain background in the bottom-left corner (one color).

## Light and dark

`?theme=light|dark` on the embed route, on005522 (template), on005415 (native) and a refusal with Retry (a forced electrodes read failure, marked in the suite so it is not counted as a data plane failure).
WCAG contrast of text, measured against the resolved CSS backgrounds, not canvas pixels (the credit link's 80 percent backing sits over the canvas); the suite takes the lowest of the first 200 elements matching each selector, and the figures below are for the first match of each, which equal the lowest in the latest run: all at least 4.5.
on005522 light: status 17.9, credit 7.6, template label 17.9, contact name 17.9, recorded line 4.8; dark: 17.0, 12.6, 17.0, 17.0, 7.3.
The canvas background luminance is 0.99 in light and 0.08 in dark; the surface and the contacts are drawn in both (surface 0.170 and 0.169 of the canvas).

## Keyboard only (on005522)

From the top of the page, 16 Tab presses reach the Brain toggle; Enter opens the panel; Tab reaches the 2D views switch, both save buttons, the credit link, the Activity switch and the contact list (one tab stop, a listbox); Space turns Activity on (one read, a colorbar); ArrowDown steps through all 88 rows in order, Home and End reach the ends; Escape from a row closes the panel and returns focus to the toggle.

## 360 px

on005522 and on005415 at 360 by 900: the panel sits below the scope, the scope is 344 by 280 CSS pixels with traces drawn (not blank), the page does not scroll sideways, no contact row overflows, the credit lies inside the viewport.

## WebGL disabled

Chromium launched with `--disable-3d-apis --disable-webgl --disable-webgl2` (both `getContext` calls return null), nm000485: the stage is the 2D views (136 contacts times 3), the sentence "3D view needs WebGL2", the 3 template outlines and the template label, the credit, working SVG and PNG saves; the surface is never requested.

## Budgets (plan section 9)

| Budget | Limit | Measured | Verdict |
| --- | --- | --- | --- |
| Panel code beyond the viewer chunk at the epic base | 64 KB gzipped (65,536 bytes) | panel chunk 36,109 bytes (99,124 raw) plus viewer chunk growth 1,432 bytes (56,848 to 58,280; 161,956 to 166,137 raw) is 37,541 bytes; with the shared stylesheet's 716 bytes and the embed chunk's 37 the whole JavaScript and CSS delta is 38,296 bytes | met, 57 percent of the limit |
| Template mesh transferred | 600 KB | as served by the dev server, no content encoding: 532,862 bytes for the two files (532,262 body, 600 of headers), the browser's own network entries; from a local server standing in for a compressing host: gzip level 9 430,133 bytes, brotli 370,440 body (371,040 transferred) | met, 89 percent of the limit uncompressed |
| First contacts drawn after opening the panel, warm cache | 1.5 s | Plan-literal figure, from the click that opens the panel to the first draw call of the contacts: 16 to 55 ms over all warm opens in five full runs on three datasets (on005522, nm000485, on005415); cold (first open in a fresh context) 20 to 52 ms; the surface follows 93 to 312 ms after the click. Excluded interval, navigation to an enabled toggle (the dataset's sidecars resolve first): 3.2 to 5.0 s cold and 0.7 to 2.3 s warm while the data plane was fast, 11.5 to 19 s while it was slow. Reader-visible figure, navigation to first contacts if the reader opens the panel the moment the toggle enables: the excluded interval plus the 16 to 55 ms, so 0.7 to 2.3 s warm and 3.2 to 5.0 s cold while fast, up to about 14 s warm and 19 s cold while slow | met as the plan words it (click to first draw); the reader waits for the sidecars, which the budget does not cover |
| Long task while Activity recomputes a 10 s window of 128 or more channels | 200 ms | nm000485, 136 located channels, 10 s window. Measured two ways: the `longtask` entries (the plan's measure) and the gaps of a 10 ms heartbeat timer. The `longtask` API alone was found to miss blocks: a simulated 300 ms delay added to the recompute (scratch, reverted) produced 9 heartbeat gaps of 293 to 323 ms and no `longtask` entry. Earlier runs here read the API only, so their fast-regime "no long task" is not trusted. Re-measured with both on recorded real responses of the Zarr host replayed (scratch HAR replay, Zarr requests 10 to 20 ms): no block over 60 ms from switch on or change of measure; the scope's own window step 199 to 200 ms (heartbeat), 187 to 196 ms (API), 190 to 199 ms with Activity off. Zarr route slow (live reads of 38 to 66 s, or the same real bytes delayed 3.5 s by a seam): switch on produced one block of 212 to 233 ms and change of measure one of 189 to 238 ms in eight live runs here (API), 228 and 219 ms (heartbeat, delayed replay), 246 and 230 ms (heartbeat, the latest live slow run, which the suite skipped on the evidence "37 Zarr requests, median 4,845 ms, slowest 39,882 ms"); in one slow-regime run of the PR review, 785 ms and 270 ms | not judged live while the Zarr route is fast, because no live run with fast reads was measured with the heartbeat; missed while it is slow, over the full observed range 189 to 785 ms (6 to 292 percent over 200 ms; the 270 ms run is 35 percent over). The stop condition (a miss of more than 50 percent, over 300 ms) was reached once (785 ms). Attribution is unknown: the panel's `computeActivityPlan` awaits the row reads and then computes in the same task and yields only after, so decoding and computing can land in one task whose length then follows what arrived together (the delayed replay reproduces blocks of this size, the fast replay does not). The lead ruled: not fixed in this card, which stays measurement only; follow-up card IS-Q2 (trace first) |

How each was measured:

- Bundle: `bunx astro build` of the epic base (517bfee) and of this branch's base (6cba53d), `gzip -9c` of each emitted file; the three `generate:*` Open Graph steps of `bun run build` were skipped (they render cards from the live catalog and touch no chunk).
- Mesh: `PerformanceResourceTiming` entries of the two `.mesh.bin` requests (`transferSize`, `encodedBodySize`, `decodedBodySize`), once from the site and once from a local server that sends identity, gzip or brotli with timing headers; what the production host does for `.bin` files was not read (see not run).
- First contacts: a probe installed before the page loads wraps `drawElementsInstanced` (the renderer's one call for the contact spheres) and `drawElements` (the surface) and records `performance.now()` at the first call with a positive count after the click on the toggle (the click event's own timestamp); the pixels are then checked to hold contacts.
  Warm means a reload in the same browser context with conditional revalidation: the dev server sends an ETag and `Cache-Control: no-cache`, so every file is revalidated with a conditional request and the surface is fetched and decoded again; the cache saves bytes, not round trips or decoding.
- Long tasks: `PerformanceObserver` of type `longtask` from before the page loads, and a 10 ms heartbeat timer whose gaps over 60 ms are recorded (gap minus the period); both are reset before each phase, and the observer's queued records are taken at each read because its callback can be late.
  The budget is judged on whichever saw the longer block.
  Whether the Zarr route is "slow" is decided from data plane evidence only: a fresh timed Zarr read right before the test (a median of three, 3 s or more) and the durations of this page's own Zarr requests while Activity reads (the slowest at 3 s or more, requests still in flight counted at their age so far); never from how long the panel took to become ready.
  With fast requests the recompute is always asserted, however long ready took, and a panel that is not ready after 120 s is a failure (a stall of the panel).
  Tested on scratch copies, not committed: with real recorded Zarr responses replayed (fast) a simulated 300 ms delay in the recompute made the test fail with 323 ms; the same replay delayed 3.5 s by a seam skipped the test with the evidence "median 3527 ms, slowest 32 s" in its message.
  A fresh preflight did not predict slow chunk reads: the small `zarr.json` request answered in 0.2 to 0.5 s while chunk range requests took a median of 3.4 s and up to 36 s.
  A first attempt with four tests in parallel gave 277 to 357 ms for the window step; that measured the host under load, not the panel, and the suite now runs this test alone.
## Findings (patch notes for the owning cards; nothing was fixed here)

1. Moved to IS-Q2 (IS-V1 and IS-J1): a recording whose channel names join no contact (nm000377, on004624) gets a disabled toggle with the sentence "None of this recording's channels match a contact in the electrodes file." and nothing else.
   The unlocated-channel note that lists the original names lives inside the panel, which cannot be opened when no channel is located, so those names are shown nowhere.
   Either enable the toggle for this case so the refusal stage can list a few original channel names with their cause, or put a few names in the toggle's title.
2. Moved to IS-Q2 (IS-V1 and IS-V2, units): on004100 declares `m` for numbers that are millimeter-sized, so the contacts are scaled by 1000 and lie about 17 m from the origin; the panel draws the template surface with no visible contact and says so only in a note below the canvas.
   The ADR forbids inferring units from magnitudes, so the numbers are right to stay; the display could fit the camera to the contacts, or not draw the surface, when the span warning fires, or put the warning on the canvas.
3. Viewer (not the panel): in the fast regime one window step of the scope at 136 channels is a long task of 187 to 209 ms with Activity off, at the plan's 200 ms limit.
   In the PR review's slow-regime run the scope's window step was not reproduced as a long task, and in this suite's slow-regime runs the baseline step showed none (the window was cached), so it is not shown to be a long task in that regime.
   The attribution of the slow-regime tasks in the budget table is unknown.
4. Platform, for the Zarr converter owner (nemar-cli or biosigIO): in on005415, on004551, on005007, on004473 and on006136 the store's channel label differs from the dataset's `channels.tsv` name.
   Writing the BIDS name into the store label would remove the need for the IS-J1 name rules.
5. Information: the on005415 electrodes file starts with a UTF-8 byte order mark; the panel's parser drops it, and a test reading the file raw has to as well.
6. Platform (data plane): the Zarr route's latency swung from 0.4 s to 12 s for the same small request within one minute, and Activity on nm000485 took 0.4 s to become ready in one hour and 38 to 66 s in another (29 range requests, the slowest 7 to 14 s each).
   The long tasks of 212 to 238 ms were seen only in the slow hours.
   The toggle said "checking" for more than 60 s on some loads in that hour.
7. Unexplained and intermittent, environment not ruled out: in about 16 runs of the export test, the page stopped answering at the click on the "2D views" switch three times (the test timed out; one teardown took 14 minutes), and once the embed page showed neither the viewer nor a notice for 90 s.
   Twelve repeated runs of the same sequence in a plain script (save PNG, then 2D views) did not reproduce it.
   If it recurs, trace it rather than guess: a heartbeat in the page (a `requestAnimationFrame` loop recording the gaps, so a frozen renderer shows as a gap and a stalled network as none), the host kept awake (`caffeinate -i`) to rule sleep out, Playwright tracing for the test, a Chrome DevTools Protocol trace with the `devtools.timeline` and `v8` categories around the click, request timing for `views.json`, the two mesh files and the Zarr route, and the dev server's log for the same minute.

## Not run, would check

- Firefox and Safari: the same suite in WebKit and Firefox, because only Chromium is installed for Playwright in this repository's setup.
- The staging site (`E2E_BASE_URL=https://test.nemar.org`, `xx099902`, a copy of `on006136`): after the owner merges the epic into staging; the manager's run.
- The production host's behavior for the mesh files: `content-encoding` and `transferSize` of `lh.mesh.bin` on the deployed site, because the local stand-in server is not the host.
- A production build under load (the dev server serves unbundled modules; the numbers above are for the page as the dev server serves it, with the panel code bundle measured separately).
- A screen reader, and touch input at 360 px: not exercised; the suite is keyboard and pointer in desktop Chromium.
- CI on the final head, which does not run this suite.

# iEEG spatial panel: validation on real datasets and measured budgets (2026-11-18)

What the Brain panel (website ADR 0033, cards IS-C1 to IS-J1) showed on real public datasets in a headless browser, what it refused, what each budget of the plan (section 9, gates G3 and G4) measured, and what was not run.
Dataset ids, counts and measurements only.
IS-Q2 (2026-11-18) updated it after the first real-data validation: what changed for the datasets it found (rows marked IS-Q2 below), a Chromium trace of the long task, the stalled 2D-views click, and the budget measured again.

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
  IS-Q2's last full run, on this branch's head with the data plane fast (a one-line preflight of 179 ms, chunk reads 2 ms median, no embed reload, no Retry press, no HTTP 5xx), passed all 27 tests in 2.9 minutes; the full run before it, in a slow hour, had 24 passed and 3 failed for outages and helper gaps that are fixed (see finding 12).
  The suite now times the Zarr route before it starts (a median of three requests, recorded first), skips the long-task budget test with a visible reason while the route is slow, counts passing failures per test and fails its last test when the counts pass a stated allowance (3 embed reloads, 3 Retry presses, 10 server errors, 10 failed requests).
  Its tests run in order in one worker only when the file is run alone (the configuration runs spec files in parallel workers).
  IS-Q2 changed three things in it: the long-task test settles the scope first and judges the budget in every regime (the skip on a slow route remains for a panel that never becomes ready), the export test installs a page watch (heartbeat, console beat, request timing) that writes into the annotations when the test does not pass, and the closed-by-names and banner datasets have tests of their own.
- The staging site check of `xx099902` is the manager's, after the epic is merged into staging; it was not run here.

## What the panel showed, per dataset

| Dataset | Frames offered | Located | What the panel showed |
| --- | --- | --- | --- |
| nm000454 | MNI152NLin2009cAsym | 48 of 125 | Surface drawn (0.170 of the canvas), label "Template brain (MNI152NLin2009cAsym), not this subject's anatomy" with no "approximate"; 77 unlocated channels listed by name (`DHAA01`, ...) with the cause |
| on005522 | MNI152NLin6ASym | 72 of 72 (88 contacts) | Surface drawn, label plus "approximate: MNI template variants differ by a few millimeters"; bipolar channels mark two contacts (`Channel LAF1-LAF2 (contacts LAF1, LAF2; midpoint)`); every join exact, so no tag, no rule note, status line without a "joined by name rules" part |
| on004100 | fsaverage | 38 of 59 | IS-Q2: a banner on the stage, in the saved SVG and in the saved PNG, "Declared unit m, but the values look millimeter-sized (largest distance 61,924 mm from the origin). Positions are shown as declared and are not placed on any template."; no surface, no outlines, no template position on a row; the stage is the three flat views (the 3D spheres are true-size millimeters, sub-pixel at this distance), with the 3D switch off and saying why; the file's own words stay on every row (`recorded (...) m, frame: fsaverage`), and the notes still say "the file says m, scaled to millimeters" and "span 72368 mm, wider than a head"; a line under the banner says the views' scale ("the drawn contacts span 72,368 mm along the widest axis"), and the reason the 3D switch is off is a visible line beside it, not only a tooltip. Before IS-Q2: surface drawn, no visible contact, the warning only in a note |
| nm000485 | Other, Talairach | 136 of 138 | Opens on Talairach (the template frame), "approximate: Talairach to MNI affine"; each row says `recorded (8.000, -27.000, 33.000) mm, frame: Talairach` and below it `template (10.006, -24.504, 34.674) mm, approximate`; Other is listed and, when chosen, says "No brain surface: this recording's coordinate frame (Other) has no cited transform to the template, so contacts are drawn in their own space." with no surface |
| nm000376 | IXI549Space | 190 of 190 | Surface drawn, "approximate: MNI template variants differ by a few millimeters"; recorded and template lines |
| on005415 | ACPC | 174 of 188 | Toggle enabled; status `joined by name rules: 174 suffix match`; rows `LTP1 (channel LTP1-20000) [suffix match]`; 14 unlocated channels listed by their original names (`LAMY2-20000`, ...); "No brain surface: this recording's coordinate frame (ACPC) has no cited transform to the template, so contacts are drawn in their own space."; contacts only (0.040 of the canvas); no mesh and no outlines file requested, in 3D or in the 2D views; all 174 `recorded` lines equal the file's text (the file starts with a byte order mark, which the panel drops) |
| on004473 | ACPC, ScanRAS | 119 of 129 | Status `joined by name rules: 119 normalized match` (`LENT 1` for `LENT1`); 10 unlocated (`Event`, `LSTG 5`, ...); the file's `-7.589096499647889e-05` (contact `LAMY1`) is shown with its exponent, never as 0; the ScanRAS frame shows its own file's text (`7.239242608449814e-05` among them); neither frame is placed; no mesh and no outlines requested |
| nm000537 | none | 0 | Toggle disabled: "The electrodes file lists no usable x, y and z positions." |
| on004642 | none | 0 | Toggle disabled: "This recording has no electrodes file, so its contact positions are not known." |
| nm000377, on004624 | none | 0 | IS-Q2: the toggle is enabled ("Brain: no channel name joins a contact; open to compare the two lists of names") and opens a refusal: the generic sentence, the cause in the notes' words ("128 unlocated channels, no contact of that name in the electrodes file."), the first 12 channel names beside the first 12 contact names as the dataset wrote them with their counts (nm000377: `ch001` to `ch012` of 128 against `SA1` to `SB2` of 94; on004624: `CH0`, `CH1`, `CH10`, ... of 36 against `F01`, `F02`, `F03`, ... of 32 for the first recording), "No rule joined these names; nothing was guessed.", and the credit. Nothing is drawn and no activity is read. Before IS-Q2: a disabled toggle, one sentence, and the names listed nowhere |
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
| Panel code beyond the viewer chunk at the epic base | 64 KB gzipped (65,536 bytes) | panel chunk 36,109 bytes (99,124 raw) plus viewer chunk growth 1,432 bytes (56,848 to 58,280; 161,956 to 166,137 raw) is 37,541 bytes; with the shared stylesheet's 716 bytes and the embed chunk's 37 the whole JavaScript and CSS delta is 38,296 bytes | met, 57 percent of the limit. IS-Q2, same method, base ec75559 and this branch: panel chunk 99,124 raw and 36,107 gzipped to 102,998 and 37,383 (+1,276), viewer chunk 166,137 raw and 58,276 to 58,278 (a file name hash); beyond the viewer chunk at the epic base (56,848): 37,383 + 1,430 = 38,813 bytes, 59 percent of the limit. After review round 1 (single read, name escapes, reason and scale lines): panel chunk 105,076 raw and 38,144 gzipped (+2,037 over the base), viewer chunk 58,275; 38,144 + 1,427 = 39,571 bytes, 60 percent of the limit |
| Template mesh transferred | 600 KB | as served by the dev server, no content encoding: 532,862 bytes for the two files (532,262 body, 600 of headers), the browser's own network entries; from a local server standing in for a compressing host: gzip level 9 430,133 bytes, brotli 370,440 body (371,040 transferred) | met, 89 percent of the limit uncompressed |
| First contacts drawn after opening the panel, warm cache | 1.5 s | Plan-literal figure, from the click that opens the panel to the first draw call of the contacts: 16 to 55 ms over all warm opens in five full runs on three datasets (on005522, nm000485, on005415); cold (first open in a fresh context) 20 to 52 ms; the surface follows 93 to 312 ms after the click. Excluded interval, navigation to an enabled toggle (the dataset's sidecars resolve first): 3.2 to 5.0 s cold and 0.7 to 2.3 s warm while the data plane was fast, 11.5 to 19 s while it was slow. Reader-visible figure, navigation to first contacts if the reader opens the panel the moment the toggle enables: the excluded interval plus the 16 to 55 ms, so 0.7 to 2.3 s warm and 3.2 to 5.0 s cold while fast, up to about 14 s warm and 19 s cold while slow | met as the plan words it (click to first draw); the reader waits for the sidecars, which the budget does not cover |
| Long task while Activity recomputes a 10 s window of 128 or more channels | 200 ms | nm000485, 136 located channels, 10 s window; measured two ways, the `longtask` entries and the gaps of a 10 ms heartbeat timer, because the `longtask` API alone missed simulated 300 ms blocks that the heartbeat saw (IS-QA1). IS-QA1 saw one block of 189 to 238 ms per phase in the slow Zarr regime (785 ms and 270 ms once, in review), none in the fast regime by the API alone. IS-Q2: a Chromium trace attributes every one of those blocks to the scope's own WebGL frame, not to decoding or computing (next section), the test now settles the scope before each phase, and the recompute alone measured 0 ms (no block over 60 ms by either detector) in all seven judged or recorded runs, in the fast live run, the replays and the slow regime alike (table below) | met, with the numbers in "Long task: what a trace says"; the scope's own window step (187 to 246 ms with Activity off, in a headless browser with software WebGL) is reported beside it and not part of the panel's budget |

How each was measured:

- Bundle: `bunx astro build` of the epic base (517bfee) and of this branch's base (6cba53d), `gzip -9c` of each emitted file; the three `generate:*` Open Graph steps of `bun run build` were skipped (they render cards from the live catalog and touch no chunk).
- Mesh: `PerformanceResourceTiming` entries of the two `.mesh.bin` requests (`transferSize`, `encodedBodySize`, `decodedBodySize`), once from the site and once from a local server that sends identity, gzip or brotli with timing headers; what the production host does for `.bin` files was not read (see not run).
- First contacts: a probe installed before the page loads wraps `drawElementsInstanced` (the renderer's one call for the contact spheres) and `drawElements` (the surface) and records `performance.now()` at the first call with a positive count after the click on the toggle (the click event's own timestamp); the pixels are then checked to hold contacts.
  Warm means a reload in the same browser context with conditional revalidation: the dev server sends an ETag and `Cache-Control: no-cache`, so every file is revalidated with a conditional request and the surface is fetched and decoded again; the cache saves bytes, not round trips or decoding.
- Long tasks: `PerformanceObserver` of type `longtask` from before the page loads, and a 10 ms heartbeat timer whose gaps over 60 ms are recorded (gap minus the period); both are reset before each phase, and the observer's queued records are taken at each read because its callback can be late.
  The budget is judged on whichever saw the longer block.
  Whether the Zarr route is "slow" is decided from data plane evidence only: a fresh timed Zarr read right before the test (a median of three, 3 s or more) and the durations of this page's own Zarr requests while Activity reads (the slowest at 3 s or more, requests still in flight counted at their age so far); never from how long the panel took to become ready.
  A panel that is not ready after 120 s is a failure with fast requests (a stall of the panel) and a skip with its evidence when the route is slow.
  Since IS-Q2 nothing is measured until the Zarr host has been quiet (no request in flight, none for 1.5 s) after the panel opens and after the baseline step, and the budget is judged whatever the route's speed; the evidence of how slow it was is noted beside the numbers.
  Tested on scratch copies, not committed: with real recorded Zarr responses replayed (fast) a simulated 300 ms delay in the recompute made the test fail with 323 ms; the same replay delayed 3.5 s by a seam skipped the test with the evidence "median 3527 ms, slowest 32 s" in its message.
  A fresh preflight did not predict slow chunk reads: the small `zarr.json` request answered in 0.2 to 0.5 s while chunk range requests took a median of 3.4 s and up to 36 s.
  A first attempt with four tests in parallel gave 277 to 357 ms for the window step; that measured the host under load, not the panel, and the suite now runs this test alone.
## Long task: what a trace says (IS-Q2, 2026-11-18)

Method: a Chrome DevTools Protocol trace (`devtools.timeline`, `v8` and its CPU profiler, `blink.user_timing`, and in two runs `cc` and `gpu`) around the click of the Activity switch on nm000485 (136 channels, 10 s window, nine slices of 16 channels), Chromium 148.0.7778.96, headless, software WebGL; a 10 ms heartbeat timer and a log of every WebGL draw with its canvas in the page; for one run, a mark at every dispatch of the panel's state machine.
Three regimes of the Zarr route: live, with chunk reads taking 1.6 to 5 s while a one-line preflight still answered in 80 to 280 ms; a seam delaying every Zarr response by 3.5 s (median 4.9 s); and a replay of recorded real responses (median 10 ms, slowest 116 ms).

What the trace shows:

- Decoding and computing are small. Over the whole 136-channel read the Zarr client and codecs took 33 ms (replay) and 39 ms (seam) in total and at most 1.4 ms in any one task; `activity.ts` 16 and 15 ms in total and at most 4.2 and 3.9 ms in one task; `panel.ts` 3 and 4 ms in total, at most 2.0 ms in one task; `brain-gl.ts` 3 ms in total, at most 2.3 ms. No main-thread task that belongs to them reaches 10 ms. These are numbers with the V8 sampling profiler running, which inflates small ones: the same band-power call measured outside a trace takes 1.5 ms for the 81,920-sample slice, 8.4 ms for 500,000 samples and 68 ms for 4,000,000 (headless Chromium 148, 16 channels, one call each, minimum of four). In the replay the whole read, with its nine yields, was ready 473 ms after the click.
- Every block over 60 ms is one native event. In the four slow-regime traces (one live, three seam) the only task over 100 ms was a compositor commit of 212 to 218 ms with no JavaScript in it: the profiler attributes all of it to native code, and inside it `LayerTreeHost::DoUpdateLayers` called `GLES2::ReadPixels`, which waited 181 to 206 ms for the GPU process (`FramebufferVk::readPixelsImpl`, "CPU Readback", `ContextVk::finishImpl`), followed in the same commit by a second readback of 32 to 35 ms. This headless Chromium with software WebGL reads each WebGL canvas back to the CPU at commit and waits for the software rasterizer to finish the frame.
- Which canvas. The page's draw log shows, just before the commit, 138 `drawArrays` calls on the scope's canvas (880 by 656 pixels) and then one `drawElementsInstanced` and one `drawElements` on the panel's canvas, so the commit read back both. The long readback is the scope's by elimination: the panel's canvas read back in 18 to 28 ms every other time in the same traces. The scope's own window step with Activity off measured 246 ms by the heartbeat in two runs here, the same size.
- Why it fell inside the Activity phases. The scope renders again when the panel opens (it narrows) and after every window step, and that render needs data from the same Zarr route. In the three seam traces the commit came 5.3, 7.0 and 16.3 s after the click, when that data arrived; the panel's state did not change at those moments (one `window_changed` from the viewer that the state machine ignores). The baseline step of the test (Activity off, 2.5 s wait) fell into the next phase the same way, which is why IS-QA1 saw "one block per phase" only in the slow hours.
- The recompute produced no block in any trace, so nothing was changed in the panel for the long task itself: yielding between the read and the compute would have changed no measured number. (`computeActivityPlan` was changed afterwards for a different reason, the repeated reads; see "Activity reads: one read per window".) The card's stop condition applies (the long task is in the scope, which is the viewer's module), and nothing outside the panel was changed.
- Not measured: a browser with a GPU. The 180 to 250 ms readback is the cost of software rasterization at commit; with a GPU-backed compositor the draw is asynchronous. The scope's frame cost on real hardware is the viewer owner's to measure.

The test now settles the scope before measuring (no Zarr request in flight and none for 1.5 s, after the panel opens and after the baseline step), and judges the 200 ms budget in every regime instead of skipping when the Zarr route is slow; a panel that is not ready after 120 s (a stall) is still skipped with its evidence when the route is slow, and fails when it is fast.
Measured with it, Chromium 148.0.7778.96, nm000485, 136 located channels (heartbeat gaps over 60 ms and `longtask` entries, both):

| Zarr route during the run | switch on, change of measure (ready after) | recompute alone, both detectors | window step, Activity on (heartbeat, API) | same step, Activity off (heartbeat, API) | test |
| --- | --- | --- | --- | --- | --- |
| live, fast chunk reads (median 2 ms, slowest 16 ms), the final all-green run | 394 ms, 244 ms | none over 60 ms (0 ms) | 200 ms, 190 ms | 229 ms, 193 ms | passed |
| replay of recorded real responses, run 1 (median 10 ms, slowest 18 ms) | 405 ms, 356 ms | none over 60 ms (0 ms) | 201 ms, 188 ms | 182 ms, 190 ms | passed |
| replay, run 2 (median 10 ms, slowest 16 ms) | 392 ms, 360 ms | none over 60 ms (0 ms) | 202 ms, 191 ms | 187 ms, 190 ms | passed |
| live, chunk reads slow (median 3.3 s, slowest 5.2 s) | 25.4 s, 35.5 s | none (0 ms) | 231 ms, 193 ms | 246 ms, 213 ms | skipped by the old skip on slow evidence; numbers recorded |
| live, chunk reads slow (median 3.0 s, slowest 7.1 s) | 40.4 s, 32.7 s | none (0 ms) | 236 ms, 194 ms | 240 ms, 207 ms | passed |
| live, chunk reads slow (median 3.6 s, slowest 12.4 s) | 34.1 s, 43.0 s | none (0 ms) | 238 ms, 207 ms | 259 ms, 217 ms | passed |
| seam, every Zarr response delayed 3.5 s (median 4.95 s, slowest 6.8 s) | 45.9 s, 47.0 s | none (0 ms) | 227 ms, 193 ms | 246 ms, 208 ms | passed |
| live, chunk reads slow (median 3.8 s, slowest 7.0 s) | switch on and window step ready; the change of measure was not ready after 120 s | not judged | not judged | not judged | skipped as a stall of a slow route, with its evidence |

In every judged run the recompute alone was 0 ms by both detectors, and the window step with Activity on was within 21 ms, either way, of the same step with Activity off (the scope's own frame).
The 200 ms budget is met in the fast regime (replay) and in the slow regime (live and seam), for the panel's recompute.
The scope's own step is 182 to 259 ms by the heartbeat (190 to 217 ms by the `longtask` API) in this headless browser, over 200 ms in the slow runs and just under it in the replay; it is the viewer's, it is reported beside the budget and not counted against the panel, and the test allows the window step 50 ms over the scope alone.
Two checks that the test can fail: a 300 ms busy loop added to the compute step failed it under the replay (recompute alone 325 ms, where the `longtask` API saw none of the nine blocks), and with the quiet waits taken out the same test failed under the 3.5 s seam (272 ms in the switch-on phase, the scope's late render).
Chunk reads were fast live in one run only, the last (median 2 ms, slowest 16 ms); in every earlier live run the route's median was 1.6 to 5 s, though a one-line preflight answered in 80 to 560 ms, so the fast regime is also measured from a replay of real responses, as IS-QA1 did, through a seam now in the spec (`QA1_ZARR_HAR`).

## Activity reads: one read per window (IS-Q2 review round 1)

The trace's per-task numbers hid a larger fault: the plan read the located rows in slices of 16 channels with one read per slice, and a chunk of the store holds many channels, so the same chunks were fetched again for every slice.
Counted on nm000485 (136 channels, 10 s window), live, Chromium 148.0.7778.96, the page's own Zarr requests from the click on Activity to ready:

| | requests | distinct responses | bytes | ready after | heartbeat gaps over 60 ms |
| --- | --- | --- | --- | --- | --- |
| before (epic base), live fast, two runs | 27, 27 | 3 (bytes=0-435086, 435087-876103, 876104-1310810), each nine times | 11,797,299 | 739 ms, 324 ms | none |
| after, live fast, two runs | 3, 3 | 3, each once | 1,310,811 | 279 ms, 280 ms | none |
| before, the 3.5 s seam, from the long-task test | 27 at switch on, 85 over the test | | | 45.9 s (switch on), 47.0 s (measure) | none (recompute alone 0 ms) |
| after, the 3.5 s seam | 3 at switch on, 13 over the test | | | 4.4 s (switch on), 4.0 s (measure) | none (recompute alone 0 ms) |

The same trace method on the fast plane, before and after (main-thread tasks 526 and 396): the Zarr client and codecs took 30.6 ms in total before and 3.3 ms after, at most 1.2 ms in one task both times; `activity.ts` 15.3 and 15.1 ms in total, at most 4.2 and 4.0 ms in one task; `panel.ts` at most 1.0 and 0.8 ms; `brain-gl.ts` at most 1.9 and 1.4 ms.
No task of the panel's or the reader's reaches 5 ms, so the fix adds no long task, and a slow route pays one read of the window instead of nine.

What changed (`computeActivityPlan`, `panel.ts`): the located rows are read once for the window, as one span from the first row to the last (rows read between located ones are discarded; a span is cut only where it would pass the 4-million-sample bound), then computed in slices of at most 16 channels and at most 1,000,000 samples (`SLICE_SAMPLE_CAP`; one channel is the floor), with a yield to the page after the read and after every slice.
The cap is from the benchmark above: band power took 8.4 ms at 500,000 samples and 68 ms at 4,000,000, so 1,000,000 samples is about 17 ms by linear interpolation (not measured at that size), against the 200 ms budget; the common slice, 16 channels of a 10 s window at 1 kHz, is 160,000 samples and unchanged.
A test through the viewer's own reader (`activity-reads.test.ts`, real zarrita over an in-memory store holding the committed on006136 window) counts chunk requests against distinct chunks, for chunks that hold every channel and for chunks that cut across the slices.

## The stalled 2D-views click (IS-Q2, 2026-11-18)

What QA1 saw: in about 16 runs of the export test the page stopped answering at the click on the "2D views" switch three times (the test timed out; one teardown took 14 minutes), and once the embed showed neither the viewer nor a notice for 90 s.
A code read of `panel.ts` found no cross-wait between the template, outlines and stage state: the click dispatches `view_changed`, which sets one flag and requests nothing; `sync` then disposes the renderer and paints the views.

Reproduction attempt, on the epic base before any change (ec75559), nm000485, headless Chromium 148.0.7778.96, one fresh browser per run, the whole sequence of the export test (open the embed, open the panel, save SVG and PNG in 3D, click "2D views", wait for the three outlines, save SVG and PNG again), `caffeinate -i` around the loop:

- 111 runs on the epic base, all under `caffeinate -i`, one fresh browser each: 45 ran 14:24 to 14:33, then 6 more to place the heartbeat gaps ran 14:33 to 14:34, then 60 more with the page's console captured ran 15:55 to 16:09. All 111 completed. The click to the 2D stage took 29 to 43 ms every time (31 to 41 ms in the first 51). A watchdog asking the page a trivial question every second would have recorded 15 s of silence as a stall, saved a Chrome trace, a JavaScript stack from `Debugger.pause`, a screenshot and a Playwright trace; none was needed.
- Heartbeat: one gap per run of 322 to 375 ms on the timer and 331 to 373 ms on the animation-frame loop; in the six runs that recorded step times it fell 0.9 to 1.3 s before the Brain toggle enabled (the scope's first frame at page load), never around the click.
- Request timing: `views.json` 85 to 103 ms, each mesh file 85 to 103 ms in the first 51; the slowest Zarr request of a run had a median of 3.5 to 3.9 s and a maximum of 11 s in the first 51 and 46 s in the last 60 (the data plane was slow for part of both loops, with 28 HTTP 5xx and 6 embed reloads in the last 60); no Retry press. The click to the 2D stage took 29 to 43 ms in all 111.
- Host sleep. The host is a laptop on battery; its power log for QA1's working day shows it asleep from 12:16:52 for about 10 minutes, from 12:27:00 to 12:41:53 (14.9 minutes) and from 13:17:57 for 2.5 minutes. A 14-minute teardown matches a sleep of that length; that is consistent with the cause, not proof of it, and the other stalls cannot be dated from this record.
  The same log shows an idle sleep of 4.5 minutes (14:53:21 to 14:57:51) during IS-Q2's own work, while no `caffeinate` was running: a headless test run holds no power assertion, so a laptop on battery sleeps under it when nobody touches it, and a page then answers late or not at all until the host wakes.
  The three loops ran under `caffeinate -i`, and the log shows no sleep event during 14:24 to 14:34 or 15:55 to 16:09.
- The committed export test, 40 repeats at head 04c58a9 (`--repeat-each=40 --workers=1`, `caffeinate -i`, 15:33 to 15:54, no sleep event in the host's log): 36 passed and 4 failed, none at or after the click on "2D views". That head's product code is the one of every later head of this branch up to the first review round (the banner, names and plan changes came after), but its spec helper was the one before the embed-notice fix, so all 40 repeats ran the old helper, and the repeat-36 failure is the notice that helper missed.
  Three failed before the panel opened, on a toggle still saying "checking this dataset for electrode positions" after 120 s; in each the page answered (its last console beat was 94 to 191 ms old, no heartbeat gap over 72 ms), `views.json` and the mesh files had not been asked for, and the Zarr host had slow requests (the slowest finished one took 11.5, 82 and 114 s) and 3 with no completion event after the test gave up at 120 s.
  The viewer starts the panel after its first frame, and its first frame waits on those reads, so this is the data plane and a viewer with no timeout on them, not the panel (finding 11).
  One failed at page load: the embed's own notice, "The signal viewer could not load this dataset's recordings right now", was on screen and the helper did not recognize it (finding 12).

Outcome: not reproduced, no product cause found, not claimed fixed, left open.
If it recurs the export test now leaves its evidence in the test's annotations: heartbeat gaps (timer over 60 ms, animation frame over 100 ms), the time since the page's last console beat (which reaches Node even while the page is blocked), whether the page answered a trivial evaluate within 5 s, and the timing of `views.json`, the mesh files and the Zarr requests.

## Findings (IS-QA1's patch notes, and what IS-Q2 did with each)

1. Fixed in IS-Q2 (IS-V1 and IS-J1): a recording whose channel names join no contact (nm000377, on004624) had a disabled toggle with one sentence and its names shown nowhere.
   The toggle now opens a refusal that lists the first 12 channel names beside the first 12 contact names as recorded, with counts, the cause in the notes' words, and "No rule joined these names; nothing was guessed."
   A refusal for want of coordinates (nm000537, on004642, or channels that name contacts with no position) keeps its disabled toggle and its sentence.
2. Fixed in IS-Q2 (IS-V1 and IS-V2, units): on004100 declares `m` for numbers that are millimeter-sized, so its contacts lie 28 to 62 m from the origin after the declared scaling.
   The ADR forbids inferring units, so nothing is rescaled.
   A banner on the stage and in the saved SVG and PNG says the declared unit, that the values look millimeter-sized, the largest distance, and that the positions are shown as declared and placed on no template; the rule is "a converted non-millimeter unit and every drawn contact more than 300 mm from the origin" (`units-banner.ts`).
   Two consequences to know: the stage is the three flat views, because the 3D spheres are true-size millimeters and a canvas drew no contact pixel at that distance (a renderer with a minimum on-screen size would change that; it is IS-R1's module); and the template is withheld for this dataset.
3. Re-attributed (viewer, not the panel): the 187 to 246 ms blocks are one frame of the scope's own WebGL canvas read back at commit in a headless browser with software WebGL; see "Long task: what a trace says".
   The panel's recompute produced none, and nothing in the panel was changed for it.
4. Platform, for the Zarr converter owner (nemar-cli or biosigIO): in on005415, on004551, on005007, on004473 and on006136 the store's channel label differs from the dataset's `channels.tsv` name.
   Writing the BIDS name into the store label would remove the need for the IS-J1 name rules.
5. Information: the on005415 electrodes file starts with a UTF-8 byte order mark; the panel's parser drops it, and a test reading the file raw has to as well.
6. Platform (data plane): the Zarr route's latency swings from 0.4 s to 12 s for the same small request within one minute, and a one-line preflight does not predict chunk reads (preflight 80 to 280 ms while each chunk range took 1.6 to 7 s, in IS-Q2's hours too).
   Activity on nm000485 took 0.3 s to become ready in one hour and 25 to 66 s in another.
   The toggle said "checking" for more than 60 s on some loads in that hour.
7. Open: the stalled 2D-views click did not reproduce in 111 plain-script repeats under `caffeinate -i` (nor in 40 repeats of the committed test, below), and no product cause was found; the host's power log shows sleeps of up to 14.9 minutes during QA1's working day.
   Details and the evidence a recurrence now leaves are in "The stalled 2D-views click".
8. Fixed in IS-Q2 round 1 (the panel): each 16-channel slice of an Activity read re-fetched the same chunks (27 requests, 11.8 MB for 1.3 MB of samples on nm000485, 25 to 47 s on a slow route); the window is now read once and computed in slices capped by channels and by samples (see "Activity reads: one read per window").
   The earlier estimate here, about 200 ms for one slice at the 4-million-sample limit, scaled a number measured under the profiler; measured outside a trace it is 68 ms, and slices are now capped at 1,000,000 samples anyway.
9. For the panel's owner, measured and not changed: every dispatch runs `sync`, which re-uploads the contact colors and schedules a redraw of the panel's canvas, even for a `window_changed` that changes nothing; each such redraw read back in 18 to 35 ms in this browser.
10. For the driver (ADR 0033): the template table lists `MNI305` and `fsaverage` as placed; both committed `fsaverage` datasets (on004100, on006253) declare meters over millimeter-sized numbers, so the banner withholds them, and no dataset in the suite places the MNI305 affine at head scale (it is tested on a known-answer input in `panel.test.ts` and on FreeSurfer's worked example in `transforms.test.ts`).

11. For the viewer's owner (not the panel), seen in 3 of 40 repeats of the export test in a slow hour: the viewer's first frame waits on Zarr reads that take 80 to 114 s or are still open when the test gives up, and shows neither content nor a notice meanwhile; the Brain toggle stays "checking" because the panel starts after the first frame.
    The page itself is responsive (heartbeat clean).
    A timeout on the first reads, with the viewer's own notice, would turn it into a message and a Retry.
12. Explained, a test helper's gap and not a silent page: the embed writes a second notice, "The signal viewer could not load this dataset's recordings right now" (`[data-embed-notice]`, when the Zarr index fails to load), and the helpers of both specs waited only for the server-rendered one (`.embed-msg__text`).
    A page snapshot of one failure (the panel spec's nm000454) shows it, with the dev server's log answering `[api] list datasets: 500` at the time.
    The other cases (on004624 in the full run, one export repeat) failed the same way and are taken to be the same page, by the symptom and not by a snapshot of their own: the export repeat's recorded page text was cut at 160 characters before the notice, and the full run's snapshot was empty.
    So IS-QA1's "once the embed showed neither the viewer nor a notice for 90 s" was most likely a notice the helper missed, during a data plane outage.
    Both specs now wait for either notice and count the reload; `openViewer` still records the page's load state, words and pending requests if it gives up on a page that shows neither.

13. The panel spec's first test (`reads` must be 1 right after ready) is a race with the scope's own render, not a problem of this branch: with every Zarr response 2.5 s late the original test failed 4 of 4 on the epic base and 1 of 4 on this branch (the single read of the window shrinks the window for the race), and with the scope settled first (the quiet wait of the validation test) it passed 4 of 4; on a fast plane the original passed 10 of 10 on the base and 10 of 10 here.
    A window report that arrives after the Activity switch is on re-plans the read, which is the designed behavior (moving the window aborts the read in flight), so the test now settles first; whether a double read could hide a real fault in the plan is not shown by these runs and is not claimed.
14. The flat views have no scale bar; under the banner a line in the stage and in the figures now says their extent in words (the widest span of the drawn contacts, 72,368 mm for on004100's fixture and the same number the notes give).

## Not run, would check

- Firefox and Safari: the same suite in WebKit and Firefox, because only Chromium is installed for Playwright in this repository's setup.
- The staging site (`E2E_BASE_URL=https://test.nemar.org`, `xx099902`, a copy of `on006136`): after the owner merges the epic into staging; the manager's run.
- The production host's behavior for the mesh files: `content-encoding` and `transferSize` of `lh.mesh.bin` on the deployed site, because the local stand-in server is not the host.
- A production build under load (the dev server serves unbundled modules; the numbers above are for the page as the dev server serves it, with the panel code bundle measured separately).
- A screen reader, and touch input at 360 px: not exercised; the suite is keyboard and pointer in desktop Chromium.
- CI on the final head, which does not run this suite.
- A Chromium with a GPU (non-software WebGL): the scope-frame cost and the panel's redraw cost above are those of software rasterization at commit.
- Firefox and Safari for the closed-by-names refusal and the banner (same reason as above).

# iEEG spatial panel: validation on real datasets and measured budgets (2026-11-18)

What the Brain panel (website ADR 0033, cards IS-C1 to IS-J1) showed on real public datasets in a headless browser, what it refused, what each budget of the plan (section 9, gates G3 and G4) measured, and what was not run.
Dataset ids, counts and measurements only.

## How it was run

- Suite: `e2e/ieeg-spatial-validation.spec.ts` (26 tests), run against the local dev server with `PUBLIC_DATA_BASE_URL=https://data.nemar.org bun run test:e2e e2e/ieeg-spatial-validation.spec.ts`.
  Each test opens the embed route (the same viewer session the dataset dialog runs) on the dataset's first recording and reads the dataset's own sidecars and Zarr store from the public data plane; nothing is written anywhere.
- Browser: Chromium 148.0.7778.96, headless, Playwright 1.60.0, desktop viewport 1280 by 900 (360 by 900 where stated), software WebGL.
  Nothing is claimed for Firefox or Safari.
- Dataset versions read on 2026-11-18 equal the census versions (nm000454, nm000485, nm000376, nm000537, nm000377 at v1.0.2; on005522, on004100, on005415, on004473, on004642, on004624, on009081 at v1.0.0), so no check was dropped for a changed version.
- The data plane answers 500 now and then, and the dev server's own server-side read of a dataset's landing file sometimes fails.
  The suite reloads the embed page and presses Retry as a reader would, and counts both; a failure that outlasts them fails the test.
  Several runs met data plane trouble and are reported as such, not hidden: one run lost ten tests to a connectivity episode (21 server-side reads of the dev server failed with `network_error` within about five minutes), others met stretches in which the Zarr route answered each range request in 7 to 14 s and sidecar resolution took over a minute; the tests that failed for those reasons were rerun.
  The final full run is quoted in the pull request with its counters.
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
WCAG contrast of text against what is behind it, measured in the page: all at least 4.5.
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
| First contacts drawn after opening the panel, warm cache | 1.5 s | contacts: 16 to 55 ms over all warm opens in five full runs on three datasets (on005522, nm000485, on005415); cold (first open in a fresh context) 20 to 52 ms; the surface follows 93 to 312 ms after the click | met |
| Long task while Activity recomputes a 10 s window of 128 or more channels | 200 ms | nm000485, 136 located channels, 10 s window. Zarr route fast (reads done in 0.4 s; seven runs): switch on and change of measure produced no long task (the browser reports tasks over 50 ms); moving the window, one task of 187 to 194 ms, against 190 to 209 ms for the same window step with Activity off. Zarr route slow (reads took 38 to 66 s; seven runs): switch on produced one task of 212 to 233 ms, change of measure one of 189 to 215 ms | met in the fast regime; missed by 6 to 17 percent (212 to 233 ms) in the slow regime, far from the 50 percent stop condition, so the lead decides; the scope's own step sits at the limit (see Findings) |

How each was measured:

- Bundle: `bunx astro build` of the epic base (517bfee) and of this branch's base (6cba53d), `gzip -9c` of each emitted file; the three `generate:*` Open Graph steps of `bun run build` were skipped (they render cards from the live catalog and touch no chunk).
- Mesh: `PerformanceResourceTiming` entries of the two `.mesh.bin` requests (`transferSize`, `encodedBodySize`, `decodedBodySize`), once from the site and once from a local server that sends identity, gzip or brotli with timing headers; what the production host does for `.bin` files was not read (see not run).
- First contacts: a probe installed before the page loads wraps `drawElementsInstanced` (the renderer's one call for the contact spheres) and `drawElements` (the surface) and records `performance.now()` at the first call with a positive count after the click on the toggle (the click event's own timestamp); the pixels are then checked to hold contacts.
  Warm means the page was reloaded in the same browser context, so the data and the surface revalidate from the HTTP cache.
  The time from page load to an enabled toggle (sidecars resolved, not budgeted) was 3.2 to 5.0 s cold and 0.7 to 2.3 s warm while the data plane was fast, and up to 19 s cold and 14 s warm while it was slow.
- Long tasks: `PerformanceObserver` of type `longtask` from before the page loads, reset before each phase.
  A first attempt with four tests in parallel gave 277 to 357 ms for the window step; that measured the host under load, not the panel, and the suite now runs this test alone.

## Findings (patch notes for the owning cards; nothing was fixed here)

1. IS-V1 and IS-J1: a recording whose channel names join no contact (nm000377, on004624) gets a disabled toggle with the sentence "None of this recording's channels match a contact in the electrodes file." and nothing else.
   The unlocated-channel note that lists the original names lives inside the panel, which cannot be opened when no channel is located, so those names are shown nowhere.
   Either enable the toggle for this case so the refusal stage can list a few original channel names with their cause, or put a few names in the toggle's title.
2. IS-V1 and IS-V2: on004100 declares `m` for numbers that are millimeter-sized, so the contacts are scaled by 1000 and lie about 17 m from the origin; the panel draws the template surface with no visible contact and says so only in a note below the canvas.
   The ADR forbids inferring units from magnitudes, so the numbers are right to stay; the display could fit the camera to the contacts, or not draw the surface, when the span warning fires, or put the warning on the canvas.
3. Viewer (not the panel): one window step of the scope at 136 channels is a long task of 187 to 209 ms with Activity off, at the plan's 200 ms limit.
   The panel's recompute adds none, but the combined step has no margin.
4. Platform, for the Zarr converter owner (nemar-cli or biosigIO): in on005415, on004551, on005007, on004473 and on006136 the store's channel label differs from the dataset's `channels.tsv` name.
   Writing the BIDS name into the store label would remove the need for the IS-J1 name rules.
5. Information: the on005415 electrodes file starts with a UTF-8 byte order mark; the panel's parser drops it, and a test reading the file raw has to as well.
6. Platform (data plane): the Zarr route's latency swung from 0.4 s to 12 s for the same small request within one minute, and Activity on nm000485 took 0.4 s to become ready in one hour and 38 to 66 s in another (29 range requests, the slowest 7 to 14 s each).
   The long task of 212 to 233 ms was seen only in the slow hour.
   The toggle said "checking" for more than 60 s on some loads in that hour.
7. Unexplained and intermittent, environment not ruled out: in about 16 runs of the export test, the page stopped answering at the click on the "2D views" switch three times (the test timed out; one teardown took 14 minutes), and once the embed page showed neither the viewer nor a notice for 90 s.
   Twelve repeated runs of the same sequence in a plain script (save PNG, then 2D views) did not reproduce it.
   If it recurs, record whether the host was idle or asleep.

## Not run, would check

- Firefox and Safari: the same suite in WebKit and Firefox, because only Chromium is installed for Playwright in this repository's setup.
- The staging site (`E2E_BASE_URL=https://test.nemar.org`, `xx099902`, a copy of `on006136`): after the owner merges the epic into staging; the manager's run.
- The production host's behavior for the mesh files: `content-encoding` and `transferSize` of `lh.mesh.bin` on the deployed site, because the local stand-in server is not the host.
- A production build under load (the dev server serves unbundled modules; the numbers above are for the page as the dev server serves it, with the panel code bundle measured separately).
- A screen reader, and touch input at 360 px: not exercised; the suite is keyboard and pointer in desktop Chromium.
- CI on the final head, which does not run this suite.

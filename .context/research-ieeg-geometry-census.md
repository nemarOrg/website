# iEEG electrode geometry census (2026-11-17)

How many recordings the spatial panel can show on a template, show in their own frame without anatomy, or must refuse, counted by the viewer's own resolver (`src/lib/ieeg-spatial/geometry.ts`, card IS-C1) over every public dataset of modality `ieeg`.
These numbers replace the sampled ones in `.context/plans/ieeg-spatial/plan.md` section 3.
Dataset ids and counts only.

## How it is counted

Rerun with `bun scripts/ieeg-geometry-census.ts --out <dir>` (add `--resume` to continue an interrupted run).
The script reads the public catalog (`modality=ieeg`), lists each dataset's latest version through the data plane, enumerates recordings, and classifies each with `resolveRecordingGeometry`; it repeats no rule of its own.
It sends only public GET requests, at most 4 in flight and 5 started per second, retries every transient failure (HTTP 5xx or 429, network error) with backoff, and never counts one as an absence: a recording that touched a failed read is unresolved and is re-resolved in a later round.

- A recording is one `<stem>_ieeg.<ext>` data entry per `ieeg` directory (a sidecar `.json` is not one; BrainVision and EEGLAB companions share a stem; a `.mefd` directory counts once).
- `template`: at least one shown space is on a standard template identifier with declared units.
- `native`: a space is shown but none is on a template with declared units, so the panel draws it in its own frame without anatomy. The frame may be `ACPC`, `ScanRAS` or `Other`, may be unlabeled (no coordsystem file, or a label that matches no standard identifier), or the units may be undeclared.
- `refused`: no space can be shown; the resolver's reason word says why.

## Run

Date 2026-11-17. Catalog total for modality `ieeg`: 167 datasets; datasets censused: 167; datasets with at least one recording: 157; recordings classified: 35,818.
31,552 requests (32,555 attempts, 1,003 retries) in 115 minutes over 2 round(s); requests that outlasted their retries: 1; recordings still unresolved: 0; directories whose listing never succeeded: 0.
Failed attempts by outcome: 500 1,000, 502 3, network 1. Definitive non-200 answers: none.

## Recordings by class

| Class | Recordings | Share | Meaning |
| --- | --- | --- | --- |
| template | 6,316 | 17.6% | on a standard template with declared units |
| native | 10,806 | 30.2% | in its own frame, no anatomy |
| refused | 18,696 | 52.2% | nothing to draw; a reason word says why |

Native recordings, by what keeps them off a template:

| Why native | Recordings |
| --- | --- |
| `native_or_described` | 9,506 |
| `unlabeled` | 1,270 |
| `template_units_undeclared` | 30 |

## Datasets by best recording class

A dataset counts under the best class any of its recordings reaches.

| Best class | Datasets | Recordings in those datasets | Of which in that class |
| --- | --- | --- | --- |
| template | 36 | 6,331 | 6,316 |
| native | 57 | 10,870 | 10,806 |
| refused | 64 | 18,617 | 18,617 |
| no recordings | 10 | 0 | 0 |

## Why recordings are refused

| Reason | Datasets | Recordings |
| --- | --- | --- |
| `no_coordinates` | 64 | 17,898 |
| `no_electrodes_file` | 10 | 756 |
| `all_zero` | 1 | 38 |
| `unreadable` | 1 | 4 |

## Frames declared

One row per frame label over every space the resolver returned (a recording with two spaces counts under both; a refused space still has its frame).

| Frame | Datasets | Recordings |
| --- | --- | --- |
| Other | 90 | 20,640 |
| ACPC | 15 | 6,771 |
| MNI152NLin6ASym | 12 | 2,923 |
| MNI152NLin2009cAsym | 3 | 1,326 |
| undeclared (no_coordsystem) | 11 | 1,197 |
| fsaverage | 6 | 703 |
| Talairach | 14 | 571 |
| MNI152NLin2009aSym | 2 | 544 |
| MNI152Lin | 5 | 220 |
| ScanRAS | 3 | 155 |
| undeclared (space_mismatch) | 2 | 82 |
| IXI549Space | 2 | 40 |
| MNI152NLin2009bAsym | 1 | 26 |
| MNI152NLin6Sym | 1 | 1 |

## Datasets with more than one space

| Dataset | Spaces offered |
| --- | --- |
| nm000473 | ACPC + Other |
| nm000485 | Other + Talairach |
| on004457 | (none) + ACPC |
| on004473 | ACPC + ScanRAS |
| on005574 | MNI152NLin2009aSym + Other |

## Fixtures for the panel's tests

One dataset per class or reason, chosen among datasets whose recordings all share it, fewest recordings first (ties by id).

| Class | Dataset |
| --- | --- |
| `template` | on003708 (1 recording) |
| `native:native_or_described` | nm000355 (1 recording) |
| `native:template_units_undeclared` | nm000373 (30 recordings) |
| `native:unlabeled` | on004370 (15 recordings) |
| `refused:no_coordinates` | nm000452 (1 recording) |
| `refused:unreadable` | on001785 (4 recordings) |
| `refused:no_electrodes_file` | on004642 (10 recordings) |
| `refused:all_zero` | on003844 (38 recordings) |

## Per dataset

| Dataset | Version | Subjects | Recordings | Template | Native | Refused (reasons) |
| --- | --- | --- | --- | --- | --- | --- |
| nm000182 | v1.0.4 | 24 | 257 | 0 | 0 | 257 (no_coordinates 257) |
| nm000183 | v1.0.4 | 14 | 632 | 0 | 0 | 632 (no_coordinates 632) |
| nm000241 | v1.0.2 | 2 | 18 | 0 | 0 | 18 (no_coordinates 18) |
| nm000251 | v1.0.1 | 1 | 6 | 0 | 0 | 6 (no_coordinates 6) |
| nm000253 | v1.2.0 | 10 | 26 | 0 | 23 | 3 (no_coordinates 3) |
| nm000276 | v1.2.1 | 50 | 50 | 0 | 0 | 50 (no_coordinates 50) |
| nm000350 | v1.0.2 | 4 | 31 | 0 | 0 | 31 (no_coordinates 31) |
| nm000352 | v1.0.2 | 24 | 111 | 0 | 88 | 23 (no_coordinates 23) |
| nm000353 | v1.0.2 | 1 | 300 | 0 | 0 | 300 (no_coordinates 300) |
| nm000354 | v1.0.2 | 20 | 20 | 20 | 0 | 0 |
| nm000355 | v1.0.0 | 1 | 1 | 0 | 1 | 0 |
| nm000356 | v1.0.2 | 29 | 29 | 0 | 29 | 0 |
| nm000357 | v1.0.0 | 16 | 29 | 0 | 29 | 0 |
| nm000358 | v1.0.2 | 12 | 55 | 0 | 55 | 0 |
| nm000359 | v1.0.2 | 1 | 7500 | 0 | 0 | 7500 (no_coordinates 7500) |
| nm000360 | v1.0.2 | 25 | 25 | 18 | 0 | 7 (no_coordinates 7) |
| nm000361 | v1.0.0 | 71 | 71 | 71 | 0 | 0 |
| nm000362 | v1.0.2 | 106 | 535 | 535 | 0 | 0 |
| nm000363 | v1.0.2 | 9 | 0 | 0 | 0 | 0 |
| nm000364 | v1.0.2 | 7 | 8 | 0 | 0 | 8 (no_coordinates 8) |
| nm000365 | v1.0.2 | 12 | 67 | 0 | 0 | 67 (no_coordinates 67) |
| nm000367 | v1.0.2 | 16 | 16 | 0 | 16 | 0 |
| nm000368 | v1.0.2 | 35 | 43 | 0 | 43 | 0 |
| nm000369 | v1.0.2 | 3 | 3 | 0 | 3 | 0 |
| nm000370 | v1.0.2 | 3 | 3 | 0 | 0 | 3 (no_coordinates 3) |
| nm000371 | v1.0.2 | 10 | 10 | 0 | 10 | 0 |
| nm000372 | v1.0.4 | 1 | 2 | 0 | 2 | 0 |
| nm000373 | v1.0.2 | 8 | 30 | 0 | 30 | 0 |
| nm000374 | v1.0.2 | 11 | 22 | 0 | 0 | 22 (no_coordinates 22) |
| nm000375 | v1.0.2 | 16 | 16 | 0 | 0 | 16 (no_coordinates 16) |
| nm000376 | v1.0.2 | 9 | 9 | 9 | 0 | 0 |
| nm000377 | v1.0.2 | 3 | 8 | 0 | 8 | 0 |
| nm000379 | v1.0.2 | 6 | 31 | 31 | 0 | 0 |
| nm000380 | v1.0.2 | 17 | 45 | 0 | 22 | 23 (no_coordinates 23) |
| nm000383 | v1.0.2 | 6 | 30 | 0 | 0 | 30 (no_coordinates 30) |
| nm000386 | v1.0.2 | 6 | 41 | 0 | 0 | 41 (no_coordinates 41) |
| nm000387 | v1.0.2 | 7 | 0 | 0 | 0 | 0 |
| nm000389 | v1.0.2 | 84 | 0 | 0 | 0 | 0 |
| nm000390 | v1.0.2 | 68 | 0 | 0 | 0 | 0 |
| nm000394 | v1.0.2 | 1 | 34 | 0 | 0 | 34 (no_coordinates 34) |
| nm000395 | v1.0.2 | 6 | 8 | 0 | 0 | 8 (no_coordinates 8) |
| nm000396 | v1.0.2 | 13 | 13 | 0 | 0 | 13 (no_coordinates 13) |
| nm000397 | v1.0.2 | 4 | 46 | 0 | 0 | 46 (no_coordinates 46) |
| nm000398 | v1.0.4 | 4 | 23 | 0 | 0 | 23 (no_coordinates 23) |
| nm000399 | v1.0.2 | 11 | 26 | 26 | 0 | 0 |
| nm000400 | v1.0.2 | 7 | 30 | 0 | 0 | 30 (no_coordinates 30) |
| nm000401 | v1.0.2 | 14 | 17 | 0 | 0 | 17 (no_coordinates 17) |
| nm000402 | v1.0.2 | 29 | 78 | 0 | 78 | 0 |
| nm000403 | v1.0.2 | 28 | 56 | 0 | 0 | 56 (no_coordinates 56) |
| nm000404 | v1.0.2 | 25 | 25 | 0 | 25 | 0 |
| nm000405 | v1.0.3 | 16 | 73 | 0 | 73 | 0 |
| nm000406 | v1.0.2 | 14 | 830 | 0 | 0 | 830 (no_coordinates 830) |
| nm000408 | v1.0.2 | 1 | 110 | 0 | 0 | 110 (no_coordinates 110) |
| nm000409 | v1.0.2 | 8 | 24 | 0 | 0 | 24 (no_coordinates 24) |
| nm000410 | v1.0.2 | 79 | 79 | 0 | 0 | 79 (no_coordinates 79) |
| nm000411 | v1.0.2 | 8 | 15 | 0 | 0 | 15 (no_coordinates 15) |
| nm000412 | v1.0.2 | 6 | 24 | 0 | 0 | 24 (no_coordinates 24) |
| nm000413 | v1.0.2 | 29 | 190 | 0 | 0 | 190 (no_coordinates 190) |
| nm000414 | v1.0.2 | 3 | 41 | 0 | 0 | 41 (no_coordinates 41) |
| nm000424 | v1.0.1 | 13 | 24 | 0 | 0 | 24 (no_coordinates 24) |
| nm000429 | v1.0.2 | 8 | 16 | 0 | 0 | 16 (no_coordinates 16) |
| nm000430 | v1.0.2 | 2 | 8 | 0 | 8 | 0 |
| nm000432 | v1.0.2 | 18 | 32 | 0 | 0 | 32 (no_coordinates 32) |
| nm000433 | v1.0.2 | 1 | 82 | 0 | 0 | 82 (no_coordinates 82) |
| nm000434 | v1.0.1 | 12 | 43 | 0 | 0 | 43 (no_coordinates 43) |
| nm000435 | v1.0.2 | 11 | 13 | 0 | 13 | 0 |
| nm000436 | v1.0.2 | 9 | 84 | 0 | 84 | 0 |
| nm000437 | v1.0.2 | 5 | 15 | 0 | 0 | 15 (no_coordinates 15) |
| nm000443 | v1.0.2 | 7 | 68 | 0 | 0 | 68 (no_coordinates 68) |
| nm000446 | v1.0.3 | 16 | 44 | 0 | 0 | 44 (no_coordinates 44) |
| nm000452 | v1.0.2 | 1 | 1 | 0 | 0 | 1 (no_coordinates 1) |
| nm000453 | v1.0.2 | 132 | 6675 | 0 | 0 | 6675 (no_coordinates 6675) |
| nm000454 | v1.0.2 | 30 | 1261 | 1261 | 0 | 0 |
| nm000455 | v1.0.2 | 30 | 32 | 0 | 31 | 1 (no_coordinates 1) |
| nm000456 | v1.0.2 | 13 | 7 | 0 | 0 | 7 (no_coordinates 7) |
| nm000460 | v1.0.2 | 1 | 7 | 0 | 0 | 7 (no_coordinates 7) |
| nm000461 | v1.0.2 | 148 | 0 | 0 | 0 | 0 |
| nm000462 | v1.0.2 | 33 | 4 | 0 | 4 | 0 |
| nm000463 | v1.0.2 | 2 | 155 | 0 | 155 | 0 |
| nm000464 | v1.0.2 | 78 | 0 | 0 | 0 | 0 |
| nm000465 | v1.0.2 | 23 | 47 | 0 | 0 | 47 (no_coordinates 47) |
| nm000469 | v1.0.2 | 1 | 2 | 0 | 2 | 0 |
| nm000471 | v1.0.2 | 11 | 22 | 0 | 0 | 22 (no_coordinates 22) |
| nm000472 | v1.0.1 | 1 | 1 | 0 | 0 | 1 (no_coordinates 1) |
| nm000473 | v1.0.2 | 10 | 10 | 0 | 10 | 0 |
| nm000475 | v1.0.2 | 3 | 9 | 9 | 0 | 0 |
| nm000476 | v1.0.2 | 5 | 14 | 0 | 0 | 14 (no_coordinates 14) |
| nm000477 | v1.0.2 | 24 | 67 | 0 | 0 | 67 (no_coordinates 67) |
| nm000480 | v1.0.3 | 11 | 11 | 0 | 11 | 0 |
| nm000481 | v1.0.2 | 14 | 14 | 0 | 11 | 3 (no_coordinates 3) |
| nm000482 | v1.0.2 | 7 | 14 | 0 | 0 | 14 (no_coordinates 14) |
| nm000483 | v1.0.2 | 1 | 5 | 0 | 5 | 0 |
| nm000484 | v1.0.2 | 1 | 1 | 0 | 0 | 1 (no_coordinates 1) |
| nm000485 | v1.0.2 | 37 | 111 | 111 | 0 | 0 |
| nm000487 | v1.0.2 | 140 | 140 | 140 | 0 | 0 |
| nm000501 | v1.0.1 | 4 | 20 | 0 | 20 | 0 |
| nm000513 | v1.0.1 | 7 | 9 | 0 | 0 | 9 (no_coordinates 9) |
| nm000537 | v1.0.2 | 11 | 46 | 0 | 0 | 46 (no_coordinates 46) |
| on001785 | v1.0.0 | 19 | 4 | 0 | 0 | 4 (unreadable 4) |
| on002799 | v1.0.0 | 26 | 0 | 0 | 0 | 0 |
| on003029 | v1.0.0 | 35 | 106 | 0 | 0 | 106 (no_electrodes_file 106) |
| on003078 | v1.0.1 | 6 | 72 | 0 | 0 | 72 (no_electrodes_file 72) |
| on003374 | v1.0.0 | 9 | 9 | 0 | 8 | 1 (no_coordinates 1) |
| on003498 | v1.0.0 | 20 | 385 | 0 | 0 | 385 (no_electrodes_file 385) |
| on003688 | v1.0.0 | 63 | 107 | 0 | 107 | 0 |
| on003708 | v1.0.0 | 1 | 1 | 1 | 0 | 0 |
| on003844 | v1.0.0 | 6 | 38 | 0 | 0 | 38 (all_zero 38) |
| on003848 | v1.0.0 | 6 | 22 | 0 | 22 | 0 |
| on003876 | v1.0.0 | 39 | 54 | 0 | 0 | 54 (no_electrodes_file 54) |
| on004080 | v1.0.0 | 74 | 117 | 117 | 0 | 0 |
| on004100 | v1.0.0 | 57 | 319 | 319 | 0 | 0 |
| on004127 | v1.0.0 | 8 | 73 | 0 | 0 | 73 (no_electrodes_file 73) |
| on004194 | v1.0.0 | 14 | 209 | 0 | 209 | 0 |
| on004370 | v1.0.0 | 7 | 15 | 0 | 15 | 0 |
| on004457 | v1.0.0 | 5 | 5 | 0 | 5 | 0 |
| on004473 | v1.0.0 | 8 | 8 | 0 | 8 | 0 |
| on004551 | v1.0.0 | 114 | 125 | 0 | 124 | 1 (no_electrodes_file 1) |
| on004624 | v1.0.0 | 3 | 614 | 0 | 614 | 0 |
| on004642 | v1.0.0 | 10 | 10 | 0 | 0 | 10 (no_electrodes_file 10) |
| on004696 | v1.0.0 | 8 | 8 | 0 | 8 | 0 |
| on004703 | v1.0.0 | 10 | 11 | 0 | 0 | 11 (no_electrodes_file 11) |
| on004752 | v1.0.0 | 15 | 68 | 0 | 68 | 0 |
| on004774 | v1.0.0 | 14 | 14 | 0 | 5 | 9 (no_electrodes_file 9) |
| on004789 | v1.0.0 | 280 | 983 | 979 | 0 | 4 (no_coordinates 4) |
| on004809 | v1.0.0 | 258 | 889 | 887 | 0 | 2 (no_coordinates 2) |
| on004819 | v1.0.0 | 1 | 8 | 0 | 0 | 8 (no_coordinates 8) |
| on004859 | v1.0.1 | 7 | 9 | 9 | 0 | 0 |
| on004865 | v1.0.0 | 49 | 172 | 172 | 0 | 0 |
| on004977 | v1.0.0 | 4 | 6 | 0 | 6 | 0 |
| on004993 | v1.0.0 | 3 | 3 | 0 | 3 | 0 |
| on005007 | v1.0.0 | 40 | 42 | 0 | 42 | 0 |
| on005059 | v1.0.0 | 72 | 282 | 282 | 0 | 0 |
| on005083 | v1.0.0 | 60 | 0 | 0 | 0 | 0 |
| on005169 | v1.0.0 | 20 | 112 | 0 | 112 | 0 |
| on005398 | v1.0.0 | 185 | 185 | 185 | 0 | 0 |
| on005411 | v1.0.0 | 48 | 193 | 193 | 0 | 0 |
| on005415 | v1.0.0 | 13 | 13 | 0 | 13 | 0 |
| on005448 | v1.0.0 | 13 | 18 | 0 | 18 | 0 |
| on005489 | v1.0.0 | 38 | 154 | 154 | 0 | 0 |
| on005491 | v1.0.0 | 19 | 51 | 51 | 0 | 0 |
| on005494 | v1.0.0 | 20 | 51 | 51 | 0 | 0 |
| on005522 | v1.0.0 | 58 | 176 | 176 | 0 | 0 |
| on005523 | v1.0.0 | 22 | 102 | 102 | 0 | 0 |
| on005545 | v1.0.0 | 106 | 336 | 0 | 336 | 0 |
| on005557 | v1.0.0 | 18 | 58 | 58 | 0 | 0 |
| on005558 | v1.0.0 | 9 | 22 | 22 | 0 | 0 |
| on005574 | v1.0.3 | 9 | 9 | 9 | 0 | 0 |
| on005624 | v1.0.0 | 24 | 35 | 0 | 0 | 35 (no_electrodes_file 35) |
| on005670 | v1.0.0 | 2 | 2 | 2 | 0 | 0 |
| on005691 | none | 0 | 0 | 0 | 0 | 0 |
| on005931 | v1.0.0 | 8 | 16 | 0 | 16 | 0 |
| on005953 | v1.0.0 | 2 | 3 | 0 | 3 | 0 |
| on006065 | v1.0.0 | 7 | 45 | 45 | 0 | 0 |
| on006107 | v1.0.0 | 166 | 167 | 0 | 167 | 0 |
| on006136 | v1.0.0 | 13 | 14 | 12 | 0 | 2 (no_coordinates 2) |
| on006233 | v1.0.0 | 108 | 347 | 0 | 347 | 0 |
| on006253 | v1.0.0 | 21 | 0 | 0 | 0 | 0 |
| on006392 | v1.0.0 | 1 | 1 | 1 | 0 | 0 |
| on006519 | v1.0.0 | 21 | 35 | 0 | 35 | 0 |
| on006890 | v1.0.0 | 2 | 870 | 0 | 870 | 0 |
| on006910 | v1.0.0 | 121 | 384 | 0 | 384 | 0 |
| on006914 | v1.0.0 | 110 | 353 | 0 | 353 | 0 |
| on007095 | v1.0.0 | 8 | 6019 | 0 | 6019 | 0 |
| on007118 | v1.0.0 | 65 | 82 | 82 | 0 | 0 |
| on007119 | v1.0.0 | 103 | 106 | 106 | 0 | 0 |
| on007120 | v1.0.0 | 65 | 70 | 70 | 0 | 0 |
| on008610 | v1.0.0 | 2 | 65 | 0 | 0 | 65 (no_coordinates 65) |

## Unresolved and anomalous

Datasets the catalog lists without a `latest_version`, so there is no tree to read (they count in the catalog total and are not classified): on005691.

None.

## Listing count against the catalog's recording count

156 of 167 datasets list exactly the catalog's `recording_count`. The others (the catalog may count recordings of other modalities in a mixed dataset):

| Dataset | Listed | Catalog |
| --- | --- | --- |
| nm000350 | 31 | 0 |
| nm000369 | 3 | 2 |
| nm000371 | 10 | 8 |
| nm000434 | 43 | 88 |
| nm000456 | 7 | 69 |
| on001785 | 4 | 54 |
| on003374 | 9 | 18 |
| on004752 | 68 | 136 |
| on004993 | 3 | 6 |
| on008610 | 65 | 0 |
| on005691 | 0 | 8 |

## Reading the numbers

- Half of all recordings (52.2 percent) cannot be drawn, almost all because the electrodes file holds only `n/a` coordinates (`no_coordinates`, 64 datasets, including large ones such as nm000183 and nm000182). Only 17.6 percent can sit on a template. The panel's refusal state is therefore the most common state, not an edge case.
- Mixed datasets are rare: 12 of 157 datasets with recordings hold more than one class (nm000253, nm000352, nm000360, nm000380, nm000455, nm000481, on003374, on004551, on004774, on004789, on004809, on006136), so the class is nearly a property of the dataset.
- 36 datasets reach `template` (the sampled audit counted 39). One difference is understood: nm000373 declares `MNI152NLin6Asym` but its units are `n/a`, so its 30 recordings are `native` with `template_units_undeclared`; the resolver never infers a unit.
- "More than one space" is counted per recording, as the panel meets it: 5 datasets offer two spaces for some recording. The sampled audit's 16 counted datasets whose different subjects use different spaces, which never meet in one recording.
- Nine datasets have no classified recording because their listings hold no `_ieeg` data entry: nm000363, nm000387, nm000390, nm000461 and nm000464 hold derived products under `ieeg/` (spike tables, ripple bands, connectivity; checked on the first subject of each), on002799, on005083 and on006253 hold electrodes, channels and events files but no `_ieeg` data entry, and nm000389's first subject has no `ieeg` directory (not checked further). The catalog's `recording_count` is 0 for all nine. A tenth, on005691, has no `latest_version` in the catalog (its `recording_count` is 8), so it was not read.
- The listings agree with the catalog's `recording_count` for 156 of 167 datasets. The 11 that differ are listed above; only on001785 was checked (its other subjects hold scalp `eeg` directories, which the catalog counts and this census does not). The census uses the listings as the record; the other ten differences were not investigated.
- on001785 is `unreadable` for its 4 recordings because its coordsystem file is not valid JSON (the IS-C1 fixture); no read for it failed transiently.
- Two datasets (nm000405, on003374) carry a `space` entity that disagrees with the declared label, which the resolver reports as an unknown frame (`undeclared (space_mismatch)` above); 11 datasets have an electrodes file and no coordsystem file (`undeclared (no_coordsystem)`). Both are `native` and `unlabeled`.

## Agreement with the IS-C1 fixtures

For every dataset committed under `test/fixtures/ieeg-geometry/`, the recordings of the committed subject were classified offline by the same code over the committed files and compared with this census's class for the same recording path (same dataset and version).
All 231 recordings agree: on005522 (4, template), nm000454 (127, template), on004100 (5, template), on005415 (1, native), nm000377 (3, native), nm000537 (3, refused `no_coordinates`), nm000405 (4, native), nm000376 (1, template), on006136 (1, template), plus nm000373 (3, native, undeclared units), nm000406 (66, refused `no_coordinates`), nm000485 (3, template), on001785 (4, refused `unreadable`), on003844 (1, refused `all_zero`), on004370 (2, native), on004457 (1, native), on004473 (1, native), on004642 (1, refused `no_electrodes_file`); on006253 has no `_ieeg` entry.

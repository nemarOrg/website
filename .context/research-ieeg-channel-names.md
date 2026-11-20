# iEEG channel names against electrode contacts (survey of 2026-11-18)

How the channel names a recording's Zarr store carries meet the contact names its electrodes file lists, and which of the differences the viewer's join may read.
The rules in `src/lib/ieeg-spatial/channel-match.ts` (card IS-J1) cite the rows below, and a pattern the survey saw without a safe reading is in `PENDING_PATTERNS` with the same row.
Dataset ids and counts only.

## What was read, and how to read it again

Every count below is printed by `bun scripts/ieeg-channel-survey.ts`, over the recordings listed in `.context/research-ieeg-channel-names-recordings.json` (dataset, version and the recording paths; about ten minutes at the polite rate).
`bun scripts/ieeg-channel-survey.ts --sample <file>` draws a fresh list by the rule below.
The data plane and the Zarr stores can change, so a later run may differ; the list pins what was read on 2026-11-18, and the reruns that day reproduced the counts exactly.

Public GET requests only, through the polite client of `scripts/ieeg-geometry-census.ts` (at most 4 in flight, 5 started per second, named user agent, retry with backoff).

- The 93 datasets the census of 2026-11-17 counts as usable (a recording that reaches `template` or `native`): the 36 and 57 of its "Datasets by best recording class" table.
  They include every dataset the census lists with more than one space (nm000473, nm000485, on004457, on004473, on005574) and every dataset whose store holds bipolar channels (18 datasets, row S2).
- Per dataset, up to six recordings taken from the dataset's Zarr index: the first, the middle, the last, and one for every distinct combination of channel group and `acq` value.
  338 recordings are listed; 328 have a store with channel labels and at least one shown space.
- Per recording: the channel labels of every channel group of its Zarr store (the group's `zarr.json`, in array-row order), and the contacts of the first shown space, resolved by `resolveRecordingGeometry`.
  That is the space the panel opens on; a recording that offers two spaces is counted once.
- A check on the joins, never a rule's input: the recording's own `_channels.tsv` (see Corroboration).
- "Channels" means name-resolved: the join is run with every contact given a position, so a channel whose contact the file leaves at `n/a` still counts, because the question here is about names.
  "Located" is the same channels joined with the positions the file gives, which is what the panel draws.
  The two differ by 914 of the 33,834 channels: 885 of S1, 19 of S2, and 10 of the rules (S5: 646 name-resolved and 638 located, the other 8 being `EKG*-20000` channels whose contacts have no position; S9: 220 and 218), and no other row.
- Names: every label and every contact name read (67,878, counted by the script) is plain ASCII: none holds a typographic prime, a non-breaking space or any other character outside printable ASCII.

The sample is large but it is a sample. A pattern absent from it is not shown to be absent from the other 3,000 or so recordings; it is shown to be absent from 328 recordings in 93 datasets.

## Patterns and counts

| Row | What the channel name does against the contact name | Channels | Located | Recordings | Datasets | Reading |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | the file's own name | 21,835 | 20,950 | 218 | 69 | `exact` |
| S2 | two contact names joined by a hyphen (a bipolar pair) | 4,436 | 4,417 | 42 | 18 | `exact`, at the midpoint |
| S3 | contact, hyphen, `AV` | 1,348 | 1,348 | 16 | 5 (on005398, on006107, on007118, on007119, on007120) | `suffix`, rule `average_reference` |
| S4 | a leading type word and one space: `POL A3` for `A3` | 778 | 778 | 8 | 3 (on004551, on005007, on005670) | `normalized`, rule `type_prefix` |
| S5 | contact, hyphen, four or more digits: `LTP1-20000` for `LTP1` | 646 | 638 | 3 | 1 (on005415) | `suffix`, rule `numeric_tail` |
| S6 | a leading type word, then a bipolar pair: `POL A1-A2` | 527 | 527 | 12 | 4 (on005545, on006233, on006910, on006914) | `normalized`, rule `type_prefix`, at the midpoint |
| S7 | contact, hyphen, `REF` or `Ref` with or without a number: `O1-REF1` | 383 | 383 | 3 | 1 (nm000379) | `suffix`, rule `reference_name` |
| S8 | whitespace inside the name: `LENT 1` for `LENT1` | 240 | 240 | 2 | 1 (on004473) | `normalized`, rule `whitespace` |
| S9 | the index written with other leading zeros: `LSF1` for `LSF01`, `el063` for `el63` | 220 | 218 | 3 | 2 (on003848, on004194) | `normalized`, rule `leading_zeros` |
| S10 | S4 then S3: `POL A1-AV` | 132 | 132 | 3 | 1 (on005931) | `suffix`, rules `type_prefix+average_reference` |
| S11 | S4 then S7: `EEG A1-Ref` | 37 | 37 | 7 | 3 (on004551, on005007, on005670) | `suffix`, rules `type_prefix+reference_name` |
| P1 | a derived copy beside the channel it came from: `AD1_rms` next to `AD1` | 412 | 0 | 6 | 1 (nm000463) | pending |
| P2 | channels numbered by position (`ch001`), contacts named by shaft | 320 | 0 | 3 | 1 (nm000377) | pending |
| P3 | letter case only: `CH1` for `Ch1`, labels from `CH0` | 192 | 0 | 6 | 1 (on004624) | pending |
| P4 | the contact index alone: `26` for `LMTG-26`, `1` for `iEEG1` | 154 | 0 | 4 | 2 (on005953, on006136) | pending |
| P5 | a prime after the shaft letter: `POL A'1` against contacts `AR1` | 150 | 0 | 1 | 1 (on005670) | pending |
| P6 | one shaft letter doubled: `mmAL1` for `mAL1`, but `DHAA01` against `DHA01` | 16 | 0 | 4 | 2 (nm000454, on003374) | pending |
| P7 | a whole lead for several contacts: `Ant` for `Ant_d10a` and the rest | 12 | 0 | 4 | 1 (nm000436) | pending |
| P8 | a dollar sign after the type word: `POL $A11` | 12 | 0 | 6 | 2 (on004551, on005007) | pending |
| P9 | a hyphen and one digit after a repeated lead: `T7-0`, `T7-1` | 4 | 0 | 1 | 1 (nm000373) | pending |
| N1 | a signal that is not a contact (ECG, trigger, marker, stimulus code, `state_*`) | 891 | 0 | 97 | 33 | not a naming problem |
| N2 | a scalp EEG lead recorded with the contacts | 240 | 0 | 21 | 12 | not a naming problem |
| N3 | a contact-like name with no row in the electrodes file | 849 | 0 | 59 | 29 | not a naming problem |

The script's own row names are the rule ids (`rule suffix:numeric_tail`) and the S1, S2, P and N labels above.
N1 to N3 are told apart by a label pattern and the Zarr channel type, a convenience for reading the table and not a rule; the line between them is approximate, the sum is not.

Before this card the viewer joined S1 and S2 only: 26,271 of the 33,834 channels (77.6 percent).
It now also joins S3 to S11, 4,311 channels (12.7 percent), in 18 datasets, of which the panel places 4,301 (the other 10 have contacts without a position); the rest is P1 to P9 (1,272 channels, 3.8 percent) and N1 to N3 (1,980 channels, 5.9 percent), which stay unlocated.
In 14 datasets the sampled recordings had no channel the old join could place and now have some, so their Brain toggle opens: nm000379, on004551, on005007, on005415, on005545, on005670, on005931, on006107, on006233, on006910, on006914, on007118, on007119, on007120.
Five datasets still place nothing in their sample: nm000377 (P2), nm000436 (P7), on004624 (P3), on006136 (P4) and on007095, whose labels (`EEG001,1+,3-`) name no contact.

## Corroboration by the dataset's own `_channels.tsv`

The survey reading of a token is only a reading until something the dataset wrote agrees with it.
For each non-exact join the script asks two questions of the recording's `_channels.tsv`: does the row at the same index as the Zarr row name the contact (a pair: both contacts joined by a hyphen), and does the file name the contact anywhere (a pair: both contacts).

| Rule row, dataset | Joins | Row-aligned | Named in the file |
| --- | --- | --- | --- |
| S5 `numeric_tail`, on005415 | 646 | 646 | 646 |
| S3 `average_reference`, on006107 | 274 | 274 | 274 |
| S3, on007118 | 381 | 381 | 381 |
| S3, on007119 | 214 | 214 | 214 |
| S3, on007120 | 288 | 288 | 288 |
| S3, on005398 | 191 | 0 | 0 |
| S9 `leading_zeros`, on004194 | 209 | 209 | 209 |
| S9, on003848 | 11 | 0 | 0 |
| S4 `type_prefix`, on004551 | 338 | 24 | 338 |
| S4, on005007 | 204 | 1 | 204 |
| S4, on005670 | 236 | 0 | 0 |
| S6 `type_prefix` (pairs), on005545, on006233, on006910, on006914 | 527 | 0 | 527 |
| S10 `type_prefix+average_reference`, on005931 | 132 | 2 | 132 |
| S11 `type_prefix+reference_name`, on004551 | 6 | 6 | 6 |
| S11, on005007 | 9 | 0 | 9 |
| S11, on005670 | 22 | 0 | 0 |
| S7 `reference_name`, nm000379 | 383 | 0 | 0 |
| S8 `whitespace`, on004473 | 240 | 0 | 0 |

- The dataset's own file agrees with the join, row for row, for S5 (646 of 646: the `_channels.tsv` row at the Zarr row's index names the contact the rule joined, in all three sampled recordings of on005415) and for the `-AV` channels of on006107, on007118, on007119 and on007120 (1,157 of 1,157), and for on004194's padded indexes (209 of 209).
  That is documented evidence for the numeric tail (S5) and for `-AV` as a naming of the same channel (S3) in four of its five datasets; nothing in the dataset says what either token means (`iEEGReference` is `n/a` in the first listed recording of on005415, on005398, on006107, on007118, on007119 and on007120), and the rules say only what the name does.
- Where row order does not align, the contact is still named somewhere in the file for every join of S4 in on004551 and on005007, S6 in all four datasets, S10 in on005931 and S11 in on005007: 1,183 joins are corroborated by the contact's presence in the dataset's own channel list, not by its position in it (the Zarr store lists extra channels first, such as `EEG A1-Ref`, and the bipolar stores list pairs where the file lists contacts).
- The check is silent, and the join rests on the survey reading alone, where the dataset's `_channels.tsv` repeats the store's label (S7 nm000379 `O1-REF1`, S8 on004473 `LENT 1`, S3 on005398 `A1-AV`, on005670 sub-02, on003848) or is absent (on005670 sub-01).
  That is 1,083 of the 4,311 non-exact joins; 3,228 (74.9 percent) have the contact in the dataset's own channel list, and 2,045 (47.4 percent) at the same row.
  The script does not look for a `_channels.tsv` row that names a different contact, so "nothing contradicts" is not claimed.

## The rules, each from its rows

- `whitespace` (S8): the name with its whitespace removed is exactly one contact.
- `type_prefix` (S4, S6, S10, S11): `EEG ` or `POL ` and the rest of the name is a contact, or a pair of contacts.
  Both words are in the survey (`POL` in 8 datasets, `EEG` with `-Ref` in 3); `SEEG ` is not, so it is not read (see below).
- `leading_zeros` (S9): the same shaft and the same index digits once the zeros in front of them are removed, on either side; the zero-tolerant reading is tried only when the exact one finds nothing.
  The zeros must be padding: with contacts `L1` and `L0`, the name `L01` could be shaft `L0` and index 1, so it joins nothing.
- `reference_name` (S7, S11): the name ends in a hyphen and `REF` or `Ref` (any case, with or without digits), read as a reference, and what is left is one contact.
- `average_reference` (S3, S10): the name ends in `-AV`, read as the average reference, and what is left is one contact.
- `numeric_tail` (S5): the name ends in a hyphen and four or more digits, and what is left is one contact.
  Fewer digits stay unread because `A1-2` is a bipolar pair in short form (row P9's `T7-1` is the same shape).
  When the shaft with the tail's digits as its index is itself a contact, the name reads two ways and joins nothing.
  Every channel of the three sampled recordings carries one (188 of 188, 266 of 266 and 224 of 224), no tail is a contact index, and the corroboration above is complete.
- The bipolar split keeps its priority: when both halves of a hyphenated name are contacts the name is a pair, and no suffix rule is tried.
  nm000360's `LA3-LA4` (`LA4` has no row) is never read as `LA3` plus a tail.
- An exact name keeps its contact: a channel that reaches the same contact through a lower tier, or two differently written channels that reach it through the same non-exact tier, are all refused (`duplicate_contact`).
  A bipolar pair is claimed the same way (`POL A1-A2` does not take the pair that `A1-A2` already holds), and two exact channels on one pair (`A1-A2` and `A2-A1`) both stay, as they do today.
  No surveyed recording needs a claim today; P1 is where it would bite if a rule read `_rms`.

## Why a pattern is pending

- P1: the copy is a computed signal, not a recording of the contact; the original channel owns the contact in every one of the six sampled recordings.
- P2: the channel name carries no part of the contact name; a join would rest on row order.
- P3: the labels are `CH0` to `CH31` (32 channels, plus four `state_*` channels, 36 in all) against contacts `Ch1` to `Ch32`, so the labels count from 0 and the file from 1; folding case would pair `CH1` with `Ch1` when it may be the second contact, wrong for `CH1` to `CH31`.
  The four `state_*` channels are signals (N1).
- P4: no shaft in the name; the contact that ends in the same number is a guess.
- P5: the prime and the contacts' `R` are two notations for a side, and the dataset states neither.
- P6: the edit is right in on003374 (four channels, one contact each) and wrong in nm000454, where `DHAA` is a real shaft that the file lacks and `DHA01` to `DHA04` are another shaft's contacts.
  No rule separates the two, so none is implemented (the card's stop condition).
  The `close` tier exists, with its tag and wording, and a guard that lets only one removed shaft letter with the same index through; its rule table is empty.
  Its marker is opacity, which is overridden while anything is selected (the other contacts are dimmed, the selected one is drawn in full), so the first close rule must add a cue that is not opacity; the text cues (the row's tag, the status line and the title) stay at all times.
- P7: one channel, several contacts.
- P8 and P9: the marker and the digit have no stated meaning.
- Never seen: a leading `SEEG ` (no label starts with it), a typographic lookalike (no name outside ASCII) and a one-letter difference that is not a doubled letter (the pairs one edit apart that do occur are left and right shafts, `AL` and `AR`).
  All three are listed in `PENDING_PATTERNS` with the reason and no dataset, so a dataset that shows one has a place to start.

## What the census would change

Nothing in its class counts or reason words.
`scripts/ieeg-geometry-census.ts` classifies a recording by its geometry (`template`, `native`, `refused`), and the join is not part of that.
The census was therefore not edited and not rerun: not run, would check: census rerun, because it takes about two hours; expected result, every class and reason count unchanged.

## Addendum 2026-11-20: the renamed channels of the fix-20261018 pull requests

Owner decision of 2026-11-20: the collaborators' renames are kept (channels.tsv names follow the recording headers; electrodes.tsv keeps the contact names), and NEMAR maps the names.
The type word is read in upper case only (`EEG`, `POL`); no dataset writes another case, so `pol A3` and `Eeg A3` stay unread.
The rows below are new forms of the existing S-rows, measured on the eight datasets' pull request branches; the counts are electrodes reached over every channels file of the dataset that has an electrodes file beside it (`sourcedata/` and `derivatives/` skipped), before and after this change.
The real name columns of eleven recordings are committed under `test/fixtures/ieeg-channel-renames/`, with the join each channel gets in `_expected-joins.json` (digest pinned in `channel-rename.test.ts`).

| Row | What the channel name does against the contact name | Datasets | Electrodes reached, before then after | Reading |
| --- | --- | --- | --- | --- |
| S12 | `EEG` run into the shaft letter: `EEGGA_01REF` for `GA01` | on004194 | 28,274 then 33,306 (with S13 and S14) | `normalized`, rule `type_prefix` |
| S13 | `REF` right after the index, no hyphen: `EEGGA_01REF`, `DC1REF` | on004194 | included in the row above | `suffix`, rule `reference_name` |
| S14 | an underscore after the shaft letters before the index: `G_03` for `G03` (an underscore after a digit is part of the name: `G1_2` is not `G12`) | on004194 | included in the row above | `normalized`, rule `leading_zeros` |
| S15 | a bipolar pair whose halves lack the contacts' zeros: `POL B1-B2` for `B01` and `B02` | on005545 (also on006233 and on006914, whose rise of 42 each is attributed to this rule) | on005545 16,944 then 17,154; on006233 17,264 then 17,306; on006914 17,376 then 17,418 | `normalized`, rule `type_prefix+leading_zeros`, at the midpoint |

Unchanged by the addendum: S4 and S11 (`POL A3`, `EEG A1-Ref`) and S10 (`POL A1-AV`) already joined on on004551, on005007, on005931 and on006107 (13,739 of 13,788, 3,337 of 3,388, 862 of 1,724 and 17,795 of 17,812 electrodes reached); the contacts left out are `POL $A..` (P8, still pending) and contacts no channel names.
The check for a wrong join over all eleven recordings: every joined channel's shaft letters equal its contact's (per half for a pair), and no two differently written channels hold one contact.

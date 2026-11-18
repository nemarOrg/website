# iEEG channel names against electrode contacts (survey of 2026-11-18)

How the channel names a recording's Zarr store carries meet the contact names its electrodes file lists, and which of the differences the viewer's join may read.
The rules in `src/lib/ieeg-spatial/channel-match.ts` (card IS-J1) cite the rows below, and a pattern the survey saw without a safe reading is in `PENDING_PATTERNS` with the same row.
Dataset ids and counts only.

## What was read

Public GET requests only, through the polite client of `scripts/ieeg-geometry-census.ts` (at most 4 in flight, 5 started per second, named user agent, retry with backoff).

- The 93 datasets the census of 2026-11-17 counts as usable (a recording that reaches `template` or `native`): the 36 and 57 of its "Datasets by best recording class" table.
  They include every dataset the census lists with more than one space (nm000473, nm000485, on004457, on004473, on005574) and every dataset whose store holds bipolar channels (18 datasets, row S2).
- Per dataset, up to six recordings taken from the dataset's Zarr index: the first, the middle, the last, and one for every distinct combination of channel group and `acq` value.
  338 recordings were sampled; 328 have a store with channel labels and at least one shown space.
- Per recording: the channel labels of every channel group of its Zarr store (the group's `zarr.json`, in array-row order), and the contacts of the first shown space, resolved by `resolveRecordingGeometry`.
  That is the space the panel opens on; a recording that offers two spaces is counted once.
- Context only, never a rule's input: the recording's `_channels.tsv` names and types, and each store's `units_report` in the Zarr index.
- Names only. A contact with no position is not told apart here (`no_position` is the panel's, per contact).
- Every label and every contact name read (69,806) is plain ASCII: none holds a typographic prime, a non-breaking space or any other character outside printable ASCII.

The sample is large but it is a sample. A pattern absent from it is not shown to be absent from the other 3,000 or so recordings; it is shown to be absent from 328 recordings in 93 datasets.
The counts are of channels in those 328 recordings (33,834), by the viewer's own `joinChannels` before and after this card.

## Patterns and counts

| Row | What the channel name does against the contact name | Channels | Recordings | Datasets | Reading |
| --- | --- | --- | --- | --- | --- |
| S1 | the file's own name | 21,835 | 216 | 69 | `exact` |
| S2 | two contact names joined by a hyphen (a bipolar pair) | 4,436 | 41 | 18 | `exact`, at the midpoint |
| S3 | contact, hyphen, `AV` (the average reference) | 1,348 | 16 | 5 (on005398, on006107, on007118, on007119, on007120) | `suffix`, rule `average_reference` |
| S4 | a leading type word and one space: `POL A3` for `A3` | 778 | 8 | 3 (on004551, on005007, on005670) | `normalized`, rule `type_prefix` |
| S5 | contact, hyphen, four or more digits: `LTP1-20000` for `LTP1` | 646 | 3 | 1 (on005415) | `suffix`, rule `numeric_tail` |
| S6 | a leading type word, then a bipolar pair: `POL A1-A2` | 527 | 11 | 4 (on005545, on006233, on006910, on006914) | `normalized`, rule `type_prefix`, at the midpoint |
| S7 | contact, hyphen, a named reference: `O1-REF1`, `A1-Ref` | 383 | 3 | 1 (nm000379) | `suffix`, rule `reference_name` |
| S8 | whitespace inside the name: `LENT 1` for `LENT1` | 240 | 2 | 1 (on004473) | `normalized`, rule `whitespace` |
| S9 | the index written with other leading zeros: `LSF1` for `LSF01`, `el063` for `el63` | 220 | 3 | 2 (on003848, on004194) | `normalized`, rule `leading_zeros` |
| S10 | S4 then S3: `POL A1-AV` | 132 | 3 | 1 (on005931) | `suffix`, rules `type_prefix+average_reference` |
| S11 | S4 then S7: `EEG A1-Ref` | 37 | 7 | 3 (on004551, on005007, on005670) | `suffix`, rules `type_prefix+reference_name` |
| P1 | a derived copy beside the channel it came from: `AD1_rms` next to `AD1` | 412 | 6 | 1 (nm000463) | pending |
| P2 | channels numbered by position (`ch001`), contacts named by shaft | 320 | 3 | 1 (nm000377) | pending |
| P3 | letter case only: `CH1` for `Ch1`, labels from `CH0` | 216 | 6 | 1 (on004624) | pending |
| P4 | the contact index alone: `26` for `LMTG-26`, `1` for `iEEG1` | 154 | 4 | 2 (on005953, on006136) | pending |
| P5 | a prime after the shaft letter: `POL A'1` against contacts `AR1` | 150 | 1 | 1 (on005670) | pending |
| P6 | one shaft letter doubled: `mmAL1` for `mAL1`, but `DHAA01` against `DHA01` | 16 | 4 | 2 (nm000454, on003374) | pending |
| P7 | a whole lead for several contacts: `Ant` for `Ant_d10a` and the rest | 12 | 4 | 1 (nm000436) | pending |
| P8 | a dollar sign after the type word: `POL $A11` | 12 | 6 | 2 (on004551, on005007) | pending |
| P9 | a hyphen and one digit after a repeated lead: `T7-0`, `T7-1` | 4 | 1 | 1 (nm000373) | pending |
| N1 | a signal that is not a contact (ECG, trigger, marker, stimulus code) | 873 | 92 | 33 | not a naming problem |
| N2 | a scalp EEG lead recorded with the contacts | 268 | 21 | 12 | not a naming problem |
| N3 | a contact-like name with no row in the electrodes file | 815 | 53 | 27 | not a naming problem |

Before this card the viewer joined S1 and S2 only: 26,271 of the 33,834 channels (77.6 percent).
It now also joins S3 to S11, 4,311 channels (12.7 percent), in 18 datasets; the rest is P1 to P9 (1,296 channels, 3.8 percent) and N1 to N3 (1,956 channels, 5.8 percent), which stay unlocated.
In 14 datasets the sampled recordings had no channel the old join could place and now have some, so their Brain toggle opens: nm000379, on004551, on005007, on005415, on005545, on005670, on005931, on006107, on006233, on006910, on006914, on007118, on007119, on007120.
Five datasets still place nothing in their sample: nm000377 (P2), nm000436 (P7), on004624 (P3), on006136 (P4) and on007095, whose labels (`EEG001,1+,3-`) name no contact.

## The rules, each from its rows

- `whitespace` (S8): the name with its whitespace removed is exactly one contact.
- `type_prefix` (S4, S6, S10, S11): `EEG ` or `POL ` and the rest of the name is a contact, or a pair of contacts.
  Both words are in the survey (`POL` in 8 datasets, `EEG` with `-Ref` in 3); `SEEG ` is not, so it is not read (see below).
- `leading_zeros` (S9): the same shaft and the same index digits once the zeros in front of them are removed, on either side; the zero-tolerant reading is tried only when the exact one finds nothing.
- `reference_name` (S7, S11): the name ends in a hyphen and `REF` or `Ref` (any case, with or without digits), and what is left is one contact.
- `average_reference` (S3, S10): the name ends in `-AV`, and what is left is one contact.
- `numeric_tail` (S5): the name ends in a hyphen and four or more digits, and what is left is one contact.
  Fewer digits stay unread because `A1-2` is a bipolar pair in short form (row P9's `T7-1` is the same shape).
  When the shaft with the tail's digits as its index is itself a contact, the name reads two ways and joins nothing.
  The meaning of the tail is not stated by the dataset (`iEEGReference` is `n/a`); the rule rests on the survey: 188 of 188, 266 of 266 and 224 of 224 channels of the three sampled recordings carry one, and no tail is a contact index.
- The bipolar split keeps its priority: when both halves of a hyphenated name are contacts the name is a pair, and no suffix rule is tried.
  nm000360's `LA3-LA4` (`LA4` has no row) is never read as `LA3` plus a tail.
- An exact name keeps its contact: a channel that reaches the same contact through a lower tier, or two differently written channels that reach it through the same non-exact tier, are all refused (`duplicate_contact`).
  No surveyed recording needs it today; P1 is where it would bite if a rule read `_rms`.

## Why a pattern is pending

- P1: the copy is a computed signal, not a recording of the contact; the original channel owns the contact in every one of the six sampled recordings.
- P2: the channel name carries no part of the contact name; a join would rest on row order.
- P3: the labels run `CH0` to `CH35` against contacts `Ch1` to `Ch32`, so the numbering may differ by one; folding case could pair `CH1` with the wrong contact.
- P4: no shaft in the name; the contact that ends in the same number is a guess.
- P5: the prime and the contacts' `R` are two notations for a side, and the dataset states neither.
- P6: the edit is right in on003374 (four channels, one contact each) and wrong in nm000454, where `DHAA` is a real shaft that the file lacks and `DHA01` to `DHA04` are another shaft's contacts.
  No rule separates the two, so none is implemented (the card's stop condition).
  The `close` tier exists, with its distinct marker and its wording, and a guard that lets only one removed shaft letter with the same index through; its rule table is empty.
- P7: one channel, several contacts.
- P8 and P9: the marker and the digit have no stated meaning.
- Never seen: a leading `SEEG ` (no label starts with it), a typographic lookalike (no name outside ASCII among 69,806) and a one-letter difference that is not a doubled letter (the pairs one edit apart that do occur are left and right shafts, `AL` and `AR`).
  All three are listed in `PENDING_PATTERNS` with the reason and no dataset, so a dataset that shows one has a place to start.

## What the census would change

Nothing in its class counts or reason words.
`scripts/ieeg-geometry-census.ts` classifies a recording by its geometry (`template`, `native`, `refused`), and the join is not part of that.
The census was therefore not edited and not rerun: not run, would check: census rerun, because it takes about two hours; expected result, every class and reason count unchanged.

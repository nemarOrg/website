# Changelog

All notable changes to the NEMAR website are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioning follows
[Semantic Versioning](https://semver.org/).

This file starts at `0.2.15`. For prior releases, see
[GitHub Releases](https://github.com/nemarOrg/website/releases), which
`release.yml` has generated automatically for every tag since `v0.2.0`.

## [Unreleased]

## [0.2.15] - 2026-09-21

### Added

- UCSD Library and EZID logos in the footer's sponsors and partners row,
  using the same colorable-on-hover treatment as the other partner marks
  (#336, #337).

### Fixed

- The NIH footer logo was actually a mismatched NIH Intramural Research
  Program lockup with dead paths left over from editing, not the NIH
  institutional mark. Replaced with a clean vector of the correct mark,
  matched against NIH's own NCBI style guide colors, and switched to the
  same monochrome-by-default / true-color-on-hover behavior as the other
  partner logos (#337, #338).

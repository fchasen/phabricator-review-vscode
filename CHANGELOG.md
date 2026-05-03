# Changelog

All notable changes to the Mozilla Phabricator extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.2] - 2026-05-02

### Added
- Activity-bar badge counting revisions that need your attention (your reviews requested, your revisions accepted, or your revisions needing changes).
- Searchfox toolbar buttons in the Remarkup composer for inserting links to Mozilla Central files (path) and identifiers (symbol). Requires `searchfox-cli` on `PATH`.
- Inline reply composer for diff comments.
- Revision file diffs rendered with `@pierre/diffs`.
- In-place editing for revision title and summary.

### Changed
- Sidebar revision rows show the title as the label and the monogram (e.g. `D123456`) as the description; the status badge text was removed because the status icon already conveys it.
- Overview header moved the monogram out of the `<h1>` and into the status row, between the status badge and `by {author}`.

## [0.0.1] - Initial development

- Sign in via a Conduit API token; secrets persist in `SecretStorage`.
- Browse revisions split into "My Active", "Needs My Review", "Subscribed", and "Recently Closed".
- Open a revision overview with summary, test plan, reviewers, files, and activity timeline.
- Diff editor for each changed file via the `phab://` URI scheme.
- Inline comment threads on diffs (read, reply, mark done).
- Submit a local git commit as a new revision or as an update to an existing one.
- Remarkup composer with toolbar formatting, `@user`/`#project` autocomplete, and a Searchfox link picker.

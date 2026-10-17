# Jev sheet structure cache

Epic #512 work B extends this foundation for read-only search. See
[the current snapshot contract and review](sheet-snapshot.md) for the complete
48-column, SID/status, description and immutable-reference contract.

The sheet router uses the source CSV snapshot as its schema boundary. The
legacy `sheetInfo` value remains the compact TSV used by the existing answer
path. A structured snapshot is derived from the same parsed rows and is stored
alongside it in the existing `sheet_info:v2:<sourceFingerprint>` KV entry.

## Contract

- `catalogVersion: 2` identifies the 48-column catalog (the former 44 plus four
  source metadata columns).
- `schemaVersion: 2` identifies the serialized snapshot shape, including
  one-based `sourceRowNumbers`.
- The snapshot keeps the first three metadata/header rows and person rows in
  catalog order. Values are kept before TSV sanitization so identity indexes
  can preserve nickname separators and embedded line breaks.
- The legacy TSV and structured snapshot share one CSV parse and the same row
  retention rule (the first three rows plus data rows with at least two
  non-empty cells).
- `availableYears` contains only election columns with at least one positive
  integer rank in a retained person row. `latestDataYear` is the last such
  year, or `null`.
- The source fingerprint and 300-second KV TTL remain unchanged.

## Compatibility and migration

Entries written before this field existed remain readable as legacy entries.
`getSheetDataStep` refreshes a legacy entry once so that a new snapshot is
available. If refresh fails, the legacy TSV is returned and the structured
route treats the snapshot as unavailable. The legacy data is written back with
an `invalid_snapshot` sentinel so subsequent requests use the fallback without
repeating the failed Sheets call during the 300-second TTL. Malformed
structured data follows the same refresh path; it is never interpreted as a
different column.

Schema validation rejects missing/shifted anchors, renamed anchors, and
schemas shorter than the catalog. Source column 6 is now retained as the
year-unspecified `latest_rank`; source columns 0–2 retain identity/status/sort. A
trailing unrelated source column is safe because it cannot shift a catalog
index.

Election headings, source indexes, and valid election years are derived from
the typed column catalog rather than maintained as separate numeric ranges.
Columns whose live metadata/header cells are blank are additionally checked
against conservative person-value shapes (for example pinyin versus age).
Schema validation requires at least 80% of the non-placeholder values in each
such column to match, so an isolated display variant does not invalidate the
whole snapshot while a physical column swap still fails closed. Birthday must
not be later than debut for at least 80% of rows where both years are present.
A mismatch makes the structured snapshot unavailable while preserving the
legacy TSV fallback.

Legacy-cache refresh telemetry records the Sheets attempt independently from
the data source. A failed refresh therefore remains a KV cache hit for the
returned TSV while also emitting a failed Sheets API metric.

The cache-size regression fixture serializes 500 people by 48 columns. It caps
the complete legacy-TSV-plus-structure entry at 4 MiB and the structured
snapshot increment at 2 MiB as explicit project budgets, preventing unbounded
duplication as the catalog evolves.

When the serialized meaning changes, increment `schemaVersion` or
`catalogVersion` and add a compatibility test. Do not change the cache prefix
or delete old entries as a migration mechanism.

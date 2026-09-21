# Jev sheet structure cache

The sheet router uses the source CSV snapshot as its schema boundary. The
legacy `sheetInfo` value remains the compact TSV used by the existing answer
path. A structured snapshot is derived from the same parsed rows and is stored
alongside it in the existing `sheet_info:v2:<sourceFingerprint>` KV entry.

## Contract

- `catalogVersion: 1` identifies the 44-column catalog.
- `schemaVersion: 1` identifies the serialized snapshot shape.
- The snapshot keeps the first three metadata/header rows and person rows in
  catalog order. Values are kept before TSV sanitization so identity indexes
  can preserve nickname separators and embedded line breaks.
- `availableYears` contains only election columns with at least one positive
  integer rank in a retained person row. `latestDataYear` is the last such
  year, or `null`.
- The source fingerprint and 300-second KV TTL remain unchanged.

## Compatibility and migration

Entries written before this field existed remain readable as legacy entries.
`getSheetDataStep` refreshes a legacy entry once so that a new snapshot is
available. If refresh fails, the legacy TSV is returned and the structured
route treats the snapshot as unavailable. Malformed structured data follows
the same refresh path; it is never interpreted as a different column.

Schema validation rejects missing/shifted anchors, renamed anchors, and
schemas shorter than the catalog. Source column 6 is intentionally outside the
44-column contract even though the live sheet may contain values there. A
trailing unrelated source column is safe because it cannot shift a catalog
index.

When the serialized meaning changes, increment `schemaVersion` or
`catalogVersion` and add a compatibility test. Do not change the cache prefix
or delete old entries as a migration mechanism.

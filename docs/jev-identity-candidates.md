# Jev identity candidates

The Jev B state receives person candidates found by a local dictionary search
over the structured sheet snapshot (`docs/jev-sheet-structure.md`). This is not
NER: an unknown spelling yields no candidate, and the search never calls Jev,
the answer LLM, or any other external service. It does not log. Zero
candidates is a normal result and selects the A state.

Code: `src/routing/identityIndex.ts` (dictionary) and
`src/routing/identityCandidates.ts` (search).

## Dictionary

- Sources are only the four identity columns: `full_name`, `pinyin`,
  `initials`, and `community_nicknames`. Official nicknames, English names,
  affiliations, generations, ages, and other attributes are never indexed.
- Community nicknames are split on `<br>`, line breaks, `/`, `／`, `,`, `，`,
  `、`, `;`, `；`, `|`, and `｜`. Blank and placeholder values are dropped.
- Spellings are normalized with Unicode NFKC, lower-cased, and whitespace
  (including full-width spaces) is collapsed and trimmed. Pinyin is indexed
  both with and without spaces. The original question is kept separately for
  the answer prompt.
- Each person is identified by `personIndex` (position in `personRows`), so
  people who share a full name are never merged.
- The index is built from one snapshot per request and holds no global
  mutable state.

## Exact matching

1. Every occurrence of every dictionary spelling in the normalized question is
   collected.
2. Latin/digit spellings must not be adjacent to another Latin letter or digit
   (`youtube` does not match `you`).
3. Single-character spellings (for example one kanji or one Latin letter) are
   flagged `ambiguousShortForm` and require a name context: quoted, the whole
   question (optionally followed by `は`, `って`, `は誰`, `って誰`), or not
   preceded by kanji/katakana and followed by punctuation, the end of the
   question, or a particle/honorific (`って`, `さん`, `ちゃん`, `くん`, `の`, `と`,
   `は`, `が`, `も`, `に`, `を`, `や`). `赤の名前` matches; `赤色` and `C言語` do
   not.
4. A spelling in `COMMON_ENGLISH_WORDS` is ignored in an English-dominant
   question (at least half of the letters are Latin) unless it is directly
   followed by a Japanese particle, quoted, or the whole question. `youと赤`
   keeps `you`; `can you explain why 16:9 is called 16:9?` has no candidate.
5. Overlapping matches keep the longest span (earliest start on a tie).
   Matches on the identical span are all kept, so shared names and shared
   nicknames still produce every person.
6. The same person, spelling, and span is reported once, preferring
   `full_name`, then `community_nicknames`, `initials`, and `pinyin`.

## Name-search matching

Partial and approximate matches run only when there is no exact candidate and
the question explicitly asks for a similar name (`みたいな名前`, `ような名前`,
`似た名前`, `に似てる名前`, `っぽい名前`, or `name like ...`).

- The fragment is the at most 20 characters next to the expression.
- Non-Latin fragments (at least 2 characters, longest suffix first) match full
  names and nicknames that contain them (`partial`).
- Latin fragments of 3–20 characters are compared with Latin full names,
  pinyin, and nicknames (spaces removed, 3–20 characters). A prefix of at least
  4 characters is `partial`; a Levenshtein distance of at most 1 is
  `approximate`. Initials are excluded. The distance check is linear.
- Ordinary questions never use partial or approximate matching.

## Output and limit

Each candidate carries the matched question text, the full name as an
identifier, the source column, the method, and the ambiguity flag. `span` and
`personIndex` are internal. Candidates are sorted by method, unambiguous before
ambiguous, source, longer match, earlier position, full name, and
`personIndex`, then truncated to 8 (`IDENTITY_CANDIDATE_LIMIT`).
`overflowCount` is diagnostic. The limit only bounds the Jev state; it never
narrows the rows given to the answer LLM.

## Non-goals

Resolving unknown nicknames, inferring names or attributes, extra NER or LLM
calls, and dictionary maintenance are out of scope. Candidate quality has not
been measured as precision/recall.

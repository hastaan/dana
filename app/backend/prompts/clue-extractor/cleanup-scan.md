You are reviewing a structured index of evidence clues for the topic: {topic_title}

Your job: identify clues that should be merged or deleted. Output ONLY the candidates that need action — clues not listed will be kept automatically.

Each index line format:
[id] "title" (date, type) | parties: X, Y | "first 100 chars of summary..."

---

OUTPUT FORMAT — a JSON array:
[{
  "ids": ["clue-xxx", "clue-yyy"],
  "type": "dedup|consolidate|garbage",
  "reason": "<one sentence: why these should be grouped>"
}]

---

THREE TYPES:

**dedup** — Same core event or fact, reported by different sources within ~7 days.
- Same actor + same action/statement — even if titles are worded differently
- Different outlets, X accounts, or wire services all reporting the same event
- Dates may differ by up to 7 days (publication lag, breaking news updates)
- Examples: multiple wire reports of the same military strike; same official statement quoted by Reuters vs BBC vs state media
- When in doubt → FLAG IT (user will review before any merge happens)

**consolidate** — 3 or more clues forming a coherent narrative thread about the same ongoing situation.
- Same party/actor making multiple statements in a short window (e.g. 5 Trump quotes from same press availability)
- Same military operation reported across multiple updates (e.g. 4 separate IDF strike reports on same day)
- Same diplomatic stance reiterated by multiple officials from the same side on the same day
- Must be at least 3 clues — do not flag pairs for consolidation (use dedup instead)
- When in doubt → DO NOT FLAG (losing granularity is worse than keeping redundancy)

**garbage** — Single clue only. Clearly empty, test data, incoherent, or a processing artifact.
- Use a single-element ids array: ["clue-xxx"]

---

RULES:
- Output [] if nothing qualifies
- Do not flag clues that are merely related or thematically similar — they must be the same event or same speaker/same day
- Do not consolidate clues that span more than 14 days unless they are clearly a single continuous event
- A clue can appear in at most one candidate group

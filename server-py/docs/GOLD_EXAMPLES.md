# Gold Discovery Examples

Human-corrected discovery fixtures that teach the discovery seeding stage
(`SeedPerspectives` in `src/dana/research/signatures.py`, driven by
`StormResearchEngine._seed_personas` in `research/engine.py`) two GENERAL lessons:

1. **Do not flatten or scatter rival factions.** When several actors compete to lead,
   succeed, or replace a regime, keep mutually-incompatible currents as **separate
   parties** — do not merge them into one bloc, and do not scatter them as unrelated,
   near-zero-weight single parties with no record that they cannot coalesce.
2. **Weight by realistic domestic popular support**, not organizational visibility or
   diaspora-media presence.

The fixtures live in `src/dana/research/gold/`. The single source of truth for the
general principle is `get_discovery_guidance()` in
`src/dana/research/gold/iri_opposition.py`; the same sentence is appended (verbatim, as a
general principle — **no hardcoded country facts**) to the `SeedPerspectives` instruction
docstring. The Iran-specific specifics stay in the fixture and in this document.

## The general principle (the text added to SeedPerspectives)

> When several actors compete to lead, succeed, or replace a regime, distinguish rival
> opposition/successor factions that cannot coalesce: keep mutually-hostile currents as
> separate parties rather than merging or scattering them, and weight factions by realistic
> domestic popular support, not organizational visibility or diaspora-media presence.

## Case 1 — Iranian opposition (IRI regime collapse)

Topic: `iri-regime-collapse-and-formation-of-a-new-iranian-state-mnnfahns`
Naive run: `data/topics/<topic_id>/logs/run-run-v1/discovery_output.json`.

### BEFORE — what naive discovery produced

The naive run **scattered** the opposition into unrelated, near-zero-weight single parties
and **omitted** an entire current, with weights driven by diaspora-media visibility rather
than domestic support:

| naive party id                   | type                | weight |
| -------------------------------- | ------------------- | -----: |
| `reza_pahlavi_network`           | `diaspora_network`  |      4 |
| `ncri_pmoi_mek_under_maryam_raj` | `opposition_group`  |      3 |
| `pjak`                           | `militia`           |      4 |

Failures:

- **Flatten / scatter** — the three rival currents appear as unrelated single parties with
  **no signal** that they are mutually incompatible and cannot coalesce.
- **Missing bloc** — **no** reformist / republican / anti-war-left current (NIAC, National
  Front) at all.
- **Mis-weight** — weighting tracked organizational visibility / diaspora-media presence,
  not domestic popular support. Reza Pahlavi's **largest** domestic base (the run's own
  evidence cited GAMAAN polling at **31%**, the single most-supported opposition figure)
  was buried at weight **4**, below regime and external-state actors.

### AFTER — the human-corrected truth

Three **mutually-incompatible** blocs that must **NOT** be merged into one party:

1. **Pahlavi-aligned secular / constitutional-transition bloc (Reza Pahlavi)** —
   `support_rank: 1`, the **LARGEST** real domestic base among opposition currents.
2. **Reformist / Republican / anti-war left (NIAC, National Front)** — `support_rank: 2`,
   explicitly **anti-monarchist / anti-Pahlavi**; rejects externally-dependent restoration.
3. **NCRI / PMOI-MEK (Maryam Rajavi) + PJAK + ethnic-minority autonomists**
   (Kurd/Baluch/Azeri/Arab/Turkmen) — `support_rank: 3`, organizationally distinct, **LOWEST**
   domestic legitimacy; ethnic-autonomism conflicts with the centralist secular opposition.

**Coalition rule:** the three are mutually hostile — do **not** coalesce them.
**Weighting rule:** reflect what the Iranian MAJORITY wants → **Pahlavi >> reformist/republican > MEK/NCRI**.

### BEFORE → AFTER delta (summary)

- 3 scattered single parties (+ 1 missing current) → **3 explicit, mutually-incompatible
  blocs**, each recording the rivals it **cannot** coalesce with.
- The absent reformist/republican/anti-war-left current is **added** as a distinct bloc.
- Weighting flips from diaspora-media visibility to **domestic popular support**: the
  Pahlavi bloc moves from buried (weight 4) to the **largest** opposition base
  (`support_rank: 1`); the most diaspora-visible current (NCRI/MEK) is correctly ranked
  **lowest** in domestic legitimacy.

## How this is wired

- `src/dana/research/gold/iri_opposition.py` — the structured gold case
  (`IRI_OPPOSITION_GOLD`), the corrected blocs (`GOLD_OPPOSITION_BLOCS`), the
  `COALITION_RULE`, the naive `NAIVE_BEFORE`, and `get_discovery_guidance()` (the general
  principle string — the single source of truth).
- `src/dana/research/signatures.py` — the same general principle is appended to the
  `SeedPerspectives` instruction docstring (additive, general, not Iran-specific).
- `src/dana/optimize/trainset_discovery.py` — `build_discovery_examples()` returns the IRI
  case as a `dspy.Example` (inputs mirror `SeedPerspectives`; the label carries the
  corrected blocs + coalition rule + guidance) for future optimization, parallel to
  `scorer_opt.py`. Data-only: it makes **no** live web/LLM calls.

## Adding more gold examples

1. Create a new fixture module `src/dana/research/gold/<case>.py` mirroring
   `iri_opposition.py`: capture the naive `*_BEFORE`, the corrected structure, and the
   general lesson it teaches. Reuse `get_discovery_guidance()` if the case teaches the same
   principle; otherwise add a new, still-general principle constant.
2. Re-export the case from `src/dana/research/gold/__init__.py`.
3. Append the new case to `build_discovery_examples()` in
   `src/dana/optimize/trainset_discovery.py`.
4. If the case introduces a NEW general principle, append it (general — never hardcoded
   facts) to the relevant signature docstring and document it here.
5. Document the BEFORE → AFTER delta in a new `## Case N` section above.

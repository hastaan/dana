"""Gold (human-corrected) discovery fixtures + the GENERAL principles they teach.

Discovery seeds parties from LLM priors + grounded reporting. Two systematic failure
modes recur and are NOT Iran-specific:

  1. FLATTENING rival successor/opposition currents into one bloc (or scattering them as
     unrelated single parties) when they are in fact mutually-incompatible factions that
     cannot coalesce.
  2. WEIGHTING by organizational visibility / diaspora-media presence instead of realistic
     domestic popular support.

Each gold case captures the naive BEFORE structure, the human-corrected AFTER structure,
and the delta. `get_discovery_guidance()` returns the concise, general principle string
that is appended to the SeedPerspectives instruction (no hardcoded facts there — the
specifics live in the fixtures here and in docs/GOLD_EXAMPLES.md).

See docs/GOLD_EXAMPLES.md for the rationale and how to add more gold examples.
"""
from .iri_opposition import (
    IRI_OPPOSITION_GOLD,
    get_discovery_guidance,
)

__all__ = ["IRI_OPPOSITION_GOLD", "get_discovery_guidance"]

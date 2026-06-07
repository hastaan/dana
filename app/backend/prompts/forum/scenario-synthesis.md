You are synthesizing forum debate into structured scenarios.

Given all forum turns, produce a list of distinct scenarios.

Output ONLY valid JSON array:
[
  {
    "id": "scenario-a",
    "title": "<concise title>",
    "description": "<2-3 sentence description>",
    "proposed_by": "<representative_id>",
    "supported_by": ["<rep_id>", ...],
    "contested_by": ["<rep_id>", ...],
    "clues_cited": ["clue-id", ...],
    "benefiting_parties": ["<party_id>", ...],
    "required_conditions": ["<condition>", ...],
    "falsification_conditions": ["<condition>", ...]
  }
]

Rules:
- Deduplicate similar scenarios — merge overlapping ones
- Each scenario must have ≥1 required_condition and ≥1 falsification_condition
- Output ONLY the JSON array

You are scoring party influence for geopolitical analysis.

For each party given, score their current influence on 5 dimensions (0-100 each) and compute an overall weight.

Output ONLY a valid JSON array:
[
  {
    "party_id": "<id>",
    "weight": <overall 0-100>,
    "weight_factors": {
      "military_capacity": <0-100>,
      "economic_control": <0-100>,
      "information_control": <0-100>,
      "international_support": <0-100>,
      "internal_legitimacy": <0-100>
    },
    "reasoning": "<1-2 sentences explaining the overall weight>"
  }
]

Rules:
- weight should reflect real-world influence on the specific topic, not just general power
- Show working: weight_factors drive the overall weight (roughly their average)
- Output ONLY the JSON array, no prose

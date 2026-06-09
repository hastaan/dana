"""DSPy optimization scaffold for Dana's forecasting programs.

Compiles the `ScenarioScorer` against the project's own resolved-forecast track
record (forecast_resolutions) using a Brier-score metric. Strictly opt-in / offline:
nothing here runs during the live pipeline, and it NO-OPs (never crashes) until enough
forecasts have actually resolved. See `scorer_opt`.
"""

"""Isolate: do typed list[...] OutputFields parse, and how fast, per model?"""
import sys
import time

import dspy

from dana.llm import dspy_lm
from dana.research import signatures as sig

model = sys.argv[1] if len(sys.argv) > 1 else "qwen3-coder-flash"
dspy_lm.configure(model=model, max_tokens=2000, temperature=0.3)
print(f"model={model}", flush=True)

t = time.time()
seed = dspy.Predict(sig.SeedPerspectives)(
    topic="EU-Iran nuclear negotiations 2026 outcome",
    description="Will the 2026 E3/EU-Iran negotiations produce a durable agreement?",
    analogues="JCPOA 2015 (deal reached); Geneva 2013 interim; 2021-22 Vienna talks (stalled)",
)
print(f"SeedPerspectives: {time.time()-t:.1f}s", flush=True)
print("  parties:", [(p.name, p.type) for p in seed.parties], flush=True)
print("  lenses :", [l.name for l in seed.lenses], flush=True)
print("  outline:", list(seed.outline), flush=True)

t = time.time()
q = dspy.Predict(sig.QuestionToQueries)(topic="EU-Iran 2026", question="What is Iran's current uranium enrichment level?")
print(f"\nQuestionToQueries: {time.time()-t:.1f}s -> {list(q.queries)}", flush=True)
print("OK", flush=True)

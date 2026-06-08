"""Smoke test: a typed DSPy Signature runs through litellm -> CLIProxyAPI.

Proves the core thesis of the rewrite — that Dana's brittle JSON-regex parsing can be
replaced by DSPy typed OutputFields parsed by the adapter — works against our actual
OpenAI-compatible proxy. Run:  .venv/bin/python tests/smoke_dspy.py
"""
import dspy

from dana.config import settings
from dana.llm import lm as lm_client


def main() -> None:
    # Pick a model the proxy actually serves (fallback handled by the chokepoint logic).
    import anyio

    models = anyio.run(lm_client.list_models)
    model = "minimax-m3" if "minimax-m3" in models else models[0]
    print(f"using model: {model}  (proxy: {settings.proxy_base_url})")

    dspy.configure(
        lm=dspy.LM(
            f"openai/{model}",
            api_base=f"{settings.proxy_base_url}/v1",
            api_key=settings.proxy_api_key,
            temperature=0.2,
            max_tokens=512,
        )
    )

    class ExtractParty(dspy.Signature):
        """Extract the most important geopolitical actor mentioned and classify it."""

        text: str = dspy.InputField()
        actor: str = dspy.OutputField(desc="the single most important actor named")
        actor_type: str = dspy.OutputField(desc="one of: state, non_state, individual, alliance")

    extract = dspy.Predict(ExtractParty)
    out = extract(
        text="As sanctions bit, the IRGC tightened control while reformist factions pushed for negotiations with the EU."
    )
    print("actor:     ", out.actor)
    print("actor_type:", out.actor_type)
    assert out.actor and out.actor_type, "typed fields should be populated"
    print("\n✅ DSPy -> CLIProxyAPI typed-signature path works.")


if __name__ == "__main__":
    main()

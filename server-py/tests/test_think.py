"""Unit tests for llm/think.py — `<think>` stripping (closed / orphan / unclosed)."""
from dana.llm.think import strip_think


class TestStripThink:
    def test_passthrough_when_no_think_tag(self):
        assert strip_think("just a normal answer") == "just a normal answer"

    def test_non_string_passthrough(self):
        assert strip_think(None) is None  # type: ignore[arg-type]
        assert strip_think(42) == 42  # type: ignore[arg-type]

    def test_closed_block_removed(self):
        assert strip_think("<think>reasoning here</think>The answer") == "The answer"

    def test_closed_block_multiline(self):
        text = "<think>\nstep 1\nstep 2\n</think>\n\nFinal answer."
        assert strip_think(text) == "Final answer."

    def test_orphan_close_keeps_tail(self):
        # opening tag dropped, stray close remains → keep only what follows it
        assert strip_think("leaked reasoning</think>The real answer") == "The real answer"

    def test_unclosed_open_left_intact_but_lstripped(self):
        # An open tag with no close isn't matched by the closed-block regex; content survives.
        out = strip_think("<think>still thinking with no close")
        assert "still thinking with no close" in out

    def test_case_insensitive(self):
        assert strip_think("<THINK>x</THINK>Y") == "Y"

    def test_leading_whitespace_stripped(self):
        assert strip_think("<think>z</think>   \n  Answer") == "Answer"

    def test_multiple_closed_blocks(self):
        text = "<think>a</think>One <think>b</think>Two"
        assert strip_think(text) == "One Two"

    def test_empty_string(self):
        assert strip_think("") == ""

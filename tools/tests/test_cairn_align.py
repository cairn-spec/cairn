"""Tests for cairn_align.py — offset parsing, VTT output, cue JSON."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import cairn_align  # noqa: E402
import align_srt      # noqa: E402

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


class TestParseOffset(unittest.TestCase):
    def test_zero(self):
        self.assertEqual(cairn_align.parse_offset("0"), 0.0)

    def test_seconds(self):
        self.assertAlmostEqual(cairn_align.parse_offset("12.5"), 12.5)

    def test_hms_comma(self):
        self.assertAlmostEqual(
            cairn_align.parse_offset("01:00:00,000"), 3600.0)

    def test_hms_dot(self):
        self.assertAlmostEqual(
            cairn_align.parse_offset("00:01:30.250"), 90.25)

    def test_hms_plain(self):
        self.assertAlmostEqual(cairn_align.parse_offset("01:00:00"), 3600.0)

    def test_short_ms_padded(self):
        # ",5" means 500ms (left-justified pad), matching SRT convention
        self.assertAlmostEqual(
            cairn_align.parse_offset("00:00:01,5"), 1.5)

    def test_nle_timecode(self):
        # 01:00:00:12 @ 24fps = 3600 + 12/24
        self.assertAlmostEqual(
            cairn_align.parse_offset("01:00:00:12@24"), 3600.5)

    def test_nle_fractional_fps(self):
        v = cairn_align.parse_offset("00:00:01:00@23.976")
        self.assertAlmostEqual(v, 1.0, places=3)

    def test_garbage_raises(self):
        with self.assertRaises(ValueError):
            cairn_align.parse_offset("one hour")


class TestVttOutput(unittest.TestCase):
    def _run(self, **kw):
        with tempfile.TemporaryDirectory() as td:
            vtt = os.path.join(td, "out.vtt")
            cues = os.path.join(td, "out.json")
            caps, report = cairn_align.run(
                os.path.join(FIX, "transcript.txt"),
                os.path.join(FIX, "whisper.json"),
                vtt_path=vtt, cues_path=cues, **kw)
            with open(vtt, encoding="utf-8") as vtt_file, \
                    open(cues, encoding="utf-8") as cues_file:
                return caps, report, vtt_file.read(), json.load(cues_file)

    def test_header(self):
        _, _, vtt, _ = self._run()
        self.assertTrue(vtt.startswith("WEBVTT\n"))

    def test_dot_timestamps(self):
        _, _, vtt, _ = self._run()
        self.assertIn(" --> ", vtt)
        # VTT uses dots; no comma timestamps allowed
        for line in vtt.splitlines():
            if "-->" in line:
                self.assertNotIn(",", line)
                self.assertRegex(
                    line, r"\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}")

    def test_metadata_note(self):
        _, _, vtt, _ = self._run(speaker="Narrator", kind="narration",
                                 fragment_id="gauge")
        self.assertIn("NOTE", vtt)
        self.assertIn("cairn-speaker: Narrator", vtt)
        self.assertIn("cairn-fragment: gauge", vtt)
        # Metadata must never leak into cue text
        cue_zone = vtt.split("NOTE")[1]
        after_cues = cue_zone.split("\n\n", 2)[-1]
        self.assertNotIn("cairn-speaker", after_cues)

    def test_no_note_without_metadata(self):
        _, _, vtt, _ = self._run()
        self.assertNotIn("NOTE", vtt)

    def test_offset_applied(self):
        caps, _, vtt, cues = self._run(offset=3600.0)
        self.assertGreaterEqual(caps[0].start, 3600.0)
        self.assertIn("01:00:0", vtt)
        self.assertGreaterEqual(cues["cues"][0]["start"], 3600.0)

    def test_cues_json_shape(self):
        _, _, _, cues = self._run(speaker="Narrator", fragment_id="gauge")
        self.assertEqual(cues["cairn"], "0.1")
        self.assertEqual(cues["fragment"], "gauge")
        self.assertEqual(cues["kind"], "narration")
        self.assertTrue(len(cues["cues"]) >= 1)
        for c in cues["cues"]:
            self.assertLessEqual(c["start"], c["end"])
            self.assertTrue(c["text"].strip())

    def test_cue_text_matches_srt_content(self):
        caps, _, _, cues = self._run()
        joined = " ".join(c["text"].replace("\n", " ") for c in cues["cues"])
        srt_joined = " ".join(" ".join(cap.lines) for cap in caps)
        self.assertEqual(joined, srt_joined)

    def test_timecodes_increase_no_overlap(self):
        _, _, _, cues = self._run()
        cs = cues["cues"]
        for a, b in zip(cs, cs[1:]):
            self.assertLessEqual(a["end"], b["start"] + 1e-9)


class TestSrtPassthrough(unittest.TestCase):
    def test_srt_still_works_with_offset(self):
        with tempfile.TemporaryDirectory() as td:
            srt = os.path.join(td, "out.srt")
            cairn_align.run(
                os.path.join(FIX, "transcript.txt"),
                os.path.join(FIX, "whisper.json"),
                srt_path=srt, offset=3600.0)
            with open(srt, encoding="utf-8") as srt_file:
                text = srt_file.read()
            self.assertIn("01:00:0", text)
            self.assertIn(",", text.splitlines()[1])  # SRT keeps comma format


if __name__ == "__main__":
    unittest.main()

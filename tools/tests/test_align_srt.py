"""
Tests for align_srt.py

Run from the transcript-srt-aligner/ directory:
    python3 -m unittest discover -s tests -v
"""

import json
import os
import sys
import tempfile
import unittest

# Allow import from parent directory
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from align_srt import (
    AlignedWord,
    Caption,
    TranscriptWord,
    WhisperWord,
    _interpolate,
    align,
    fmt_time,
    load_transcript,
    load_whisper,
    normalize,
    run_pipeline,
    segment,
)

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


# ── fmt_time ──────────────────────────────────────────────────────────────────

class TestFmtTime(unittest.TestCase):
    def test_zero(self):
        self.assertEqual(fmt_time(0.0), "00:00:00,000")

    def test_subsecond(self):
        self.assertEqual(fmt_time(0.5), "00:00:00,500")

    def test_seconds(self):
        self.assertEqual(fmt_time(1.6), "00:00:01,600")

    def test_minutes(self):
        self.assertEqual(fmt_time(75.25), "00:01:15,250")

    def test_hours(self):
        self.assertEqual(fmt_time(3661.5), "01:01:01,500")

    def test_rounding_hundredths(self):
        self.assertEqual(fmt_time(6.1), "00:00:06,100")

    def test_rounding_tenths(self):
        self.assertEqual(fmt_time(10.5), "00:00:10,500")


# ── normalize ─────────────────────────────────────────────────────────────────

class TestNormalize(unittest.TestCase):
    def test_lowercase(self):
        self.assertEqual(normalize("Hello"), "hello")

    def test_strips_comma(self):
        self.assertEqual(normalize("hello,"), "hello")

    def test_strips_period(self):
        self.assertEqual(normalize("end."), "end")

    def test_keeps_apostrophe(self):
        self.assertEqual(normalize("region's"), "region's")

    def test_keeps_numbers(self):
        self.assertEqual(normalize("1950"), "1950")

    def test_collapses_whitespace(self):
        self.assertEqual(normalize("  hello  world  "), "hello world")


# ── load_whisper ──────────────────────────────────────────────────────────────

class TestLoadWhisper(unittest.TestCase):
    def _write_json(self, data, tmp):
        path = os.path.join(tmp, "w.json")
        with open(path, "w") as f:
            json.dump(data, f)
        return path

    def test_flat_words_format(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_json({
                "words": [
                    {"word": "Hello", "start": 0.0, "end": 0.4},
                    {"word": "world", "start": 0.5, "end": 0.9},
                ]
            }, tmp)
            words = load_whisper(path)
        self.assertEqual(len(words), 2)
        self.assertEqual(words[0].word, "Hello")
        self.assertAlmostEqual(words[0].start, 0.0)
        self.assertAlmostEqual(words[1].end, 0.9)

    def test_segments_format(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_json({
                "segments": [
                    {
                        "start": 0.0, "end": 2.0,
                        "text": "Hello world",
                        "words": [
                            {"word": "Hello", "start": 0.0, "end": 0.4},
                            {"word": "world", "start": 0.5, "end": 0.9},
                        ]
                    }
                ]
            }, tmp)
            words = load_whisper(path)
        self.assertEqual(len(words), 2)
        self.assertEqual(words[1].norm, "world")

    def test_norms_are_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_json({
                "words": [{"word": "Cemetery.", "start": 0.0, "end": 0.5}]
            }, tmp)
            words = load_whisper(path)
        self.assertEqual(words[0].norm, "cemetery")

    def test_invalid_format_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_json({"text": "oops"}, tmp)
            with self.assertRaises(ValueError):
                load_whisper(path)


# ── load_transcript ───────────────────────────────────────────────────────────

class TestLoadTranscript(unittest.TestCase):
    def _write(self, text, tmp):
        path = os.path.join(tmp, "t.txt")
        with open(path, "w") as f:
            f.write(text)
        return path

    def test_basic_words(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write("Hello world.", tmp)
            words = load_transcript(path)
        self.assertEqual(len(words), 2)
        self.assertEqual(words[0].surface, "Hello")
        self.assertEqual(words[1].surface, "world")

    def test_sent_end_period(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write("End.", tmp)
            words = load_transcript(path)
        self.assertTrue(words[0].sent_end)

    def test_sent_end_exclamation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write("Go!", tmp)
            words = load_transcript(path)
        self.assertTrue(words[0].sent_end)

    def test_comma_not_sent_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write("1950, it", tmp)
            words = load_transcript(path)
        self.assertFalse(words[0].sent_end)
        self.assertEqual(words[0].surface, "1950")

    def test_apostrophe_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write("region's", tmp)
            words = load_transcript(path)
        self.assertEqual(words[0].surface, "region's")
        self.assertEqual(words[0].norm, "region's")

    def test_norm_computed(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write("Trail.", tmp)
            words = load_transcript(path)
        self.assertEqual(words[0].norm, "trail")


# ── align ─────────────────────────────────────────────────────────────────────

class TestAlign(unittest.TestCase):
    def _tw(self, surface, sent_end=False):
        return TranscriptWord(surface=surface, norm=normalize(surface),
                              sent_end=sent_end)

    def _ww(self, word, start, end):
        return WhisperWord(word=word, start=start, end=end)

    def test_perfect_match_coverage(self):
        twords = [self._tw("Hello"), self._tw("world", sent_end=True)]
        wwords = [self._ww("Hello", 0.0, 0.4), self._ww("world", 0.5, 0.9)]
        aligned, report = align(twords, wwords)
        self.assertEqual(report["coverage"], 1.0)
        self.assertEqual(report["matched_words"], 2)
        self.assertEqual(report["interpolated_words"], 0)
        self.assertEqual(report["unmatched_passages"], [])

    def test_perfect_match_timestamps(self):
        twords = [self._tw("Hello"), self._tw("world", sent_end=True)]
        wwords = [self._ww("Hello", 0.0, 0.4), self._ww("world", 0.5, 0.9)]
        aligned, _ = align(twords, wwords)
        self.assertAlmostEqual(aligned[0].start, 0.0)
        self.assertAlmostEqual(aligned[0].end, 0.4)
        self.assertAlmostEqual(aligned[1].start, 0.5)
        self.assertAlmostEqual(aligned[1].end, 0.9)

    def test_partial_match_coverage(self):
        # Transcript has "the beautiful" that whisper doesn't
        twords = [self._tw("Welcome"), self._tw("to"),
                  self._tw("the"), self._tw("beautiful"),
                  self._tw("Riverside"), self._tw("Trail", sent_end=True)]
        wwords = [self._ww("Welcome", 0.0, 0.5), self._ww("to", 0.5, 0.65),
                  self._ww("Riverside", 0.9, 1.3), self._ww("Trail", 1.3, 1.8)]
        aligned, report = align(twords, wwords)
        self.assertAlmostEqual(report["coverage"], round(4 / 6, 4))
        self.assertEqual(report["matched_words"], 4)
        self.assertEqual(report["interpolated_words"], 2)
        self.assertEqual(len(report["unmatched_passages"]), 1)
        self.assertEqual(report["unmatched_passages"][0]["text"], "the beautiful")

    def test_unmatched_timestamps_are_interpolated(self):
        twords = [self._tw("A"), self._tw("MISSING"), self._tw("B", sent_end=True)]
        wwords = [self._ww("A", 0.0, 0.5), self._ww("B", 1.0, 1.5)]
        aligned, _ = align(twords, wwords)
        # "MISSING" should have times interpolated between A.end and B.start
        self.assertGreaterEqual(aligned[1].start, 0.5)
        self.assertLess(aligned[1].end, 1.0)
        self.assertEqual(aligned[1].confidence, 0.0)


# ── _interpolate ──────────────────────────────────────────────────────────────

class TestInterpolate(unittest.TestCase):
    def _make(self, confidence, start=-1.0, end=-1.0):
        return AlignedWord(surface="x", start=start, end=end,
                           confidence=confidence)

    def test_interior_gap(self):
        words = [
            self._make(1.0, 0.0, 0.5),
            self._make(0.0),
            self._make(0.0),
            self._make(1.0, 1.5, 2.0),
        ]
        _interpolate(words)
        # Interpolated words should fall between 0.5 and 1.5
        self.assertGreaterEqual(words[1].start, 0.5)
        self.assertLess(words[2].end, 1.5)

    def test_no_matches_assigns_dummy(self):
        words = [self._make(0.0), self._make(0.0)]
        _interpolate(words)
        # Should not raise; timestamps should be finite non-negative
        for w in words:
            self.assertGreaterEqual(w.start, 0.0)
            self.assertGreater(w.end, 0.0)


# ── segment ───────────────────────────────────────────────────────────────────

class TestSegment(unittest.TestCase):
    def _tw(self, surface, sent_end=False):
        return TranscriptWord(surface=surface, norm=normalize(surface),
                              sent_end=sent_end)

    def _aw(self, surface, start, end):
        return AlignedWord(surface=surface, start=start, end=end,
                           confidence=1.0)

    def test_sentence_break_creates_new_caption(self):
        twords = [self._tw("Hello", sent_end=True), self._tw("World", sent_end=True)]
        awords = [self._aw("Hello", 0.0, 1.0), self._aw("World", 2.0, 3.0)]
        caps = segment(awords, twords)
        self.assertEqual(len(caps), 2)
        self.assertEqual(caps[0].lines[0], "Hello")
        self.assertEqual(caps[1].lines[0], "World")

    def test_line_length_respected(self):
        # 5-word line that fits + one word that overflows
        surfaces = ["short"] * 8 + ["end"]
        sent_ends = [False] * 8 + [True]
        twords = [self._tw(s, e) for s, e in zip(surfaces, sent_ends)]
        awords = [self._aw(s, i * 0.5, i * 0.5 + 0.4)
                  for i, s in enumerate(surfaces)]
        caps = segment(awords, twords, max_chars=42)
        # All captions should respect max_chars per line
        for cap in caps:
            for line in cap.lines:
                self.assertLessEqual(len(line), 42)

    def test_no_overlap(self):
        twords = [self._tw("A"), self._tw("B"), self._tw("C", sent_end=True)] * 3
        awords = [self._aw("A", i * 0.5, i * 0.5 + 0.45)
                  for i in range(len(twords))]
        caps = segment(awords, twords)
        for i in range(len(caps) - 1):
            self.assertLessEqual(caps[i].end, caps[i + 1].start)

    def test_timecodes_increase(self):
        twords = [self._tw("word", i == 4) for i in range(5)]
        awords = [self._aw("word", i * 1.0, i * 1.0 + 0.8)
                  for i in range(5)]
        caps = segment(awords, twords)
        for i in range(len(caps) - 1):
            self.assertLess(caps[i].start, caps[i + 1].start)

    def test_srt_formatting(self):
        twords = [self._tw("Hello", sent_end=True)]
        awords = [self._aw("Hello", 0.0, 1.5)]
        cap = segment(awords, twords)[0]
        srt = cap.to_srt()
        self.assertIn("00:00:00,000 --> 00:00:01,500", srt)
        self.assertIn("Hello", srt)


# ── Integration: fixture-based ────────────────────────────────────────────────

class TestIntegration(unittest.TestCase):
    def setUp(self):
        self.transcript = os.path.join(FIXTURES, "transcript.txt")
        self.whisper = os.path.join(FIXTURES, "whisper.json")
        self.expected_srt = os.path.join(FIXTURES, "expected.srt")
        self.mismatch_transcript = os.path.join(FIXTURES, "transcript_mismatch.txt")
        self.mismatch_whisper = os.path.join(FIXTURES, "whisper_mismatch.json")

    def test_output_matches_expected_srt(self):
        with tempfile.NamedTemporaryFile(suffix=".srt", delete=False) as f:
            out_path = f.name
        try:
            run_pipeline(self.transcript, self.whisper, out_path)
            with open(out_path, "rb") as f:
                actual = f.read()
            with open(self.expected_srt, "rb") as f:
                expected = f.read()
            self.assertEqual(actual, expected,
                             "SRT output does not byte-for-byte match expected.srt")
        finally:
            os.unlink(out_path)

    def test_timecodes_increase_without_overlap(self):
        with tempfile.NamedTemporaryFile(suffix=".srt", delete=False) as f:
            out_path = f.name
        try:
            captions, _ = run_pipeline(self.transcript, self.whisper, out_path)
            starts = [c.start for c in captions]
            ends = [c.end for c in captions]
            # Starts must be strictly increasing
            for i in range(len(starts) - 1):
                self.assertLess(starts[i], starts[i + 1],
                                f"Caption {i+1} start >= caption {i+2} start")
            # No caption may end after the next one begins
            for i in range(len(captions) - 1):
                self.assertLessEqual(ends[i], starts[i + 1],
                                     f"Caption {i+1} overlaps caption {i+2}")
        finally:
            os.unlink(out_path)

    def test_report_coverage_is_100_percent(self):
        with tempfile.NamedTemporaryFile(suffix=".srt", delete=False) as srt_f, \
             tempfile.NamedTemporaryFile(suffix=".json", delete=False, mode="w") as rep_f:
            srt_path = srt_f.name
            rep_path = rep_f.name
        try:
            _, report = run_pipeline(self.transcript, self.whisper,
                                     srt_path, report_path=rep_path)
            self.assertEqual(report["coverage"], 1.0)
            self.assertEqual(report["matched_words"], 23)
            self.assertEqual(report["interpolated_words"], 0)
            self.assertEqual(report["unmatched_passages"], [])
            self.assertEqual(report["caption_count"], 3)
        finally:
            os.unlink(srt_path)
            os.unlink(rep_path)

    def test_mismatch_fixture_partial_coverage(self):
        with tempfile.NamedTemporaryFile(suffix=".srt", delete=False) as f:
            out_path = f.name
        try:
            _, report = run_pipeline(
                self.mismatch_transcript, self.mismatch_whisper, out_path
            )
            self.assertLess(report["coverage"], 1.0)
            self.assertGreater(report["interpolated_words"], 0)
            self.assertGreater(len(report["unmatched_passages"]), 0)
            self.assertEqual(report["unmatched_passages"][0]["text"],
                             "the beautiful")
        finally:
            os.unlink(out_path)

    def test_mismatch_srt_still_valid(self):
        with tempfile.NamedTemporaryFile(suffix=".srt", delete=False) as f:
            out_path = f.name
        try:
            captions, _ = run_pipeline(
                self.mismatch_transcript, self.mismatch_whisper, out_path
            )
            self.assertGreater(len(captions), 0)
            # Each caption must have valid (non-negative) timecodes
            for cap in captions:
                self.assertGreaterEqual(cap.start, 0.0)
                self.assertGreater(cap.end, cap.start)
        finally:
            os.unlink(out_path)

    def test_whisper_segments_format(self):
        # Verify the segments-style JSON format also works end-to-end
        import json as _json
        with open(self.whisper) as f:
            flat = _json.load(f)

        segments_data = {"segments": [{"start": 0.0, "end": 11.0,
                                        "text": "", "words": flat["words"]}]}
        with tempfile.NamedTemporaryFile(suffix=".json", mode="w",
                                         delete=False) as f:
            _json.dump(segments_data, f)
            seg_path = f.name
        with tempfile.NamedTemporaryFile(suffix=".srt", delete=False) as f:
            out_path = f.name
        try:
            _, report = run_pipeline(self.transcript, seg_path, out_path)
            self.assertEqual(report["coverage"], 1.0)
        finally:
            os.unlink(seg_path)
            os.unlink(out_path)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""
align_srt.py — align a curator-cleaned transcript to Whisper word timestamps
and output Premiere-ready SRT captions.

Usage:
    python3 align_srt.py transcript.txt whisper.json -o captions.srt [--report report.json]
"""

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Optional

# ── Constants ─────────────────────────────────────────────────────────────────

MAX_CHARS = 42       # max characters per caption line
MAX_LINES = 2        # max lines per caption block
MAX_DURATION = 7.0   # max seconds a caption stays on screen
MIN_DURATION = 0.8   # min seconds a caption stays on screen


# ── SRT formatting ────────────────────────────────────────────────────────────

def fmt_time(seconds: float) -> str:
    """Format seconds as SRT timestamp HH:MM:SS,mmm."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = round((seconds - int(seconds)) * 1000)
    # Guard against floating-point rounding producing ms=1000
    if ms == 1000:
        ms = 999
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


# ── Text normalization ────────────────────────────────────────────────────────

def normalize(text: str) -> str:
    """Lowercase and strip punctuation (keep apostrophes) for matching."""
    text = text.lower()
    text = re.sub(r"[^\w\s']", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


# ── Data structures ───────────────────────────────────────────────────────────

@dataclass
class WhisperWord:
    word: str
    start: float
    end: float
    norm: str = field(default="", init=False)

    def __post_init__(self):
        self.norm = normalize(self.word)


@dataclass
class TranscriptWord:
    surface: str    # curator's wording (punctuation stripped)
    norm: str       # normalized form for matching
    sent_end: bool  # True if followed by sentence-ending punctuation


@dataclass
class AlignedWord:
    surface: str        # curator's surface word
    start: float        # timestamp in seconds
    end: float
    confidence: float   # 1.0 = direct Whisper match, 0.0 = interpolated


@dataclass
class Caption:
    index: int
    start: float
    end: float
    lines: list

    def to_srt(self) -> str:
        text = "\n".join(self.lines)
        return f"{self.index}\n{fmt_time(self.start)} --> {fmt_time(self.end)}\n{text}\n"


# ── Parsing ───────────────────────────────────────────────────────────────────

def load_whisper(path: str) -> list:
    """
    Parse Whisper word-timestamp JSON.
    Accepts two formats:
      {"words": [{"word": ..., "start": ..., "end": ...}, ...]}
      {"segments": [{"words": [...]}]}
    """
    with open(path) as f:
        data = json.load(f)

    if "words" in data:
        raw = data["words"]
    elif "segments" in data:
        raw = []
        for seg in data["segments"]:
            raw.extend(seg.get("words", []))
    else:
        raise ValueError(
            "Whisper JSON must have a top-level 'words' list or 'segments' list"
        )

    words = []
    for w in raw:
        word = w.get("word", w.get("text", "")).strip()
        start = float(w["start"])
        end = float(w["end"])
        if word:
            words.append(WhisperWord(word=word, start=start, end=end))
    return words


def load_transcript(path: str) -> list:
    """
    Parse a plain-text curator transcript into TranscriptWord objects.
    Preserves the curator's surface wording; strips leading/trailing punctuation
    from tokens for the surface form; detects sentence-ending tokens.
    """
    with open(path) as f:
        text = f.read()

    words = []
    for match in re.finditer(r'\S+', text):
        token = match.group()
        sent_end = bool(re.search(r'[.!?]["\')\]]*$', token))
        # Strip outer punctuation to get the clean surface word
        surface = token.rstrip(".,;:!?\"')-]")
        surface = surface.lstrip("\"'([")
        if surface:
            words.append(TranscriptWord(
                surface=surface,
                norm=normalize(surface),
                sent_end=sent_end,
            ))
    return words


# ── Alignment ─────────────────────────────────────────────────────────────────

def align(transcript_words: list, whisper_words: list) -> tuple:
    """
    Align curator transcript words to Whisper word timestamps using
    SequenceMatcher on normalized forms. Interpolates timestamps for
    curator words that have no Whisper match.

    Returns (aligned_words: list[AlignedWord], report: dict).
    """
    t_norms = [w.norm for w in transcript_words]
    w_norms = [w.norm for w in whisper_words]

    matcher = SequenceMatcher(None, t_norms, w_norms, autojunk=False)
    blocks = matcher.get_matching_blocks()

    # Build transcript_index → whisper_index mapping
    t_to_w = {}
    for t_start, w_start, size in blocks:
        for i in range(size):
            t_to_w[t_start + i] = w_start + i

    matched = len(t_to_w)
    total = len(transcript_words)

    # Initial pass: fill known timestamps
    aligned = []
    for i, tw in enumerate(transcript_words):
        if i in t_to_w:
            ww = whisper_words[t_to_w[i]]
            aligned.append(AlignedWord(
                surface=tw.surface,
                start=ww.start,
                end=ww.end,
                confidence=1.0,
            ))
        else:
            aligned.append(AlignedWord(
                surface=tw.surface,
                start=-1.0,
                end=-1.0,
                confidence=0.0,
            ))

    _interpolate(aligned)

    # Collect unmatched passages (consecutive runs of unmatched words)
    unmatched_passages = []
    i = 0
    while i < len(aligned):
        if aligned[i].confidence == 0.0:
            j = i
            while j < len(aligned) and aligned[j].confidence == 0.0:
                j += 1
            unmatched_passages.append({
                "word_range": [i, j - 1],
                "text": " ".join(aligned[k].surface for k in range(i, j)),
                "approx_start": round(aligned[i].start, 3),
                "approx_end": round(aligned[j - 1].end, 3),
            })
            i = j
        else:
            i += 1

    coverage = matched / total if total > 0 else 0.0
    report = {
        "total_curator_words": total,
        "matched_words": matched,
        "interpolated_words": total - matched,
        "coverage": round(coverage, 4),
        "unmatched_passages": unmatched_passages,
    }
    return aligned, report


def _interpolate(aligned: list) -> None:
    """
    Fill -1.0 placeholders with linearly interpolated timestamps,
    using the nearest matched neighbours as anchors.
    """
    n = len(aligned)
    if n == 0:
        return

    first_match = next(
        (i for i, w in enumerate(aligned) if w.confidence > 0), None
    )
    if first_match is None:
        # Nothing matched at all — spread across a dummy 0.5s-per-word range
        for i, w in enumerate(aligned):
            w.start = i * 0.5
            w.end = i * 0.5 + 0.4
        return

    last_match = next(
        (n - 1 - i for i, w in enumerate(reversed(aligned)) if w.confidence > 0)
    )

    # Leading unmatched words: place before the first anchor
    if first_match > 0:
        anchor = aligned[first_match].start
        step = anchor / (first_match + 1) if anchor > 0 else 0.5
        for i in range(first_match):
            aligned[i].start = round(step * i, 4)
            aligned[i].end = round(step * i + step * 0.85, 4)

    # Trailing unmatched words: place after the last anchor
    if last_match < n - 1:
        anchor_end = aligned[last_match].end
        for i in range(last_match + 1, n):
            offset = i - last_match
            aligned[i].start = round(anchor_end + offset * 0.5, 4)
            aligned[i].end = round(anchor_end + offset * 0.5 + 0.4, 4)

    # Interior gaps: linear interpolation between left.end and right.start
    i = 0
    while i < n:
        if aligned[i].confidence == 0.0:
            left = i - 1
            j = i
            while j < n and aligned[j].confidence == 0.0:
                j += 1
            right = j  # first matched word after the gap (or n)

            if left >= 0 and right < n:
                t0 = aligned[left].end
                t1 = aligned[right].start
                gap = right - left - 1
                step = (t1 - t0) / (gap + 1) if gap > 0 else 0.0
                for k in range(gap):
                    idx = left + 1 + k
                    aligned[idx].start = round(t0 + step * k, 4)
                    aligned[idx].end = round(
                        t0 + step * k + max(step * 0.85, 0.1), 4
                    )
            i = j
        else:
            i += 1


# ── Caption segmentation ──────────────────────────────────────────────────────

def segment(aligned: list, transcript_words: list,
            max_chars: int = MAX_CHARS,
            max_duration: float = MAX_DURATION) -> list:
    """
    Break aligned words into Caption blocks, respecting:
    - max_chars characters per line
    - MAX_LINES lines per caption
    - max_duration seconds per caption
    - Sentence boundaries (prefer to break at sentence-ending punctuation)
    """
    captions = []
    cap_idx = 1
    i = 0
    n = len(aligned)

    while i < n:
        line1_words = []
        line = ""

        # Build line 1
        while i < n:
            surface = aligned[i].surface
            candidate = (line + " " + surface).strip()
            if len(candidate) > max_chars and line1_words:
                break
            line = candidate
            line1_words.append(i)
            if transcript_words[i].sent_end:
                i += 1
                break
            i += 1

        if not line1_words:
            # Safety: shouldn't happen, but avoid infinite loop
            i += 1
            continue

        start_time = aligned[line1_words[0]].start
        end_time = aligned[line1_words[-1]].end

        # Build line 2 (only if line 1 didn't end on a sentence boundary)
        line2_words = []
        if i < n and not transcript_words[line1_words[-1]].sent_end:
            line2 = ""
            while i < n:
                surface = aligned[i].surface
                candidate = (line2 + " " + surface).strip()
                if len(candidate) > max_chars and line2_words:
                    break
                # Duration guard
                if aligned[i].end - start_time > max_duration and line2_words:
                    break
                line2 = candidate
                line2_words.append(i)
                if transcript_words[i].sent_end:
                    i += 1
                    break
                i += 1

            if line2_words:
                end_time = aligned[line2_words[-1]].end

        # Enforce minimum display duration
        if end_time - start_time < MIN_DURATION:
            end_time = start_time + MIN_DURATION

        lines = [" ".join(aligned[j].surface for j in line1_words)]
        if line2_words:
            lines.append(" ".join(aligned[j].surface for j in line2_words))

        captions.append(Caption(
            index=cap_idx,
            start=start_time,
            end=end_time,
            lines=lines,
        ))
        cap_idx += 1

    # Prevent overlaps: each caption must end before the next begins
    for k in range(len(captions) - 1):
        if captions[k].end > captions[k + 1].start:
            captions[k].end = round(captions[k + 1].start - 0.001, 3)

    return captions


# ── Pipeline ──────────────────────────────────────────────────────────────────

def run_pipeline(transcript_path: str, whisper_path: str, output_path: str,
                 report_path: Optional[str] = None,
                 max_chars: int = MAX_CHARS,
                 max_duration: float = MAX_DURATION) -> tuple:
    """
    Full pipeline: parse → align → segment → write SRT (and optional report).
    Returns (captions, report).
    """
    transcript_words = load_transcript(transcript_path)
    whisper_words = load_whisper(whisper_path)
    aligned, report = align(transcript_words, whisper_words)
    captions = segment(aligned, transcript_words,
                       max_chars=max_chars, max_duration=max_duration)

    with open(output_path, "w", newline="\n") as f:
        for cap in captions:
            f.write(cap.to_srt())
            f.write("\n")

    if report_path:
        report["caption_count"] = len(captions)
        with open(report_path, "w") as f:
            json.dump(report, f, indent=2)

    return captions, report


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Align curator transcript to Whisper timestamps → SRT captions"
    )
    parser.add_argument("transcript", help="Curator-cleaned transcript (.txt)")
    parser.add_argument("whisper", help="Whisper word-timestamp JSON")
    parser.add_argument("-o", "--output", required=True, help="Output SRT file")
    parser.add_argument("--report", help="Output alignment report JSON")
    parser.add_argument(
        "--max-chars", type=int, default=MAX_CHARS,
        help=f"Max characters per caption line (default {MAX_CHARS})"
    )
    parser.add_argument(
        "--max-duration", type=float, default=MAX_DURATION,
        help=f"Max seconds per caption (default {MAX_DURATION})"
    )
    args = parser.parse_args()

    captions, report = run_pipeline(
        args.transcript, args.whisper, args.output, args.report,
        max_chars=args.max_chars, max_duration=args.max_duration,
    )

    print(f"Wrote {len(captions)} captions → {args.output}")
    if args.report:
        print(
            f"Coverage {report['coverage']:.1%} "
            f"({report['matched_words']}/{report['total_curator_words']} words matched) "
            f"→ {args.report}"
        )
    if report["unmatched_passages"]:
        print(
            f"WARNING: {len(report['unmatched_passages'])} unmatched passage(s) — "
            "check report for details"
        )


if __name__ == "__main__":
    main()

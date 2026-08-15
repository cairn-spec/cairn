#!/usr/bin/env python3
"""
cairn_align.py — the Cairn authoring tool.

Takes a known-verbatim script and Whisper word timestamps for a rendered
narration fragment, and emits caption artifacts for spatial scenes:

  - WebVTT (.vtt)   — 100% standard; the temporal layer of the Cairn spec
  - cue JSON        — precompiled cues for runtimes that skip VTT parsing
  - SRT (.srt)      — optional, for NLE workflows (Premiere/Resolve import)

Built on align_srt.py (forced alignment + caption segmentation). Adds:
  --offset          shift all timestamps (sequence-start timecode, or
                    trimming compensation). Accepts:
                      seconds        12.5
                      HH:MM:SS.mmm   01:00:00.000
                      HH:MM:SS,mmm   01:00:00,000
                      HH:MM:SS:FF@fps  01:00:00:00@23.976  (NLE timecode)
  --speaker/--kind  Cairn cue metadata, carried in the VTT NOTE block and
                    the cue JSON (never in cue text).

Usage:
    python3 cairn_align.py script.txt whisper.json --vtt gauge.vtt \
        [--cues gauge.cues.json] [--srt gauge.srt] [--report gauge.report.json] \
        [--offset 01:00:00,000] [--speaker Narrator] [--kind narration]
"""

import argparse
import json
import re
import sys

import align_srt


# ── Offset parsing ────────────────────────────────────────────────────────────

def parse_offset(spec: str) -> float:
    """Parse an offset spec into seconds. See module docstring for forms."""
    spec = spec.strip()
    if not spec:
        return 0.0

    # NLE timecode: HH:MM:SS:FF@fps
    m = re.fullmatch(r"(\d+):(\d{2}):(\d{2}):(\d{2})@([\d.]+)", spec)
    if m:
        h, mnt, s, ff = int(m[1]), int(m[2]), int(m[3]), int(m[4])
        fps = float(m[5])
        if fps <= 0:
            raise ValueError("fps must be positive")
        return h * 3600 + mnt * 60 + s + ff / fps

    # HH:MM:SS.mmm or HH:MM:SS,mmm
    m = re.fullmatch(r"(\d+):(\d{2}):(\d{2})[.,](\d{1,3})", spec)
    if m:
        ms = int(m[4].ljust(3, "0"))
        return int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) + ms / 1000.0

    # HH:MM:SS
    m = re.fullmatch(r"(\d+):(\d{2}):(\d{2})", spec)
    if m:
        return int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3])

    # Plain seconds
    try:
        return float(spec)
    except ValueError:
        raise ValueError(f"unrecognized offset format: {spec!r}")


# ── VTT formatting ────────────────────────────────────────────────────────────

def fmt_vtt_time(seconds: float) -> str:
    """WebVTT timestamp HH:MM:SS.mmm (dot, not comma)."""
    return align_srt.fmt_time(seconds).replace(",", ".")


def to_vtt(captions, speaker=None, kind=None, fragment_id=None) -> str:
    """Render Caption blocks as a standard WebVTT document."""
    out = ["WEBVTT", ""]
    meta = {}
    if fragment_id:
        meta["cairn-fragment"] = fragment_id
    if speaker:
        meta["cairn-speaker"] = speaker
    if kind:
        meta["cairn-kind"] = kind
    if meta:
        out.append("NOTE")
        for k, v in meta.items():
            out.append(f"{k}: {v}")
        out.append("")
    for cap in captions:
        out.append(str(cap.index))
        out.append(f"{fmt_vtt_time(cap.start)} --> {fmt_vtt_time(cap.end)}")
        out.extend(cap.lines)
        out.append("")
    return "\n".join(out) + "\n"


def to_cues_json(captions, speaker=None, kind=None, fragment_id=None) -> dict:
    """Precompiled cue list for runtimes that skip VTT parsing."""
    return {
        "cairn": "0.1",
        "fragment": fragment_id,
        "speaker": speaker,
        "kind": kind or "narration",
        "cues": [
            {
                "start": round(cap.start, 3),
                "end": round(cap.end, 3),
                "text": "\n".join(cap.lines),
            }
            for cap in captions
        ],
    }


# ── Pipeline ──────────────────────────────────────────────────────────────────

def run(script_path, whisper_path, vtt_path=None, cues_path=None,
        srt_path=None, report_path=None, offset=0.0,
        speaker=None, kind=None, fragment_id=None,
        max_chars=align_srt.MAX_CHARS, max_duration=align_srt.MAX_DURATION):
    transcript_words = align_srt.load_transcript(script_path)
    whisper_words = align_srt.load_whisper(whisper_path)
    aligned, report = align_srt.align(transcript_words, whisper_words)
    captions = align_srt.segment(aligned, transcript_words,
                                 max_chars=max_chars,
                                 max_duration=max_duration)

    if offset:
        for cap in captions:
            cap.start += offset
            cap.end += offset

    if vtt_path:
        with open(vtt_path, "w", newline="\n") as f:
            f.write(to_vtt(captions, speaker, kind, fragment_id))
    if cues_path:
        with open(cues_path, "w") as f:
            json.dump(to_cues_json(captions, speaker, kind, fragment_id),
                      f, indent=2)
    if srt_path:
        with open(srt_path, "w", newline="\n") as f:
            for cap in captions:
                f.write(cap.to_srt())
                f.write("\n")
    if report_path:
        report["caption_count"] = len(captions)
        report["offset_seconds"] = offset
        with open(report_path, "w") as f:
            json.dump(report, f, indent=2)

    return captions, report


def main():
    p = argparse.ArgumentParser(
        description="Cairn authoring: script + Whisper timings → VTT/cues/SRT")
    p.add_argument("script", help="Known-verbatim script text file")
    p.add_argument("whisper", help="Whisper word-timestamp JSON")
    p.add_argument("--vtt", help="Output WebVTT file")
    p.add_argument("--cues", help="Output precompiled cue JSON")
    p.add_argument("--srt", help="Output SRT (NLE import)")
    p.add_argument("--report", help="Output alignment report JSON")
    p.add_argument("--offset", default="0",
                   help="Timestamp offset: seconds, HH:MM:SS[.,]mmm, "
                        "or HH:MM:SS:FF@fps")
    p.add_argument("--speaker", help="Speaker label (metadata, not cue text)")
    p.add_argument("--kind", default="narration",
                   choices=["narration", "ambience", "hint"])
    p.add_argument("--fragment-id", help="Cairn fragment id (metadata)")
    p.add_argument("--max-chars", type=int, default=align_srt.MAX_CHARS)
    p.add_argument("--max-duration", type=float,
                   default=align_srt.MAX_DURATION)
    args = p.parse_args()

    if not (args.vtt or args.cues or args.srt):
        p.error("nothing to do: pass at least one of --vtt / --cues / --srt")

    captions, report = run(
        args.script, args.whisper,
        vtt_path=args.vtt, cues_path=args.cues, srt_path=args.srt,
        report_path=args.report, offset=parse_offset(args.offset),
        speaker=args.speaker, kind=args.kind, fragment_id=args.fragment_id,
        max_chars=args.max_chars, max_duration=args.max_duration,
    )

    outs = [x for x in (args.vtt, args.cues, args.srt) if x]
    print(f"{len(captions)} captions → {', '.join(outs)}")
    print(f"Coverage {report['coverage']:.1%} "
          f"({report['matched_words']}/{report['total_curator_words']} matched)")
    if report["unmatched_passages"]:
        print(f"WARNING: {len(report['unmatched_passages'])} unmatched "
              "passage(s) — check report")


if __name__ == "__main__":
    main()

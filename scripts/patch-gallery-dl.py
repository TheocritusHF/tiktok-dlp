"""Compatibility fix for Instagram video variants without optional dimensions.

gallery-dl 1.32.14 assumes merged video variants always have width/height.
Instagram stories can return only type/url. Keep the chosen MP4 and report
unknown dimensions (0); original dimensions need not describe that variant.
Remove this patch when a pinned upstream release handles these fields.
"""
import copy
from pathlib import Path

from gallery_dl import extractor, version
from gallery_dl.extractor import instagram


def patch():
    if version.__version__ != "1.32.14":
        raise RuntimeError("Review Instagram compatibility patch after gallery-dl upgrade")
    source_path = Path(instagram.__file__)
    source = source_path.read_text()
    for dimension in ("width", "height"):
        old = f'{dimension} = video["{dimension}"]'
        new = f'{dimension} = video.get("{dimension}", 0)'
        if source.count(old) != 1:
            raise RuntimeError(f"Unexpected gallery-dl {dimension} implementation")
        source = source.replace(old, new)
    source_path.write_text(source)


def verify():
    # Reduced response shape observed September 30, 2026; no account data or
    # signed CDN URLs. Exercise the actual installed parser without networking.
    item = {
        "pk": "1234567890123456789", "media_type": 2,
        "original_width": 1080, "original_height": 1920,
        "taken_at": 1790800000,
        "image_versions2": {"candidates": [{
            "width": 640, "height": 1136,
            "url": "https://example.com/preview.jpg",
        }]},
        "video_versions": [
            {"type": 101, "url": "https://example.com/video-first.mp4"},
            {"type": 103, "url": "https://example.com/video-selected.mp4"},
        ],
    }
    post = {"id": "1234", "seen": 1790800000,
            "user": {"pk": "1234", "username": "fixture"}, "items": [item]}
    parser = extractor.find("https://www.instagram.com/stories/fixture/1234567890123456789/")
    parser.initialize()
    parser.videos_dash = False
    parser._warn_video = False
    parsed = parser._parse_post(copy.deepcopy(post))["_files"][0]
    assert parsed["video_url"] == item["video_versions"][-1]["url"]
    assert (parsed["width"], parsed["height"]) == (0, 0)
    item["video_versions"][-1].update(width=720, height=1280)
    parsed = parser._parse_post(copy.deepcopy(post))["_files"][0]
    assert (parsed["width"], parsed["height"]) == (720, 1280)
    item.pop("video_versions")
    parsed = parser._parse_post(copy.deepcopy(post))["_files"][0]
    assert parsed["video_url"] is None
    assert (parsed["width"], parsed["height"]) == (640, 1136)
    print("gallery-dl Instagram video compatibility checks passed")


if __name__ == "__main__":
    import sys
    if "--verify" in sys.argv:
        verify()
    else:
        patch()

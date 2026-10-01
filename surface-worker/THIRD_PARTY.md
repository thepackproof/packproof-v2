# Dependency inventory

The `requirements.lock` records SHA-256 for the exact Linux x86_64 wheels used by this baseline.

| Dependency | Version | Upstream license | Purpose |
| --- | --- | --- | --- |
| CPython | 3.12 (patch recorded per result) | PSF | Runtime |
| NumPy | 2.2.6 | BSD-3-Clause | Numerical arrays and reductions |
| opencv-python-headless / OpenCV | 4.11.0.86 / 4.11.0 | Apache-2.0 (OpenCV); package and bundled components carry additional notices | Image decoding, bounded geometric alignment and classical descriptors |

Redistribution must preserve notices shipped inside the exact wheel distributions, including bundled components; this list is not a replacement for those notices. No learned model weights are distributed. Rebuild and scan a pinned container/runtime before physical qualification. OpenCV reference consulted: https://docs.opencv.org/4.13.0/d1/de0/tutorial_py_feature_homography.html (API primitives only; executing baseline is pinned to 4.11.0).

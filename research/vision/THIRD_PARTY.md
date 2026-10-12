# Dependency and method inventory

The exact installed wheel names, versions, hashes and package license declarations are in `dependency-inventory.json`; the hash lock is `requirements-linux-py312.lock`. No weights or private corpus are bundled.

- OpenCV Python headless 4.11.0.86: Apache-2.0 wrapper/OpenCV distribution; bundled native components retain their licenses. SIFT, homography, optical flow and image primitives. [Official method documentation](https://docs.opencv.org/4.x/d1/de0/tutorial_py_feature_homography.html).
- NumPy 2.2.6 and SciPy 1.15.3: BSD-3-Clause distributions and bundled numerical library notices. SciPy beta quantiles implement exact binomial intervals; the statistical independence assumption is separate.
- Pillow 11.3.0: MIT-CMU distribution. Header-level image size inspection before decode.
- PyCOLMAP 3.13.0: BSD-3-Clause distribution and bundled dependency notices. Maintained bindings in the COLMAP project, not the archived `colmap/pycolmap` project. [Pinned primary API documentation](https://colmap.github.io/legacy/3.13/pycolmap/pycolmap.html).
- Tesseract 5.3.4 (system tool observed): Apache-2.0 with Leptonica/dependency notices. CLI TSV exact readings. [Primary CLI documentation](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html). OCR language-data version remains a deployment-image pinning requirement.
- rfc8785 0.1.4: Apache-2.0; independent Python test implementation for shared canonical vectors. This does not replace the authoritative shared evidence SDK.

Documentation was consulted October 2, 2026. These primary sources support implementation mechanics, not PackProof accuracy or hardware/physical qualification. Distribution review must inspect the complete wheel/native/system notices and exact container image before any later authorized rollout. No production deployment is part of this work.

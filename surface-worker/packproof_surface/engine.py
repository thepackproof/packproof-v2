"""Interpretable CPU baseline. All measurements are private, uncalibrated R&D data."""
from __future__ import annotations
import hashlib
import math
import platform
from pathlib import Path
import cv2
import numpy as np
from .contracts import InputError, canonical, digest, file_digest, media_bytes, read_json, validate_job
from .discovery import propose

PROFILE_DIR = Path(__file__).resolve().parent.parent / "profiles"

def rounded(value):
    return round(float(value), 6) if np.isfinite(value) else None

def load_profile(profile_id):
    # No caller-controlled profile path or threshold overrides. Registry is shipped source.
    if profile_id != "research-paper-v1":
        raise InputError("Unknown frozen profile")
    profile = read_json(PROFILE_DIR / "research-paper-v1.json")
    if profile["qualification"] != "unqualified" or profile["thresholds"] is not None or profile["customerFindingsAllowed"]:
        raise InputError("This research executable cannot enable qualified findings")
    return profile

def method_metadata(profile):
    files = sorted(Path(__file__).parent.glob("*.py"))
    artifacts = {p.name: file_digest(p) for p in files}
    return {"profileId": profile["id"], "profileSha256": digest(profile),
            "extractorVersion": profile["extractorVersion"], "descriptorVersion": profile["descriptorVersion"],
            "scorerVersion": profile["scorerVersion"], "thresholdVersion": profile["thresholdVersion"],
            "coverageVersion": profile["coverageVersion"], "executableSha256": digest(artifacts),
            "artifactInventory": artifacts, "runtime": {"opencv": cv2.__version__, "numpy": np.__version__, "python": platform.python_version(), "platform": platform.system(), "machine": platform.machine()},
            "dependencyLockSha256": file_digest(PROFILE_DIR.parent / "requirements.lock"),
            "determinism": "Single CPU thread, fixed RNG; replay requires the recorded runtime and originals."}

def initialize():
    cv2.setNumThreads(1)
    cv2.setRNGSeed(0)
    cv2.ocl.setUseOpenCL(False)

def decode(root, source, bounds):
    data, (w, h) = media_bytes(root, source, bounds)
    # IMREAD_IGNORE_ORIENTATION preserves the source-pixel coordinate system.
    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_GRAYSCALE | cv2.IMREAD_IGNORE_ORIENTATION)
    if image is None or image.shape != (h, w):
        raise InputError("Decoder rejected image or dimensions changed")
    return image

def crop_region(image, polygon, bounds):
    p = np.float32(polygon)
    h, w = image.shape
    if (p[:, 0] >= w).any() or (p[:, 1] >= h).any() or not cv2.isContourConvex(p):
        raise InputError("Polygon is outside the source or not convex")
    # Require clockwise TL/TR/BR/BL orientation in image coordinates, no mirrored crop.
    if cv2.contourArea(p, oriented=True) <= 0:
        raise InputError("Polygon order must be TL/TR/BR/BL, clockwise in image coordinates")
    width = min(np.linalg.norm(p[1] - p[0]), np.linalg.norm(p[2] - p[3]))
    height = min(np.linalg.norm(p[3] - p[0]), np.linalg.norm(p[2] - p[1]))
    native = [rounded(width), rounded(height)]
    if min(width, height) < bounds["minNativePatchDimension"]:
        return None, {"nativeDimensions": native, "reason": "insufficient_native_pixels"}
    scale = min(1.0, bounds["maxPatchDimension"] / max(width, height))
    out_w, out_h = max(8, int(width * scale)), max(8, int(height * scale))
    target = np.float32([[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]])
    transform = cv2.getPerspectiveTransform(p, target)
    patch = cv2.warpPerspective(image, transform, (out_w, out_h), flags=cv2.INTER_AREA)
    return patch, {"nativeDimensions": native, "sampledDimensions": [out_w, out_h],
                   "sourceToPatch": [[rounded(v) for v in row] for row in transform],
                   "physicalScale": None, "interpolation": "OpenCV INTER_AREA perspective rectification; no upsampling"}

def features(patch, group, process):
    gray = patch.astype(np.float32)
    illumination = cv2.GaussianBlur(gray, (0, 0), 12)
    broad = gray - illumination
    layout = cv2.GaussianBlur(gray, (0, 0), 2.0)
    # The nominal-layout mask is fitted separately per image, never from a mismatch map.
    edges = cv2.Canny(layout.astype(np.uint8), 35, 90)
    excluded = cv2.dilate(edges, np.ones((5, 5), np.uint8)) > 0
    # High clipped-flat areas are unusable. Do not label ordinary white paper as glare.
    local_variance = cv2.GaussianBlur(gray * gray, (0, 0), 2) - cv2.GaussianBlur(gray, (0, 0), 2) ** 2
    clipping = ((gray <= 1) | (gray >= 254)) & (local_variance < 2)
    mask = ~clipping
    if group == "print":
        mask &= ~excluded
        sigmas = {"inkjet": (0.6, 2.0), "laser": (0.7, 2.5),
                  "thermal_transfer": (0.8, 2.8), "direct_thermal": (0.9, 3.0)}
        a, b = sigmas.get(process, (0.8, 2.5))
    else:
        a, b = 0.7, 3.0
        if group == "carton":
            mask &= ~excluded  # broad text and logos must not drive substrate matching
    residual = cv2.GaussianBlur(broad, (0, 0), a) - cv2.GaussianBlur(broad, (0, 0), b)
    # Repeated printer-axis streaks and broad rows/columns are nuisance structure.
    residual -= np.median(residual, axis=0, keepdims=True)
    residual -= np.median(residual, axis=1, keepdims=True)
    residual *= mask.astype(np.float32)
    rms = float(np.sqrt(np.mean(residual[mask] ** 2))) if mask.any() else 0.0
    if rms > 1e-8:
        residual /= rms
    gx, gy = cv2.Sobel(residual, cv2.CV_32F, 1, 0), cv2.Sobel(residual, cv2.CV_32F, 0, 1)
    angles = (np.arctan2(gy, gx) + np.pi) % np.pi
    hist, _ = np.histogram(angles[mask], bins=8, range=(0, np.pi), weights=np.hypot(gx, gy)[mask])
    hist = hist / max(float(hist.sum()), 1e-8)
    quality = {"sharpnessLaplacianVariance": rounded(cv2.Laplacian(gray, cv2.CV_32F).var()),
               "contrastStd": rounded(gray.std()), "usableFraction": rounded(mask.mean()),
               "nominalDesignMaskFraction": rounded(excluded.mean()), "clippedFlatFraction": rounded(clipping.mean()),
               "residualRms": rounded(rms), "glareFraction": None, "motionBlur": None,
               "viewAngle": None, "focusDistance": None, "iso": None,
               "unavailableSignals": ["calibrated_glare", "motion_blur", "optical_resolution", "sensor_noise_separation"]}
    projection = cv2.resize(residual, (24, 24), interpolation=cv2.INTER_AREA)
    descriptor = {"projectionShape": [24, 24], "quantizationScale": 32,
                  "residualProjection": np.rint(np.clip(projection, -3.96875, 3.96875) * 32).astype(np.int8).ravel().tolist(),
                  "orientationHistogram": [rounded(v) for v in hist],
                  "maskSha256": hashlib.sha256(mask.tobytes()).hexdigest(),
                  "recipe": {"illuminationSigma": 12, "bandpassSigmas": [a, b], "nominalEdgeSuppression": True,
                             "printerAxisMedianSuppression": True, "learnedModel": None}}
    return {"patch": patch, "layout": layout, "residual": residual, "mask": mask,
            "quality": quality, "descriptor": descriptor}

def selection_diagnostics(regions, profile):
    tracks = {}
    for region in regions:
        if not region["usableForResearch"]:
            continue
        key = region.get("trackId") or region["id"]
        quality = region["quality"]
        rank = quality["usableFraction"] * math.log1p(quality["sharpnessLaplacianVariance"]) * math.log1p(quality["residualRms"])
        tracks.setdefault((region["group"], key), []).append((rank, region))
    ranked=[]
    for (group, track), members in tracks.items():
        members.sort(key=lambda item: (-item[0], item[1]["id"]))
        descriptor = np.float64(members[0][1]["descriptor"]["residualProjection"])
        repeatability=[]
        for _, region in members[1:]:
            other = np.float64(region["descriptor"]["residualProjection"])
            denominator = np.linalg.norm(descriptor) * np.linalg.norm(other)
            if denominator > 0:
                repeatability.append(float(np.dot(descriptor, other) / denominator))
        ranked.append({"group":group,"trackId":track,"representativeRegionId":members[0][1]["id"],
                       "qualityRank":rounded(members[0][0]),"observations":len(members),
                       "descriptorRepeatabilityDiagnostic":rounded(np.median(repeatability)) if repeatability else None,
                       "physicalDiscriminability":None})
    ranked.sort(key=lambda item:(item["group"],-item["qualityRank"],item["trackId"]))
    return {"policy":"quality-repeatability-budget-0.1.0-unqualified","rankedTracks":ranked,
            "minimumCandidateBudget":profile["groups"],"operatorEffortEstimate":None,
            "limitations":["Ranking is diagnostic. Physical discriminability and useful cost/effort weights require real-copy controls.",
                           "All enrolled regions remain in comparison and coverage; ranking cannot hide contradictory or missing evidence.",
                           "Repeated frames and overlapping regions are not independent support."]}

def extract_capture(capture, root, profile):
    bounds = profile["engineeringBounds"]
    regions = []
    discovery = []
    internal = {}
    generated_budget = max(0, bounds["maxRegions"] - len(capture["regions"]))
    for source in capture["sources"]:
        image = decode(root, source, bounds)
        supplied = [r for r in capture["regions"] if r["sourceId"] == source["sourceId"]]
        hints = [hint for hint in capture.get("hints", []) if hint["sourceId"] == source["sourceId"]]
        generated = []
        for hint in hints:
            proposals, diagnostic = propose(image, hint)
            discovery.append(diagnostic)
            # Keep explicit observations, adding candidates for groups absent or under-covered.
            counts = {g: sum(r["group"] == g for r in supplied) for g in ("print", "carton", "context")}
            for candidate in proposals:
                if generated_budget > 0 and counts[candidate["group"]] < profile["groups"][candidate["group"]] and candidate["id"] not in {r["id"] for r in supplied}:
                    generated.append(candidate)
                    generated_budget -= 1
                    counts[candidate["group"]] += 1
        for region in sorted(supplied + generated, key=lambda r: r["id"]):
            patch, recipe = crop_region(image, region["polygon"], bounds)
            entry = {key: region.get(key) for key in ("id", "sourceId", "group", "polygon", "trackId")}
            entry["process"] = region.get("process", "unknown")
            entry["materialStatus"] = region.get("materialStatus", "declared_unverified")
            entry["provenance"] = region.get("provenance", "supplied_region")
            entry.update({"sourceSha256": source["sha256"], "frameTimeMs": source.get("frameTimeMs"), "rectification": recipe})
            reasons = []
            if patch is None:
                reasons.append(recipe["reason"])
            else:
                computed = features(patch, region["group"], entry["process"])
                q = computed["quality"]
                if q["sharpnessLaplacianVariance"] < bounds["minSharpness"]:
                    reasons.append("low_sharpness")
                if q["contrastStd"] < bounds["minContrast"]:
                    reasons.append("low_contrast")
                if q["usableFraction"] < bounds["minUsableFraction"]:
                    reasons.append("insufficient_unmasked_area")
                if q["residualRms"] < 0.05:
                    reasons.append("insufficient_residual_signal")
                if region["group"] == "print" and entry["process"] in {"unknown", "substrate"}:
                    reasons.append("unknown_print_process")
                entry.update({"quality": q, "descriptor": computed["descriptor"],
                              "patchSha256": hashlib.sha256(patch.tobytes()).hexdigest()})
                internal[region["id"]] = computed
            entry.update({"usableForResearch": not reasons, "qualityReasons": reasons})
            regions.append(entry)
        del image
    template = {"schemaVersion": "surface-template/1", "qualification": "unqualified", "private": True,
                "sourceCommitment": digest(capture), "captureProfileId": capture.get("captureProfileId", "unknown"),
                "acquisition": capture.get("acquisition", "supplemental"), "regions": regions,
                "requiredGroups": capture.get("requiredGroups", ["print", "carton", "context"]),
                "frozenGroupCounts": profile["groups"], "profileSha256": digest(profile), "discovery": discovery,
                "selection": selection_diagnostics(regions, profile)}
    template["artifactSha256"] = digest(template)
    template["canonicalJson"] = canonical({k: v for k, v in template.items() if k != "artifactSha256"}).decode()
    return template, internal

def correlation(a, b, mask):
    if np.count_nonzero(mask) < 64:
        return None
    aa, bb = a[mask].astype(np.float64), b[mask].astype(np.float64)
    aa -= aa.mean()
    bb -= bb.mean()
    den = np.linalg.norm(aa) * np.linalg.norm(bb)
    return rounded(np.dot(aa, bb) / den) if den > 1e-9 else None

def register(reference, observed, bounds):
    target = reference["patch"]
    query = observed["patch"]
    h, w = target.shape
    query = cv2.resize(query, (w, h), interpolation=cv2.INTER_AREA)
    layout_a = reference["layout"].astype(np.uint8)
    layout_b = cv2.GaussianBlur(query, (0, 0), 2).astype(np.uint8)
    orb = cv2.ORB_create(nfeatures=600, edgeThreshold=12, fastThreshold=10)
    ka, da = orb.detectAndCompute(layout_a, None)
    kb, db = orb.detectAndCompute(layout_b, None)
    if da is None or db is None or len(da) < 8 or len(db) < 8:
        return None, {"status": "unavailable", "reason": "insufficient_registration_keypoints"}
    pairs = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(db, da, k=2)
    good = [m for pair in pairs if len(pair) == 2 for m, n in [pair] if m.distance < 0.75 * n.distance]
    if len(good) < bounds["minInliers"]:
        return None, {"status": "unavailable", "reason": "insufficient_geometric_matches", "matches": len(good)}
    src = np.float32([kb[m.queryIdx].pt for m in good])
    dst = np.float32([ka[m.trainIdx].pt for m in good])
    homography, inliers = cv2.findHomography(src, dst, cv2.RANSAC, bounds["maxFitResidualPx"], maxIters=1000, confidence=0.995)
    if homography is None or inliers is None or not np.isfinite(homography).all():
        return None, {"status": "unavailable", "reason": "geometric_fit_failed"}
    homography /= homography[2, 2]
    corners = np.float32([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]]).reshape(-1, 1, 2)
    warped_corners = cv2.perspectiveTransform(corners, homography)
    shifts = np.linalg.norm(warped_corners - corners, axis=2)
    area_ratio = cv2.contourArea(warped_corners, oriented=True) / ((w - 1) * (h - 1))
    projected = cv2.perspectiveTransform(src.reshape(-1, 1, 2), homography).reshape(-1, 2)
    good_mask = inliers.ravel().astype(bool)
    error = np.linalg.norm(projected[good_mask] - dst[good_mask], axis=1)
    fit = {"status": "bounded", "inliers": int(good_mask.sum()), "matches": len(good),
           "inlierFraction": rounded(good_mask.mean()), "fitResidualPx": rounded(np.median(error)),
           "maxCornerShiftPx": rounded(shifts.max()), "areaRatio": rounded(area_ratio),
           "observationResampling": {"from": list(observed["patch"].shape[::-1]), "to": [w, h], "purpose": "alignment interpolation; no recovered optical detail"},
           "homography": [[rounded(v) for v in row] for row in homography]}
    if (good_mask.sum() < bounds["minInliers"] or good_mask.mean() < bounds["minInlierFraction"]
        or shifts.max() > bounds["maxRegistrationCornerShiftPx"] or not 0.65 <= area_ratio <= 1.5
        or abs(homography[2, 0]) > bounds["maxPerspectiveCoefficient"] or abs(homography[2, 1]) > bounds["maxPerspectiveCoefficient"]
        or np.median(error) > bounds["maxFitResidualPx"] or np.linalg.det(homography[:2, :2]) <= 0):
        fit.update(status="unavailable", reason="registration_out_of_bounds")
        return None, fit
    warped = cv2.warpPerspective(query, homography, (w, h), flags=cv2.INTER_LINEAR)
    valid = cv2.warpPerspective(np.ones_like(query), homography, (w, h), flags=cv2.INTER_NEAREST).astype(bool)
    # Refine layout only with translation; no nonrigid fitting to physical residuals.
    translation = np.eye(2, 3, dtype=np.float32)
    try:
        ecc, translation = cv2.findTransformECC(layout_a.astype(np.float32), cv2.GaussianBlur(warped, (0, 0), 2).astype(np.float32), translation,
                                               cv2.MOTION_TRANSLATION, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 1e-4), valid.astype(np.uint8), 3)
        if np.linalg.norm(translation[:, 2]) > bounds["maxLocalTranslationPx"]:
            fit.update(status="unavailable", reason="local_alignment_out_of_bounds")
            return None, fit
        warped = cv2.warpAffine(warped, translation, (w, h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
        valid = cv2.warpAffine(valid.astype(np.uint8), translation, (w, h), flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP).astype(bool)
        fit.update(localTranslationPx=[rounded(v) for v in translation[:, 2]], layoutEcc=rounded(ecc))
    except cv2.error:
        fit["localRefinement"] = "unavailable; bounded coarse transform retained"
    return (warped, valid), fit

def compare_regions(enrollment, observation, original, observed, profile):
    lookup = {r["id"]: r for r in observation["regions"]}
    tracks = {}
    for r in observation["regions"]:
        if r.get("trackId"):
            tracks.setdefault(r["trackId"], []).append(r)
    results = []
    for region in enrollment["regions"]:
        matches = [lookup[region["id"]]] if region["id"] in lookup else tracks.get(region.get("trackId"), [])
        matches = [r for r in matches if r["group"] == region["group"] and r["process"] == region["process"]]
        out = {"enrollmentRegionId": region["id"], "group": region["group"], "trackId": region.get("trackId"),
               "status": "inconclusive", "researchOnly": True, "observations": []}
        if not region["usableForResearch"]:
            out["reasons"] = ["enrollment_quality_insufficient"]
        elif not matches:
            out["reasons"] = ["required_region_not_observed"]
        else:
            for query in matches:
                item = {"observationRegionId": query["id"]}
                if not query["usableForResearch"]:
                    item["reason"] = "observation_quality_insufficient"
                else:
                    aligned, fit = register(original[region["id"]], observed[query["id"]], profile["engineeringBounds"])
                    item["registration"] = fit
                    if aligned is not None:
                        warped, valid = aligned
                        computed = features(warped, region["group"], region["process"])
                        reference = original[region["id"]]
                        mask = reference["mask"] & computed["mask"] & valid
                        item.update(usableFraction=rounded(mask.mean()),
                                    residualCorrelation=correlation(reference["residual"], computed["residual"], mask),
                                    layoutCorrelation=correlation(reference["layout"], computed["layout"], valid),
                                    maskPolicy="Intersection of source clipping/layout masks and geometric support; never mismatch-derived")
                        if mask.mean() < profile["engineeringBounds"]["minUsableFraction"]:
                            item["reason"] = "insufficient_common_unmasked_area"
                out["observations"].append(item)
            scores = [v["residualCorrelation"] for v in out["observations"] if v.get("residualCorrelation") is not None and "reason" not in v]
            out["researchResidualMedian"] = rounded(np.median(scores)) if scores else None
            out["researchResidualRange"] = [min(scores), max(scores)] if scores else None
            out["reasons"] = ["profile_unqualified"] if scores else ["registration_or_quality_unavailable"]
        results.append(out)
    return results

def coverage(enrollment, observation, results, profile):
    required = set(enrollment["requiredGroups"])
    # A caller cannot reduce the profile's assembly requirements by omitting groups.
    required |= set(profile["groups"])
    coverage = {}
    observed_ids = {r["enrollmentRegionId"] for r in results if r.get("researchResidualMedian") is not None}
    for group in sorted(required):
        candidates = [r for r in enrollment["regions"] if r["group"] == group and r["usableForResearch"]]
        tracks = set()
        selected = []
        untracked_source = None
        for r in candidates:
            if not r.get("trackId"):
                if untracked_source is None:
                    untracked_source = r["sourceId"]
                elif r["sourceId"] != untracked_source:
                    continue
            track = r.get("trackId") or r["id"]
            if track in tracks:
                continue
            center = np.mean(np.float32(r["polygon"]), axis=0)
            diagonal = np.linalg.norm(np.float32(r["polygon"])[2] - np.float32(r["polygon"])[0])
            if any(r["sourceId"] == prev["sourceId"] and np.linalg.norm(center - pc) < max(diagonal, pd) * 0.5 for prev, pc, pd in selected):
                continue
            tracks.add(track)
            selected.append((r, center, diagonal))
        seen_tracks = {r.get("trackId") or r["id"] for r, _, _ in selected if r["id"] in observed_ids}
        count = len(seen_tracks) if observation else 0
        coverage[group] = {"required": profile["groups"][group], "usableEnrollmentRegions": len(selected),
                           "observedRegisteredRegions": count, "completeForResearch": count >= profile["groups"][group],
                           "state": "unqualified" if count >= profile["groups"][group] else "insufficient_coverage"}
    return coverage

def run(job, media_root):
    initialize()
    profile = load_profile(job.get("profileId"))
    validate_job(job, profile)
    enrollment, original = extract_capture(job["enrollment"], media_root, profile)
    observation, observed = (extract_capture(job["observation"], media_root, profile) if job["operation"] == "compare" else (None, None))
    results = compare_regions(enrollment, observation, original, observed, profile) if observation else []
    cov = coverage(enrollment, observation, results, profile)
    reasons = ["profile_unqualified", "no_calibrated_physical_thresholds"]
    if observation and set(s["sha256"] for s in job["enrollment"]["sources"]) & set(s["sha256"] for s in job["observation"]["sources"]):
        reasons.append("identical_media_bytes_reused_no_fresh_observation_assurance")
    status = "inconclusive" if enrollment["regions"] else "unsupported"
    scopes = {}
    for scope, groups in {"label": ["print"], "carton": ["carton"], "assembly": ["print", "carton", "context"]}.items():
        gaps = [g for g in groups if not cov[g]["completeForResearch"]]
        scopes[scope] = {"status": status if observation else "not_checked", "reasons": reasons + (["required_coverage_missing:" + ",".join(gaps)] if gaps else []),
                         "claim": None}
    source_digests = [{"role": role, "sourceId": source["sourceId"], "sha256": source["sha256"]}
                      for role in ("enrollment", "observation") if role in job for source in job[role]["sources"]]
    result = {"schemaVersion": "surface-result/1", "jobId": job["jobId"], "operation": job["operation"],
              "status": status if observation else "not_checked", "qualification": "unqualified", "customerFinding": None,
              "method": method_metadata(profile), "sourceDigests": source_digests, "scopeResults": scopes,
              "coverage": cov, "regionResults": results, "limitations": profile["limitations"],
              "researchMetrics": {"physicalAccuracyEstablished": False, "decisionThresholds": None,
                                  "multiFramePolicy": "Per-track median and range; no independent-probability multiplication",
                                  "calibratedConfidence": None, "relationshipSignal": "Context layout only; physical relationship unvalidated"},
              "templates": {"enrollment": enrollment, "observation": observation},
              "privacy": "Private research artifact: descriptors, scores, and source regions must not be in public exports."}
    result["artifactSha256"] = digest(result)
    result["artifactCanonicalJson"] = canonical({k: v for k, v in result.items() if k != "artifactSha256"}).decode()
    return result

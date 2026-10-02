"""CPU-first diagnostic extractors. Observations never certify physical identity."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

POLICY_PATH = Path(__file__).with_name('policy.json')
POLICY = json.loads(POLICY_PATH.read_text())
MAX_PIXELS = 24_000_000
MAX_FRAMES = 120
MAX_VIDEO_SECONDS = 120
MAX_SIDE = 1600


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as file:
        for part in iter(lambda: file.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def finite(value):
    return float(value) if math.isfinite(float(value)) else None


def correlation(a, b):
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    if len(a) < 4 or np.std(a) < 1e-7 or np.std(b) < 1e-7:
        return None
    return finite(np.corrcoef(a, b)[0, 1])


@dataclass
class Frame:
    image: np.ndarray
    source: dict
    frame_index: int
    time_ms: float | None
    original_size: tuple
    scale: float

    def ref(self, polygon=None):
        ref = {key: self.source[key] for key in ('sourceId', 'sha256', 'objectVersionId', 'captureSessionId', 'relationship') if key in self.source}
        ref.update({'frameIndex': self.frame_index, 'timeMs': self.time_ms, 'coordinateSpace': 'stored-decoded-pixels',
                    'decodedDimensions': list(self.original_size), 'analysisScale': self.scale})
        if self.source.get('frameReference') is not None:
            ref['captureTimeAssociation'] = self.source['frameReference']
            ref['associationSemantics'] = 'Concurrent sidecar timing association; not pixel-identical to decoded video.'
        if polygon is not None:
            ref['polygon'] = [[round(float(x) / self.scale, 3), round(float(y) / self.scale, 3)] for x, y in polygon]
        return ref


def resized(image, source, index, time_ms):
    h, w = image.shape[:2]
    if w * h > MAX_PIXELS or w < 16 or h < 16:
        raise ValueError('IMAGE_DIMENSION_LIMIT')
    scale = min(1.0, MAX_SIDE / max(w, h))
    if scale < 1:
        image = cv2.resize(image, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
    return Frame(image, source, index, time_ms, (w, h), scale)


def decode_sources(sources, sampling_hz=2.0):
    """Sample immutable local snapshots; keep intervals explicit and never claim full coverage."""
    frames, coverage = [], []
    for source in sources:
        path = source['_snapshot']
        mime = source.get('mimeType', source.get('mediaType', ''))
        if mime.startswith('image/'):
            with Image.open(path) as probe:
                if probe.width * probe.height > MAX_PIXELS:
                    raise ValueError('IMAGE_DIMENSION_LIMIT')
                if getattr(probe, 'n_frames', 1) != 1:
                    raise ValueError('MULTIFRAME_IMAGE_UNSUPPORTED')
                # Orientation is deliberately not silently transformed by the decoder.
            image = cv2.imread(str(path), cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)
            if image is None:
                raise ValueError('IMAGE_DECODE_FAILED')
            frames.append(resized(image, source, 0, None))
            coverage.append({'sourceId': source['sourceId'], 'type': 'STILL_IMAGE', 'sampleCount': 1,
                             'temporalCoverage': 'NOT_APPLICABLE', 'orientation': 'stored-pixel-orientation',
                             'colorScope': 'LUMA_ONLY_NO_CHROMATIC_MATERIAL_ASSURANCE' if mime == 'image/x-portable-graymap' else 'DECODED_BGR8'})
            continue
        cap = cv2.VideoCapture(str(path), cv2.CAP_FFMPEG)
        try:
            if not cap.isOpened():
                raise ValueError('VIDEO_DECODE_FAILED')
            width, height = cap.get(cv2.CAP_PROP_FRAME_WIDTH), cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
            fps, count = cap.get(cv2.CAP_PROP_FPS), cap.get(cv2.CAP_PROP_FRAME_COUNT)
            if width * height > MAX_PIXELS or fps <= 0 or not np.isfinite(fps) or count <= 0:
                raise ValueError('VIDEO_METADATA_UNSUPPORTED')
            duration = count / fps
            if duration > MAX_VIDEO_SECONDS:
                raise ValueError('VIDEO_DURATION_LIMIT')
            stride = max(1, round(fps / sampling_hz))
            selected = list(range(0, int(count), stride))
            if len(frames) + len(selected) > MAX_FRAMES:
                raise ValueError('FRAME_COUNT_LIMIT')
            refs = []
            # Sequential grab honors decoder packet reordering. POS_MSEC is decoder PTS;
            # index/fps is retained separately and never presented as hardware timing.
            wanted = set(selected)
            for index in range(int(count)):
                if not cap.grab():
                    raise ValueError('VIDEO_TRUNCATED_OR_DECODE_FAILED')
                if index not in wanted:
                    continue
                ok, image = cap.retrieve()
                if not ok:
                    raise ValueError('VIDEO_DECODE_FAILED')
                pts = cap.get(cv2.CAP_PROP_POS_MSEC)
                if not np.isfinite(pts) or (index > 0 and pts <= 0):
                    pts = index * 1000 / fps
                    timing = 'frame-index-estimate'
                else:
                    timing = 'decoder-presentation-time'
                frame = resized(image, source, index, pts)
                frames.append(frame)
                refs.append({'frameIndex': index, 'timeMs': pts, 'timingMethod': timing})
            coverage.append({'sourceId': source['sourceId'], 'type': 'SPARSE_VIDEO_SAMPLES', 'durationMs': duration * 1000,
                             'samplingHz': sampling_hz, 'sampleCount': len(refs), 'samples': refs,
                             'temporalCoverage': 'PARTIAL', 'fullContinuity': False,
                             'gaps': [{'startMs': refs[i]['timeMs'], 'endMs': refs[i+1]['timeMs'], 'reason': 'INTER_SAMPLE_INTERVAL_NOT_EVALUATED'} for i in range(len(refs)-1)] + ([{'startMs': refs[-1]['timeMs'], 'endMs': duration * 1000, 'reason': 'TRAILING_INTERVAL_NOT_EVALUATED'}] if refs else [])})
        finally:
            cap.release()
    if not frames or len(frames) > MAX_FRAMES:
        raise ValueError('FRAME_COUNT_LIMIT')
    return frames, coverage


def full_resolution(frame):
    """Decode one selected immutable sample again, preserving original spatial detail."""
    if frame.scale == 1:
        return frame
    source=frame.source
    if source.get('mimeType',source.get('mediaType','')).startswith('image/'):
        image=cv2.imread(str(source['_snapshot']),cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)
    else:
        cap=cv2.VideoCapture(str(source['_snapshot']),cv2.CAP_FFMPEG)
        try:
            cap.set(cv2.CAP_PROP_POS_FRAMES,frame.frame_index)
            ok,image=cap.read()
            if not ok or abs(cap.get(cv2.CAP_PROP_POS_FRAMES)-(frame.frame_index+1))>.5:
                raise ValueError('SELECTED_FRAME_REDECODE_MISMATCH')
        finally:
            cap.release()
    if image is None or (image.shape[1],image.shape[0])!=frame.original_size:
        raise ValueError('SELECTED_FRAME_REDECODE_MISMATCH')
    return Frame(image,source,frame.frame_index,frame.time_ms,frame.original_size,1.)


def quality(frame):
    gray = cv2.cvtColor(frame.image, cv2.COLOR_BGR2GRAY)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_32F).var())
    clipped = float(np.mean(gray >= 250))
    dark = float(np.mean(gray <= 5))
    dynamic = float(np.percentile(gray, 95) - np.percentile(gray, 5))
    gate = POLICY['quality']
    reasons = []
    if sharpness < gate['minLaplacianVariance']:
        reasons.append('LOW_SPATIAL_DETAIL_OR_BLUR')
    if clipped > gate['maxClippedBrightFraction']:
        reasons.append('HIGH_BRIGHT_CLIPPING_OR_WHITE_SURFACE')
    if dynamic < gate['minDynamicRange']:
        reasons.append('LOW_DYNAMIC_RANGE')
    return {'laplacianVariance': sharpness, 'brightClippedFraction': clipped, 'darkClippedFraction': dark,
            'dynamicRangeP95P5': dynamic, 'screeningUsable': not reasons, 'reasons': reasons,
            'semantics': 'Engineering image diagnostics; brightness clipping alone is not a calibrated glare detector.'}


class Artifacts:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.items = []
        self.bytes = 0

    def add(self, name, value, refs, kind='application/json'):
        if '/' in name or '\\' in name or name.startswith('.'):
            raise ValueError('BAD_ARTIFACT_NAME')
        path = self.directory / name
        if path.exists():
            raise ValueError('ARTIFACT_ALREADY_EXISTS')
        if kind == 'image/png':
            ok, encoded = cv2.imencode('.png', value)
            if not ok:
                raise ValueError('ARTIFACT_ENCODING_FAILED')
            data = encoded.tobytes()
        else:
            data = json.dumps(value, sort_keys=True, allow_nan=False, separators=(',', ':')).encode()
        self.bytes += len(data)
        if self.bytes > 16 * 1024 * 1024:
            raise ValueError('ARTIFACT_QUOTA_EXCEEDED')
        with path.open('xb') as file:
            file.write(data)
        record = {'artifactId': name, 'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'byteLength': len(data),
                  'mimeType': kind, 'sourceRefs': refs, 'retention': 'INHERIT_SOURCES_AND_AUTHORIZED_PURPOSE',
                  'access': 'PRIVATE_ORIGINAL_AUTHORIZATION_REQUIRED'}
        self.items.append(record)
        return record


def observation(kind, refs, value, **extras):
    channels = {'IDENTIFIER_OBSERVED': 'identifier', 'MATERIAL_REGION_DIAGNOSTIC': 'surface',
                'VISIBLE_CONDITION_DIAGNOSTIC': 'condition', 'SPARSE_GEOMETRY_RECONSTRUCTED': 'condition'}
    channel = {'channel': channels[kind], 'findingState': 'RECORDED' if kind == 'IDENTIFIER_OBSERVED' else 'INCONCLUSIVE', 'qualified': False} if kind in channels else {}
    return {'type': kind, 'sourceRefs': refs, 'value': value, **channel,
            'method': 'packproof.cpu-vision.v1', 'confidence': None,
            'confidenceSemantics': 'Not calibrated; no physical probability is emitted.', **extras}


def pilot(frames, artifacts, parameters):
    measurements = [quality(frame) for frame in frames]
    # Temporal bins preserve the whole interval, including low-quality context.
    usable = [i for i, value in enumerate(measurements) if value['screeningUsable']]
    selected = sorted(usable, key=lambda i: measurements[i]['laplacianVariance'], reverse=True)[:4]
    context = sorted(set([0, len(frames)//2, len(frames)-1]))
    records = []
    for index in sorted(set(selected + context)):
        frame = frames[index]
        records.append(artifacts.add(f'quality-frame-{index}.png', frame.image, [frame.ref()], 'image/png'))
    observations = [observation('FRAME_QUALITY', [frame.ref()], {**measurement, 'selectedDetail': i in selected, 'retainedContext': i in context})
                    for i, (frame, measurement) in enumerate(zip(frames, measurements))]
    return {'findingState': 'RECORDED', 'observations': observations,
            'diagnostics': {'usableCount': len(usable), 'attemptedCount': len(frames), 'selectedCount': len(selected), 'cameraControlsApplied': False},
            'limitations': ['Quality thresholds are unqualified research screening values.', 'Context and low-quality samples remain visible; selection does not establish completeness.']}


def region_mask(shape, polygon):
    mask = np.zeros(shape[:2], dtype=np.uint8)
    cv2.fillPoly(mask, [np.array(polygon, dtype=np.int32)], 255)
    return mask


def parse_regions(frame, parameters):
    regions = parameters.get('regions', [])
    if not isinstance(regions, list) or len(regions) > 16:
        raise ValueError('REGION_LIMIT')
    checked = []
    width, height = frame.original_size
    for i, region in enumerate(regions):
        group = region.get('group')
        polygon = np.array(region.get('polygon', []), dtype=np.float32)
        if group not in ('label', 'carton', 'support', 'face') or polygon.ndim != 2 or polygon.shape[1] != 2 or not 3 <= len(polygon) <= 16:
            raise ValueError('INVALID_REGION')
        if not np.isfinite(polygon).all() or (polygon[:, 0] < 0).any() or (polygon[:, 1] < 0).any() or (polygon[:, 0] >= width).any() or (polygon[:, 1] >= height).any():
            raise ValueError('REGION_OUT_OF_BOUNDS')
        checked.append({'regionId': region.get('regionId', f'region-{i}'), 'group': group,
                        'polygon': polygon * frame.scale, 'material': region.get('material', 'UNKNOWN')})
    return checked


def register(first, second, support_mask=None):
    gray_a, gray_b = [cv2.cvtColor(x.image, cv2.COLOR_BGR2GRAY) for x in (first, second)]
    sift = cv2.SIFT_create(nfeatures=2500)
    key_a, desc_a = sift.detectAndCompute(gray_a, support_mask)
    key_b, desc_b = sift.detectAndCompute(gray_b, None)
    if desc_a is None or desc_b is None or min(len(key_a), len(key_b)) < 12:
        return None, {'reason': 'INSUFFICIENT_REGISTRATION_FEATURES'}
    matches = cv2.BFMatcher(cv2.NORM_L2).knnMatch(desc_b, desc_a, k=2)
    good = [pair[0] for pair in matches if len(pair) == 2 and pair[0].distance < .72 * pair[1].distance]
    if len(good) < 12:
        return None, {'reason': 'INSUFFICIENT_REGISTRATION_MATCHES', 'matches': len(good)}
    src = np.float32([key_b[x.queryIdx].pt for x in good])
    dst = np.float32([key_a[x.trainIdx].pt for x in good])
    matrix, mask = cv2.findHomography(src, dst, cv2.RANSAC, 2.5, maxIters=2000, confidence=.995)
    if matrix is None or mask is None or not np.isfinite(matrix).all():
        return None, {'reason': 'REGISTRATION_FAILED'}
    inliers = mask.ravel().astype(bool)
    residual = np.linalg.norm(cv2.perspectiveTransform(src[:, None, :], matrix).reshape(-1, 2) - dst, axis=1)
    med = float(np.median(residual[inliers])) if inliers.any() else float('inf')
    ratio = float(inliers.mean())
    gate = POLICY['registration']
    diagnostics = {'matches': len(good), 'inliers': int(inliers.sum()), 'inlierRatio': ratio, 'medianResidualPixels': finite(med),
                   'homographySecondToFirst': matrix.tolist(), 'registrationMethod': 'SIFT_RATIO_RANSAC_HOMOGRAPHY'}
    if int(inliers.sum()) < gate['minInliers'] or ratio < gate['minInlierRatio'] or med > gate['maxMedianResidualPixels']:
        return None, {**diagnostics, 'reason': 'REGISTRATION_SCREEN_FAILED'}
    h, w = gray_b.shape
    corners = np.float32([[[0,0],[w-1,0],[w-1,h-1],[0,h-1]]])
    mapped = cv2.perspectiveTransform(corners, matrix)[0]
    area = cv2.contourArea(mapped, oriented=True)
    target_area = first.image.shape[0] * first.image.shape[1]
    if area <= 0 or not .1 <= area / target_area <= 10 or not cv2.isContourConvex(mapped):
        return None, {**diagnostics, 'reason': 'IMPLAUSIBLE_OR_MIRRORED_REGISTRATION'}
    return matrix, diagnostics


def residual(image, group):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)
    band = cv2.GaussianBlur(gray, (0,0), .7) - cv2.GaussianBlur(gray, (0,0), 2.2)
    # Remove row/column common-mode components as a printer/camera shortcut ablation.
    band -= np.median(band, axis=0)[None, :]
    band -= np.median(band, axis=1)[:, None]
    gradient = cv2.magnitude(cv2.Sobel(gray, cv2.CV_32F, 1,0), cv2.Sobel(gray, cv2.CV_32F, 0,1))
    content = cv2.dilate((gradient > 160).astype(np.uint8), np.ones((5,5), np.uint8))
    usable = (content == 0) if group == 'label' else np.ones(gray.shape, bool)
    return band, usable, gray


def comparison_pair(frames,parameters=None):
    groups = {}
    for frame in frames:
        groups.setdefault(frame.source['sourceId'], []).append(frame)
    if len(groups) != 2:
        return None
    pair = tuple(max(group, key=lambda frame: quality(frame)['laplacianVariance']) for group in groups.values())
    expected=(parameters or {}).get('enrollmentFrameRef')
    if expected:
        candidates=[frame for frame in frames if frame.source['sourceId']==expected.get('sourceId') and frame.frame_index==expected.get('frameIndex') and frame.source['sha256']==str(expected.get('sha256','')).removeprefix('sha256:')]
        if len(candidates)!=1 or pair[0].source['sourceId']!=expected.get('sourceId'):
            raise ValueError('FROZEN_ENROLLMENT_FRAME_UNAVAILABLE')
        pair=(candidates[0],pair[1])
    return pair


def proofprint(frames, artifacts, parameters):
    pair = comparison_pair(frames,parameters)
    if pair is None:
        return {'findingState': 'NOT_CHECKED', 'observations': [], 'diagnostics': {'reason': 'LATER_SOURCE_REQUIRED'}, 'limitations': ['A single enrollment cannot establish correspondence.']}
    first, second = pair
    regions = parse_regions(first, parameters)
    auto_proposal = None
    if not regions:
        from enrollment import propose
        auto_proposal = propose(first)
        if not auto_proposal['available']:
            return {'findingState': 'INCONCLUSIVE', 'observations': [], 'diagnostics': {'reason': 'PASSIVE_TYPED_REGION_ASSOCIATION_UNAVAILABLE', 'proposal': auto_proposal}, 'limitations': ['A single unambiguous geometric label/carton proposal was unavailable. No whole-frame physical match is substituted.']}
        regions = parse_regions(first, {'regions': auto_proposal['regions']})
    matrix, registration = register(first, second)
    refs = [first.ref(), second.ref()]
    if matrix is None:
        return {'findingState': 'INCONCLUSIVE', 'observations': [], 'diagnostics': registration, 'limitations': ['Registration failed; no physical comparison was made.']}
    native_first, native_second = full_resolution(first), full_resolution(second)
    native_matrix = np.diag([1 / first.scale, 1 / first.scale, 1.]) @ matrix @ np.diag([second.scale, second.scale, 1.])
    registration['homographyNativeSecondToFirst'] = native_matrix.tolist()
    observations = []
    for index, region in enumerate(regions):
        if region['group'] not in ('label', 'carton'):
            continue
        native_polygon = region['polygon'] / first.scale
        x,y,w,h = cv2.boundingRect(native_polygon.astype(np.float32))
        # Keep native sensor/video detail in crops; only registration/localization is resized.
        patch_first = native_first.image[y:y+h,x:x+w]
        local_matrix = np.array([[1.,0.,-x],[0.,1.,-y],[0.,0.,1.]]) @ native_matrix
        aligned = cv2.warpPerspective(native_second.image, local_matrix, (w,h))
        valid = cv2.warpPerspective(np.ones(native_second.image.shape[:2], np.uint8)*255, local_matrix, (w,h)) == 255
        mask = region_mask(patch_first.shape, native_polygon - [x,y]) > 0
        ra, ma, ga = residual(patch_first, region['group'])
        rb, mb, gb = residual(aligned, region['group'])
        pixels = mask & valid & ma & mb
        n = int(pixels.sum())
        value = {'regionId': region['regionId'], 'group': region['group'], 'material': region['material'],
                 'qualified': False, 'findingState': 'INCONCLUSIVE', 'usableResidualPixels': n,
                 'maskCoverage': n / max(1, int(mask.sum())), 'textureCorrelation': correlation(ra[pixels], rb[pixels]) if n >= 256 else None,
                 'contentOnlyCorrelation': correlation(ga[mask & valid], gb[mask & valid]),
                 'residualEnergyFirst': float(np.std(ra[pixels])) if n else None,
                 'residualEnergySecond': float(np.std(rb[pixels])) if n else None,
                 'scaleStatus': 'UNCALIBRATED', 'pixelSampling': 'ORIGINAL_DECODED_SOURCE_PIXELS', 'physicalMatchProbability': None}
        observations.append(observation('MATERIAL_REGION_DIAGNOSTIC', [native_first.ref(native_polygon), native_second.ref()], value))
        artifacts.add(f'region-{index}-residual-mask.png', (pixels.astype(np.uint8)*255), refs, 'image/png')
        artifacts.add(f'region-{index}-first.png', patch_first, [native_first.ref(native_polygon)], 'image/png')
        artifacts.add(f'region-{index}-registered-second.png', aligned, refs, 'image/png')
        descriptor = {'descriptorVersion': 'masked-bandpass-pool16.v1', 'scaleStatus': 'UNCALIBRATED',
                      'first': cv2.resize((ra*pixels), (16,16), interpolation=cv2.INTER_AREA).ravel().tolist(),
                      'second': cv2.resize((rb*pixels), (16,16), interpolation=cv2.INTER_AREA).ravel().tolist(),
                      'maskPolicy': 'strong-print-edges-suppressed; row-and-column-common-modes-subtracted'}
        artifacts.add(f'region-{index}-descriptors.json', descriptor, refs)
    required = POLICY['requiredRegionGroups']
    groups = sorted(set(x['value']['group'] for x in observations))
    artifacts.add('registration.json', registration, refs)
    return {'findingState': 'INCONCLUSIVE', 'observations': observations,
            'diagnostics': {'registration': registration, 'autoRegionProposal': auto_proposal, 'requiredGroups': required, 'observedGroups': groups,
                            'missingGroups': [x for x in required if x not in groups], 'qualified': False, 'enrollmentPolicyFrozen': POLICY['policyVersion'], 'expectedEnrollmentDigest': parameters.get('expectedEnrollmentDigest'), 'enrollmentFrameRef': parameters.get('enrollmentFrameRef')},
            'limitations': ['Residual correlation is a diagnostic, not calibrated identity evidence.',
                           'Printed content is suppressed but camera noise, printing process, material and resampling shortcuts still require physical attack validation.',
                           'Label and carton groups stay separate. Missing carton never becomes package consistency.',
                           'Matching material does not establish unopened packaging, contents or custody.']}


def condition(frames, artifacts, parameters):
    pair = comparison_pair(frames,parameters)
    if pair is None:
        return {'findingState': 'NOT_CHECKED', 'observations': [], 'diagnostics': {'reason': 'PAIR_REQUIRED'}, 'limitations': []}
    first, second = pair
    regions = parse_regions(first, parameters)
    supports = [region for region in regions if region['group'] == 'support']
    if not supports:
        return {'findingState': 'INCONCLUSIVE', 'observations': [], 'diagnostics': {'reason': 'UNCHANGED_SUPPORT_REGION_REQUIRED'},
                'limitations': ['Condition registration requires an explicitly attributed unchanged support region; whole-face warping could hide a deformation.']}
    mask = np.maximum.reduce([region_mask(first.image.shape, x['polygon']) for x in supports])
    matrix, registration = register(first, second, mask)
    if matrix is None:
        return {'findingState': 'INCONCLUSIVE', 'observations': [], 'diagnostics': registration, 'limitations': ['No stable face registration; visible condition is not compared.']}
    h,w = first.image.shape[:2]
    aligned = cv2.warpPerspective(second.image, matrix, (w,h))
    valid = cv2.warpPerspective(np.ones(second.image.shape[:2], np.uint8)*255, matrix, (w,h)) == 255
    a,b = [cv2.cvtColor(x, cv2.COLOR_BGR2GRAY).astype(float) for x in (first.image,aligned)]
    support = (mask > 0) & valid
    offset = float(np.median(a[support]-b[support]))
    difference = np.abs(a-np.clip(b+offset,0,255))
    noise = float(np.median(difference[support]))
    mad = float(np.median(np.abs(difference[support]-noise)))
    # This is repeat-region image noise, not repeated physical metrology calibration.
    threshold = max(12.0, noise + 6*mad)
    changed = (difference > threshold) & valid & ~support
    refs = [first.ref(),second.ref()]
    heat = cv2.applyColorMap(np.clip(difference*4,0,255).astype(np.uint8), cv2.COLORMAP_INFERNO)
    heat[~valid] = 0
    artifacts.add('condition-difference.png',heat,refs,'image/png')
    artifacts.add('condition-observed-mask.png',valid.astype(np.uint8)*255,refs,'image/png')
    artifacts.add('condition-registered-second.png',aligned,refs,'image/png')
    return {'findingState': 'INCONCLUSIVE', 'observations': [observation('VISIBLE_CONDITION_DIAGNOSTIC',refs,{
        'mode':'REGISTERED_2D_FACE','registration':registration,'photometricOffsetGrayLevels':offset,
        'supportNoiseMedianGrayLevels':noise,'supportNoiseMadGrayLevels':mad,'screeningThresholdGrayLevels':threshold,
        'changedPixelFractionInObservedArea':float(changed.sum()/max(1,valid.sum())), 'observedPixelFraction':float(valid.mean()),
        'metricScale':'UNKNOWN','metricDimensions':None,'minimumDetectablePhysicalChange':None,'qualified':False})],
        'diagnostics':{'mode':'condition2d','unobservedFaces':'ALL_NOT_EXPLICITLY_SOURCED'},
        'limitations':['Appearance difference may arise from light, viewpoint, compression or material change; no damage finding is qualified.',
                       'A single projective transform fits unchanged supports; no deformable registration is used.',
                       'This is a 2D observed condition map, not a complete 3D twin.']}


def ocr(frame):
    if not shutil.which('tesseract'):
        return [], 'TESSERACT_NOT_INSTALLED'
    ok, encoded = cv2.imencode('.png',frame.image)
    if not ok:
        raise ValueError('OCR_ENCODE_FAILED')
    process = subprocess.run(['tesseract','stdin','stdout','--psm','11','tsv'], input=encoded.tobytes(),
                             capture_output=True,timeout=8,check=False)
    if process.returncode:
        return [], 'OCR_EXECUTION_FAILED'
    rows = []
    for row in csv.DictReader(io.StringIO(process.stdout.decode('utf-8',errors='replace')),delimiter='\t'):
        text = row.get('text','').strip()
        conf = float(row.get('conf','-1'))
        if not text or conf < 0:
            continue
        x,y,w,h = [int(row[key]) for key in ('left','top','width','height')]
        rows.append({'observedText':text,'normalizedText':None,'engineConfidence':conf,
                     'polygon':[[x,y],[x+w,y],[x+w,y+h],[x,y+h]],'alternatives':[],
                     'readingUncertainty':'Engine confidence is uncalibrated; alternatives unavailable.'})
    return rows, None


def sight(frames, artifacts, parameters, trusted_model=None):
    observations, previous, failures = [], None, []
    # OCR bounded to six frames while motion samples remain independently source-linked.
    ocr_indices = sorted(set(np.linspace(0,len(frames)-1,min(6,len(frames))).astype(int).tolist()))
    reads = []
    for i,frame in enumerate(frames):
        if i in ocr_indices:
            words, error = ocr(frame)
            if error:
                failures.append({'sourceRef':frame.ref(),'reason':error})
            if words:
                for word in words[:128]:
                    polygon = word.pop('polygon')
                    reads.append((word['observedText'],frame.ref(polygon)))
                    observations.append(observation('IDENTIFIER_OBSERVED',[frame.ref(polygon)],word))
                artifacts.add(f'ocr-context-{i}.png',frame.image,[frame.ref()],'image/png')
        gray = cv2.cvtColor(frame.image,cv2.COLOR_BGR2GRAY)
        if previous is not None and previous[0].source['sourceId'] == frame.source['sourceId']:
            prior, prior_gray = previous
            points = cv2.goodFeaturesToTrack(prior_gray,maxCorners=80,qualityLevel=.02,minDistance=8)
            tracked, state, _ = cv2.calcOpticalFlowPyrLK(prior_gray,gray,points,None) if points is not None else (None,None,None)
            retained = int(state.sum()) if state is not None else 0
            total = len(points) if points is not None else 0
            observations.append(observation('COARSE_IMAGE_FEATURE_TRACK',[prior.ref(),frame.ref()],{
                'candidateFeatureCount':total,'retainedFeatureCount':retained,'association':'IMAGE_FEATURES_ONLY',
                'physicalObjectIdentity':None,'fullContinuity':False,'visibilityState':'UNRESOLVED',
                'medianFlowPixels':finite(np.median(np.linalg.norm(tracked[state.ravel()==1]-points[state.ravel()==1],axis=2))) if retained else None}))
            if retained < max(8,total*.3):
                observations.append(observation('IMAGE_FEATURE_TRACK_LOST',[prior.ref(),frame.ref()],{
                    'reason':'IMAGE_FEATURE_TRACK_LOST_OR_INSUFFICIENT','itemIdentity':'UNASSOCIATED','startMs':prior.time_ms,'endMs':frame.time_ms}))
        previous=(frame,gray)
    # Exact text consensus is descriptive only. Never autocorrect to expected order text.
    groups = {}
    for text,ref in reads:
        groups.setdefault(text,[]).append(ref)
    consensus = [{'observedText':text,'sourceRefs':refs,'distinctFrames':len(set((x['sourceId'],x['frameIndex']) for x in refs))} for text,refs in groups.items()]
    from segmentation import annotations,background_masks
    observations.extend(annotations(frames,artifacts,parameters))
    observations.extend(background_masks(frames,artifacts,parameters))
    model_diagnostics={'state':'NOT_CONFIGURED','qualified':False}
    if trusted_model is not None:
        from action_model import features_from_images,predict_features
        model=trusted_model['model'];model_diagnostics={'state':'PINNED_UNQUALIFIED_MODEL','sha256':trusted_model['sha256'],'releaseId':trusted_model.get('releaseId'),'qualified':False,'windowCount':0}
        groups={}
        for frame in frames:
            if frame.time_ms is not None:
                groups.setdefault(frame.source['sourceId'],[]).append(frame)
        for group in groups.values():
            ordered=sorted(group,key=lambda frame:frame.time_ms)
            for index in range(0,max(0,len(ordered)-2),3):
                window=ordered[index:index+3]
                record={'recordId':f'window-{index}','frames':[{'sha256':frame.source['sha256'],'timeMs':frame.time_ms} for frame in window]}
                prediction=predict_features(model,features_from_images([frame.image for frame in window]),record)
                observations.append(observation('ACTION_MODEL_CANDIDATE',[frame.ref() for frame in window],{**prediction,'modelSha256':trusted_model['sha256'],'modelReleaseId':trusted_model.get('releaseId'),'fullContinuity':False}))
                model_diagnostics['windowCount']+=1
    return {'findingState':'RECORDED','observations':observations,'diagnostics':{'modelInference':model_diagnostics,'ocrFailures':failures,'exactTextConsensus':consensus,
            'actionClassifierQualified':False,'objectIdentityQualified':False,'fullContinuity':False},
            'limitations':['Sparse image-feature tracks do not identify a parcel or establish custody through an occlusion.',
                           'Action and closure events are not emitted without a separately qualified model.',
                           'OCR observes visible strings; it does not authenticate serial stickers.']}


def motion_parallax(first, second):
    """Compare projective and epipolar fits; never interpret as a liveness verdict."""
    detector=cv2.SIFT_create(nfeatures=1200)
    pairs=[detector.detectAndCompute(cv2.cvtColor(f.image,cv2.COLOR_BGR2GRAY),None) for f in (first,second)]
    if any(desc is None for _,desc in pairs):
        return {'state':'UNAVAILABLE','reason':'INSUFFICIENT_FEATURES'}
    (ka,da),(kb,db)=pairs
    matches=cv2.BFMatcher(cv2.NORM_L2).knnMatch(da,db,k=2)
    good=[x[0] for x in matches if len(x)==2 and x[0].distance<.72*x[1].distance]
    if len(good)<12:
        return {'state':'UNAVAILABLE','reason':'INSUFFICIENT_MATCHES'}
    a=np.float32([ka[m.queryIdx].pt for m in good]); b=np.float32([kb[m.trainIdx].pt for m in good])
    homography,hmask=cv2.findHomography(a,b,cv2.RANSAC,2.5)
    fundamental,fmask=cv2.findFundamentalMat(a,b,cv2.FM_RANSAC,1.5,.995)
    residuals=np.linalg.norm(cv2.perspectiveTransform(a[:,None,:],homography).reshape(-1,2)-b,axis=1) if homography is not None else None
    return {'state':'DIAGNOSTIC_ONLY','matchedPoints':len(good),
            'homographyInlierFraction':float(hmask.mean()) if hmask is not None else None,
            'fundamentalInlierFraction':float(fmask.mean()) if fmask is not None else None,
            'homographyResidualP90Pixels':float(np.percentile(residuals,90)) if residuals is not None else None,
            'medianMotionPixels':float(np.median(np.linalg.norm(a-b,axis=1))),
            'parallaxConclusion':None,'qualified':False,
            'limitation':'Epipolar versus planar residuals can reflect tracking error or object motion; no calibrated depth/replay decision.'}


def live(frames, artifacts, parameters):
    challenge = parameters.get('challenge')
    if not challenge:
        return {'findingState':'NOT_CHECKED','observations':[],'diagnostics':{'responseState':'NOT_CHECKED','reason':'FRESH_BOUND_CHALLENGE_NOT_SUPPLIED'},'limitations':['Offline passive footage cannot establish a fresh server challenge.']}
    commands = challenge.get('commands',[])
    if not isinstance(commands,list) or not 4 <= len(commands) <= 32:
        raise ValueError('CHALLENGE_COMMAND_LIMIT')
    times,levels = [],[]
    for command in commands:
        time,level = command.get('timeMs'),command.get('level')
        if not isinstance(time,(int,float)) or not isinstance(level,(int,float)) or not math.isfinite(time) or not math.isfinite(level) or not 0<=level<=1 or time<0 or time>120000:
            raise ValueError('INVALID_CHALLENGE_COMMAND')
        times.append(time); levels.append(level)
    if any(b-a<1000 for a,b in zip(times,times[1:])):
        raise ValueError('UNSAFE_OR_UNORDERED_CHALLENGE_SCHEDULE')
    # This worker never executes illumination. Gradual lab command metadata is
    # measurement input and the backend must separately validate freshness/binding.
    timed = [f for f in frames if f.time_ms is not None and times[0] <= f.time_ms <= times[-1]]
    if len(timed)<4 or len(set(f.source['sourceId'] for f in timed)) != 1:
        return {'findingState':'INCONCLUSIVE','observations':[],'diagnostics':{'responseState':'INCONCLUSIVE','reason':'INSUFFICIENT_SINGLE_RESPONSE_TIMELINE'},'limitations':['Still images or multiple unbound source clocks cannot establish response timing.']}
    rows=[]
    for frame in timed:
        gray=cv2.cvtColor(frame.image,cv2.COLOR_BGR2GRAY)
        tiles=[float(np.mean(tile)) for strip in np.array_split(gray,2,axis=0) for tile in np.array_split(strip,2,axis=1)]
        expected=float(np.interp(frame.time_ms,times,levels))
        rows.append({'sourceRef':frame.ref(),'timeMs':frame.time_ms,'commandedLevelInterpolated':expected,'meanLuminance':float(gray.mean()),'tileLuminance':tiles,'quality':quality(frame)})
    expected=[r['commandedLevelInterpolated'] for r in rows]
    tile_corr=[correlation(expected,[r['tileLuminance'][i] for r in rows]) for i in range(4)]
    registration,detail=register(timed[0],timed[-1])
    diagnostics={'responseState':'INCONCLUSIVE','challengeId':challenge.get('challengeId'),'freshnessValidatedByWorker':False,
                 'illuminationCorrelation':correlation(expected,[r['meanLuminance'] for r in rows]),'spatialTileCorrelations':tile_corr,
                 'motionPlanarFit':detail,'motionParallaxDiagnostic':motion_parallax(timed[0],timed[-1]),'parallaxDiscriminationQualified':False,'livenessProbability':None,'qualified':False}
    artifacts.add('response-measurements.json',rows,[f.ref() for f in timed])
    return {'findingState':'INCONCLUSIVE','observations':[observation('SCENE_RESPONSE_DIAGNOSTIC',[f.ref() for f in timed],diagnostics)],'diagnostics':diagnostics,
            'limitations':['A print or screen can reflect changing light; correlation does not establish liveness.',
                           'Command timestamps are not measured optical emission and exposure metadata may be unavailable.',
                           'Planar-fit residual is a motion diagnostic, not a qualified replay discriminator.',
                           'Only backend-validated challenge binding can establish request freshness. No light is emitted by this worker.']}


def appearance(frames,artifacts,parameters):
    pair=comparison_pair(frames)
    if pair is None:
        return {'findingState':'NOT_CHECKED','observations':[],'diagnostics':{'reason':'TWO_DISTINCT_SOURCES_REQUIRED'},'limitations':['Appearance comparison needs two authorized sources.']}
    first,second=pair
    histograms=[]
    for frame in pair:
        histogram=cv2.calcHist([frame.image],[0,1,2],None,[8,8,8],[0,256,0,256,0,256]).ravel()
        histogram/=max(float(histogram.sum()),1)
        histograms.append(histogram)
    matrix,registration=register(first,second)
    refs=[first.ref(),second.ref()]
    value={'histogramIntersection':float(np.minimum(*histograms).sum()),
           'histogramCorrelation':correlation(*histograms),'registration':registration,
           'registeredLumaCorrelation':None,'qualified':False,'physicalInstanceConclusion':None,
           'scope':'Broad appearance of observed frames; same-model different objects can look alike.'}
    if matrix is not None:
        h,w=first.image.shape[:2]
        aligned=cv2.warpPerspective(second.image,matrix,(w,h))
        valid=cv2.warpPerspective(np.ones(second.image.shape[:2],np.uint8)*255,matrix,(w,h))==255
        a=cv2.cvtColor(first.image,cv2.COLOR_BGR2GRAY);b=cv2.cvtColor(aligned,cv2.COLOR_BGR2GRAY)
        value['registeredLumaCorrelation']=correlation(a[valid],b[valid])
        value['observedOverlapFraction']=float(valid.mean())
        artifacts.add('appearance-registered-second.png',aligned,refs,'image/png')
    return {'findingState':'RECORDED','observations':[observation('APPEARANCE_DIAGNOSTIC',refs,value,channel='appearance',findingState='INCONCLUSIVE',qualified=False)],
            'diagnostics':{'qualified':False,'method':'COLOR_HISTOGRAM_AND_CONSTRAINED_REGISTRATION'},
            'limitations':['Histogram and registered image resemblance do not identify a physical item, authenticate a serial or prove unchanged contents.',
                           'Lighting, viewpoint, occlusion and image quality can change these uncalibrated measurements.']}

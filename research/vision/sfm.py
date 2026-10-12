"""Pinned COLMAP sparse reconstruction. CPU-only; no neural/invented geometry."""
from __future__ import annotations
import math
from pathlib import Path
import tempfile

import cv2
import numpy as np

from engine import finite, observation, quality, region_mask


def fit_planes(points):
    """Deterministic RANSAC exploratory planes, in arbitrary reconstruction units."""
    rng=np.random.default_rng(173)
    remaining=np.arange(len(points)); planes=[]
    extent=float(np.linalg.norm(np.ptp(points,axis=0))) if len(points) else 0
    threshold=max(extent*.008,1e-8)
    for _ in range(3):
        if len(remaining)<20:
            break
        current=points[remaining]; best=np.array([],dtype=int); best_normal=None
        for _ in range(150):
            ids=rng.choice(len(current),3,replace=False)
            normal=np.cross(current[ids[1]]-current[ids[0]],current[ids[2]]-current[ids[0]])
            norm=np.linalg.norm(normal)
            if norm<1e-10:
                continue
            normal/=norm
            distance=current@normal-float(current[ids[0]]@normal)
            subset=np.flatnonzero(np.abs(distance)<threshold)
            if len(subset)>len(best):
                best=subset; best_normal=normal
        if len(best)<20:
            break
        center=current[best].mean(axis=0)
        _,_,vh=np.linalg.svd(current[best]-center,full_matrices=False)
        normal=vh[-1]
        residuals=np.abs((current[best]-center)@normal)
        planes.append({'normal':normal.tolist(),'offset':float(-center@normal),'pointIndices':remaining[best].tolist(),
                       'residualMedian':float(np.median(residuals)),'residualP95':float(np.percentile(residuals,95)),
                       'units':'ARBITRARY_RECONSTRUCTION_UNITS','inferredSurface':True,'faceIdentity':None})
        remaining=np.delete(remaining,best)
    return planes


def reconstruct(frames,artifacts,parameters):
    try:
        import pycolmap
    except ImportError:
        return {'findingState':'UNSUPPORTED','observations':[], 'diagnostics':{'reason':'PINNED_PYCOLMAP_DEPENDENCY_UNAVAILABLE'},
                'limitations':['Install requirements-sfm.txt in the isolated reconstruction environment; use the 2D mode meanwhile.']}
    if pycolmap.__version__!='3.13.0':
        raise ValueError('UNPINNED_RECONSTRUCTION_VERSION')
    if not 3<=len(frames)<=12:
        return {'findingState':'INCONCLUSIVE','observations':[],'diagnostics':{'reason':'REQUIRE_3_TO_12_OBJECT_MASKED_VIEWS'},'limitations':['Sparse reconstruction requires overlapping distinct views.']}
    masks=parameters.get('objectMasks',[])
    if not isinstance(masks,list) or len(masks)>12:
        raise ValueError('OBJECT_MASK_LIMIT')
    mask_map={ (m.get('sourceId'),m.get('frameIndex',0)):m.get('polygon') for m in masks }
    if len(mask_map)!=len(frames) or any((f.source['sourceId'],f.frame_index) not in mask_map for f in frames):
        return {'findingState':'INCONCLUSIVE','observations':[],'diagnostics':{'reason':'EVERY_VIEW_REQUIRES_OBJECT_CENTRIC_MASK'},
                'limitations':['Mask hands, changing geometry and background before sparse reconstruction. Whole-scene motion is not package motion.']}
    source_map={}; refs=[f.ref() for f in frames]
    with tempfile.TemporaryDirectory(prefix='.sfm-',dir=artifacts.directory) as temporary:
        root=Path(temporary); images=root/'images'; image_masks=root/'masks'; model_dir=root/'models'
        images.mkdir(); image_masks.mkdir(); model_dir.mkdir()
        for i,frame in enumerate(frames):
            polygon=np.asarray(mask_map[(frame.source['sourceId'],frame.frame_index)],dtype=np.float32)
            if polygon.ndim!=2 or polygon.shape[1]!=2 or not 3<=len(polygon)<=16 or not np.isfinite(polygon).all():
                raise ValueError('INVALID_OBJECT_MASK')
            w,h=frame.original_size
            if (polygon<0).any() or (polygon[:,0]>=w).any() or (polygon[:,1]>=h).any():
                raise ValueError('OBJECT_MASK_OUT_OF_BOUNDS')
            mask=region_mask(frame.image.shape,polygon*frame.scale)
            if np.mean(mask>0)<.1:
                raise ValueError('OBJECT_MASK_INSUFFICIENT_COVERAGE')
            name=f'view-{i:03d}.png'; source_map[name]=frame.ref(polygon*frame.scale)
            cv2.imwrite(str(images/name),frame.image)
            cv2.imwrite(str(image_masks/(name+'.png')),mask)
        database=root/'features.db'
        reader=pycolmap.ImageReaderOptions(); reader.mask_path=str(image_masks)
        focal=parameters.get('focalLengthPixels')
        if focal is not None:
            if isinstance(focal,bool) or not isinstance(focal,(int,float)) or not math.isfinite(focal) or focal<=0 or focal>100000:
                raise ValueError('INVALID_DECLARED_FOCAL_LENGTH')
            if len(set(f.original_size for f in frames))!=1:
                raise ValueError('DECLARED_INTRINSICS_REQUIRE_SAME_DIMENSIONS')
            h,w=frames[0].image.shape[:2]
            reader.camera_params=f'{focal*frames[0].scale},{w/2},{h/2}'
        extraction=pycolmap.FeatureExtractionOptions()
        extraction.num_threads=1; extraction.max_image_size=1600; extraction.use_gpu=False
        extraction.sift.max_num_features=2500
        matching=pycolmap.FeatureMatchingOptions(); matching.num_threads=1; matching.use_gpu=False
        verification=pycolmap.TwoViewGeometryOptions(); verification.ransac.random_seed=173
        mapping=pycolmap.IncrementalPipelineOptions()
        mapping.num_threads=1; mapping.random_seed=173; mapping.min_model_size=3; mapping.multiple_models=False
        mapping.max_runtime_seconds=35; mapping.ba_use_gpu=False; mapping.init_num_trials=25
        mapping.mapper.init_min_num_inliers=30; mapping.mapper.init_min_tri_angle=2
        mapping.mapper.abs_pose_min_num_inliers=20; mapping.mapper.num_threads=1; mapping.mapper.random_seed=173
        mapping.ba_refine_focal_length=focal is None; mapping.ba_refine_extra_params=False
        pycolmap.logging.minloglevel=2
        pycolmap.extract_features(str(database),str(images),camera_mode=pycolmap.CameraMode.SINGLE,
                                 camera_model='SIMPLE_PINHOLE',reader_options=reader,extraction_options=extraction,device=pycolmap.Device.cpu)
        pycolmap.match_exhaustive(str(database),matching_options=matching,verification_options=verification,device=pycolmap.Device.cpu)
        reconstructions=pycolmap.incremental_mapping(str(database),str(images),str(model_dir),options=mapping)
        if not reconstructions:
            artifacts.add('sparse-reconstruction-attempt.json',{'tool':'pycolmap','version':pycolmap.__version__,'sourceMapping':source_map,
                           'parameters':{'minTriangulationAngleDegrees':2,'cpuThreads':1,'maxRuntimeSeconds':35},'reason':'NO_RECONSTRUCTION'},refs)
            return {'findingState':'INCONCLUSIVE','observations':[],'diagnostics':{'reason':'NO_STABLE_SPARSE_RECONSTRUCTION','toolVersion':pycolmap.__version__},
                    'limitations':['Weak texture, overlap, rigidity or viewpoint diversity may prevent reconstruction. No missing surfaces are filled.']}
        reconstruction=max(reconstructions.values(),key=lambda rec:rec.num_reg_images())
        cameras=[]
        for image_id,image in reconstruction.images.items():
            if not image.has_pose:
                continue
            cameras.append({'imageId':image_id,'sourceRef':source_map[image.name],
                            'camFromWorld':image.cam_from_world().matrix().tolist(),'projectionCenter':image.projection_center().tolist(),
                            'intrinsics':reconstruction.cameras[image.camera_id].todict()})
        # Native enum in camera dict is converted to a stable model name.
        for camera in cameras:
            camera['intrinsics']['model']=str(camera['intrinsics']['model'])
            camera['intrinsics']['params']=np.asarray(camera['intrinsics']['params']).tolist()
        points=[]; angles=[]
        for point_id,point in reconstruction.points3D.items():
            tracks=[]; vectors=[]
            for element in point.track.elements:
                image=reconstruction.images[element.image_id]
                xy=image.points2D[element.point2D_idx].xy.tolist()
                tracks.append({'sourceRef':source_map[image.name],'pixel':xy,'point2DIndex':element.point2D_idx})
                vector=point.xyz-image.projection_center()
                vectors.append(vector/np.linalg.norm(vector))
            if len(vectors)>1:
                angles.append(max(math.degrees(math.acos(float(np.clip(a@b,-1,1)))) for i,a in enumerate(vectors) for b in vectors[i+1:]))
            points.append({'pointId':point_id,'xyz':point.xyz.tolist(),'color':point.color.tolist(),'reprojectionErrorPixels':float(point.error),'observations':tracks})
        median_error=float(np.median([p['reprojectionErrorPixels'] for p in points])) if points else None
        median_angle=float(np.median(angles)) if angles else None
        eligible=len(cameras)>=3 and len(points)>=30 and median_error is not None and median_error<=3 and median_angle is not None and median_angle>=1
        planes=fit_planes(np.asarray([p['xyz'] for p in points])) if len(points)>=20 else []
        geometry={'schemaVersion':'packproof.sparse-geometry.v1','tool':'pycolmap','toolVersion':pycolmap.__version__,
                  'coordinateFrame':'COLMAP_WORLD_ARBITRARY_SIMILARITY','scaleProvenance':{'status':'UNKNOWN','metricScale':None},
                  'intrinsicsProvenance':'CALLER_DECLARED_NOT_CALIBRATED' if focal else 'ESTIMATED_FROM_IMAGES',
                  'cameras':cameras,'points':points,'exploratoryPlanes':planes,
                  'renderingRules':{'fillHiddenFaces':False,'interpolateUnobservedDamage':False,'claimMetricDimensions':False}}
        artifacts.add('sparse-geometry.json',geometry,refs)
        diagnostics={'registeredImages':len(cameras),'attemptedImages':len(frames),'points3D':len(points),'medianReprojectionErrorPixels':median_error,
                     'medianTriangulationAngleDegrees':median_angle,'geometryScreenPassed':eligible,'toolVersion':pycolmap.__version__,'qualified':False}
        return {'findingState':'RECORDED' if eligible else 'INCONCLUSIVE','observations':[observation('SPARSE_GEOMETRY_RECONSTRUCTED',refs,diagnostics)],'diagnostics':diagnostics,
                'limitations':['Sparse points and inferred planes represent only observed geometry; hidden faces remain unobserved.',
                               'Monocular geometry has unknown metric scale; declared focal length is not calibrated package metrology.',
                               'A passed geometry screen does not qualify condition detection or physical-package correspondence.',
                               'Object masks are supplied annotations and must exclude moving hands/background; source associations need physical validation.']}

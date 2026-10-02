"""Source-attributed parcel/item annotation masks and static-background diagnostics."""
from __future__ import annotations
import cv2
import numpy as np
from engine import observation,region_mask

CLASSES={'PARCEL','ITEM','HAND','OCCLUDER','OPENING','SEAM','OTHER'}


def annotations(frames,artifacts,parameters):
    records=parameters.get('annotations',[])
    if not isinstance(records,list) or len(records)>24:
        raise ValueError('ANNOTATION_COUNT_LIMIT')
    observations=[]
    for index,record in enumerate(records):
        if not isinstance(record,dict) or record.get('semanticClass') not in CLASSES or not isinstance(record.get('annotationId'),str):
            raise ValueError('INVALID_SOURCE_ANNOTATION')
        matching=[frame for frame in frames if frame.source['sourceId']==record.get('sourceId') and frame.frame_index==record.get('frameIndex',0)]
        if len(matching)!=1:
            raise ValueError('ANNOTATION_FRAME_NOT_IN_COMMITTED_SAMPLES')
        frame=matching[0];polygon=np.asarray(record.get('polygon'),dtype=np.float32)
        if polygon.ndim!=2 or polygon.shape[1]!=2 or not 3<=len(polygon)<=16 or not np.isfinite(polygon).all():
            raise ValueError('INVALID_ANNOTATION_POLYGON')
        width,height=frame.original_size
        if (polygon<0).any() or (polygon[:,0]>=width).any() or (polygon[:,1]>=height).any():
            raise ValueError('ANNOTATION_OUT_OF_BOUNDS')
        mask=region_mask(frame.image.shape,polygon*frame.scale)
        artifacts.add(f'annotation-mask-{index}.png',mask,[frame.ref(polygon*frame.scale)],'image/png')
        observations.append(observation('REGION_MASK_ANNOTATION',[frame.ref(polygon*frame.scale)],{
            'annotationId':record['annotationId'],'semanticClass':record['semanticClass'],'maskPixels':int(np.count_nonzero(mask)),
            'attribution':{'kind':'HUMAN_SUPPLIED_ANNOTATION','actorId':parameters.get('annotationActorId'),
                           'identityAssurance':'BACKEND_ACTOR_CONTEXT_NOT_REVERIFIED_BY_WORKER' if parameters.get('annotationActorId') else 'LOCAL_CALLER_NOT_AUTHENTICATED'},
            'qualified':False,'physicalObjectIdentity':None,'continuityConclusion':None}))
    return observations


def background_masks(frames,artifacts,parameters):
    config=parameters.get('segmentation')
    if not config:return []
    if not isinstance(config,dict) or set(config)-{'mode','backgroundSourceId'} or config.get('mode')!='STATIC_BACKGROUND_DIAGNOSTIC':
        raise ValueError('UNSUPPORTED_SEGMENTATION_POLICY')
    backgrounds=[frame for frame in frames if frame.source['sourceId']==config.get('backgroundSourceId')]
    if len(backgrounds)!=1:
        raise ValueError('SINGLE_COMMITTED_BACKGROUND_STILL_REQUIRED')
    background=backgrounds[0]
    if background.time_ms is not None:
        raise ValueError('BACKGROUND_MUST_BE_COMMITTED_STILL')
    targets=[frame for frame in frames if frame.source['sourceId']!=background.source['sourceId']]
    if not targets:return []
    chosen=sorted(set(np.linspace(0,len(targets)-1,min(8,len(targets))).astype(int).tolist()))
    observations=[]
    for index in chosen:
        frame=targets[index]
        if frame.image.shape!=background.image.shape:
            observations.append(observation('FOREGROUND_SEGMENTATION_UNAVAILABLE',[background.ref(),frame.ref()],{'reason':'CAMERA_DIMENSIONS_CHANGED','qualified':False}));continue
        gray=cv2.cvtColor(frame.image,cv2.COLOR_BGR2GRAY)
        base=cv2.cvtColor(background.image,cv2.COLOR_BGR2GRAY)
        # Caller declares fixed camera and clean background; the worker makes no
        # physical parcel association from a moving region alone.
        delta=cv2.absdiff(gray,base)
        mask=(delta>25).astype(np.uint8)*255
        mask=cv2.morphologyEx(mask,cv2.MORPH_OPEN,np.ones((3,3),np.uint8))
        mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((5,5),np.uint8))
        count,labels,stats,_=cv2.connectedComponentsWithStats(mask)
        filtered=np.zeros_like(mask);regions=[]
        for label in range(1,count):
            x,y,w,h,pixels=map(int,stats[label])
            if pixels<max(64,gray.size*.003):continue
            filtered[labels==label]=255
            regions.append({'box':[x/frame.scale,y/frame.scale,w/frame.scale,h/frame.scale],'pixelCount':pixels,
                            'semanticClass':'UNASSOCIATED_FOREGROUND','physicalObjectIdentity':None})
        refs=[background.ref(),frame.ref()]
        artifacts.add(f'foreground-mask-{index}.png',filtered,refs,'image/png')
        observations.append(observation('FOREGROUND_MASK_DIAGNOSTIC',refs,{'method':'STATIC_BACKGROUND_ABSDIFF_MORPHOLOGY',
            'regions':regions,'maskPixels':int(np.count_nonzero(filtered)),'fixedCameraAssumption':'CALLER_DECLARED_UNQUALIFIED',
            'qualified':False,'continuityConclusion':None,'limitation':'Camera motion, light changes, hands and items can all form foreground; no parcel or product identity is inferred.'}))
    return observations

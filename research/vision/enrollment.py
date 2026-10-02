"""Passive geometric proposals and immutable unqualified F01 enrollment records."""
from __future__ import annotations
import hashlib
import json

import cv2
import numpy as np
import rfc8785

from engine import POLICY, Frame, full_resolution, observation, ocr, quality, region_mask, residual


def ordered_quad(points):
    points=np.asarray(points,dtype=np.float32).reshape(4,2)
    # Order around center then rotate to upper-left, preserving positive area.
    center=points.mean(axis=0)
    points=points[np.argsort(np.arctan2(points[:,1]-center[1],points[:,0]-center[0]))]
    points=np.roll(points,-int(np.argmin(points.sum(axis=1))),axis=0)
    if cv2.contourArea(points,oriented=True)<0:
        points=points[[0,3,2,1]]
    return points


def quadrilaterals(mask,min_area,max_area):
    found=[]
    contours,_=cv2.findContours(mask,cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        area=cv2.contourArea(contour)
        if not min_area<=area<=max_area:
            continue
        approx=cv2.approxPolyDP(contour,.025*cv2.arcLength(contour,True),True)
        if len(approx)!=4 or not cv2.isContourConvex(approx):
            continue
        quad=ordered_quad(approx)
        if min(np.linalg.norm(quad-np.roll(quad,1,axis=0),axis=1))<25:
            continue
        if any(float(cv2.intersectConvexConvex(quad,old)[0])/max(1,min(cv2.contourArea(quad),cv2.contourArea(old)))>.85 for old in found):
            continue
        found.append(quad)
    return found


def propose(frame):
    """High-specificity kraft-box geometry screening; never a physical qualification."""
    gray=cv2.cvtColor(frame.image,cv2.COLOR_BGR2GRAY);h,w=gray.shape;area=h*w
    hsv=cv2.cvtColor(frame.image,cv2.COLOR_BGR2HSV)
    labels=[]
    for threshold in (185,205,225):
        white=((gray>threshold)&(hsv[:,:,1]<65)).astype(np.uint8)*255
        white=cv2.morphologyEx(white,cv2.MORPH_CLOSE,np.ones((13,13),np.uint8))
        white=cv2.morphologyEx(white,cv2.MORPH_OPEN,np.ones((5,5),np.uint8))
        for quad in quadrilaterals(white,area*.025,area*.50):
            if not any(float(cv2.intersectConvexConvex(quad,old)[0])/max(1,min(cv2.contourArea(quad),cv2.contourArea(old)))>.8 for old in labels):
                labels.append(quad)
    if len(labels)!=1:
        return {'available':False,'reason':'LABEL_GEOMETRY_AMBIGUOUS_OR_UNAVAILABLE','labelCandidateCount':len(labels),'regions':[]}
    label=labels[0]
    words,error=ocr(frame)
    text_hits=[word for word in words if word['engineConfidence']>=60 and cv2.pointPolygonTest(label,tuple(np.mean(word['polygon'],axis=0)),False)>=0]
    if len(text_hits)<2:
        return {'available':False,'reason':'LABEL_TEXT_SUPPORT_UNAVAILABLE','ocrStatus':error or 'INSUFFICIENT_TEXT_REGIONS','regions':[]}
    # Material is a provisional color-based scope restriction, not a classifier of
    # cardboard authenticity. The outer boundary must independently enclose label.
    edges=cv2.Canny(gray,45,120)
    edges=cv2.morphologyEx(edges,cv2.MORPH_CLOSE,np.ones((9,9),np.uint8))
    boxes=quadrilaterals(edges,max(area*.08,cv2.contourArea(label)*1.7),area*.95)
    label_mask=region_mask(gray.shape,label)>0
    kraft=(hsv[:,:,0]>=5)&(hsv[:,:,0]<=40)&(hsv[:,:,1]>=20)&(hsv[:,:,1]<=180)&(gray>35)&(gray<240)
    associated=[]
    for box in boxes:
        if not all(cv2.pointPolygonTest(box,tuple(map(float,point)),True)>4 for point in label):
            continue
        mask=(region_mask(gray.shape,box)>0)&~cv2.dilate(label_mask.astype(np.uint8),np.ones((15,15),np.uint8)).astype(bool)
        if mask.sum()<area*.03 or float(kraft[mask].mean())<.65:
            continue
        associated.append(box)
    if len(associated)!=1:
        return {'available':False,'reason':'PACKAGE_ASSOCIATION_AMBIGUOUS_OR_UNAVAILABLE','packageCandidateCount':len(associated),'regions':[]}
    box=associated[0];box_mask=region_mask(gray.shape,box)>0
    transform=cv2.getPerspectiveTransform(np.float32([[0,0],[1,0],[1,1],[0,1]]),label)
    regions=[]
    for index,normalized in enumerate(([[.08,.08],[.45,.08],[.45,.42],[.08,.42]],[[.55,.58],[.92,.58],[.92,.92],[.55,.92]])):
        polygon=cv2.perspectiveTransform(np.float32([normalized]),transform)[0]
        regions.append({'regionId':f'passive-label-{index}','group':'label','material':'UNCLASSIFIED_PRINT_ON_PAPER',
                        'polygon':(polygon/frame.scale).tolist(),'attribution':'AUTOMATIC_GEOMETRIC_PROPOSAL'})
    x,y,bw,bh=cv2.boundingRect(box)
    candidates=[]
    for gy in range(4):
        for gx in range(4):
            x0=x+(gx+.1)*bw/4;y0=y+(gy+.1)*bh/4;x1=x+(gx+.9)*bw/4;y1=y+(gy+.9)*bh/4
            polygon=np.float32([[x0,y0],[x1,y0],[x1,y1],[x0,y1]])
            mask=region_mask(gray.shape,polygon)>0
            if min(x1-x0,y1-y0)<20 or not mask.any() or float(box_mask[mask].mean())<.99 or label_mask[mask].any() or float(kraft[mask].mean())<.7:
                continue
            candidates.append(polygon)
    if len(candidates)<2:
        return {'available':False,'reason':'SEPARATED_CARTON_REGIONS_UNAVAILABLE','regions':[]}
    pair=max(((a,b) for i,a in enumerate(candidates) for b in candidates[i+1:]),key=lambda pair:np.linalg.norm(pair[0].mean(axis=0)-pair[1].mean(axis=0)))
    for index,polygon in enumerate(pair):
        regions.append({'regionId':f'passive-carton-{index}','group':'carton','material':'KRAFT_COLOR_CANDIDATE',
                        'polygon':(polygon/frame.scale).tolist(),'attribution':'AUTOMATIC_GEOMETRIC_PROPOSAL'})
    return {'available':True,'associationState':'SINGLE_GEOMETRIC_CANDIDATE_UNQUALIFIED','qualified':False,
            'sourceRef':frame.ref(),'labelPolygon':(label/frame.scale).tolist(),'cartonPolygon':(box/frame.scale).tolist(),
            'observedTextRegionCount':len(text_hits),'regions':regions,
            'limitations':['White quad, OCR and kraft-color enclosure are a conservative geometric proposal, not a qualified parcel detector.',
                           'Material class, final attached-label state and physical association require native/physical validation.']}


def enroll(frames,artifacts,parameters):
    # No automatic retry captures, prompts, extra seller action or camera controls.
    recent=frames[max(0,(len(frames)*2)//3):] if any(frame.time_ms is not None for frame in frames) else frames
    ranked=sorted(recent,key=lambda frame:quality(frame)['laplacianVariance'],reverse=True)
    selected=ranked[:3]
    proposals=[]
    for frame in selected:
        if not quality(frame)['screeningUsable']:
            proposals.append({'available':False,'reason':'FRAME_QUALITY_UNAVAILABLE','sourceRef':frame.ref(),'regions':[]})
        else:
            proposals.append({**propose(frame),'sourceRef':frame.ref()})
    eligible=[(frame,proposal) for frame,proposal in zip(selected,proposals) if proposal['available']]
    chosen=eligible[0] if eligible else None
    # Freeze every required group even when its input is unavailable. A later
    # version is a new immutable enrollment, never an edited favorable subset.
    inventory=[frame.ref() for frame in frames]
    commitment={'schemaVersion':'packproof.proofprint-enrollment.v1','extractorVersion':'passive-kraft-geometry-bandpass.v1',
                'policyVersion':POLICY['policyVersion'],'frozenRequiredGroups':POLICY['requiredRegionGroups'],
                'sourceRefs':inventory,'selectedSourceRef':chosen[0].ref() if chosen else None,
                'regions':chosen[1]['regions'] if chosen else [],'proposals':proposals,
                'qualificationState':'UNAVAILABLE','locked':True,'qualified':False,
                'unavailableReasons':['PHYSICAL_CAPTURE_PROFILE_UNQUALIFIED']+([] if chosen else ['PASSIVE_ASSOCIATION_UNAVAILABLE']),
                'stateHistory':['CANDIDATE','SOURCES_COMMITTED','ANALYZED','UNAVAILABLE','LOCKED'],
                'supersedesEnrollmentId':parameters.get('enrollmentId'),
                'scope':'Typed visible-region research enrollment; no package identity, unopened-state or contents assertion.'}
    commitment['enrollmentDigest']=hashlib.sha256(rfc8785.dumps(commitment)).hexdigest()
    refs=[f.ref() for f in frames]
    artifacts.add('enrollment.json',commitment,refs)
    context=sorted(set((0,len(frames)//2,len(frames)-1)))
    for index in context:
        frame=frames[index]
        artifacts.add(f'enrollment-context-{index}.png',frame.image,[frame.ref()],'image/png')
    if chosen:
        frame,proposal=chosen
        frame=full_resolution(frame)
        for index,region in enumerate(proposal['regions']):
            polygon=np.float32(region['polygon'])*frame.scale
            mask=region_mask(frame.image.shape,polygon)>0
            band,content,gray=residual(frame.image,region['group'])
            usable=mask&content
            x,y,w,h=cv2.boundingRect(polygon)
            artifacts.add(f'enrollment-region-{index}.png',frame.image[y:y+h,x:x+w],[frame.ref(polygon)],'image/png')
            artifacts.add(f'enrollment-mask-{index}.png',usable.astype(np.uint8)*255,[frame.ref(polygon)],'image/png')
            artifacts.add(f'enrollment-descriptor-{index}.json',{'descriptorVersion':'masked-bandpass-pool16.v1',
                          'values':cv2.resize((band*usable)[y:y+h,x:x+w],(16,16),interpolation=cv2.INTER_AREA).ravel().tolist(),
                          'usablePixels':int(usable.sum()),'sourceRef':frame.ref(polygon)},[frame.ref(polygon)])
    return {'findingState':'INCONCLUSIVE','observations':[observation('PASSIVE_REGION_ENROLLMENT',refs,commitment,channel='surface',findingState='INCONCLUSIVE',qualified=False)],
            'diagnostics':{'mode':'enroll','associationCandidateAvailable':chosen is not None,'enrollmentDigest':commitment['enrollmentDigest'],
                           'stateHistory':commitment['stateHistory'],'qualificationState':'UNAVAILABLE','locked':True,'requiredGroups':POLICY['requiredRegionGroups']},
            'limitations':['Passive enrollment requires no new seller step; unavailable association remains unavailable.',
                           'All research enrollments are locked UNAVAILABLE until their capture/material/matcher profile is physically qualified.',
                           'Later inputs or methods create a linked new enrollment; previous sources, group requirements and attempts cannot be rewritten.']}

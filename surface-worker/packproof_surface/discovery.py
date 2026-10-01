"""Bounded candidate discovery from same-frame barcode geometry.

Regions are geometric proposals, never material identification or parcel binding.
Missing/ambiguous label geometry yields explicit absence rather than invented carton.
"""
import cv2
import numpy as np

def ordered_quad(points):
    points = np.float32(points).reshape(4, 2)
    center = points.mean(axis=0)
    angles = np.arctan2(points[:, 1]-center[1], points[:, 0]-center[0])
    p = points[np.argsort(angles)]
    start = int(np.argmin(p.sum(axis=1)))
    return np.roll(p, -start, axis=0)

def discover_label(image, barcode):
    h, w = image.shape
    scale = min(1., 1000. / max(h, w))
    small = cv2.resize(image, (round(w*scale), round(h*scale)), interpolation=cv2.INTER_AREA)
    edges = cv2.Canny(cv2.GaussianBlur(small, (5,5), 0), 35, 100)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((5,5), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    candidates=[]
    barcode=np.float32(barcode)
    barcode_area=abs(cv2.contourArea(barcode))
    if barcode_area < 64:
        return None, {"status":"unavailable", "reason":"barcode_geometry_too_small"}
    for contour in sorted(contours,key=cv2.contourArea,reverse=True)[:64]:
        perimeter=cv2.arcLength(contour,True)
        quad=cv2.approxPolyDP(contour,0.025*perimeter,True)
        if len(quad)!=4 or not cv2.isContourConvex(quad):
            continue
        quad=ordered_quad(quad)/scale
        area=abs(cv2.contourArea(quad))
        if not max(barcode_area*1.8,4096) <= area <= w*h*.85:
            continue
        if not all(cv2.pointPolygonTest(quad,(float(x),float(y)),False)>=0 for x,y in barcode):
            continue
        sides=[np.linalg.norm(quad[(i+1)%4]-quad[i]) for i in range(4)]
        if min(sides)<64 or max(sides)/min(sides)>4:
            continue
        # A bounded number of enclosing outlines. Nested duplicate edge contours collapse.
        if any(np.mean(np.linalg.norm(quad-existing,axis=1))<8 for _,existing in candidates):
            continue
        candidates.append((area,quad))
    if not candidates:
        return None,{"status":"unavailable","reason":"no_reliable_enclosing_label_outline","algorithm":"canny-contour-quad-v1"}
    candidates.sort(key=lambda pair:pair[0])
    if len(candidates)>1 and candidates[1][0] < candidates[0][0]*1.5:
        return None,{"status":"unavailable","reason":"ambiguous_enclosing_label_outlines","candidateCount":len(candidates)}
    return candidates[0][1], {"status":"candidate_only","algorithm":"canny-contour-quad-v1","candidateCount":len(candidates),
                               "geometrySource":"same_frame_outline_enclosing_barcode","materialConfirmed":False}

def propose(image,hint):
    source=hint["sourceId"]
    if hint.get("association") not in {"bound","same_frame_expected_barcode"}:
        return [],{"sourceId":source,"status":"unavailable","reason":"ambiguous_or_absent_transaction_context"}
    if hint.get("labelPolygon"):
        label=np.float32(hint["labelPolygon"])
        diagnostic={"status":"candidate_only","geometrySource":"supplied_label_quad","materialConfirmed":False}
    elif hint.get("barcodePolygon"):
        label,diagnostic=discover_label(image,hint["barcodePolygon"])
        if label is None:
            return [],dict(diagnostic,sourceId=source)
    else:
        return [],{"sourceId":source,"status":"unavailable","reason":"no_same_frame_geometry"}
    h,w=image.shape
    if (label[:,0]>=w).any() or (label[:,1]>=h).any() or not cv2.isContourConvex(label) or cv2.contourArea(label,oriented=True)<=0:
        return [],{"sourceId":source,"status":"unavailable","reason":"invalid_label_outline"}
    transform=cv2.getPerspectiveTransform(np.float32([[0,0],[1,0],[1,1],[0,1]]),label)
    boxes=[("print",0,(.08,.18,.42,.48)),("print",1,(.58,.52,.92,.82)),
           ("carton",0,(-.35,.12,-.06,.5)),("carton",1,(1.06,.5,1.35,.88))]
    regions=[]
    track=hint.get("labelTrackId") or "untracked"
    for group,index,(x0,y0,x1,y1) in boxes:
        polygon=cv2.perspectiveTransform(np.float32([[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]]),transform)[0]
        if (polygon[:,0]<0).any() or (polygon[:,1]<0).any() or (polygon[:,0]>=w).any() or (polygon[:,1]>=h).any():
            continue
        regions.append({"id":f"auto-{source}-{group}-{index}","sourceId":source,"group":group,
                        "polygon":[[round(float(x),4),round(float(y),4)] for x,y in polygon],
                        "trackId":f"auto-{track}-{group}-{index}","process":hint.get("printProcess","unknown") if group=="print" else "substrate",
                        "materialStatus":"proposed_unverified","provenance":"label-relative-geometry-v1"})
    regions.append({"id":f"auto-{source}-context","sourceId":source,"group":"context","polygon":[[0,0],[w-1,0],[w-1,h-1],[0,h-1]],
                    "trackId":f"auto-{track}-context","process":"substrate","materialStatus":"context_only","provenance":"same-frame-context-v1"})
    diagnostic.update(sourceId=source,labelPolygon=[[round(float(x),4),round(float(y),4)] for x,y in label],
                      regionCount=len(regions),association=hint["association"],physicalAssociationVerified=False,
                      warning="Outside-label regions may be non-carton or another plane. Material/parcel identity is unverified.")
    return regions,diagnostic

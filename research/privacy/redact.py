"""Bounded, local-only R&D privacy derivatives. Never modifies the source."""
from __future__ import annotations
import argparse, base64, csv, hashlib, io, json, math, os, platform, subprocess, tempfile
from pathlib import Path
from datetime import datetime, timezone
import cv2
from PIL import Image
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives import serialization
import rfc8785

SCHEMA = 'packproof.redaction.v1'
POLICY = 'opaque-rgb8-review-required-v1'
MAX_PIXELS = 24_000_000
MAX_SECONDS = 300
MAX_BYTES = 500_000_000
LIMITATIONS = ['Candidate detectors are unqualified; all external exports require human review.', 'Masks can hide evidence-critical regions; findings depending on omitted pixels are not disclosed.', 'A signed transformation is not a zero-knowledge proof or a claim that every sensitive field was found.']

def canonical(x): return rfc8785.dumps(x)
def sha(data): return hashlib.sha256(data).hexdigest()
def file_sha(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for b in iter(lambda:f.read(1024*1024), b''): h.update(b)
    return h.hexdigest()
def run(args, timeout=120):
    return subprocess.run(args, check=True, capture_output=True, timeout=timeout).stdout

def inspect(path):
    p=Path(path)
    if not p.is_file() or p.stat().st_size > MAX_BYTES: raise ValueError('source missing or byte cap exceeded')
    doc=json.loads(run(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height,duration,nb_frames:format=duration','-of','json',str(p)]))
    if not doc['streams']: raise ValueError('no visual stream')
    s=doc['streams'][0]; w,h=int(s['width']),int(s['height'])
    duration=float(s.get('duration',doc.get('format',{}).get('duration',0)))
    if not math.isfinite(duration) or not 0<w*h<=MAX_PIXELS or duration>MAX_SECONDS: raise ValueError('source profile exceeds caps')
    return w,h,duration

def recipe_for(width,height,masks,kind):
    if kind not in ('still','video'): raise ValueError('invalid media kind')
    if not isinstance(masks,list) or len(masks)>128: raise ValueError('mask cap exceeded')
    normalized=[]
    for m in masks:
        if set(m)-{'x','y','width','height','start','end','class','evidenceCritical'}: raise ValueError('unknown mask field')
        vals=[m.get(k) for k in ('x','y','width','height')]
        if any(type(x) is not int for x in vals): raise ValueError('mask coordinates must be integers')
        x,y,w,h=vals
        if x<0 or y<0 or w<=0 or h<=0 or x+w>width or y+h>height: raise ValueError('mask outside image')
        start,end=m.get('start',0),m.get('end',MAX_SECONDS)
        if isinstance(start,bool) or isinstance(end,bool) or not all(isinstance(v,(int,float)) and math.isfinite(v) for v in (start,end)) or not 0<=start<end<=MAX_SECONDS: raise ValueError('invalid interval')
        allowed_classes={'manual','address','face','label','screen','serial','face-candidate','text-address-label-candidate','screen-or-label-candidate','reviewed-swept-mask','optical-flow-review-required'}
        if m.get('class','manual') not in allowed_classes: raise ValueError('unsupported mask class; free-text is excluded from exports')
        normalized.append({'x':x,'y':y,'width':w,'height':h,'start':start,'end':end,'class':str(m.get('class','manual'))[:64], 'evidenceCritical':bool(m.get('evidenceCritical',False))})
    return {'policyVersion':POLICY,'kind':kind,'width':width,'height':height,'format':'RGB8','rotation':'stored-pixel-orientation-no-autorotate','constant':[0,0,0],'masks':normalized,'audio':'removed','alpha':'composited-on-black','metadata':'stripped','subtitles':'omitted','attachments':'omitted','thumbnails':'omitted','ocr':'omitted','captions':'omitted','selectedIntervals':'complete visual stream'}

def sign_manifest(record,private_key):
    key=serialization.load_pem_private_key(Path(private_key).read_bytes(),password=None)
    if not isinstance(key,Ed25519PrivateKey): raise ValueError('requires Ed25519 signing key')
    pub=key.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw)
    return {'record':record,'signature':base64.b64encode(key.sign(canonical(record))).decode(),'keyId':sha(pub)}

def verify_signature(manifest,trusted_pem):
    key=serialization.load_pem_public_key(Path(trusted_pem).read_bytes())
    if not isinstance(key,Ed25519PublicKey): raise ValueError('requires Ed25519 trust key')
    pub=key.public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw)
    if manifest['keyId']!=sha(pub): raise ValueError('untrusted signing key')
    key.verify(base64.b64decode(manifest['signature'],validate=True),canonical(manifest['record']))
    return manifest['record']

def pixel_digest(path,kind):
    if kind=='still':
        with Image.open(path) as im: return sha(im.convert('RGB').tobytes())
    # Stream decoded frames; keep bounded memory and enforce subprocess runtime.
    fd,name=tempfile.mkstemp(); os.close(fd)
    try:
        run(['ffmpeg','-v','error','-noautorotate','-i',str(path),'-map','0:v:0','-pix_fmt','rgb24','-f','hash','-hash','sha256','-y',name])
        return Path(name).read_text().strip().split('=')[-1]
    finally: Path(name).unlink(missing_ok=True)

def transform(source,output,recipe):
    source,output=Path(source).resolve(),Path(output).resolve()
    if source==output: raise ValueError('original cannot be overwritten')
    if output.exists(): raise ValueError('derivative output already exists')
    if recipe['kind']=='still':
        with Image.open(source) as im:
            if im.width*im.height>MAX_PIXELS: raise ValueError('pixel cap exceeded')
            rgba=im.convert('RGBA')
            im=Image.alpha_composite(Image.new('RGBA',rgba.size,(0,0,0,255)),rgba).convert('RGB')
            for m in recipe['masks']: im.paste((0,0,0),(m['x'],m['y'],m['x']+m['width'],m['y']+m['height']))
            # New RGB PNG carries no EXIF, ICC, comments, filename, or original thumbnail.
            im.save(output,format='PNG',compress_level=9)
    else:
        filters=[f"drawbox=x={m['x']}:y={m['y']}:w={m['width']}:h={m['height']}:color=black:t=fill:enable='between(t,{m['start']},{m['end']})'" for m in recipe['masks']]
        run(['ffmpeg','-v','error','-nostdin','-noautorotate','-i',str(source),'-map','0:v:0','-an','-sn','-dn','-map_metadata','-1','-map_chapters','-1','-vf',','.join(filters) or 'null','-c:v','libx264','-preset','medium','-crf','0','-pix_fmt','yuv444p','-threads','1','-fflags','+bitexact','-flags:v','+bitexact','-f','mp4',str(output)])

def create(source,output,masks,kind,private_key):
    width,height,_=inspect(source)
    recipe=recipe_for(width,height,masks,kind)
    original=file_sha(source)
    transform(source,output,recipe)
    if file_sha(source)!=original: raise ValueError('source changed during processing')
    record={'schemaVersion':SCHEMA,'sourceSha256':original,'derivativeSha256':file_sha(output),'canonicalPixelSha256':pixel_digest(output,kind),'recipe':recipe,'recipeSha256':sha(canonical(recipe)),'verificationLevel':'SIGNED_TRANSFORMATION_RECORD','review':{'state':'REQUIRED','approvedArtifactSha256':None},'createdAt':datetime.now(timezone.utc).isoformat(),'processor':{'python':platform.python_version(),'pillow':Image.__version__,'opencv':cv2.__version__,'ffmpeg':run(['ffmpeg','-version']).decode().splitlines()[0]},'limitations':LIMITATIONS}
    return sign_manifest(record,private_key) if private_key else {"record":record,"signature":None,"keyId":None,"requiresServerSignature":True}

def recompute(source,derivative,manifest,trusted_pem):
    r=verify_signature(manifest,trusted_pem)
    if r['schemaVersion']!=SCHEMA or file_sha(source)!=r['sourceSha256'] or file_sha(derivative)!=r['derivativeSha256']: raise ValueError('source/derivative binding mismatch')
    if sha(canonical(r['recipe']))!=r['recipeSha256']: raise ValueError('recipe digest mismatch')
    w,h,_=inspect(source); recipe=recipe_for(w,h,r['recipe']['masks'],r['recipe']['kind'])
    if recipe!=r['recipe']: raise ValueError('unsupported recipe')
    with tempfile.TemporaryDirectory() as td:
        rebuilt=Path(td)/('redacted.png' if recipe['kind']=='still' else 'redacted.mp4')
        transform(source,rebuilt,recipe)
        if pixel_digest(rebuilt,recipe['kind'])!=r['canonicalPixelSha256'] or pixel_digest(derivative,recipe['kind'])!=r['canonicalPixelSha256']: raise ValueError('recomputed canonical pixels mismatch')
    return {'verificationLevel':'RECOMPUTED_TRANSFORM','valid':True,'sourceSha256':r['sourceSha256']}

def detect(path):
    """Candidates only: all text is conservatively sensitive; no identity recognition."""
    w,h,_=inspect(path)
    frame=cv2.imread(str(path))
    if frame is None: raise ValueError('detect expects a decoded still')
    boxes=[]
    def add(x,y,bw,bh,kind):
        pad=8; x0,y0=max(0,int(x)-pad),max(0,int(y)-pad)
        boxes.append({'x':x0,'y':y0,'width':min(w,int(x+bw)+pad)-x0,'height':min(h,int(y+bh)+pad)-y0,'class':kind})
    gray=cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY)
    detector=cv2.CascadeClassifier(cv2.data.haarcascades+'haarcascade_frontalface_default.xml')
    for x,y,bw,bh in detector.detectMultiScale(gray,1.1,5): add(x,y,bw,bh,'face-candidate')
    ocr='unavailable'
    try:
        data=run(['tesseract',str(path),'stdout','tsv'],timeout=30).decode()
        for row in csv.DictReader(io.StringIO(data),delimiter='\t'):
            if row.get('text','').strip() and float(row['conf'])>=0: add(int(row['left']),int(row['top']),int(row['width']),int(row['height']),'text-address-label-candidate')
        ocr='candidate-only'
    except (OSError,subprocess.SubprocessError): pass
    contours,_=cv2.findContours(cv2.Canny(gray,50,150),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    for c in contours:
        p=cv2.approxPolyDP(c,0.02*cv2.arcLength(c,True),True)
        if len(p)==4 and cv2.contourArea(p)>w*h*.05:
            add(*cv2.boundingRect(p),'screen-or-label-candidate')
    return {'masks':boxes[:128],'findingState':'NOT_CHECKED','requiresHumanReview':True,'coverage':{'face':'frontal-haar-candidate-only','text':ocr,'screen':'quadrilateral-candidate-only'},'limitations':LIMITATIONS}

def temporal_union(track):
    """Conservative swept rectangle between reviewed temporal keyframes; no identity tracking."""
    if len(track)<2: raise ValueError('two or more reviewed keyframes required')
    out=[]
    for a,b in zip(track,track[1:]):
        if not a['time']<b['time']: raise ValueError('keyframes must increase')
        x,y=min(a['x'],b['x']),min(a['y'],b['y'])
        out.append({'x':x,'y':y,'width':max(a['x']+a['width'],b['x']+b['width'])-x,'height':max(a['y']+a['height'],b['y']+b['height'])-y,'start':a['time'],'end':b['time'],'class':'reviewed-swept-mask'})
    return out

def track_masks(source,seeds):
    """Track reviewed regions with pyramidal LK optical flow; loss masks whole frame.

    Bounded research profile: <=500 decoded frames, <=8 seeds. This follows regions,
    never people/identities. Newly appearing private regions still require review.
    """
    w,h,duration=inspect(source)
    if len(seeds)>8: raise ValueError('tracking seed cap exceeded')
    recipe_for(w,h,seeds,'video')
    cap=cv2.VideoCapture(str(source));cap.set(cv2.CAP_PROP_ORIENTATION_AUTO,0)
    fps=cap.get(cv2.CAP_PROP_FPS);count=cap.get(cv2.CAP_PROP_FRAME_COUNT)
    if not math.isfinite(fps) or fps<=0 or count<=0 or count>500:
        cap.release();raise ValueError('tracking requires a bounded <=500-frame video')
    ok,frame=cap.read()
    if not ok: cap.release();raise ValueError('cannot decode video')
    import numpy as np
    prev=cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY)
    tracks=[]
    for m in seeds:
        roi=np.zeros_like(prev);roi[m['y']:m['y']+m['height'],m['x']:m['x']+m['width']]=255
        points=cv2.goodFeaturesToTrack(prev,80,.01,3,mask=roi)
        tracks.append({'box':[m['x'],m['y'],m['x']+m['width'],m['y']+m['height']],'points':points,'lost':points is None or len(points)<4,'window':None})
    masks=[];events=[];frame_index=1;window_start=0
    def flush(end):
        for t in tracks:
            b=t['window'] or t['box'];x0,y0,x1,y1=b
            masks.append({'x':int(x0),'y':int(y0),'width':int(x1-x0),'height':int(y1-y0),'start':window_start,'end':min(MAX_SECONDS,end),'class':'optical-flow-review-required'})
            t['window']=None
    try:
        while True:
            ok,frame=cap.read()
            if not ok: break
            gray=cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY)
            for index,t in enumerate(tracks):
                old=t['box'][:]
                if not t['lost']:
                    nxt,status,error=cv2.calcOpticalFlowPyrLK(prev,gray,t['points'],None)
                    valid=status.reshape(-1).astype(bool) if status is not None else np.zeros(0,dtype=bool)
                    if nxt is None or valid.sum()<4:
                        t['lost']=True
                    else:
                        move=(nxt[valid]-t['points'][valid]).reshape(-1,2);dx,dy=np.median(move,axis=0)
                        residual=np.linalg.norm(move-np.array([dx,dy]),axis=1)
                        if np.quantile(residual,.9)>5 or not np.isfinite([dx,dy]).all():t['lost']=True
                        else:
                            x0,y0,x1,y1=old;t['box']=[max(0,int(math.floor(x0+dx))),max(0,int(math.floor(y0+dy))),min(w,int(math.ceil(x1+dx))),min(h,int(math.ceil(y1+dy)))];t['points']=nxt[valid].reshape(-1,1,2)
                            if t['box'][0]>=t['box'][2] or t['box'][1]>=t['box'][3]:t['lost']=True
                if t['lost']:
                    box=[0,0,w,h]
                    if old!=box:events.append({'frame':frame_index,'seed':index,'state':'TRACKING_LOST_FULL_FRAME_MASK'})
                    t['box']=box
                else:
                    b=t['box'];box=[max(0,min(old[0],b[0])-8),max(0,min(old[1],b[1])-8),min(w,max(old[2],b[2])+8),min(h,max(old[3],b[3])+8)]
                prior=t['window'];t['window']=box if prior is None else [min(prior[0],box[0]),min(prior[1],box[1]),max(prior[2],box[2]),max(prior[3],box[3])]
            prev=gray;frame_index+=1
            if frame_index/fps-window_start>=1:
                flush(frame_index/fps);window_start=frame_index/fps
        if frame_index/fps>window_start:flush(frame_index/fps)
    finally:cap.release()
    if len(masks)>128:raise ValueError('tracked mask recipe exceeds bounded mask cap')
    return {'masks':masks,'events':events,'requiresHumanReview':True,'findingState':'NOT_CHECKED','limitations':LIMITATIONS+['Only supplied seed regions tracked. New regions and optical-flow errors require review.']}

def approve(manifest,reviewer,private_key):
    # Caller must authorize reviewer. Approval binds bytes and exact masks, not just a boolean.
    key=serialization.load_pem_private_key(Path(private_key).read_bytes(),password=None)
    key.public_key().verify(base64.b64decode(manifest['signature'],validate=True),canonical(manifest['record']))
    if not isinstance(reviewer,str) or not reviewer.strip(): raise ValueError('attributed authorized reviewer required')
    r=manifest['record']
    record={**r,'review':{'state':'APPROVED','reviewerId':reviewer,'approvedArtifactSha256':r['derivativeSha256'],'approvedRecipeSha256':r['recipeSha256'],'approvedAt':datetime.now(timezone.utc).isoformat()}}
    return sign_manifest(record,private_key)

def export_reviewed(derivative,manifest,trusted_pem,destination):
    r=verify_signature(manifest,trusted_pem)
    review=r.get('review',{})
    if review.get('state')!='APPROVED' or review.get('approvedArtifactSha256')!=r['derivativeSha256'] or review.get('approvedRecipeSha256')!=r['recipeSha256']: raise ValueError('human approval for exact derivative and masks required')
    if file_sha(derivative)!=r['derivativeSha256']: raise ValueError('derivative digest mismatch')
    # Allowlist files only; never copy source trees or user filenames.
    import zipfile
    with zipfile.ZipFile(destination,'x',zipfile.ZIP_DEFLATED) as z:
        z.write(derivative,'redacted.png' if r['recipe']['kind']=='still' else 'redacted.mp4')
        z.writestr('transformation.json',canonical(manifest))
        z.writestr('OMISSIONS.txt','Private original, audio, OCR, captions, thumbnails, source filenames and attachments omitted. Downloaded exports cannot be recalled.\n')
    return {'sha256':file_sha(destination),'containsOriginal':False}

def main():
    p=argparse.ArgumentParser(); sub=p.add_subparsers(dest='cmd',required=True)
    d=sub.add_parser('detect'); d.add_argument('source')
    t=sub.add_parser('track'); t.add_argument('source'); t.add_argument('--masks',required=True)
    c=sub.add_parser('create'); c.add_argument('source'); c.add_argument('output'); c.add_argument('--masks',required=True); c.add_argument('--kind',choices=['still','video'],required=True); c.add_argument('--key'); c.add_argument('--unsigned-record',action='store_true')
    v=sub.add_parser('recompute'); v.add_argument('source'); v.add_argument('derivative'); v.add_argument('manifest'); v.add_argument('--trust-key',required=True)
    e=sub.add_parser('export'); e.add_argument('derivative'); e.add_argument('manifest'); e.add_argument('output'); e.add_argument('--trust-key',required=True)
    a=p.parse_args()
    if a.cmd=='detect': result=detect(a.source)
    elif a.cmd=='track': result=track_masks(a.source,json.loads(Path(a.masks).read_text()))
    elif a.cmd=='create':
        if not a.key and not a.unsigned_record: p.error('--key or --unsigned-record required')
        result=create(a.source,a.output,json.loads(Path(a.masks).read_text()),a.kind,a.key)
    elif a.cmd=='recompute': result=recompute(a.source,a.derivative,json.loads(Path(a.manifest).read_text()),a.trust_key)
    else: result=export_reviewed(a.derivative,json.loads(Path(a.manifest).read_text()),a.trust_key,a.output)
    print(json.dumps(result))
if __name__=='__main__': main()

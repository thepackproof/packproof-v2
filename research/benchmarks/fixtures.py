"""Synthetic deterministic pixels for engineering checks. Never physical validation."""
from pathlib import Path
import hashlib
import cv2
import numpy as np


def source(path, source_id):
    path=Path(path)
    return {'sourceId':source_id,'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
            'byteLength':path.stat().st_size,'mimeType':'video/x-msvideo' if path.suffix=='.avi' else 'image/png',
            'objectVersionId':'synthetic-v1','captureSessionId':'synthetic-session'}


def parcel(seed=173):
    rng=np.random.default_rng(seed)
    image=np.clip(rng.normal(145,18,(480,640,3)),0,255).astype(np.uint8)
    image[110:340,160:485]=np.clip(rng.normal(220,8,(230,325,3)),0,255)
    cv2.putText(image,'PP 713820',(175,150),cv2.FONT_HERSHEY_SIMPLEX,.8,(20,20,20),2)
    cv2.putText(image,'SERIAL AB12345',(175,195),cv2.FONT_HERSHEY_SIMPLEX,.55,(20,20,20),2)
    for x in range(180,450,5):
        cv2.rectangle(image,(x,220),(x+2,280),(10,10,10),-1)
    for _ in range(40):
        center=(int(rng.integers(20,620)),int(rng.integers(20,460)))
        cv2.circle(image,center,4,(50,80,100),1)
    return image


def basic(directory):
    root=Path(directory); root.mkdir(parents=True,exist_ok=True)
    base=parcel()
    transforms={'base':base,'recapture':cv2.warpPerspective(base,np.array([[1.,.015,3],[-.008,1.,4],[.00001,.00002,1.]]),(640,480)),
                'same-content-copy':parcel(719),'blur':cv2.GaussianBlur(base,(31,31),8),'glare':np.full_like(base,255),
                'label-transfer':parcel(123)}
    transforms['label-transfer'][110:340,160:485]=base[110:340,160:485]
    transforms['condition-change']=base.copy()
    cv2.line(transforms['condition-change'],(90,360),(500,390),(15,15,15),12)
    paths={}
    for name,image in transforms.items():
        path=root/(name+'.png'); cv2.imwrite(str(path),image); paths[name]=path
    video=root/'response.avi'; writer=cv2.VideoWriter(str(video),cv2.VideoWriter_fourcc(*'MJPG'),10,(640,480))
    for index in range(80):
        level=np.interp(index/10,[0,2,4,6,7.9],[0,.4,.1,.6,.2])
        writer.write(np.clip(base.astype(float)*(.65+.4*level),0,255).astype(np.uint8))
    writer.release(); paths['response']=video
    return paths


def cube_views(directory):
    """Perspective-render three textured cuboid faces and their exact object masks."""
    root=Path(directory); root.mkdir(parents=True,exist_ok=True)
    rng=np.random.default_rng(719)
    faces=[np.array([[-1,-.75,-.5],[1,-.75,-.5],[1,.75,-.5],[-1,.75,-.5]]),
           np.array([[-1,-.75,.5],[1,-.75,.5],[1,-.75,-.5],[-1,-.75,-.5]]),
           np.array([[1,-.75,-.5],[1,-.75,.5],[1,.75,.5],[1,.75,-.5]]),
           np.array([[-1,-.75,.5],[-1,-.75,-.5],[-1,.75,-.5],[-1,.75,.5]])]
    textures=[]
    for index in range(4):
        tex=np.clip(rng.normal(155,36,(384,512,3)),0,255).astype(np.uint8)
        for i in range(90):
            center=(int(rng.integers(15,495)),int(rng.integers(15,365)))
            cv2.circle(tex,center,int(rng.integers(3,10)),tuple(map(int,rng.integers(0,255,3))),-1)
        cv2.putText(tex,f'SYNTHETIC FACE {index}',(20,150),cv2.FONT_HERSHEY_SIMPLEX,.7,(15,15,15),2)
        textures.append(tex)
    sources=[]; masks=[]
    for view,x in enumerate([-1.25,-.8,-.3,.2,.7,1.2]):
        center=np.array([x,-1.6,-4.])
        forward=-center/np.linalg.norm(center)
        right=np.cross(forward,np.array([0.,-1.,0.]));right/=np.linalg.norm(right)
        down=np.cross(forward,right); rotation=np.vstack([right,down,forward])
        camera_faces=[(face-center)@rotation.T for face in faces]
        projected=[np.column_stack((600*face[:,0]/face[:,2]+320,600*face[:,1]/face[:,2]+240)).astype(np.float32) for face in camera_faces]
        image=np.full((480,640,3),22,dtype=np.uint8)
        for index in sorted(range(4),key=lambda i:camera_faces[i][:,2].mean(),reverse=True):
            origin=np.float32([[0,0],[511,0],[511,383],[0,383]])
            homography=cv2.getPerspectiveTransform(origin,projected[index])
            warped=cv2.warpPerspective(textures[index],homography,(640,480))
            mask=cv2.warpPerspective(np.full((384,512),255,np.uint8),homography,(640,480))>0
            image[mask]=warped[mask]
        path=root/f'cube-{view}.png';cv2.imwrite(str(path),image)
        ident=f'cube-{view}';sources.append(source(path,ident))
        polygon=cv2.convexHull(np.concatenate(projected)).reshape(-1,2)
        polygon[:,0]=np.clip(polygon[:,0],0,639);polygon[:,1]=np.clip(polygon[:,1],0,479)
        masks.append({'sourceId':ident,'frameIndex':0,'polygon':polygon.tolist()})
    return sources,masks


def passive_parcel(directory,scale=1):
    """Clearly bounded synthetic kraft-like parcel for automatic-region plumbing."""
    rng=np.random.default_rng(44)
    image=np.full((480,640,3),40,np.uint8)
    image[40:440,50:590]=np.clip(np.array([115,155,185])+rng.normal(0,5,(400,540,3)),0,255).astype(np.uint8)
    image[140:320,200:440]=230
    for index,text in enumerate(('PACKPROOF','AB12345678','LABEL SAMPLE')):
        cv2.putText(image,text,(212,177+index*39),cv2.FONT_HERSHEY_SIMPLEX,.55,(10,10,10),2)
    if scale!=1:
        image=cv2.resize(image,(640*scale,480*scale),interpolation=cv2.INTER_NEAREST)
    path=Path(directory)/f'passive-parcel-{scale}.png';cv2.imwrite(str(path),image)
    return path

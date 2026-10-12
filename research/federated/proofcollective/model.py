"""Bounded logistic usefulness learner on technical quality measurements only."""
from __future__ import annotations
import numpy as np
from .governance import GateError, PURPOSE, verify, digest

FEATURES = ['sharpness', 'glare_fraction', 'local_contrast', 'bias']


def synthetic_dataset(partner: int, count: int = 128, *, holdout: bool = False) -> tuple[np.ndarray,np.ndarray]:
    """Invented quality vectors, not camera observations or physical accuracy data."""
    rng=np.random.default_rng(17031+partner+100000*int(holdout))
    raw=rng.uniform(-1,1,(count,3))
    x=np.column_stack((raw,np.ones(count)))
    y=(1.6*raw[:,0]-1.2*raw[:,1]+1.1*raw[:,2]+rng.normal(0,.16,count)>0).astype(np.float64)
    return x,y


def validate_dataset(x: np.ndarray,y: np.ndarray) -> None:
    if x.ndim!=2 or x.shape[1]!=4 or not 16<=len(x)<=512 or y.shape!=(len(x),):
        raise GateError('Dataset outside bounded local recipe')
    if not np.isfinite(x).all() or not np.isfinite(y).all() or np.max(np.abs(x))>1 or not np.isin(y,[0,1]).all():
        raise GateError('Invalid quality measurements or labels')


def train_update(x:np.ndarray,y:np.ndarray,model:np.ndarray,signed_recipe:dict, trusted_key:bytes) -> np.ndarray:
    recipe=verify(signed_recipe,trusted_key)
    if recipe['purpose']!=PURPOSE or recipe['featureOrder']!=FEATURES or recipe['modelDigest']!=digest(model.tolist()):
        raise GateError('Recipe purpose, feature order or model digest mismatch')
    steps,lr,clip=recipe['localSteps'],recipe['learningRate'],recipe['clipNorm']
    if not 1<=steps<=64 or not 0<lr<=1 or not 0<clip<=1 or model.shape!=(4,) or not np.isfinite(model).all():
        raise GateError('Training work or model outside governed bounds')
    validate_dataset(x,y)
    weights=model.copy()
    for _ in range(steps):
        pred=1/(1+np.exp(-np.clip(x@weights,-30,30)))
        weights-=lr*(x.T@(pred-y))/len(y)
    update=weights-model
    return update*min(1.0,clip/max(float(np.linalg.norm(update)),1e-12))


def evaluate(model:np.ndarray) -> dict:
    groups={}
    for group in range(3):
        pairs=[synthetic_dataset(100+group*20+i,256,holdout=True) for i in range(4)]
        x=np.concatenate([p[0] for p in pairs]); y=np.concatenate([p[1] for p in pairs])
        groups[f'synthetic-device-group-{group}']=float(np.mean((x@model>=0)==y))
    return {'accuracy':float(np.mean(list(groups.values()))),'groups':groups,'n':3072,'population':'frozen synthetic held-out quality vectors; no camera or partner validation','split':'seed-v1; training partners 1..64; holdout 100..143 with separate seed domain'}


def preprocess_quality(sharpness:np.ndarray,glare_fraction:np.ndarray,contrast:np.ndarray) -> np.ndarray:
    """Versioned deterministic transformation of local technical measurements.

    Sharpness is a declared Laplacian variance in [0,1000]; glare and normalized
    contrast are in [0,1]. Upstream acquisition/extractor qualification is separate.
    No images, transaction identifiers or person attributes are accepted here.
    """
    if sharpness.ndim!=1 or glare_fraction.shape!=sharpness.shape or contrast.shape!=sharpness.shape:
        raise GateError('Quality feature shape mismatch')
    raw=np.column_stack((sharpness,glare_fraction,contrast)).astype(np.float64)
    if not np.isfinite(raw).all() or np.any(raw<0) or np.any(raw[:,0]>1000) or np.any(raw[:,1:]>1):
        raise GateError('Quality measurements outside preprocessing-v1 ranges')
    return np.column_stack((2*raw[:,0]/1000-1,2*raw[:,1]-1,2*raw[:,2]-1,np.ones(len(raw))))


def load_consented_local_quality(path,partner:str,governance) -> tuple[np.ndarray,np.ndarray]:
    """Read a bounded, digest-consented local quality file; no telemetry or upload.

    Registration of real partner consent and deployment still needs independent
    governance approval. This loader alone grants no permission to collect data.
    """
    import hashlib
    import io
    import zipfile
    from pathlib import Path
    path=Path(path)
    if path.stat().st_size>65536:
        raise GateError('Local dataset byte limit exceeded')
    raw=path.read_bytes()
    governance.require_consent(partner,hashlib.sha256(raw).hexdigest())
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        if sum(info.file_size for info in archive.infolist())>65536 or len(archive.infolist())!=4:
            raise GateError('Local dataset expanded byte or array count limit exceeded')
        for info in archive.infolist():
            with archive.open(info) as member:
                version=np.lib.format.read_magic(member)
                if version==(1,0):
                    shape,order,dtype=np.lib.format.read_array_header_1_0(member)
                elif version==(2,0):
                    shape,order,dtype=np.lib.format.read_array_header_2_0(member)
                else:
                    raise GateError('Unsupported local array format')
                if len(shape)!=1 or not 16<=shape[0]<=512 or dtype.kind not in 'biuf' or dtype.itemsize>8:
                    raise GateError('Local array header outside resource bounds')
                if member.tell()+shape[0]*dtype.itemsize!=info.file_size:
                    raise GateError('Local array length does not match its header')
    with np.load(io.BytesIO(raw),allow_pickle=False) as local:
        if set(local.files)!={'sharpness','glare_fraction','contrast','usable'}:
            raise GateError('Local dataset may contain only permitted technical measurements')
        x=preprocess_quality(local['sharpness'],local['glare_fraction'],local['contrast'])
        y=local['usable'].astype(np.float64)
    validate_dataset(x,y)
    return x,y

#!/usr/bin/env python3
"""Offline compact temporal event candidate training. No pretrained packing claims."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import sys

import cv2
import numpy as np
from PIL import Image
from scipy.optimize import minimize
from scipy.special import logsumexp

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from research.benchmarks.statistics import validate_manifest,LEAKAGE_KEYS

EVENTS=('LABEL_VISIBLE','IDENTIFIER_OBSERVED','ITEM_TRACK_STARTED','ITEM_VISIBILITY_LOST','CONTAINER_VISIBLE','ITEM_CROSSES_OPENING','CLOSURE_ACTION_VISIBLE','SEAM_VISIBLE','RECORDING_INTERRUPTED','POSSIBLE_REOPENING')
METHOD='temporal-hog-linear-softmax.v1'


def strict_file(root,record):
    candidate=Path(record['path'])
    path=(root/candidate).resolve() if not candidate.is_absolute() else candidate.resolve()
    if not path.is_relative_to(root) or candidate.is_symlink() or path.stat().st_size>16*1024*1024:
        raise ValueError('TRAINING_SOURCE_OUTSIDE_POLICY')
    data=path.read_bytes()
    if hashlib.sha256(data).hexdigest()!=record['sha256']:
        raise ValueError('TRAINING_SOURCE_DIGEST_MISMATCH')
    with Image.open(path) as header:
        if header.width*header.height>4_000_000 or getattr(header,'n_frames',1)!=1:raise ValueError('TRAINING_IMAGE_LIMIT')
    image=cv2.imdecode(np.frombuffer(data,np.uint8),cv2.IMREAD_COLOR)
    if image is None or image.shape[0]*image.shape[1]>4_000_000:
        raise ValueError('TRAINING_IMAGE_LIMIT')
    return image


def features(root,record):
    frames=record.get('frames',[])
    if len(frames)!=3:
        raise ValueError('THREE_ORDERED_SOURCE_FRAMES_REQUIRED')
    if not all(isinstance(f.get('timeMs'),(int,float)) for f in frames) or not frames[0]['timeMs']<frames[1]['timeMs']<frames[2]['timeMs']:
        raise ValueError('ORDERED_FRAME_TIMING_REQUIRED')
    return features_from_images([strict_file(root,f) for f in frames])


def features_from_images(images):
    if len(images)!=3:raise ValueError('THREE_ORDERED_SOURCE_FRAMES_REQUIRED')
    images=[cv2.resize(image,(64,64),interpolation=cv2.INTER_AREA) for image in images]
    gray=[cv2.cvtColor(image,cv2.COLOR_BGR2GRAY) for image in images]
    descriptor=cv2.HOGDescriptor((64,64),(16,16),(8,8),(8,8),9)
    appearance=descriptor.compute(gray[1]).ravel()
    motion=np.concatenate([cv2.resize(cv2.absdiff(gray[i],gray[i+1]),(8,8),interpolation=cv2.INTER_AREA).ravel()/255 for i in range(2)])
    return np.concatenate([appearance,motion]).astype(np.float64)


def train(manifest,root,iterations=120):
    split=validate_manifest(manifest)
    if not split['valid']:
        raise ValueError('TRAINING_SPLIT_LEAKAGE')
    if manifest.get('dataOrigin') not in ('physical-consented','synthetic') or manifest.get('trainingConsentConfirmed') is not True:
        raise ValueError('PURPOSE_SPECIFIC_TRAINING_CONSENT_REQUIRED')
    records=manifest['records']
    if not 4<=len(records)<=1000:
        raise ValueError('TRAINING_RECORD_LIMIT')
    if any(r.get('annotation',{}).get('event') not in EVENTS or r['annotation'].get('ambiguous') is not False or not r['annotation'].get('annotatorId') for r in records):
        raise ValueError('SOURCE_LINKED_UNAMBIGUOUS_ANNOTATION_REQUIRED')
    train_rows=[r for r in records if r['split']=='train'];tune_rows=[r for r in records if r['split']=='tune']
    labels=sorted({r['annotation']['event'] for r in train_rows})
    if len(labels)<2 or len(train_rows)<4 or not tune_rows:
        raise ValueError('TRAIN_AND_TUNE_POPULATIONS_REQUIRED')
    if any(r['annotation']['event'] not in labels for r in tune_rows):
        raise ValueError('UNSEEN_TUNE_CLASS')
    x=np.stack([features(root,r) for r in train_rows]);y=np.asarray([labels.index(r['annotation']['event']) for r in train_rows])
    mean=x.mean(axis=0);scale=x.std(axis=0);scale[scale<1e-5]=1
    x=np.column_stack(((x-mean)/scale,np.ones(len(x))))
    classes=len(labels);target=np.eye(classes)[y];regularization=.01
    def loss_gradient(flat):
        weights=flat.reshape(x.shape[1],classes);logits=x@weights
        probability=np.exp(logits-logsumexp(logits,axis=1,keepdims=True))
        loss=float(np.mean(logsumexp(logits,axis=1)-logits[np.arange(len(y)),y])+regularization*np.square(weights[:-1]).sum()/2)
        gradient=x.T@(probability-target)/len(y);gradient[:-1]+=regularization*weights[:-1]
        return loss,gradient.ravel()
    optimized=minimize(loss_gradient,np.zeros(x.shape[1]*classes),jac=True,method='L-BFGS-B',options={'maxiter':iterations,'ftol':1e-9})
    weights=optimized.x.reshape(x.shape[1],classes)
    model={'schemaVersion':'packproof.event-model.v1','feature':'proofsight','method':METHOD,'labels':labels,'featureMean':mean.tolist(),'featureScale':scale.tolist(),'weights':weights.tolist(),
           'qualified':False,'customerDisplayEnabled':False,'dataOrigin':manifest['dataOrigin'],
           'trainingRecordIds':[r['recordId'] for r in train_rows], 'testSetAccessed':False,
           'leakageKeys':list(dict.fromkeys(LEAKAGE_KEYS+tuple(manifest.get('holdoutDimensions',[])))),
           'trainingLineage':[{key:r.get(key) for key in tuple(LEAKAGE_KEYS)+tuple(manifest.get('holdoutDimensions',[]))} for r in train_rows],
           'optimizer':{'method':'L-BFGS-B','iterations':int(optimized.nit),'converged':bool(optimized.success),'l2':regularization},
           'scoreSemantics':'Uncalibrated candidate-class score; not event truth, object identity, physical continuity or authenticity.'}
    evaluation=evaluate(model,root,tune_rows)
    return model,{'split':'tune','dataOrigin':manifest['dataOrigin'],'evaluation':evaluation,'physicalQualification':False,
                  'limitations':['No public event class can be enabled by this fit or its synthetic/tune-set metrics.','Independent physical test precision/recall and blinded reviewer evaluation remain required.']}


def predict(model,root,record):
    return predict_features(model,features(root,record),record)


def predict_features(model,x,record):
    if model.get('schemaVersion')!='packproof.event-model.v1' or model.get('feature')!='proofsight' or model.get('method')!=METHOD or model.get('qualified') is not False or not isinstance(model.get('labels'),list) or not 2<=len(model['labels'])<=len(EVENTS) or any(label not in EVENTS for label in model['labels']):
        raise ValueError('UNSUPPORTED_MODEL_POLICY')
    mean=np.asarray(model['featureMean']);scale=np.asarray(model['featureScale']);weights=np.asarray(model['weights'])
    if mean.shape!=x.shape or scale.shape!=x.shape or weights.shape!=(len(x)+1,len(model['labels'])) or not np.isfinite(weights).all() or not np.isfinite(mean).all() or not np.isfinite(scale).all() or not np.all(scale>0):
        raise ValueError('MODEL_SHAPE_INVALID')
    logits=np.append((x-mean)/scale,1)@weights;prob=np.exp(logits-logsumexp(logits));index=int(prob.argmax())
    return {'recordId':record['recordId'],'candidateEvent':model['labels'][index],'candidateScore':float(prob[index]),
            'qualified':False,'findingState':'INCONCLUSIVE','sourceRefs':[{k:f[k] for k in ('sha256','timeMs')} for f in record['frames']],
            'scoreSemantics':'Uncalibrated model output. Candidate requires attributed human review.'}


def evaluate(model,root,records):
    predictions=[predict(model,root,r) for r in records]
    classes=model['labels'];counts=np.zeros((len(classes),len(classes)),dtype=int)
    for record,prediction in zip(records,predictions):
        counts[classes.index(record['annotation']['event']),classes.index(prediction['candidateEvent'])]+=1
    return {'population':len(records),'labels':classes,'confusionMatrix':counts.tolist(),'predictions':predictions,
            'accuracyOnThisAnnotatedPopulation':float(np.trace(counts)/max(1,counts.sum())),
            'qualified':False,'abstentionPolicy':'All machine output remains INCONCLUSIVE pending independent qualification.'}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('operation',choices=['train','evaluate'])
    parser.add_argument('--manifest',required=True);parser.add_argument('--output',required=True);parser.add_argument('--model');parser.add_argument('--model-sha256')
    args=parser.parse_args();manifest_path=Path(args.manifest).resolve()
    if manifest_path.stat().st_size>4*1024*1024:raise ValueError('MANIFEST_SIZE_LIMIT')
    data=manifest_path.read_bytes();manifest=json.loads(data);root=manifest_path.parent
    if args.operation=='train':
        model,report=train(manifest,root)
        model['trainingManifestSha256']=hashlib.sha256(data).hexdigest()
        output={'model':model,'report':report}
    else:
        model_data=Path(args.model).read_bytes()
        if len(model_data)>4*1024*1024 or hashlib.sha256(model_data).hexdigest()!=args.model_sha256:raise ValueError('MODEL_DIGEST_MISMATCH')
        model=json.loads(model_data)['model']
        if not validate_manifest(manifest)['valid']:raise ValueError('EVALUATION_SPLIT_LEAKAGE')
        records=[r for r in manifest['records'] if r['split']=='test']
        if not records:raise ValueError('INDEPENDENT_TEST_POPULATION_REQUIRED')
        if any(r['recordId'] in model['trainingRecordIds'] for r in records):raise ValueError('EVALUATION_RECORD_LEAKAGE')
        for key in model['leakageKeys']:
            seen={r.get(key) for r in model['trainingLineage'] if r.get(key)}
            if any(r.get(key) in seen for r in records):raise ValueError('EVALUATION_PHYSICAL_OR_SOURCE_LEAKAGE')
        output={'modelSha256':args.model_sha256,'evaluation':evaluate(model,root,records),'qualified':False}
    with Path(args.output).open('x') as file:json.dump(output,file,sort_keys=True,allow_nan=False,indent=2)
    print(json.dumps({'output':args.output,'qualified':False,'operation':args.operation}))


if __name__=='__main__':main()

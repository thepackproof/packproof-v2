#!/usr/bin/env python3
"""Offline JSON Schema validation of R&D API and shared external contracts.
Install scripts/requirements-rnd-contracts.txt in an isolated environment first.
"""
import json
from pathlib import Path
from jsonschema import Draft202012Validator
from referencing import Registry,Resource

ROOT=Path(__file__).resolve().parents[1]
API=ROOT/'backend/rnd-openapi.json'
doc=json.loads(API.read_text())
resources=[(API.as_uri(),Resource.from_contents(doc,default_specification=__import__('referencing.jsonschema',fromlist=['DRAFT202012']).DRAFT202012))]
for file in sorted((ROOT/'packages/evidence-contracts/schemas').glob('*.json')):
 schema=json.loads(file.read_text());Draft202012Validator.check_schema(schema)
 resource=Resource.from_contents(schema)
 resources.extend([(file.as_uri(),resource),(schema['$id'],resource)])
registry=Registry().with_resources(resources)
for name,schema in doc['components']['schemas'].items():
 Draft202012Validator.check_schema(schema)
 # Resolve every reference offline, including those nested below optional fields.
 def walk(value,base=API.as_uri()):
  if isinstance(value,dict):
   if '$ref' in value:registry.resolver(base).lookup(value['$ref'])
   for v in value.values():walk(v,base)
  elif isinstance(value,list):
   for v in value:walk(v,base)
 walk(schema)
def validates(name,instance):
 schema={'$ref':API.as_uri()+'#/components/schemas/'+name}
 return Draft202012Validator(schema,registry=registry).is_valid(instance)
valid={
 'AnalysisRequest':{'feature':'proofsight','evidenceIds':['ev1'],'parameters':{'samplingHz':2,'annotations':[{'annotationId':'a1','sourceId':'ev1','semanticClass':'PARCEL','polygon':[[0,0],[10,0],[10,10]]}]}},
 'ConsentInput':{'purpose':'EXPERIMENTAL_ANALYSIS','version':'packproof.research-consent.v1','granted':True},
 'DerivativeRequest':{'evidenceIds':['ev1'],'parameters':{'mode':'zk-prove','enrollmentId':'z1','mask':[True]*16}},
 'DerivativeGrantInput':{'artifactSha256':'a'*64,'recipeSha256':'b'*64,'expiresInSeconds':60},
 'PlatformVerifyInput':{'platform':'android','token':'token'},
}
for name,value in valid.items():assert validates(name,value),name
invalid=[
 ('AnalysisRequest',{'feature':'proofsight','evidenceIds':['e'],'parameters':{'modelPath':'/tmp/a'}}),
 ('AnalysisRequest',{'feature':'proofpilot','evidenceIds':['e'],'parameters':{'samplingHz':0}}),
 ('AnalysisRequest',{'feature':'proofsight','evidenceIds':['e','e']}),
 ('AnalysisRequest',{'feature':'proofsight','evidenceIds':['e'],'parameters':{'annotations':[{'annotationId':'a','sourceId':'e','semanticClass':'PARCEL','polygon':[[0,0]]}]}}),
 ('DerivativeRequest',{'evidenceIds':['e'],'parameters':{'mode':'zk-prove','enrollmentId':'z','mask':[True]*17}}),
 ('DerivativeGrantInput',{**valid['DerivativeGrantInput'],'expiresInSeconds':86401}),
 ('PlatformVerifyInput',{'platform':'android','token':'token','attestationObjectBase64':'ios'}),
 ('ConsentInput',{**valid['ConsentInput'],'tenantId':'forged'}),
]
for name,value in invalid:assert not validates(name,value),name
print(f"Validated {len(doc['components']['schemas'])} schemas, offline references, {len(valid)} positive and {len(invalid)} adversarial request fixtures.")

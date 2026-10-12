"""Security, attribution and statistical tests using generated nonprivate data."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from research.benchmarks.fixtures import basic,source,passive_parcel
from research.benchmarks.run import REGIONS,SUPPORT
from research.benchmarks.statistics import independent_error_report,one_sided_upper,validate_manifest


class WorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary=tempfile.TemporaryDirectory(prefix='pp-vision-tests-')
        cls.root=Path(cls.temporary.name);cls.paths=basic(cls.root/'sources');cls.sequence=0

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def execute(self,feature='proofpilot',sources=None,parameters=None,trusted_models=None):
        type(self).sequence+=1
        directory=self.root/f'case-{self.sequence}';directory.mkdir()
        job={'schemaVersion':'packproof.vision-job.v1','feature':feature,'sandboxRoot':str(self.root),
             'sources':sources if sources is not None else [source(self.paths['base'],'source-a')],'parameters':parameters or {}}
        if trusted_models is not None:job['trustedModels']=trusted_models
        path=directory/'job.json';path.write_text(json.dumps(job))
        process=subprocess.run([sys.executable,str(ROOT/'research/vision/worker.py'),'--job',str(path),'--output',str(directory)],capture_output=True,timeout=60)
        self.assertTrue((directory/'result.json').exists(),process.stderr.decode())
        return json.loads((directory/'result.json').read_text()),directory

    def assert_failure(self,result,reason):
        self.assertEqual(result['operationalState'],'FAILED')
        self.assertEqual(result['findingState'],'NOT_CHECKED')
        self.assertEqual(result['diagnostics']['errorCode'],reason)
        self.assertEqual(result['observations'],[])

    def test_digest_corruption(self):
        item=source(self.paths['base'],'a');item['sha256']='0'*64
        result,_=self.execute(sources=[item]);self.assert_failure(result,'SOURCE_DIGEST_MISMATCH')

    def test_external_url_rejected_before_decoder(self):
        item=source(self.paths['base'],'a');item['path']='https://example.invalid/image.png'
        result,_=self.execute(sources=[item]);self.assert_failure(result,'LOCAL_FILE_REQUIRED')

    def test_outside_path_rejected(self):
        item=source(self.paths['base'],'a');item['path']='/etc/passwd'
        result,_=self.execute(sources=[item]);self.assert_failure(result,'PATH_OUTSIDE_SANDBOX')

    def test_symlink_rejected(self):
        link=self.root/'symbolic.png';link.symlink_to(self.paths['base'])
        item=source(self.paths['base'],'a');item['path']=str(link)
        result,_=self.execute(sources=[item]);self.assert_failure(result,'SOURCE_SYMLINK_REJECTED')

    def test_client_qualification_override_rejected(self):
        result,_=self.execute(parameters={'qualified':True});self.assert_failure(result,'CLIENT_POLICY_OVERRIDE_REJECTED')

    def test_spoofed_container_rejected(self):
        item=source(self.paths['base'],'a');item['mimeType']='video/mp4'
        result,_=self.execute(sources=[item]);self.assert_failure(result,'MEDIA_CONTAINER_SIGNATURE_MISMATCH')

    def test_source_length_and_duplicate_ids_rejected(self):
        item=source(self.paths['base'],'a');item['byteLength']+=1
        result,_=self.execute(sources=[item]);self.assert_failure(result,'SOURCE_LENGTH_MISMATCH')
        item=source(self.paths['base'],'a')
        result,_=self.execute(sources=[item,item]);self.assert_failure(result,'INVALID_OR_DUPLICATE_SOURCE_ID')

    def test_quality_preserves_context(self):
        result,directory=self.execute(sources=[source(self.paths[name],name) for name in ('base','blur','glare')])
        self.assertEqual(result['findingState'],'RECORDED')
        values={x['sourceRefs'][0]['sourceId']:x['value'] for x in result['observations']}
        self.assertGreater(values['base']['laplacianVariance'],values['blur']['laplacianVariance'])
        self.assertFalse(values['glare']['screeningUsable'])
        self.assertTrue(values['glare']['retainedContext'])
        self.assertEqual(set(a['sourceRefs'][0]['sourceId'] for a in result['artifacts']),{'base','blur','glare'})
        for artifact in result['artifacts']:
            self.assertTrue((directory/artifact['path']).exists())
            self.assertEqual(source(directory/artifact['path'],'check')['sha256'],artifact['sha256'])

    def test_material_groups_and_missing_carton(self):
        inputs=[source(self.paths['base'],'a'),source(self.paths['label-transfer'],'b')]
        result,_=self.execute('proofprint',inputs,{'regions':REGIONS})
        self.assertEqual(result['findingState'],'INCONCLUSIVE')
        self.assertEqual(set(result['diagnostics']['observedGroups']),{'carton','label'})
        self.assertTrue(all(not x['value']['qualified'] for x in result['observations']))
        result,_=self.execute('proofprint',inputs,{'regions':REGIONS[:2]})
        self.assertEqual(result['diagnostics']['missingGroups'],['carton'])
        self.assertEqual(result['findingState'],'INCONCLUSIVE')

    def test_single_video_is_not_two_capture_comparison(self):
        result,_=self.execute('proofprint',[source(self.paths['response'],'a')],{'regions':REGIONS,'samplingHz':1})
        self.assertEqual(result['findingState'],'NOT_CHECKED')

    def test_condition_requires_unchanged_support(self):
        inputs=[source(self.paths['base'],'a'),source(self.paths['condition-change'],'b')]
        result,_=self.execute('prooftwin',inputs)
        self.assertEqual(result['diagnostics']['reason'],'UNCHANGED_SUPPORT_REGION_REQUIRED')
        result,_=self.execute('prooftwin',inputs,{'regions':SUPPORT})
        self.assertGreater(result['observations'][0]['value']['changedPixelFractionInObservedArea'],0)
        self.assertIsNone(result['observations'][0]['value']['metricDimensions'])

    def test_timeline_never_bridges_sparse_gaps(self):
        result,_=self.execute('proofsight',[source(self.paths['response'],'a')],{'samplingHz':1})
        self.assertEqual(result['operationalState'],'SUCCEEDED')
        self.assertFalse(result['diagnostics']['fullContinuity'])
        self.assertTrue(result['coverage']['sources'][0]['gaps'])
        self.assertTrue(any(x['type']=='IDENTIFIER_OBSERVED' for x in result['observations']))
        for observation in result['observations']:
            self.assertTrue(observation['sourceRefs'])
            self.assertTrue(all(ref['sourceId']=='a' for ref in observation['sourceRefs']))

    def test_passive_enrollment_needs_no_manual_regions_and_freezes_unavailable(self):
        path=passive_parcel(self.root)
        result,directory=self.execute('proofprint',[source(path,'parcel')],{'mode':'enroll'})
        self.assertEqual(result['operationalState'],'SUCCEEDED')
        self.assertTrue(result['diagnostics']['associationCandidateAvailable'])
        self.assertEqual(result['diagnostics']['stateHistory'],['CANDIDATE','SOURCES_COMMITTED','ANALYZED','UNAVAILABLE','LOCKED'])
        enrollment=json.loads((directory/'enrollment.json').read_text())
        self.assertEqual(enrollment['frozenRequiredGroups'],['label','carton'])
        self.assertEqual(len(enrollment['regions']),4)
        self.assertFalse(enrollment['qualified'])
        self.assertTrue(enrollment['locked'])

    def test_passive_ambiguous_scene_abstains(self):
        result,directory=self.execute('proofprint',[source(self.paths['glare'],'ambiguous')],{'mode':'enroll'})
        self.assertEqual(result['findingState'],'INCONCLUSIVE')
        self.assertFalse(result['diagnostics']['associationCandidateAvailable'])
        self.assertEqual(json.loads((directory/'enrollment.json').read_text())['regions'],[])

    def test_fingerprint_crops_preserve_original_pixel_resolution(self):
        import cv2
        path=passive_parcel(self.root,3)
        regions=[{'regionId':'label','group':'label','polygon':[[630,450],[1260,450],[1260,900],[630,900]]},
                 {'regionId':'carton','group':'carton','polygon':[[180,180],[510,180],[510,900],[180,900]]}]
        result,directory=self.execute('proofprint',[source(path,'a'),source(path,'b')],{'regions':regions})
        self.assertEqual(result['operationalState'],'SUCCEEDED')
        crop=cv2.imread(str(directory/'region-0-first.png'))
        self.assertEqual(crop.shape[:2],(451,631))
        self.assertEqual(result['observations'][0]['value']['pixelSampling'],'ORIGINAL_DECODED_SOURCE_PIXELS')

    def test_native_luma_sidecar_has_distinct_time_association(self):
        import cv2
        path=self.root/'native-luma.pgm'
        cv2.imwrite(str(path),cv2.imread(str(self.paths['base']),cv2.IMREAD_GRAYSCALE))
        item=source(path,'sidecar');item['mimeType']='image/x-portable-graymap'
        item['relationship']='CONCURRENT_SIDECAR';item['frameReference']={'mediaTimeMs':1250,'width':640,'height':480}
        result,_=self.execute('proofpilot',[item])
        self.assertEqual(result['operationalState'],'SUCCEEDED')
        ref=result['observations'][0]['sourceRefs'][0]
        self.assertEqual(ref['relationship'],'CONCURRENT_SIDECAR')
        self.assertEqual(ref['captureTimeAssociation']['mediaTimeMs'],1250)
        self.assertIsNone(ref['timeMs'])
        self.assertEqual(result['coverage']['sources'][0]['colorScope'],'LUMA_ONLY_NO_CHROMATIC_MATERIAL_ASSURANCE')

    def test_source_attributed_masks_and_controlled_background_segmentation(self):
        import cv2
        import numpy as np
        background=np.full((160,200,3),30,np.uint8);target=background.copy();target[40:120,60:150]=200
        bg=self.root/'background.png';fg=self.root/'foreground.png'
        cv2.imwrite(str(bg),background);cv2.imwrite(str(fg),target)
        params={'annotations':[{'annotationId':'reviewer-mask','sourceId':'target','frameIndex':0,'semanticClass':'PARCEL','polygon':[[60,40],[149,40],[149,119],[60,119]]}],
                'annotationActorId':'authenticated-researcher','segmentation':{'mode':'STATIC_BACKGROUND_DIAGNOSTIC','backgroundSourceId':'background'}}
        result,_=self.execute('proofsight',[source(bg,'background'),source(fg,'target')],params)
        self.assertEqual(result['operationalState'],'SUCCEEDED')
        annotation=next(o for o in result['observations'] if o['type']=='REGION_MASK_ANNOTATION')
        foreground=next(o for o in result['observations'] if o['type']=='FOREGROUND_MASK_DIAGNOSTIC')
        self.assertEqual(annotation['value']['attribution']['actorId'],'authenticated-researcher')
        self.assertGreater(foreground['value']['maskPixels'],6000)
        self.assertIsNone(foreground['value']['regions'][0]['physicalObjectIdentity'])
        self.assertFalse(result['diagnostics']['fullContinuity'])

    def test_real_appearance_diagnostics_never_assert_instance_identity(self):
        result,_=self.execute('proofmatch',[source(self.paths['base'],'a'),source(self.paths['same-content-copy'],'b')])
        self.assertEqual(result['operationalState'],'SUCCEEDED')
        value=result['observations'][0]['value']
        self.assertEqual(result['observations'][0]['channel'],'appearance')
        self.assertIsNone(value['physicalInstanceConclusion'])
        self.assertIsInstance(value['histogramIntersection'],float)
        self.assertFalse(value['qualified'])

    def test_pinned_model_executes_source_linked_inference_and_rejects_wrong_digest(self):
        import cv2
        import numpy as np
        import hashlib
        from research.vision.action_model import train
        records=[]
        for i in range(8):
            frames=[]
            for j in range(3):
                image=np.full((80,80,3),20,np.uint8)
                if i%2:cv2.rectangle(image,(10+j,10),(60,65),(200,210,220),3)
                else:cv2.putText(image,'TEST',(3,40+j),cv2.FONT_HERSHEY_SIMPLEX,.65,(220,210,200),2)
                image[0,0]=[i,j,1]
                path=self.root/f'training-{i}-{j}.png';cv2.imwrite(str(path),image)
                frames.append({'path':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'timeMs':j*1000})
            records.append({'recordId':f'train-{i}','split':'train' if i<6 else 'tune','physicalInstanceId':f'synthetic-{i}',
                            'captureSessionId':f'capture-{i}','sourceDigest':hashlib.sha256(str(frames).encode()).hexdigest(),
                            'deviceId':'SYNTHETIC_RENDERER','materialLot':'NONE','attackFamily':'synthetic-protocol','frames':frames,
                            'annotation':{'event':'CONTAINER_VISIBLE' if i%2 else 'LABEL_VISIBLE','ambiguous':False,'annotatorId':'SYNTHETIC_FIXTURE_GENERATOR'}})
        model,_=train({'dataOrigin':'synthetic','trainingConsentConfirmed':True,'records':records},self.root,30)
        model_path=self.root/'trained-event-model.json';model_path.write_text(json.dumps({'model':model}))
        pin={'path':str(model_path),'sha256':hashlib.sha256(model_path.read_bytes()).hexdigest(),'releaseId':'synthetic-engineering-only'}
        result,_=self.execute('proofsight',[source(self.paths['response'],'response')],{'samplingHz':1},{'proofsight':pin})
        self.assertEqual(result['operationalState'],'SUCCEEDED')
        predictions=[o for o in result['observations'] if o['type']=='ACTION_MODEL_CANDIDATE']
        self.assertGreater(len(predictions),0)
        self.assertTrue(all(o['value']['qualified'] is False and len(o['sourceRefs'])==3 for o in predictions))
        result,_=self.execute('proofsight',[source(self.paths['response'],'response')],{'samplingHz':1},{'proofsight':{**pin,'sha256':'0'*64}})
        self.assert_failure(result,'MODEL_DIGEST_MISMATCH')

    def test_missing_challenge_and_unsafe_schedule(self):
        inputs=[source(self.paths['response'],'a')]
        result,_=self.execute('prooflive',inputs)
        self.assertEqual(result['findingState'],'NOT_CHECKED')
        result,_=self.execute('prooflive',inputs,{'challenge':{'commands':[{'timeMs':i*50,'level':i%2} for i in range(4)]}})
        self.assert_failure(result,'UNSAFE_OR_UNORDERED_CHALLENGE_SCHEDULE')


class StatisticalTests(unittest.TestCase):
    def test_zero_error_bound_requires_independent_population(self):
        self.assertGreater(one_sided_upper(0,100),.0001)
        self.assertLessEqual(one_sided_upper(0,30000),.0001)
        self.assertAlmostEqual(one_sided_upper(0,10),1-.05**.1)

    def test_pairs_do_not_inflate_independence(self):
        attempts=[{'independentUnitId':'one-carton','attackFamily':'transfer','outcome':'CORRECT'} for _ in range(10000)]
        report=independent_error_report(attempts,.0001)
        self.assertEqual(report['families'][0]['evaluatedUnits'],1)
        self.assertFalse(report['families'][0]['passesErrorBound'])
        self.assertEqual(report['zeroErrorUnitsNeeded'],29956)

    def test_any_error_preserved_in_unit(self):
        attempts=[{'independentUnitId':'one','attackFamily':'copy','outcome':x} for x in ('CORRECT','ERROR','ABSTAIN')]
        self.assertEqual(independent_error_report(attempts,.01)['families'][0]['errorUnits'],1)

    def test_split_leakage_and_held_out_devices(self):
        record={'recordId':'a','split':'train','physicalInstanceId':'p','captureSessionId':'c','sourceDigest':'d','deviceId':'phone','materialLot':'lot','attackFamily':'genuine'}
        other={**record,'recordId':'b','split':'test','captureSessionId':'c2','sourceDigest':'d2'}
        check=validate_manifest({'records':[record,other],'holdoutDimensions':['deviceId']})
        self.assertFalse(check['valid'])
        self.assertEqual({e['dimension'] for e in check['errors']},{'physicalInstanceId','deviceId'})


if __name__=='__main__':
    unittest.main()

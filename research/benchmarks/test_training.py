"""Synthetic fitting checks only; no packing-action accuracy or physical labels."""
import hashlib
from pathlib import Path
import tempfile
import unittest
import cv2
import numpy as np

from research.vision.action_model import train,predict
from research.benchmarks.create_corpus_template import template


class CorpusTemplate(unittest.TestCase):
    def test_exact_planned_population_has_no_fabricated_sources(self):
        plan=template()
        self.assertEqual(len(plan['plannedLabels']),240)
        self.assertEqual(len(plan['plannedCartons']),60)
        self.assertEqual(plan['records'],[])
        self.assertTrue(all(x['sourceDigest'] is None and not x['groundTruthVerified'] for x in plan['plannedLabels']))
        self.assertEqual(len(set(x['plannedPrintInstanceId'] for x in plan['plannedLabels'])),240)


class TrainingProtocol(unittest.TestCase):
    def test_actual_fit_and_predictions_stay_unqualified(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);records=[]
            for i in range(8):
                frames=[]
                for j in range(3):
                    image=np.full((80,80,3),20,np.uint8)
                    if i%2:cv2.rectangle(image,(10+j,10),(60,65),(200,210,220),3)
                    else:cv2.putText(image,'TEST',(3,40+j),cv2.FONT_HERSHEY_SIMPLEX,.65,(220,210,200),2)
                    image[0,0]=[i,j,1] # Distinct synthetic source digest without influencing task feature.
                    path=root/f'{i}-{j}.png';cv2.imwrite(str(path),image)
                    frames.append({'path':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'timeMs':j*1000})
                records.append({'recordId':f'record-{i}','split':'train' if i<6 else 'tune','physicalInstanceId':f'synthetic-{i}',
                                'captureSessionId':f'capture-{i}','sourceDigest':hashlib.sha256(str(frames).encode()).hexdigest(),
                                'deviceId':'SYNTHETIC_RENDERER','materialLot':'NONE','attackFamily':'synthetic-protocol','frames':frames,
                                'annotation':{'event':'CONTAINER_VISIBLE' if i%2 else 'LABEL_VISIBLE','ambiguous':False,'annotatorId':'SYNTHETIC_FIXTURE_GENERATOR'}})
            manifest={'dataOrigin':'synthetic','trainingConsentConfirmed':True,'records':records}
            model,report=train(manifest,root,iterations=30)
            self.assertFalse(model['qualified']);self.assertFalse(model['customerDisplayEnabled']);self.assertFalse(model['testSetAccessed'])
            self.assertEqual(report['evaluation']['population'],2)
            prediction=predict(model,root,records[-1])
            self.assertEqual(prediction['findingState'],'INCONCLUSIVE');self.assertEqual(len(prediction['sourceRefs']),3)
            self.assertTrue(np.isfinite(np.asarray(model['weights'])).all())
            manifest['trainingConsentConfirmed']=False
            with self.assertRaisesRegex(ValueError,'CONSENT'):train(manifest,root)


if __name__=='__main__':unittest.main()

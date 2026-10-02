#!/usr/bin/env python3
"""Create the frozen PLANNED-ONLY 240-label/60-carton acquisition matrix."""
import argparse
import hashlib
import json
from pathlib import Path

TECHNOLOGIES=('DIRECT_THERMAL','THERMAL_TRANSFER','INKJET','LASER')
ATTACKS=('same-content-reprint','photographed-print','screen-replay','label-transfer','carton-patch-transfer','wrong-template','probing','malicious-baseline','partial-occlusion','same-box-reopening')


def template():
    labels=[];cartons=[]
    # 4 technologies x 3 lots x 2 repeated-content designs x 10 physical copies.
    for technology in TECHNOLOGIES:
        for lot in range(1,4):
            split=('train','tune','test')[lot-1]
            for design in range(1,3):
                for copy in range(1,11):
                    ident=f'{technology}-LOT{lot}-D{design}-COPY{copy:02d}'
                    labels.append({'plannedPrintInstanceId':ident,'plannedSubstrateId':f'SUBSTRATE-{ident}',
                                   'printTechnology':technology,'plannedMediaLotId':f'{technology}-LOT{lot}',
                                   'contentDesignId':f'IDENTICAL-CONTENT-DESIGN-{design}',
                                   'plannedPrinterUnitId':f'{technology}-LOT{lot}-UNIT{1+(copy%2)}',
                                   'split':split,'collectionState':'NOT_COLLECTED','sourceDigest':None,
                                   'actualDeviceIds':[],'actualCaptureSessionIds':[],'groundTruthVerified':False})
    for kind in ('SINGLE_WALL_KRAFT','RECYCLED_CORRUGATED','COATED_WHITE_CORRUGATED'):
        for index in range(1,21):
            cartons.append({'plannedCartonId':f'{kind}-{index:02d}','surfaceClass':kind,
                            'condition':'NEW' if index<=10 else 'REUSED',
                            'split':('train','tune','test')[(index-1)%3],
                            'collectionState':'NOT_COLLECTED','sourceDigest':None,'groundTruthVerified':False})
    return {'schemaVersion':'packproof.physical-corpus-plan.v1','version':'optical-screening-240-60-v1',
            'state':'FROZEN_ACQUISITION_TEMPLATE_NOT_DATA','dataOrigin':'NOT_COLLECTED','records':[],
            'plannedLabels':labels,'plannedCartons':cartons,
            'counts':{'plannedLabelInstances':240,'plannedCartonInstances':60,'collectedLabelInstances':0,'collectedCartonInstances':0},
            'captureMatrix':{'directions':['S24_ULTRA_TO_A16','A16_TO_S24_ULTRA','INDEPENDENT_ANDROID_CROSS_DEVICE','INDEPENDENT_IPHONE_CROSS_DEVICE'],
                             'modes':['ORDINARY_CONTINUOUS_VIDEO','CONCURRENT_NATIVE_SELECTED_FRAME','COACHED_LAB_CLOSEUP_SEPARATE'],
                             'conditions':['DIFFERENT_OPERATORS','DIFFERENT_DAYS','LOW_AMBIENT','HIGH_AMBIENT','NATURAL_MOTION','NORMAL_DISTANCE'],
                             'requiredFields':['actualDeviceId','deviceFamily','operatorId','captureSessionId','nativeStreamProfile','sourceDigest','shipmentLegId','regionGroundTruth','assemblyStateId','contentsClosureScenario','consentRecordId','retentionUntil']},
            'assemblyProtocols':['SAME_LABEL_SAME_CARTON','SAME_LABEL_DIFFERENT_CARTON','SAME_CARTON_DIFFERENT_LABEL','SMALL_INTERNAL_MARKER_CONTROL_NO_PRODUCTION_REQUIREMENT'],
            'attackFamilies':list(ATTACKS),'handlingFamilies':['scuff','fold','moisture-drying','dirt','compression','thermal-heat-light','over-tape','torn-label','legitimate-reprint','carrier-reboxing'],
            'ablationVariants':['BARCODE_ONLY','IMAGE_LAYOUT_ONLY','PRINT_RESIDUAL','SUBSTRATE_ONLY','RELATIONSHIP_ONLY','MULTIFRAME','COMPLETE'],
            'splitPolicy':{'physicalItemLeakageForbidden':True,'sourceDigestLeakageForbidden':True,'mainTemplateHoldouts':['mediaLotId','printerUnitId'],
                           'separateBlindDomainStudies':['PRINT_DESIGN','DEVICE_FAMILY','OPERATOR'],
                           'note':'Actual device/operator inventories must be assigned before collecting and freezing each blind study. Reused phones/designs in optical screening cannot be relabeled as held-out-domain validation.'},
            'stageB':{'minimumPlannedDistinctAssemblies':1000,'collectedAssemblies':0,'rareErrorQualificationSatisfied':False},
            'limits':['All identifiers are planned specimen allocations, not captured media or measured results.',
                      'A transferred original label is same-label and different-assembly ground truth.',
                      'Frozen detector/matcher thresholds and independent evaluation population require a separate versioned approved protocol.',
                      'This template intentionally fails dataset evaluation until real consented records and immutable source hashes exist.']}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',required=True)
    args=parser.parse_args();path=Path(args.output)
    data=(json.dumps(template(),indent=2,sort_keys=True)+'\n').encode()
    with path.open('xb') as file:file.write(data)
    with path.with_suffix(path.suffix+'.sha256').open('x') as file:file.write(hashlib.sha256(data).hexdigest()+'  '+path.name+'\n')
    print(json.dumps({'template':str(path),'labels':240,'cartons':60,'collected':0}))


if __name__=='__main__':main()

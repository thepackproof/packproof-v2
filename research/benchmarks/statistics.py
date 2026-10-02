"""Prespecified independent-unit evaluation; pair counts are not independent trials."""
from __future__ import annotations
import math
from collections import defaultdict
from scipy.stats import beta


LEAKAGE_KEYS=('physicalInstanceId','captureSessionId','sourceDigest','printRunId','cartonId','labelId')


def validate_manifest(manifest):
    records=manifest.get('records',[])
    if not isinstance(records,list) or not records:
        raise ValueError('EMPTY_DATASET_MANIFEST')
    required=('recordId','split','physicalInstanceId','captureSessionId','sourceDigest','deviceId','materialLot','attackFamily')
    seen={}; errors=[]; keys=tuple(dict.fromkeys(LEAKAGE_KEYS+tuple(manifest.get('holdoutDimensions',[]))))
    if any(key not in LEAKAGE_KEYS+('deviceId','materialLot','printerUnitId','attackDeviceId') for key in keys):
        raise ValueError('UNKNOWN_HOLDOUT_DIMENSION')
    ids=set()
    for record in records:
        if any(not record.get(key) for key in required):
            errors.append({'recordId':record.get('recordId'),'reason':'MISSING_REQUIRED_LINEAGE'});continue
        if record['recordId'] in ids:
            errors.append({'recordId':record['recordId'],'reason':'DUPLICATE_RECORD'})
        ids.add(record['recordId'])
        if record['split'] not in ('train','tune','test'):
            errors.append({'recordId':record['recordId'],'reason':'INVALID_SPLIT'})
        for key in keys:
            value=record.get(key)
            if not value:
                continue
            previous=seen.setdefault((key,str(value)),record['split'])
            if previous!=record['split']:
                errors.append({'recordId':record['recordId'],'reason':'SPLIT_LEAKAGE','dimension':key,'value':value})
    return {'valid':not errors,'recordCount':len(records),'errors':errors,'isPhysicalValidation':manifest.get('dataOrigin')=='physical-consented',
            'holdoutDimensions':list(keys)}


def one_sided_upper(events,trials,confidence=.95):
    if not isinstance(events,int) or not isinstance(trials,int) or events<0 or trials<0 or events>trials:
        raise ValueError('INVALID_EVENT_COUNTS')
    if not 0<confidence<1:
        raise ValueError('INVALID_CONFIDENCE')
    if trials==0 or events==trials:
        return 1.
    return float(beta.ppf(confidence,events+1,trials-events))


def independent_error_report(attempts,target,confidence=.95):
    """Aggregate dependent pairs within physical experiment units pessimistically."""
    grouped=defaultdict(list)
    for attempt in attempts:
        if not attempt.get('independentUnitId') or not attempt.get('attackFamily'):
            raise ValueError('INDEPENDENT_UNIT_AND_FAMILY_REQUIRED')
        if attempt.get('outcome') not in ('ERROR','CORRECT','ABSTAIN','EXCLUDED'):
            raise ValueError('INVALID_OUTCOME')
        grouped[(attempt['attackFamily'],attempt['independentUnitId'])].append(attempt['outcome'])
    families=sorted({family for family,_ in grouped});results=[]
    for family in families:
        units=[values for (kind,_),values in grouped.items() if kind==family]
        errors=sum('ERROR' in values for values in units)
        evaluated=sum(any(value in ('ERROR','CORRECT') for value in values) for values in units)
        upper=one_sided_upper(errors,evaluated,confidence)
        results.append({'attackFamily':family,'attempts':sum(map(len,units)),'independentUnits':len(units),'evaluatedUnits':evaluated,
                        'errorUnits':errors,'abstentionOnlyUnits':sum(all(v=='ABSTAIN' for v in values) for values in units),
                        'excludedOnlyUnits':sum(all(v=='EXCLUDED' for v in values) for values in units),
                        'oneSidedUpperBound':upper,'confidence':confidence,'target':target,'passesErrorBound':evaluated>0 and upper<=target})
    return {'method':'Exact one-sided Clopper-Pearson at the prespecified independent experimental unit; any error counts the unit as error.',
            'families':results,'zeroErrorUnitsNeeded':math.ceil(math.log(1-confidence)/math.log(1-target)),
            'limitations':['A statistical bound assumes genuinely independent prespecified units and cannot excuse a repeatable bypass.',
                           'Error bound alone does not satisfy conclusive coverage, eligible population or physical validation gates.']}

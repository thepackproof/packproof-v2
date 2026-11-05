"""Run only with an authorized sandbox source identity and server credential."""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages' / 'partner-sdk-python'))
from packproof import PackProofClient, PackProofError


def first_record(client, integration_account_id, operator_membership_id, external_id):
    receipt = client.create_proof({
        'integrationAccountId': integration_account_id,
        'operatorMembershipId': operator_membership_id,
        'externalId': external_id,
        'transaction': {'itemTitle': 'Pump assembly', 'quantity': 2},
    }, idempotency_key=f'source:{external_id}:import:v1')
    record = client.get_proof(receipt.data['proofId'])
    return {'proofId': receipt.data['proofId'], 'created': receipt.data['created'], 'recordRevision': receipt.data.get('recordRevision'), 'portalPath': receipt.data.get('portalPath'), 'requestId': record.request_id}


def main():
    required = ['PACKPROOF_API_BASE_URL', 'PACKPROOF_SERVICE_TOKEN', 'PACKPROOF_INTEGRATION_ACCOUNT_ID', 'PACKPROOF_OPERATOR_MEMBERSHIP_ID', 'PACKPROOF_SOURCE_REFERENCE']
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise ValueError(f"Set {', '.join(missing)} using your authorized sandbox workspace values")
    client = PackProofClient(os.environ['PACKPROOF_API_BASE_URL'], os.environ['PACKPROOF_SERVICE_TOKEN'],
                            merchant_id=os.environ.get('PACKPROOF_MERCHANT_ID'), delegation_id=os.environ.get('PACKPROOF_DELEGATION_ID'))
    print(json.dumps(first_record(client, os.environ['PACKPROOF_INTEGRATION_ACCOUNT_ID'], os.environ['PACKPROOF_OPERATOR_MEMBERSHIP_ID'], os.environ['PACKPROOF_SOURCE_REFERENCE'])))


if __name__ == '__main__':
    try:
        main()
    except PackProofError as error:
        print(json.dumps({'status': error.status, 'code': error.code, 'requestId': error.request_id}), file=sys.stderr)
        sys.exit(1)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

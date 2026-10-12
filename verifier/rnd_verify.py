#!/usr/bin/env python3
"""Offline R&D witness/derivative verifier. Trust files are supplied out of band."""
import argparse,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from research.witness.witness import verify_receipt,sha,canonical

def main():
    p=argparse.ArgumentParser();p.add_argument('receipt');p.add_argument('--policy',required=True);p.add_argument('--canonical-record',required=True);p.add_argument('--require-independent',action='store_true');args=p.parse_args()
    record=json.loads(Path(args.canonical_record).read_text())
    print(json.dumps(verify_receipt(json.loads(Path(args.receipt).read_text()),json.loads(Path(args.policy).read_text()),sha(canonical(record)),args.require_independent),indent=2))
if __name__=='__main__':
    try: main()
    except Exception as exc: print(f'VERIFICATION FAILED: {exc}',file=sys.stderr);sys.exit(1)

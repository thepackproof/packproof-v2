"""Independent Python RFC8785 implementation against shared Node/native vectors."""
import hashlib
import json
from pathlib import Path
import unittest
import rfc8785

ROOT=Path(__file__).resolve().parents[2]


def strict_pairs(pairs):
    result={}
    for key,value in pairs:
        if key in result:
            raise ValueError('DUPLICATE_JSON_KEY')
        result[key]=value
    return result


def parse_binary64(text):
    # JSON numeric tokens follow the shared ECMAScript binary64 contract.
    # Integer counters requiring exact precision beyond 2**53 use strings.
    return json.loads(text,parse_int=float,parse_float=float,object_pairs_hook=strict_pairs)


class CanonicalVectors(unittest.TestCase):
    def test_shared_positive_vectors(self):
        vectors=parse_binary64((ROOT/'packages/evidence-contracts/canonical-vectors.json').read_text())
        for vector in vectors['vectors']:
            with self.subTest(vector=vector['name']):
                encoded=rfc8785.dumps(vector['value'])
                self.assertEqual(encoded,vector['canonical'].encode('utf-8'))
                self.assertEqual(hashlib.sha256(encoded).hexdigest(),vector['sha256'])

    def test_shared_rejection_vectors(self):
        vectors=json.loads((ROOT/'packages/evidence-contracts/canonical-vectors.json').read_text())
        for encoded in vectors['rejectedJson']:
            with self.subTest(json=encoded):
                with self.assertRaises((ValueError,UnicodeError,rfc8785.CanonicalizationError)):
                    rfc8785.dumps(parse_binary64(encoded))


if __name__=='__main__':
    unittest.main()

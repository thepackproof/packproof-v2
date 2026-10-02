import copy,json,secrets,tempfile,unittest
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
from research.witness.witness import *

class WitnessTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.p=Path(self.tmp.name);self.db=self.p/'log.db';self.keys={}; self.entries={}
        for who in ('log','operator-a','operator-b'):
            k=Ed25519PrivateKey.generate();path=self.p/f'{who}.pem';path.write_bytes(k.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()));self.keys[who]=path
            self.entries[who]={'keyId':key_id(k.public_key()),'publicKeyPem':k.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo).decode(),'operatorId':who,'testOnly':True,'independent':False}
        self.policy={'schemaVersion':'packproof.witness-trust.v1','policyId':'rnd-test-v1','logId':'packproof-rnd-test','testOnly':True,'requiredOperators':['operator-a','operator-b'],'logKeys':{self.entries['log']['keyId']:self.entries['log']},'witnessKeys':{self.entries[x]['keyId']:self.entries[x] for x in ('operator-a','operator-b')}}
    def tearDown(self):self.tmp.cleanup()
    def append(self,d=None,blind=None):
        r=append(self.db,d or sha(b'evidence'),blind or secrets.token_hex(32),self.keys['log'],self.policy['logId']);r['trustPolicyId']=self.policy['policyId'];return r
    def witnessed(self,r,proof=None):
        for op in self.policy['requiredOperators']:r['witnessSignatures'].append(witness(r,self.policy,self.p/f'{op}.db',self.keys[op],op,proof))
        return r
    def test_actual_log_proofs_persistent_witnesses_and_private_openings(self):
        a=self.witnessed(self.append());b=self.append(sha(b'next'));proof=consistency(self.db,1,2);self.witnessed(b,proof)
        self.assertTrue(verify_receipt(b,self.policy)['valid']);self.assertEqual(verify_receipt(b,self.policy)['independentOperatorCount'],0)
        tree=SqliteTree(str(self.db));self.assertEqual(len(tree.get_entry(1)),32);self.assertNotIn(a['opening']['recordDigest'].encode(),tree.get_entry(1));tree.con.close()
        with self.assertRaises(ValueError):verify_receipt(b,self.policy,require_independent=True)
    def test_inclusion_level_never_claims_witnessing(self):
        r=self.append();verified=verify_inclusion_receipt(r,self.policy)
        self.assertEqual(verified['publicationState'],'INCLUDED');self.assertEqual(verified['assurance'],'LOG_INCLUSION_ONLY')
        with self.assertRaises(ValueError):verify_receipt(r,self.policy)
    def test_idempotent_retry(self):
        blind=secrets.token_hex(32);a=self.append(blind=blind);b=self.append(blind=blind)
        self.assertEqual(a['leafIndex'],b['leafIndex']);self.assertEqual(b['checkpoint']['treeSize'],1)
    def test_all_malformed_receipts_rejected(self):
        self.append(sha(b'other'));r=self.witnessed(self.append())
        mutations=[lambda x:x['opening'].__setitem__('blind','0'*64),lambda x:x.__setitem__('commitment','0'*64),lambda x:x['checkpoint'].__setitem__('treeSize',100),lambda x:x.__setitem__('leafIndex',1),lambda x:x['inclusionProof']['path'].__setitem__(0,'0'*64),lambda x:x['inclusionProof']['metadata'].__setitem__('security',False),lambda x:x['logSignature'].__setitem__('keyId','unknown'),lambda x:x['witnessSignatures'].pop(),lambda x:x.__setitem__('trustPolicyId','other'),lambda x:x['opening'].__setitem__('recordDigest','0'*64)]
        for mutate in mutations:
            bad=copy.deepcopy(r);mutate(bad)
            with self.assertRaises(Exception):verify_receipt(bad,self.policy)
        with self.assertRaises(ValueError):verify_receipt(r,self.policy,sha(b'changed manifest'))
    def test_persistent_state_blocks_split_view_rollback_and_missing_consistency(self):
        a=self.witnessed(self.append());b=self.append(sha(b'next'))
        with self.assertRaises(ValueError):witness(b,self.policy,self.p/'operator-a.db',self.keys['operator-a'],'operator-a')
        bad=copy.deepcopy(a);bad['checkpoint']['rootHash']='0'*64;bad['logSignature']=sign(bad['checkpoint'],load_private(self.keys['log']))
        with self.assertRaises(ValueError):witness(bad,self.policy,self.p/'operator-a.db',self.keys['operator-a'],'operator-a')
        self.witnessed(b,consistency(self.db,1,2))
        with self.assertRaises(ValueError):witness(a,self.policy,self.p/'operator-a.db',self.keys['operator-a'],'operator-a')
    def test_wrong_consistency_size_and_corrupt_history_rejected(self):
        self.witnessed(self.append());b=self.append(sha(b'next'));proof=consistency(self.db,1,2);proof['path'][0]='0'*64
        with self.assertRaises(Exception):witness(b,self.policy,self.p/'operator-a.db',self.keys['operator-a'],'operator-a',proof)
    def test_unknown_or_revoked_key_and_duplicate_operator_rejected(self):
        r=self.witnessed(self.append());p=copy.deepcopy(self.policy);p['logKeys'][r['logSignature']['keyId']]['revoked']=True
        with self.assertRaises(ValueError):verify_receipt(r,p)
        r['witnessSignatures'][1]=r['witnessSignatures'][0]
        with self.assertRaises(ValueError):verify_receipt(r,self.policy)
    def test_proof_shapes_cover_different_tree_sizes(self):
        for i in range(1,17):self.append(sha(str(i).encode()))
        tree=SqliteTree(str(self.db))
        for size in range(1,17):
            for index in range(1,size+1):
                parse_proof(tree.prove_inclusion(index,size).serialize(),'inclusion',size,index)
                parse_proof(tree.prove_consistency(index,size).serialize(),'consistency',size,index)
        tree.con.close()
    def test_sqlite_backup_restore_rehearsal_keeps_external_checkpoint_and_rejects_stale_log(self):
        def backup(source,target):
            original=sqlite3.connect(source);restored=sqlite3.connect(target)
            try: original.backup(restored)
            finally: original.close();restored.close()
        first=self.witnessed(self.append());stale_log=self.p/'stale-log.db';backup(self.db,stale_log)
        latest=self.witnessed(self.append(sha(b'second')),consistency(self.db,1,2))
        retained=copy.deepcopy(latest['checkpoint'])  # Independently retained before restore.
        restored_log=self.p/'restored-log.db';backup(self.db,restored_log)
        states={}
        for operator in self.policy['requiredOperators']:
            states[operator]=self.p/f'restored-{operator}.db';backup(self.p/f'{operator}.db',states[operator])
            self.assertEqual(last_checkpoint(states[operator],self.policy['logId'],operator),retained)
        recovered=append(restored_log,sha(b'after consistent restore'),secrets.token_hex(32),self.keys['log'],self.policy['logId']);recovered['trustPolicyId']=self.policy['policyId']
        proof=consistency(restored_log,retained['treeSize'],recovered['checkpoint']['treeSize'])
        for operator in self.policy['requiredOperators']:recovered['witnessSignatures'].append(witness(recovered,self.policy,states[operator],self.keys[operator],operator,proof))
        self.assertTrue(verify_receipt(recovered,self.policy)['valid'])
        # Restoring a stale log does not authorize deleting/rewinding witness history.
        stale=append(stale_log,sha(b'conflicting restored history'),secrets.token_hex(32),self.keys['log'],self.policy['logId']);stale['trustPolicyId']=self.policy['policyId']
        with self.assertRaises(ValueError):witness(stale,self.policy,states['operator-a'],self.keys['operator-a'],'operator-a')
        self.assertEqual(last_checkpoint(states['operator-a'],self.policy['logId'],'operator-a'),recovered['checkpoint'])
if __name__=='__main__':unittest.main()

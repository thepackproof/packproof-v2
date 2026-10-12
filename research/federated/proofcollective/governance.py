"""Purpose-bound consent, signed artifacts and cumulative participant accounting."""
from __future__ import annotations
import base64
import hashlib
import json
import math
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives import serialization
from dp_accounting import dp_event, rdp

PURPOSE = "capture-frame-usefulness/v1"
MAX_EPSILON = 3.0
MIN_CONTRIBUTORS = 20

class GateError(ValueError):
    pass

def canonical(value: Any) -> bytes:
    """Package-specific signed JSON bytes; never presented as core RFC8785 bytes."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii")

def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()

def public_key(key: Ed25519PrivateKey) -> bytes:
    return key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)

def sign(payload: dict, key: Ed25519PrivateKey) -> dict:
    return {"payload": payload, "canonicalPayload":canonical(payload).decode("ascii"), "signature": base64.b64encode(key.sign(b"PACKPROOF-F10-V1\0" + canonical(payload))).decode(), "keyId": hashlib.sha256(public_key(key)).hexdigest()}

def verify(artifact: dict, trusted_key: bytes) -> dict:
    if artifact.get("keyId") != hashlib.sha256(trusted_key).hexdigest():
        raise GateError("Untrusted artifact signing key")
    if artifact.get("canonicalPayload",canonical(artifact["payload"]).decode("ascii")) != canonical(artifact["payload"]).decode("ascii"):
        raise GateError("Signed payload bytes do not match payload")
    try:
        Ed25519PublicKey.from_public_bytes(trusted_key).verify(base64.b64decode(artifact["signature"], validate=True), b"PACKPROOF-F10-V1\0" + canonical(artifact["payload"]))
    except Exception as exc:
        raise GateError("Invalid artifact signature") from exc
    return artifact["payload"]

class Governance:
    """Append-only SQLite lab ledger. Campaign names cannot reset privacy exposure.

    Pilot deployment requires a protected centrally governed ledger and stable enrollment
    identity. Operators with filesystem access can erase a lab DB; this is not a trust root.
    """
    def __init__(self, path: Path):
        self.path = path.resolve()
        self.db = sqlite3.connect(path, isolation_level=None, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS consents(seq INTEGER PRIMARY KEY, partner TEXT NOT NULL, purpose TEXT NOT NULL, dataset TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('GRANTED','WITHDRAWN')), at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS spend(seq INTEGER PRIMARY KEY, campaign TEXT NOT NULL, round_id TEXT NOT NULL, partner TEXT NOT NULL, sigma REAL NOT NULL, delta REAL NOT NULL, eligible INTEGER NOT NULL, UNIQUE(round_id,partner));
        CREATE TRIGGER IF NOT EXISTS consent_no_update BEFORE UPDATE ON consents BEGIN SELECT RAISE(ABORT,'append-only consent'); END;
        CREATE TRIGGER IF NOT EXISTS consent_no_delete BEFORE DELETE ON consents BEGIN SELECT RAISE(ABORT,'append-only consent'); END;
        CREATE TRIGGER IF NOT EXISTS spend_no_update BEFORE UPDATE ON spend BEGIN SELECT RAISE(ABORT,'append-only privacy ledger'); END;
        CREATE TRIGGER IF NOT EXISTS spend_no_delete BEFORE DELETE ON spend BEGIN SELECT RAISE(ABORT,'append-only privacy ledger'); END;
        ''')

    def consent(self, partner: str, dataset: str, purpose: str = PURPOSE) -> None:
        if not partner or not dataset or purpose != PURPOSE:
            raise GateError("Invalid enrollment or training purpose")
        self.db.execute("INSERT INTO consents(partner,purpose,dataset,action) VALUES(?,?,?,'GRANTED')", (partner,purpose,dataset))

    def withdraw(self, partner: str) -> None:
        self.db.execute("INSERT INTO consents(partner,purpose,dataset,action) VALUES(?,?,'*','WITHDRAWN')", (partner,PURPOSE))

    def local_consent_guard(self, partner: str, dataset: str):
        """Fresh read-only connection for a local transport thread; withdrawal is not cached."""
        def guard():
            with closing(sqlite3.connect(self.path.as_uri()+'?mode=ro',uri=True,timeout=5)) as connection:
                connection.row_factory=sqlite3.Row
                self._require_consent(connection,partner,dataset,PURPOSE)
        return guard

    def require_consent(self, partner: str, dataset: str, purpose: str = PURPOSE) -> None:
        self._require_consent(self.db,partner,dataset,purpose)

    @staticmethod
    def _require_consent(connection,partner:str,dataset:str,purpose:str) -> None:
        if purpose != PURPOSE:
            raise GateError("Wrong purpose version")
        row = connection.execute("SELECT * FROM consents WHERE partner=? ORDER BY seq DESC LIMIT 1", (partner,)).fetchone()
        if not row or row['action'] != 'GRANTED' or row['purpose'] != purpose or row['dataset'] != dataset:
            raise GateError("Missing, withdrawn or mismatched dataset consent")

    def exposure(self, partner: str, extra_sigma: float | None = None, delta: float = 1e-6) -> tuple[float,float]:
        rows = self.db.execute("SELECT sigma,delta FROM spend WHERE partner=? ORDER BY seq", (partner,)).fetchall()
        governed_delta = min([delta] + [row['delta'] for row in rows])
        accountant = rdp.RdpAccountant()
        for row in rows:
            accountant.compose(dp_event.GaussianDpEvent(row['sigma']))
        if extra_sigma is not None:
            accountant.compose(dp_event.GaussianDpEvent(extra_sigma))
        return float(accountant.get_epsilon(governed_delta)), governed_delta

    def reserve(self, campaign: str, round_id: str, partners: list[str], datasets: dict[str,str], sigma: float, eligible: int) -> dict:
        if len(partners) != len(set(partners)) or len(partners) < MIN_CONTRIBUTORS or eligible < len(partners):
            raise GateError("At least 20 distinct enrolled contributors required")
        if not math.isfinite(sigma) or sigma <= 0 or eligible > 1000000:
            raise GateError("Invalid noise or population")
        delta = min(1e-6, 1/(10*eligible**2))
        self.db.execute("BEGIN IMMEDIATE")
        try:
            exposures = []
            deltas = []
            for partner in partners:
                self.require_consent(partner,datasets[partner])
                epsilon, governed_delta = self.exposure(partner,sigma,delta)
                if epsilon > MAX_EPSILON:
                    raise GateError("Cumulative privacy budget exhausted")
                exposures.append(epsilon)
                deltas.append(governed_delta)
                self.db.execute("INSERT INTO spend(campaign,round_id,partner,sigma,delta,eligible) VALUES(?,?,?,?,?,?)", (campaign,round_id,partner,sigma,governed_delta,eligible))
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        return {"epsilonMaxCumulative":max(exposures),"delta":min(deltas),"noiseMultiplier":sigma,"accountant":"google-dp-accounting/0.6.0:RdpAccountant","sampling":"full-participation; no amplification","adjacency":"replace one bounded enrolled partner contribution","reservation":"spent before aggregate; no refund on abort"}


def release_gates(baseline: dict, candidate: dict) -> dict:
    gain = candidate['accuracy']-baseline['accuracy']
    groups = set(baseline['groups'])
    if groups != set(candidate['groups']):
        raise GateError("Held-out group inventory mismatch")
    drops = {g:candidate['groups'][g]-baseline['groups'][g] for g in groups}
    return {"passed":gain >= .05 and all(v >= -.02 for v in drops.values()),"requiredGain":.05,"observedGain":gain,"maximumAllowedGroupDrop":.02,"groupDeltas":drops}

class ModelRegistry:
    def __init__(self, root: Path, trusted_key: bytes):
        self.root, self.key = root, trusted_key
        root.mkdir(parents=True,exist_ok=True)
        self.db = sqlite3.connect(root/'registry.sqlite')
        self.db.executescript('''CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY, digest TEXT NOT NULL, action TEXT NOT NULL, previous TEXT, at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TRIGGER IF NOT EXISTS registry_no_update BEFORE UPDATE ON history BEGIN SELECT RAISE(ABORT,'append-only registry'); END;
        CREATE TRIGGER IF NOT EXISTS registry_no_delete BEFORE DELETE ON history BEGIN SELECT RAISE(ABORT,'append-only registry'); END;''')

    def store(self, signed: dict) -> str:
        payload = verify(signed,self.key)
        ident = digest(payload)
        target = self.root/f'{ident}.json'
        encoded = canonical(signed)
        if target.exists() and target.read_bytes() != encoded:
            raise GateError("Immutable artifact collision")
        target.write_bytes(encoded)
        return ident

    def get(self, ident: str) -> dict:
        if len(ident)!=64 or any(c not in '0123456789abcdef' for c in ident):
            raise GateError("Invalid model digest")
        signed = json.loads((self.root/f'{ident}.json').read_text())
        payload = verify(signed,self.key)
        if digest(payload) != ident:
            raise GateError("Model artifact digest mismatch")
        return payload

    @property
    def active(self) -> str | None:
        row=self.db.execute("SELECT digest FROM history ORDER BY seq DESC LIMIT 1").fetchone()
        return row[0] if row else None

    def promote_lab(self, ident: str) -> None:
        payload=self.get(ident)
        if payload.get('scope')!='SYNTHETIC_LOCAL_RESEARCH' or not payload.get('qualityGate',{}).get('passed'):
            raise GateError("Candidate failed lab release gate")
        if not payload.get('privacy',{}).get('epsilonMaxCumulative',math.inf)<=MAX_EPSILON:
            raise GateError("Candidate privacy budget invalid")
        previous=self.active
        self.db.execute("INSERT INTO history(digest,action,previous) VALUES(?,'LAB_PROMOTE',?)",(ident,previous));self.db.commit()

    def rollback(self, ident: str) -> None:
        self.get(ident)
        if not self.db.execute("SELECT 1 FROM history WHERE digest=? AND action='LAB_PROMOTE'",(ident,)).fetchone():
            raise GateError("Rollback target was never approved")
        self.db.execute("INSERT INTO history(digest,action,previous) VALUES(?,'ROLLBACK',?)",(ident,self.active));self.db.commit()

"""Cross-language synthetic RFC 3161 fixture; no service or network calls."""
import datetime as dt
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'verifier'))
from timestamp import verify_timestamp

fixture = json.load(sys.stdin)
print(json.dumps(verify_timestamp(fixture['material'], fixture['jws'], fixture.get('trust'), dt.datetime.fromisoformat(fixture['now'].replace('Z', '+00:00')))))

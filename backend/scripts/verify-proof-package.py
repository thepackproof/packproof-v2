#!/usr/bin/env python3
"""Compatibility entry point; independently distribute verifier/verify.py."""
import runpy
from pathlib import Path
runpy.run_path(str(Path(__file__).resolve().parents[2] / 'verifier' / 'verify.py'), run_name='__main__')

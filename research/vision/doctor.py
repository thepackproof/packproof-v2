#!/usr/bin/env python3
"""Read-only worker dependency diagnostic; never contacts a network or service."""
import importlib.metadata
import json
import platform
import shutil
import subprocess

EXPECTED={'numpy':'2.2.6','opencv-python-headless':'4.11.0.86','Pillow':'11.3.0','scipy':'1.15.3','pycolmap':'3.13.0','rfc8785':'0.1.4'}
results={}
for name,expected in EXPECTED.items():
    try:
        version=importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        version=None
    results[name]={'expected':expected,'installed':version,'matchesPin':version==expected}
tesseract=shutil.which('tesseract')
print(json.dumps({'platform':platform.platform(),'python':platform.python_version(),'dependencies':results,
                  'tesseract':subprocess.run(['tesseract','--version'],capture_output=True,text=True).stdout.splitlines()[0] if tesseract else None,
                  'linuxProcessLimitsAvailable':platform.system()=='Linux','physicalDeviceQualification':False,
                  'productionConnectionAttempted':False},indent=2))

"""Bounded observed OCR provenance; recording hashes is not approving a runtime."""
import hashlib
from functools import lru_cache
from pathlib import Path
import re
import shutil
import subprocess

MAX_BINARY_BYTES=128*1024*1024
MAX_LANGUAGE_BYTES=64*1024*1024
# Tesseract 4 does not report its default data directory. These are selection
# candidates, not inferred provenance: a chosen directory is subsequently
# passed explicitly to BOTH the language listing and actual OCR command.
TESSERACT4_DIRECTORIES=(Path('/usr/share/tesseract-ocr/4.00/tessdata'),)

def bounded_digest(path, maximum):
    path=Path(path).resolve(strict=True)
    if not path.is_file() or not 0<path.stat().st_size<=maximum:
        raise ValueError('OCR_RUNTIME_FILE_LIMIT')
    digest=hashlib.sha256();total=0
    with path.open('rb') as handle:
        for chunk in iter(lambda:handle.read(1024*1024),b''):
            total+=len(chunk)
            if total>maximum:raise ValueError('OCR_RUNTIME_FILE_LIMIT')
            digest.update(chunk)
    return digest.hexdigest()

@lru_cache(maxsize=1)
def selected_ocr_runtime():
    """One immutable selection per worker process, including private command paths."""
    executable=shutil.which('tesseract')
    result={'state':'UNAVAILABLE','language':'eng','executableSha256':None,'traineddataSha256':None,
            'version':None,'approvedRuntime':False,'scope':'Observed runtime bytes; no physical OCR accuracy or approved version claim.'}
    if not executable:return None,None,result
    result['state']='INCOMPLETE'
    directory=None
    try:
        result['executableSha256']=bounded_digest(executable,MAX_BINARY_BYTES)
        version=subprocess.run([executable,'--version'],capture_output=True,text=True,timeout=3,check=True)
        lines=version.stdout.splitlines()
        if lines and re.fullmatch(r'tesseract [A-Za-z0-9.+_ -]{1,100}',lines[0]):result['version']=lines[0]
        languages=subprocess.run([executable,'--list-langs'],capture_output=True,text=True,timeout=3,check=True)
        text=languages.stdout+'\n'+languages.stderr
        if len(text)>16384:raise ValueError('OCR_RUNTIME_OUTPUT_LIMIT')
        match=re.search(r'^List of available languages in "([^"\r\n]+)" \(\d+\):\s*$',text,re.MULTILINE)
        if match and 'eng' in text.splitlines():
            directory=Path(match.group(1)).resolve(strict=True)
        elif result['version'] and result['version'].startswith('tesseract 4.'):
            for candidate in TESSERACT4_DIRECTORIES:
                if not (candidate/'eng.traineddata').is_file():continue
                explicit=subprocess.run([executable,'--list-langs','--tessdata-dir',str(candidate)],capture_output=True,text=True,timeout=3,check=True)
                explicit_text=explicit.stdout+'\n'+explicit.stderr
                if len(explicit_text)>16384:raise ValueError('OCR_RUNTIME_OUTPUT_LIMIT')
                if 'eng' in explicit_text.splitlines():
                    directory=candidate.resolve(strict=True)
                    break
        if directory is not None:
            result['traineddataSha256']=bounded_digest(directory/'eng.traineddata',MAX_LANGUAGE_BYTES)
        if result['version'] and result['traineddataSha256']:result['state']='RECORDED'
    except (OSError,ValueError,subprocess.SubprocessError):
        # A bounded missingness marker, never paths or arbitrary decoder messages.
        result['state']='INCOMPLETE'
    return executable,directory,result

def observed_ocr_runtime():
    """Public observed identity never includes local filesystem paths."""
    return dict(selected_ocr_runtime()[2])

def ocr_command():
    executable,directory,identity=selected_ocr_runtime()
    if identity['state']!='RECORDED':return None
    return [executable,'stdin','stdout','--tessdata-dir',str(directory),'-l','eng','--psm','11','tsv']

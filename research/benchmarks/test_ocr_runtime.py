import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from research.vision.ocr_runtime import observed_ocr_runtime,bounded_digest

class OcrRuntimeTests(unittest.TestCase):
    def test_actual_fixture_bytes_are_hashed_without_exporting_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);binary=root/'tesseract';language=root/'eng.traineddata'
            binary.write_bytes(b'synthetic executable');language.write_bytes(b'synthetic language bytes')
            def run(args,**kwargs):
                output='tesseract 5.3.4\n' if args[-1]=='--version' else f'List of available languages in "{root}" (1):\neng\n'
                return subprocess.CompletedProcess(args,0,output,'')
            with patch('research.vision.ocr_runtime.shutil.which',return_value=str(binary)),patch('research.vision.ocr_runtime.subprocess.run',side_effect=run):
                result=observed_ocr_runtime()
            self.assertEqual(result['state'],'RECORDED')
            self.assertEqual(result['executableSha256'],hashlib.sha256(binary.read_bytes()).hexdigest())
            self.assertEqual(result['traineddataSha256'],hashlib.sha256(language.read_bytes()).hexdigest())
            self.assertNotIn(str(root),str(result));self.assertFalse(result['approvedRuntime'])

    def test_missing_executable_is_explicit(self):
        with patch('research.vision.ocr_runtime.shutil.which',return_value=None):
            self.assertEqual(observed_ocr_runtime()['state'],'UNAVAILABLE')

    def test_inaccessible_runtime_stays_incomplete_and_sanitized(self):
        with patch('research.vision.ocr_runtime.shutil.which',return_value='/private/nonexistent/tesseract'):
            result=observed_ocr_runtime()
        self.assertEqual(result['state'],'INCOMPLETE');self.assertNotIn('/private',str(result))

    def test_file_size_bound_precedes_hashing(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'oversized';path.write_bytes(b'12345')
            with self.assertRaisesRegex(ValueError,'FILE_LIMIT'):bounded_digest(path,4)

if __name__=='__main__':unittest.main()

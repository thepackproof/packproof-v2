import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from research.vision.ocr_runtime import observed_ocr_runtime,bounded_digest,selected_ocr_runtime,ocr_command

class OcrRuntimeTests(unittest.TestCase):
    def setUp(self):selected_ocr_runtime.cache_clear()
    def tearDown(self):selected_ocr_runtime.cache_clear()
    def test_actual_fixture_bytes_are_hashed_without_exporting_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);binary=root/'tesseract';language=root/'eng.traineddata'
            binary.write_bytes(b'synthetic executable');language.write_bytes(b'synthetic language bytes')
            def run(args,**kwargs):
                output='tesseract 5.3.4\n' if args[-1]=='--version' else f'List of available languages in "{root}" (1):\neng\n'
                return subprocess.CompletedProcess(args,0,output,'')
            with patch('research.vision.ocr_runtime.shutil.which',return_value=str(binary)),patch('research.vision.ocr_runtime.subprocess.run',side_effect=run):
                result=observed_ocr_runtime()
                command=ocr_command()
            self.assertEqual(result['state'],'RECORDED')
            self.assertEqual(result['executableSha256'],hashlib.sha256(binary.read_bytes()).hexdigest())
            self.assertEqual(result['traineddataSha256'],hashlib.sha256(language.read_bytes()).hexdigest())
            self.assertNotIn(str(root),str(result));self.assertFalse(result['approvedRuntime'])
            self.assertEqual(command[command.index('--tessdata-dir')+1],str(root.resolve()))

    def test_tesseract4_selection_is_explicit_and_matches_hashed_language(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);binary=root/'tesseract';language=root/'eng.traineddata'
            binary.write_bytes(b'synthetic executable');language.write_bytes(b'selected English language')
            calls=[]
            def run(args,**kwargs):
                calls.append(args)
                output='tesseract 4.1.1\n' if '--version' in args else 'List of available languages (1):\neng\n'
                return subprocess.CompletedProcess(args,0,output,'')
            with patch('research.vision.ocr_runtime.shutil.which',return_value=str(binary)),patch('research.vision.ocr_runtime.subprocess.run',side_effect=run),patch('research.vision.ocr_runtime.TESSERACT4_DIRECTORIES',(root,)):
                result=observed_ocr_runtime();command=ocr_command()
            self.assertEqual(result['state'],'RECORDED')
            self.assertEqual(result['traineddataSha256'],hashlib.sha256(language.read_bytes()).hexdigest())
            self.assertIn([str(binary),'--list-langs','--tessdata-dir',str(root)],calls)
            self.assertEqual(command[command.index('--tessdata-dir')+1],str(root.resolve()))
            self.assertNotIn(str(root),str(result))

    def test_tesseract4_unavailable_selected_data_does_not_claim_default_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary=Path(temporary)/'tesseract';binary.write_bytes(b'synthetic executable')
            def run(args,**kwargs):
                return subprocess.CompletedProcess(args,0,'tesseract 4.1.1\n' if '--version' in args else 'List of available languages (1):\neng\n','')
            with patch('research.vision.ocr_runtime.shutil.which',return_value=str(binary)),patch('research.vision.ocr_runtime.subprocess.run',side_effect=run),patch('research.vision.ocr_runtime.TESSERACT4_DIRECTORIES',(Path(temporary),)):
                result=observed_ocr_runtime();command=ocr_command()
            self.assertEqual(result['state'],'INCOMPLETE');self.assertIsNone(result['traineddataSha256']);self.assertIsNone(command)

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

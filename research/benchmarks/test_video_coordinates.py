"""Real rotated-container regression; synthetic pixels do not qualify real optics."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import cv2
import numpy as np
from research.vision.engine import decode_sources, full_resolution

class VideoCoordinatesTests(unittest.TestCase):
    def test_rotated_container_keeps_stored_coordinates_in_sampling_and_redecode(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary);plain=directory/'plain.mp4';rotated=directory/'rotated.mp4'
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=1920x1080:rate=2:duration=1',
                            '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-threads','1',str(plain)],check=True,timeout=30)
            subprocess.run(['ffmpeg','-v','error','-i',str(plain),'-c','copy','-metadata:s:v:0','rotate=90',str(rotated)],check=True,timeout=30)
            metadata=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(rotated)],timeout=10))
            if not any(abs(entry.get('rotation',0))==90 for entry in metadata['streams'][0].get('side_data_list',[])):
                # New FFmpeg releases use the explicit display-matrix input
                # option; older distro releases support rotate metadata above.
                subprocess.run(['ffmpeg','-v','error','-display_rotation:v:0','90','-i',str(plain),'-c','copy','-y',str(rotated)],check=True,timeout=30)
                metadata=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(rotated)],timeout=10))
            self.assertTrue(any(abs(entry.get('rotation',0))==90 for entry in metadata['streams'][0].get('side_data_list',[])),
                            'Fixture must contain an actual display rotation matrix')
            source={'sourceId':'synthetic-rotated-video','_snapshot':rotated,'mimeType':'video/mp4',
                    'sha256':hashlib.sha256(rotated.read_bytes()).hexdigest()}
            frames,coverage=decode_sources([source],sampling_hz=2)
            self.assertEqual(len(frames),2)
            self.assertEqual(frames[0].original_size,(1920,1080))
            self.assertEqual(frames[0].ref()['decodedDimensions'],[1920,1080])
            self.assertEqual(frames[0].ref()['coordinateSpace'],'stored-decoded-pixels')
            self.assertLess(frames[0].scale,1)
            restored=full_resolution(frames[0])
            self.assertEqual(restored.image.shape[:2],(1080,1920))
            cap=cv2.VideoCapture(str(plain),cv2.CAP_FFMPEG)
            try:ok,reference=cap.read()
            finally:cap.release()
            self.assertTrue(ok)
            np.testing.assert_array_equal(restored.image,reference)
            self.assertFalse(coverage[0]['fullContinuity'])

if __name__=='__main__':unittest.main()

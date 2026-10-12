import base64,copy,json,subprocess,tempfile,unittest,zipfile
from pathlib import Path
from unittest.mock import patch
import io
import cv2
import numpy as np
from PIL import Image,PngImagePlugin
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
from research.privacy.redact import create,recompute,detect,approve,export_reviewed,temporal_union,file_sha,sign_manifest,track_masks

class PrivacyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.p=Path(self.tmp.name)
        key=Ed25519PrivateKey.generate(); self.key=self.p/'key.pem';self.pub=self.p/'public.pem'
        self.key.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
        self.pub.write_bytes(key.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo))
        self.source=self.p/'customer-private-name.png'; self.out=self.p/'redacted.png'
        metadata=PngImagePlugin.PngInfo();metadata.add_text('customer','PRIVATE-ADDRESS')
        Image.new('RGB',(64,64),(250,20,50)).save(self.source,pnginfo=metadata)
        self.masks=[{'x':5,'y':5,'width':20,'height':20,'class':'address'}]
    def tearDown(self):self.tmp.cleanup()
    def test_still_original_preserved_opaque_metadata_stripped_and_recomputed(self):
        original=file_sha(self.source);m=create(self.source,self.out,self.masks,'still',self.key)
        self.assertEqual(original,file_sha(self.source))
        with Image.open(self.out) as result:
            self.assertEqual(result.getpixel((10,10)),(0,0,0));self.assertFalse(result.info)
        self.assertTrue(recompute(self.source,self.out,m,self.pub)['valid'])
        self.assertFalse(b'PRIVATE-ADDRESS' in self.out.read_bytes())
    def test_external_export_requires_human_review_and_omits_original(self):
        m=create(self.source,self.out,self.masks,'still',self.key)
        with self.assertRaises(ValueError):export_reviewed(self.out,m,self.pub,self.p/'no.zip')
        approved=approve(m,'authorized-test-reviewer',self.key)
        export_reviewed(self.out,approved,self.pub,self.p/'yes.zip')
        with zipfile.ZipFile(self.p/'yes.zip') as z:
            self.assertEqual(set(z.namelist()),{'redacted.png','transformation.json','OMISSIONS.txt'})
            self.assertNotIn(b'PRIVATE-ADDRESS',b''.join(z.read(n) for n in z.namelist()))
    def test_tampered_output_mask_source_and_signature_fail(self):
        m=create(self.source,self.out,self.masks,'still',self.key)
        for field in ('sourceSha256','derivativeSha256','recipeSha256'):
            bad=copy.deepcopy(m);bad['record'][field]='0'*64
            with self.assertRaises(Exception):recompute(self.source,self.out,bad,self.pub)
        bad=copy.deepcopy(m);bad['record']['recipe']['masks'][0]['x']=0
        bad=sign_manifest(bad['record'],self.key)
        with self.assertRaises(ValueError):recompute(self.source,self.out,bad,self.pub)
        Image.new('RGB',(64,64),(1,2,3)).save(self.out)
        with self.assertRaises(ValueError):recompute(self.source,self.out,m,self.pub)
    def test_detectors_and_swept_temporal_masks_are_candidates_only(self):
        self.assertTrue(detect(self.source)['requiresHumanReview'])
        self.assertEqual(temporal_union([{'time':0,'x':1,'y':2,'width':3,'height':4},{'time':1,'x':5,'y':6,'width':3,'height':4}])[0]['width'],7)
    def test_unsigned_requires_server_signature(self):
        m=create(self.source,self.out,self.masks,'still',None);self.assertTrue(m['requiresServerSignature']);self.assertIsNone(m['signature'])
    def test_video_audio_metadata_removed_and_temporal_mask_recomputes(self):
        src=self.p/'private.mp4';out=self.p/'redacted.mp4'
        subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=red:s=64x64:r=4:d=1','-f','lavfi','-i','sine=frequency=1000:duration=1','-metadata','comment=PRIVATE-ADDRESS','-c:v','libx264','-c:a','aac','-shortest',str(src)],check=True)
        m=create(src,out,[{'x':0,'y':0,'width':32,'height':32,'start':0,'end':1}],'video',self.key)
        info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(out)]))
        tracked=track_masks(src,[{'x':0,'y':0,'width':32,'height':32}]);self.assertTrue(tracked['requiresHumanReview']);self.assertEqual(tracked['masks'][0]['width'],64)
        self.assertEqual(len(info['streams']),1);self.assertNotIn('PRIVATE-ADDRESS',json.dumps(info));self.assertTrue(recompute(src,out,m,self.pub)['valid'])
    def test_transparent_hidden_rgb_is_not_exposed(self):
        Image.new('RGBA',(64,64),(255,10,20,0)).save(self.source)
        create(self.source,self.out,[],'still',self.key)
        with Image.open(self.out) as im:self.assertEqual(im.getpixel((0,0)),(0,0,0))
    def test_invalid_masks_cannot_overwrite_source(self):
        with self.assertRaises(ValueError):create(self.source,self.source,self.masks,'still',self.key)
        with self.assertRaises(ValueError):create(self.source,self.out,[{'x':-1,'y':0,'width':10,'height':10}],'still',self.key)

    def test_exif_rotated_jpeg_detectors_and_ocr_use_stored_pixels(self):
        source=self.p/'oriented.jpg'
        exif=Image.Exif();exif[274]=6
        Image.new('RGB',(80,40),(180,30,50)).save(source,exif=exif)
        seen=[];case=self
        class Detector:
            def detectMultiScale(self,gray,*args):
                case.assertEqual(gray.shape,(40,80))
                seen.append(gray.shape)
                return [(52,8,10,12)]
        from research.privacy import redact
        original_run=redact.run
        def run(args,**kwargs):
            if args[0]!='tesseract':return original_run(args,**kwargs)
            self.assertEqual(args[1],'stdin')
            with Image.open(io.BytesIO(kwargs['input'])) as decoded:
                self.assertEqual(decoded.size,(80,40))
                self.assertFalse(decoded.getexif())
            return b'left\ttop\twidth\theight\tconf\ttext\n52\t8\t10\t12\t95\tSYNTHETIC\n'
        with patch.object(cv2,'CascadeClassifier',return_value=Detector()),patch.object(redact,'run',side_effect=run):
            result=detect(source)
        self.assertEqual(seen,[(40,80)])
        for kind in ('face-candidate','text-address-label-candidate'):
            box=next(mask for mask in result['masks'] if mask['class']==kind)
            self.assertEqual((box['x'],box['y'],box['width'],box['height']),(44,0,26,28))
        create(source,self.out,result['masks'],'still',self.key)
        with Image.open(self.out) as image:
            self.assertEqual(image.size,(80,40))
            self.assertEqual(image.getpixel((55,15)),(0,0,0))

    def test_actual_decoded_frame_count_is_bounded_when_metadata_understates_it(self):
        from research.privacy import redact
        class Capture:
            def __init__(self):self.reads=0;self.released=False
            def set(self,*args):return True
            def get(self,prop):return 1000 if prop==cv2.CAP_PROP_FPS else 1
            def read(self):
                self.reads+=1
                return (True,np.zeros((16,16,3),np.uint8)) if self.reads<=501 else (False,None)
            def release(self):self.released=True
        cap=Capture()
        with patch.object(redact,'inspect',return_value=(16,16,1)),patch.object(cv2,'VideoCapture',return_value=cap):
            with self.assertRaisesRegex(ValueError,'decoded frame cap'):
                track_masks(self.source,[])
        self.assertEqual(cap.reads,501)
        self.assertTrue(cap.released)

    def test_nonfinite_frame_count_is_rejected_before_decode(self):
        from research.privacy import redact
        from unittest.mock import Mock
        cap=Mock();cap.get.side_effect=lambda prop:30 if prop==cv2.CAP_PROP_FPS else float('nan')
        with patch.object(redact,'inspect',return_value=(16,16,1)),patch.object(cv2,'VideoCapture',return_value=cap):
            with self.assertRaisesRegex(ValueError,'bounded'):
                track_masks(self.source,[])
        cap.read.assert_not_called();cap.release.assert_called_once()

if __name__=='__main__':unittest.main()

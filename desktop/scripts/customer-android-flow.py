"""UI verification of published Android payloads with explicit installation provenance."""
import hashlib, json, os, pathlib, re, subprocess, time, zipfile, xml.etree.ElementTree as ET
out = pathlib.Path(os.environ['RUNNER_TEMP']) / 'customer-android'
out.mkdir(parents=True, exist_ok=True)
report = {'schema':'packproof.native-customer-flow.v1','platform':'android','version':'1.0.1 (64)','apkSha256':'97a7f08a95938cdab1c1b91a911195cdfe7d119db6e0a2eb21c6e903a6fe88b3','physicalDeviceChecks':'waived','syntheticCamera':True,'steps':[]}
report['artifactScope']=os.environ.get('CUSTOMER_ANDROID_PACKAGE','play')
if report['artifactScope']=='candidate-bundle-test-signature':
    report['version']='1.0.1 (65)'
    report['sourceSha']=os.environ['CANDIDATE_SOURCE_SHA']
    report['buildRun']=os.environ['CANDIDATE_BUILD_RUN']
apk_path=pathlib.Path(os.environ['RUNNER_TEMP'])/'64.apk'
report['apkSha256']=hashlib.sha256(apk_path.read_bytes()).hexdigest()
report['playDistributionFlowVerified']=False
if report['artifactScope'] in ['published-bundle-test-signature','candidate-bundle-test-signature','diagnostic-only']:
    aab_path=pathlib.Path(os.environ['RUNNER_TEMP'])/'64.aab'
    report['aabSha256']=hashlib.sha256(aab_path.read_bytes()).hexdigest()
    expected=os.environ['CANDIDATE_AAB_SHA256'] if report['artifactScope']=='candidate-bundle-test-signature' else '229f9238289a40da2f780dd6fe4bd2091ee45fff2946de4ed40e86cea6a3dfa4'
    if report['aabSha256']!=expected:raise RuntimeError('AAB_MISMATCH')
    with zipfile.ZipFile(aab_path) as a,zipfile.ZipFile(apk_path) as b:
        config=json.loads(a.read('base/assets/app.config'))
        if config['android']['package']!='com.packproof.mobile':raise RuntimeError('PACKAGE_IDENTITY_MISMATCH')
        if report['artifactScope']=='candidate-bundle-test-signature':
            if config['version']!='1.0.1' or config['android']['versionCode']!=65 or config['extra']['packproofBuildSha']!=report['sourceSha']:raise RuntimeError('CANDIDATE_IDENTITY_MISMATCH')
        if config['extra']['packproofApiBaseUrl']!='https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws' or config['extra']['packproofResearch'] is not False:raise RuntimeError('PRODUCTION_CONFIGURATION_MISMATCH')
        report['packagedConfiguration']={'version':config['version'],'versionCode':config['android']['versionCode'],'sourceSha':config['extra']['packproofBuildSha'],'apiBaseUrl':config['extra']['packproofApiBaseUrl'],'research':config['extra']['packproofResearch']}
        verified=[]
        for entry in a.namelist():
            if entry.startswith(('base/assets/','base/lib/','base/dex/')) and not entry.endswith('/'):
                target=entry.removeprefix('base/dex/') if entry.startswith('base/dex/') else entry.removeprefix('base/')
                if report['artifactScope']=='diagnostic-only' and entry=='base/assets/index.android.bundle':
                    report['diagnosticBundleSha256']=hashlib.sha256(b.read(target)).hexdigest()
                    report['releaseVerification']=False
                    continue
                if a.read(entry)!=b.read(target):raise RuntimeError('PUBLISHED_APP_PAYLOAD_CHANGED')
                verified.append(entry)
        report['unchangedBundlePayloads']=verified
    report['signingScope']='Disposable emulator test signature; production signing keys and Play settings unchanged'
current = 'install-verified-apk'
def adb(*args, binary=False):
    result=subprocess.run(['adb',*args],capture_output=True,timeout=90)
    if result.returncode: raise RuntimeError('ADB_OPERATION_FAILED')
    return result.stdout if binary else result.stdout.decode('utf-8',errors='replace')
def snapshot(name):
    adb('shell','uiautomator','dump','/sdcard/customer-ui.xml')
    xml=adb('shell','cat','/sdcard/customer-ui.xml')
    tree=ET.fromstring(xml)
    for node in tree.iter('node'):
        if node.get('password')=='true': node.set('text','[REDACTED]')
    (out/(name+'.xml')).write_text(ET.tostring(tree,encoding='unicode'))
    (out/(name+'.png')).write_bytes(adb('exec-out','screencap','-p',binary=True))
    return tree
def tree_now():
    adb('shell','uiautomator','dump','--compressed','/sdcard/customer-ui.xml')
    return ET.fromstring(adb('shell','cat','/sdcard/customer-ui.xml'))
def find(tree, label, partial=False):
    matches=[]
    for n in tree.iter('node'):
        values=[n.get('text',''),n.get('content-desc','')]
        if n.get('enabled')=='true' and any(label in v if partial else label==v for v in values): matches.append(n)
    return next((n for n in matches if n.get('clickable')=='true'),matches[0] if matches else None)
def tap(node):
    bounds=[int(n) for n in re.findall(r'\d+',node.get('bounds',''))]
    if len(bounds)!=4: raise RuntimeError('UI_BOUNDS_UNAVAILABLE')
    adb('shell','input','tap',str((bounds[0]+bounds[2])//2),str((bounds[1]+bounds[3])//2))
def permission(tree):
    for n in tree.iter('node'):
        if n.get('resource-id','').endswith(('permission_allow_foreground_only_button','permission_allow_button')) and n.get('enabled')=='true': tap(n);return True
    return False
def wait(label, timeout=60, partial=False, scroll=False):
    deadline=time.time()+timeout
    previous=None
    down=True
    while time.time()<deadline:
        tree=tree_now()
        if permission(tree): continue
        n=find(tree,label,partial)
        if n is not None:return n
        disabled=any(any(label in v if partial else label==v for v in [node.get('text',''),node.get('content-desc','')]) for node in tree.iter('node'))
        if scroll and not disabled:
            visible=ET.tostring(tree,encoding='unicode')
            if visible==previous:down=not down
            previous=visible
            adb('shell','input','swipe','540','1850' if down else '750','540','750' if down else '1850','400')
        time.sleep(1)
    raise RuntimeError('UI_CONTROL_NOT_REACHED')
def click(label, **kwargs): tap(wait(label,**kwargs))
def fill(label,value):
    n=wait(label);tap(n);adb('shell','input','text',value.replace(' ','%s'))
def backend(action,title=''):
    r=subprocess.run(['node','desktop/scripts/customer-backend-readback.cjs','android',action,title,str(out)],capture_output=True,text=True,timeout=180)
    if r.returncode:raise RuntimeError(r.stderr.strip() if re.fullmatch('[A-Z_0-9]+',r.stderr.strip()) else 'BACKEND_READBACK_FAILED')
    return json.loads(r.stdout)
def passed(id,**details):
    report['steps'].append({'id':id,'outcome':'passed','details':details});print(id+': passed',flush=True)

def save_runtime_diagnostics():
    # Only this disposable test app's process; scrub credentials and token-shaped values.
    pid=adb('shell','pidof','com.packproof.mobile').strip().split()[0]
    log=adb('logcat','-d','--pid='+pid,'-v','threadtime')
    raw=os.environ.get('CUSTOMER_FLOW_CREDENTIALS')
    if raw:
        for account in json.loads(raw).values():
            for key in ['password','email']:
                if account.get(key):log=log.replace(account[key],'[REDACTED]')
    log=re.sub(r'https?://[^\s]+','[REDACTED_URL]',log)
    log=re.sub(r'eyJ[A-Za-z0-9_.-]+','[REDACTED_TOKEN]',log)
    log=re.sub(r'(?i)(authorization|access_token|refresh_token|id_token|password)[\s:=\"\x27]+[^\s,}]+',r'\1=[REDACTED]',log)
    (out/'runtime-diagnostics.txt').write_text(log)
def enroll_emulated_fingerprint():
    adb('shell','locksettings','set-pin','246813')
    adb('shell','am','start','-a','android.settings.BIOMETRIC_ENROLL','--ei','android.provider.extra.BIOMETRIC_AUTHENTICATORS_ALLOWED','15')
    for i in range(35):
        time.sleep(1);tree=tree_now()
        texts=' '.join(n.get('text','') for n in tree.iter('node'))
        if 'Fingerprint added' in texts or 'Fingerprint 1' in texts:
            n=find(tree,'Done') or find(tree,'DONE')
            if n is not None:tap(n)
            snapshot('00-emulated-biometric-enrolled');return
        edit=next((n for n in tree.iter('node') if n.get('class')=='android.widget.EditText'),None)
        if edit is not None and ('PIN' in texts or 'pin' in texts):
            tap(edit);adb('shell','input','text','246813');adb('shell','input','keyevent','66');continue
        acted=False
        for label in ['I agree','I AGREE','Next','NEXT','More','MORE','Fingerprint','Fingerprint unlock','Set up']:
            n=find(tree,label)
            if n is not None:tap(n);acted=True;break
        if not acted and any(s in texts.lower() for s in ['touch','sensor','finger']):
            adb('emu','finger','touch','1');time.sleep(.5);adb('emu','finger','remove')
    snapshot('biometric-enrollment-failure');raise RuntimeError('EMULATOR_BIOMETRIC_ENROLLMENT_UNFINISHED')
def sign_in(credential):
    email=wait('Email')
    # Sign-out retains the account identifier. Do not append a second copy.
    if email.get('text','')!=credential['email']:
        tap(email)
        adb('shell','input','keyevent','KEYCODE_MOVE_END')
        existing=email.get('text','')
        if existing:adb('shell','input','keyevent',*(['KEYCODE_DEL']*len(existing)))
        adb('shell','input','text',credential['email'])
    fill('Password',credential['password']);adb('shell','input','keyevent','4');click('Sign in')
    wait('Create Proof',timeout=90)
def open_camera_preview():
    deadline=time.time()+100
    opened=False
    index=0
    while time.time()<deadline:
        tree=tree_now()
        if permission(tree):continue
        if find(tree,'Record packing') is not None:return
        n=find(tree,'Open camera')
        if n is not None and not opened:tap(n);opened=True
        elif n is not None and opened:
            snapshot('camera-open-result')
            texts=' '.join(n.get('text','') for n in tree.iter('node'))
            if 'Something went wrong' in texts or 'Try again' in texts:raise RuntimeError('CAMERA_OPEN_REPORTED_ERROR')
        else:adb('shell','input','swipe','540','1850','540','750','400')
        if index%3==0:snapshot('camera-transition-'+str(index))
        index+=1
        time.sleep(1)
    raise RuntimeError('CAMERA_PREVIEW_NOT_REACHED')

def verify_saved_proof(title,credential):
    global current
    current='relaunch-and-view-saved-proof'
    adb('shell','am','force-stop','com.packproof.mobile');adb('shell','monkey','-p','com.packproof.mobile','-c','android.intent.category.LAUNCHER','1');wait('Proofs',timeout=90);click('Proofs');click('Completed');click(title,partial=True,timeout=90,scroll=True);wait('Proof');snapshot('08-relaunch-proof');passed(current,**backend('verify',title))
    current='sign-out-and-sign-back-in-through-ui'
    adb('shell','input','keyevent','4');click('Home');click('Open profile menu');click('Settings');click('Sign out',scroll=True);wait('Sign in');snapshot('09-signed-out');sign_in(credential);click('Proofs');click('Completed');click(title,partial=True,scroll=True);wait('Proof');snapshot('10-signed-back-in');passed(current,**backend('verify',title))

try:
    adb('install','-r',str(pathlib.Path(os.environ['RUNNER_TEMP'])/'64.apk'))
    report['steps'].append({'id':current,'status':'passed'})
    current='launch-production-app'
    adb('shell','monkey','-p','com.packproof.mobile','-c','android.intent.category.LAUNCHER','1')
    for i in range(30):
        time.sleep(2)
        tree=snapshot('01-launch')
        if any('Check that Google Play is enabled' in n.get('text','') for n in tree.iter('node')):raise RuntimeError('GOOGLE_PLAY_ENVIRONMENT_REQUIRED')
        if any(n.get('package')=='com.android.vending' and 'Sign in' in n.get('text','') for n in tree.iter('node')):raise RuntimeError('PLAY_STORE_ACCOUNT_REQUIRED')
        if any(n.get('package')=='com.packproof.mobile' and n.get('class')=='android.widget.EditText' and n.get('content-desc')=='Email' for n in tree.iter('node')): break
    else: raise RuntimeError('SIGN_IN_NOT_REACHED')
    report['steps'].append({'id':current,'status':'passed'})
    if os.environ.get('CUSTOMER_FLOW_CREDENTIALS'):
        credential=json.loads(os.environ['CUSTOMER_FLOW_CREDENTIALS'])['android']
        current='isolated-account-preflight';passed(current,**backend('preflight'))
        existing=os.environ.get('CUSTOMER_EXISTING_FINALIZED_PROOF','')
        if existing:
            match=re.fullmatch(r'SYNTHETIC native flow Android (\d+) attempt (\d+)',existing)
            if not match:raise RuntimeError('EXACT_SYNTHETIC_PROOF_TITLE_REQUIRED')
            report['verificationScope']='remaining-finalized-proof-restart-and-sign-in-checks'
            report['continuationOfRun']=match.group(1)
            report['syntheticProofTitle']=existing
            current='sign-in-customer-ui';sign_in(credential);passed(current)
            current='open-existing-finalized-proof'
            click('Proofs');click('Completed');click(existing,partial=True,timeout=90,scroll=True);wait('Proof');snapshot('existing-finalized-proof');passed(current,**backend('verify',existing))
            verify_saved_proof(existing,credential)
            report['remainingChecksPassed']=True
            report['passed']=True
            raise SystemExit(0)
        current='enroll-emulated-biometric'
        enroll_emulated_fingerprint();passed(current,physicalBiometricVerified=False)
        adb('shell','input','keyevent','3');adb('shell','monkey','-p','com.packproof.mobile','-c','android.intent.category.LAUNCHER','1')
        current='sign-in-customer-ui';sign_in(credential);snapshot('02-workspace');passed(current)
        title='SYNTHETIC native flow Android '+os.environ['GITHUB_RUN_ID']+' attempt '+os.environ.get('GITHUB_RUN_ATTEMPT','1')
        report['syntheticProofTitle']=title
        current='create-proof-through-ui'
        click('Create Proof');click('Record a shipment',partial=True);fill('What are you shipping?',title);adb('shell','input','keyevent','4');click('Continue to camera',scroll=True)
        proof=backend('find',title)
        if proof['status']!='READY_FOR_EVIDENCE':raise RuntimeError('INITIAL_PROOF_STATE_UNEXPECTED')
        passed(current,**proof)
        current='open-native-camera'
        open_camera_preview();snapshot('03-camera-preview');passed(current)
        current='record-continuous-synthetic-camera-video'
        click('Record packing',scroll=True);wait('Finish recording',timeout=90,scroll=True);time.sleep(8);snapshot('04-recording');click('Finish recording',scroll=True)
        wait('Review recording',timeout=120);snapshot('05-review');passed(current,syntheticCamera=True)
        current='biometric-confirmation-and-upload-through-ui'
        click('Confirm and submit.',partial=True,timeout=120,scroll=True)
        # The normal Android BiometricPrompt must be present before a virtual fingerprint is supplied.
        deadline=time.time()+60
        while time.time()<deadline:
            tree=tree_now();text=' '.join(n.get('text','') for n in tree.iter('node'))
            if any(n.get('package')=='com.android.systemui' and ('fingerprint' in n.get('text','').lower() or 'biometric' in n.get('resource-id','')) for n in tree.iter('node')):
                snapshot('06-biometric-prompt');adb('emu','finger','touch','1');break
            time.sleep(1)
        else:raise RuntimeError('NATIVE_BIOMETRIC_PROMPT_NOT_REACHED')
        passed(current,nativeBiometricPromptObserved=True,authenticationInput='emulated enrolled fingerprint')
        current='server-finalization-and-original-readback'
        deadline=time.time()+240
        while time.time()<deadline:
            state=backend('find',title)
            if state['status']=='FINALIZED':break
            time.sleep(5)
        else:raise RuntimeError('SERVER_FINALIZATION_NOT_CONFIRMED')
        snapshot('07-finalized-proof');passed(current,**backend('verify',title))
        verify_saved_proof(title,credential)
        report['fullSignedInFlow']=True
    report['passed']=True
except Exception as error:
    report['passed']=False
    report['failure']={'step':current,'code':str(error) if str(error).isupper() else 'UI_STEP_FAILED'}
    if report.get('syntheticProofTitle'):
        try: report['failureBackendReadback']=backend('find',report['syntheticProofTitle'])
        except Exception: pass
    try: snapshot('failure')
    except Exception: pass
    try: save_runtime_diagnostics()
    except Exception: pass
finally:
    (out/'receipt.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report))
raise SystemExit(0 if report['passed'] else 1)

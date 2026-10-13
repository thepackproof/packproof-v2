"""UI verification of the unchanged Google-signed production APK on a hosted emulator."""
import json, os, pathlib, subprocess, time, xml.etree.ElementTree as ET
out = pathlib.Path(os.environ['RUNNER_TEMP']) / 'customer-android'
out.mkdir(parents=True, exist_ok=True)
report = {'schema':'packproof.native-customer-flow.v1','platform':'android','version':'1.0.1 (64)','apkSha256':'97a7f08a95938cdab1c1b91a911195cdfe7d119db6e0a2eb21c6e903a6fe88b3','physicalDeviceChecks':'waived','syntheticCamera':True,'steps':[]}
current = 'install-google-signed-apk'
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
try:
    adb('install','-r',str(pathlib.Path(os.environ['RUNNER_TEMP'])/'64.apk'))
    report['steps'].append({'id':current,'status':'passed'})
    current='launch-production-app'
    adb('shell','monkey','-p','com.packproof.mobile','-c','android.intent.category.LAUNCHER','1')
    for i in range(30):
        time.sleep(2)
        tree=snapshot('01-launch')
        if any(n.get('text')=='Sign in' or n.get('content-desc')=='Sign in' for n in tree.iter('node')): break
    else: raise RuntimeError('SIGN_IN_NOT_REACHED')
    report['steps'].append({'id':current,'status':'passed'})
    report['passed']=True
except Exception as error:
    report['passed']=False
    report['failure']={'step':current,'code':str(error) if str(error).isupper() else 'UI_STEP_FAILED'}
    try: snapshot('failure')
    except Exception: pass
finally:
    (out/'receipt.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report))
raise SystemExit(0 if report['passed'] else 1)

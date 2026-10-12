"""Synthetic hostile payload copied to an allowed test entry point by the CI harness.

This is never an additional production launcher entry point. It tests only its own
temporary canaries; no account material, outside services or real media are used.
"""
import errno
import json
import os
from pathlib import Path
import resource
import socket
import subprocess
import sys
import tempfile

job = json.loads(Path(sys.argv[sys.argv.index('--job') + 1]).read_text())
root = Path.cwd()

def cannot_open_for_write(path):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_APPEND)
    except OSError as error:
        return error.errno in (errno.EROFS, errno.EACCES, errno.EPERM)
    else:
        os.close(fd)
        return False

def bounded_child(code):
    completed = subprocess.run([sys.executable, '-I', '-c', code],
                               capture_output=True, text=True, timeout=5)
    return completed.returncode == 0 and completed.stdout.strip() == 'DENIED'

try:
    with socket.create_connection(('127.0.0.1', job['hostPort']), timeout=1):
        host_network_denied = False
except OSError:
    host_network_denied = True

namespaces = {name: os.readlink('/proc/self/ns/' + name) for name in ('net', 'pid', 'mnt', 'user')}
status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
limits = {name: list(resource.getrlimit(getattr(resource, 'RLIMIT_' + name)))
          for name in ('AS', 'CPU', 'FSIZE', 'NOFILE')}
(root / 'positive-write.txt').write_text('synthetic job write')
with tempfile.TemporaryFile() as temporary:
    temporary.write(b'synthetic private temporary write')
    private_tmp_writable = True

checks = {
    'hostLoopbackDenied': host_network_denied,
    'noExternalRoute': len(Path('/proc/net/route').read_text().splitlines()) == 1,
    'unrelatedHostFileUnavailable': not Path(job['outsideCanary']).exists(),
    'hostEnvironmentRemoved': 'PACKPROOF_SANDBOX_CANARY' not in os.environ,
    'separateNamespaces': all(namespaces[name] != job['hostNamespaces'][name] for name in namespaces),
    'capabilitiesDropped': int(status['CapEff'].strip(), 16) == 0,
    'codeReadOnly': cannot_open_for_write(job['codeCanary']),
    'runtimeReadOnly': cannot_open_for_write(job['runtimeCanary']),
    'jobWritable': (root / 'positive-write.txt').read_text() == 'synthetic job write',
    'privateTmpWritable': private_tmp_writable,
    'configuredAddressSpaceLimit': limits['AS'] == [2147483648, 2147483648],
    'configuredCpuLimit': limits['CPU'] == [55, 55],
    'configuredFileSizeLimit': limits['FSIZE'] == [134217728, 134217728],
    'configuredFdLimit': limits['NOFILE'] == [128, 128],
    'addressSpaceAllocationDenied': bounded_child("import mmap\ntry:mmap.mmap(-1,3*1024**3)\nexcept (OSError,ValueError):print('DENIED')"),
    'fileSizeGrowthDenied': bounded_child("import os,errno\nf=os.open('limit-file.bin',os.O_WRONLY|os.O_CREAT,0o600)\ntry:os.ftruncate(f,134217729)\nexcept OSError as e:\n if e.errno==errno.EFBIG:print('DENIED')\nfinally:os.close(f)"),
    'fdExhaustionDenied': bounded_child("import os,errno\nfds=[]\ntry:\n for i in range(129):fds.append(os.open('/dev/null',os.O_RDONLY))\nexcept OSError as e:\n if e.errno==errno.EMFILE:print('DENIED')\nfinally:\n for fd in fds:os.close(fd)"),
}
print(json.dumps({'checks': checks, 'limits': limits, 'passed': all(checks.values())}))
sys.exit(0 if all(checks.values()) else 1)

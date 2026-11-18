"""Rebuild or verify the PackProof packages from integrity-pinned upstream npm archives."""
import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
from urllib.request import urlopen

HERE = Path(__file__).resolve().parent
MOBILE = HERE.parents[2] / "mobile" / "vendor" / "picomatch"
UPSTREAM = {
    "2.3.2": "V7+vQEJ06Z+c5tSye8S+nHUfI51xoXIXjHQ99cQtKUkQqqO1kO/KCJUfZXuB47h/YBlDhah2H3hdUGXn8ie0oA==",
    "3.0.2": "cfDHL6LStTEKlNilboNtobT/kEa30PtAf2Q1OgszfrG/rpVl1xaFWT9ktfkS306GmHgmnad1Sw4wabhlvFtsTw==",
    "4.0.7": "qcJu88Q2IWqJsDD529JKMdwGm/dvInW4HvQnRwiH9JtihJvzGOscDtHE3x1pBKeUOTysQ8kVmLnJ2kJu7yhcGA==",
}


def rebuild(version, cache):
    filename = f"picomatch-{version}.tgz"
    if cache:
        source = (cache / filename).read_bytes()
    else:
        with urlopen("https://registry.npmjs.org/picomatch/-/" + filename, timeout=45) as response:
            source = response.read()
    if base64.b64encode(hashlib.sha512(source).digest()).decode() != UPSTREAM[version]:
        raise ValueError("Upstream npm archive integrity mismatch: " + version)
    with tarfile.open(fileobj=io.BytesIO(source), mode="r:gz") as archive:
        files = {entry.name: archive.extractfile(entry).read() for entry in archive if entry.isfile()}
    path = "package/lib/parse.js"
    with tempfile.TemporaryDirectory() as scratch:
        parser = Path(scratch) / "parse.js"
        parser.write_bytes(files[path])
        subprocess.run(["patch", "--silent", "--batch", "--fuzz=0", str(parser), str(HERE / "repetition.patch")], check=True)
        files[path] = parser.read_bytes()
    meta = json.loads(files["package/package.json"])
    if meta["name"] != "picomatch" or meta["version"] != version:
        raise ValueError("Unexpected npm package identity")
    meta.update(name="@packproof/picomatch", version=version + "-packproof.1",
                description="PackProof's bounded repetition patch of picomatch " + version)
    files["package/package.json"] = (json.dumps(meta, indent=2, ensure_ascii=False) + "\n").encode()
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.USTAR_FORMAT) as tar:
            for name, content in sorted(files.items()):
                entry = tarfile.TarInfo(name)
                entry.size = len(content)
                entry.mode = 0o644
                tar.addfile(entry, io.BytesIO(content))
    return output.getvalue()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, help="directory containing the original npm .tgz files")
    parser.add_argument("--check", action="store_true", help="compare with committed archives without writing")
    args = parser.parse_args()
    for version in UPSTREAM:
        target = (HERE if version.startswith("4.") else MOBILE) / f"picomatch-{version}-packproof.1.tgz"
        result = rebuild(version, args.cache)
        if args.check:
            if gzip.decompress(result) != gzip.decompress(target.read_bytes()):
                raise SystemExit("Vendored bytes differ: " + str(target))
        else:
            target.write_bytes(result)
        print(target.name, hashlib.sha256(result).hexdigest())

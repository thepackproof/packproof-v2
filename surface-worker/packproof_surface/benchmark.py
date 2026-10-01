"""Measured CPU-only microbenchmark. Synthetic measurements are not optical evidence."""
import argparse
import math
import platform
import resource
import statistics
import time
from pathlib import Path
from .contracts import canonical, read_json
from .engine import run

def measure(job, media_root, iterations, provenance):
    if not 1 <= iterations <= 30 or provenance not in {"synthetic", "physical"}:
        raise ValueError("Specify 1-30 iterations and explicit fixture provenance")
    elapsed, cpu = [], []
    hashes=[]
    result=None
    for _ in range(iterations):
        start, cpu_start = time.perf_counter(), time.process_time()
        result=run(job,media_root)
        elapsed.append(time.perf_counter()-start)
        cpu.append(time.process_time()-cpu_start)
        hashes.append(result["artifactSha256"])
    originals={source["mediaPath"] for role in ("enrollment","observation") if role in job for source in job[role]["sources"]}
    original_bytes=sum((Path(media_root)/name).stat().st_size for name in originals)
    return {"schemaVersion":"surface-microbenchmark/1","fixtureProvenance":provenance,"iterations":iterations,
            "independentPhysicalTrials":0,"productionEligible":False,"method":result["method"],
            "runtime":{"python":platform.python_version(),"system":platform.system(),"machine":platform.machine(),"opencvThreads":1},
            "wallSeconds":{"samples":elapsed,"median":statistics.median(elapsed),"p95NearestRank":sorted(elapsed)[math.ceil(iterations*.95)-1]},
            "cpuSeconds":{"median":statistics.median(cpu),"total":sum(cpu)},
            "peakProcessRssBytes":resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if platform.system()=="Darwin" else 1024),
            "originalMediaBytes":original_bytes,"resultJsonBytes":len(canonical(result)),
            "repeatedResultDigestsIdentical":len(set(hashes))==1,"outputStatus":result["status"],
            "limitations":["Repeated same-fixture iterations are not independent trials or a workload p95.",
                           "CPU and RSS measurements include this process; no production cloud cost or device optical performance is inferred.",
                           "Runtime is the present shared execution host, not a qualified deployed worker profile."]}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input",required=True)
    parser.add_argument("--media-root",required=True)
    parser.add_argument("--iterations",type=int,default=5)
    parser.add_argument("--provenance",choices=["synthetic","physical"],required=True)
    parser.add_argument("--output",required=True)
    args=parser.parse_args()
    report=measure(read_json(args.input),args.media_root,args.iterations,args.provenance)
    with open(args.output,"xb") as out:
        out.write(canonical(report)+b"\n")

if __name__=="__main__":
    main()

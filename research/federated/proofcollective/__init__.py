"""ProofCollective: isolated, synthetic protocol engineering; no production training."""
import os

# Bound native worker multiplication before this package imports NumPy/Flower.
# The standalone CLI and forkserver preload enter here before native imports.
for _name in ('OPENBLAS_NUM_THREADS','OMP_NUM_THREADS','MKL_NUM_THREADS','NUMEXPR_NUM_THREADS'):
    os.environ[_name]='1'

__version__ = "0.1.0"

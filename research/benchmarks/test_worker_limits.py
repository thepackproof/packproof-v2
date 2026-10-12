"""Portable boundary checks; actual kernel enforcement is a separate Linux probe."""
import unittest
from research.vision.worker import apply_resource_limits

class Limits:
    RLIMIT_CPU, RLIMIT_FSIZE, RLIMIT_NOFILE, RLIMIT_AS = range(4)
    RLIM_INFINITY = -1
    def __init__(self, pairs):self.pairs = dict(enumerate(pairs))
    def getrlimit(self, kind):return self.pairs[kind]
    def setrlimit(self, kind, pair):
        previous = self.pairs[kind]
        if previous[1] != self.RLIM_INFINITY and pair[1] > previous[1]:
            raise ValueError('cannot raise inherited hard limit')
        self.pairs[kind] = pair

class WorkerLimitsTests(unittest.TestCase):
    def test_stricter_sandbox_hard_limits_are_preserved(self):
        original = [(55,55),(33554432,33554432),(128,128),(2147483648,2147483648)]
        limits = Limits(original)
        apply_resource_limits(limits,55)
        self.assertEqual(list(limits.pairs.values()),original)

    def test_unlimited_parent_receives_worker_profile(self):
        limits = Limits([(-1,-1)] * 4)
        apply_resource_limits(limits,55)
        self.assertEqual(list(limits.pairs.values()),[(55,56),(134217728,134217728),(128,128),(2147483648,2147483648)])

    def test_inherited_soft_limits_are_not_relaxed(self):
        limits = Limits([(10,20),(1024,2048),(32,64),(1073741824,2147483648)])
        before = dict(limits.pairs)
        apply_resource_limits(limits,55)
        self.assertEqual(limits.pairs,before)

if __name__ == '__main__':unittest.main()

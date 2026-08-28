# Legacy PackProof freeze

PackProof V2 does not live in the PackProof git history.

| Item | Value |
| --- | --- |
| Legacy working tree | `C:\src\PackProof\repo` |
| Legacy default branch | `master` (`origin/master`) |
| Frozen commit | `c24cd22be590e6eb4ae99c2aa3788e11dacca66e` |
| Frozen subject | `fix: open active PackProofs on the existing task surface (#94)` |
| Recommended tag (apply inside the legacy repo only) | `legacy-v1` |

This workspace must not create branches, commits, or tags in `C:\src\PackProof\repo`.

To tag legacy later, from that repository:

```text
git tag -a legacy-v1 c24cd22be590e6eb4ae99c2aa3788e11dacca66e -m "Legacy PackProof architecture freeze"
```

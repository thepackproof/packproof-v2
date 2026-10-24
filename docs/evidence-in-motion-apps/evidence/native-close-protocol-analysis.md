# Native close acknowledgment diagnosis

Observed installed-smoke failure: the candidate reached renderer readiness and secure storage, then logged `WINDOW_CLOSE_REQUESTED` and exited with code 0/no signal. The harness reported `delivered:false`, `matchedWindows:null`, and `OWNED_WINDOW_CLOSE_NOT_CONFIRMED`. This is not a passing native smoke.

The caller decodes PowerShell stdout as UTF-8 and requires one JSON acknowledgment with the exact owned PID/method, one matched window, `delivered:true`, a successful helper exit, no helper error, and a subsequent normal zero exit. The old helper emitted JSON through a PowerShell pipeline without fixing the output encoding.

A local Windows no-UI reproduction starts PowerShell with Unicode output encoding. Its successful JSON acknowledgment reaches Node as interleaved NUL bytes, reproducing the same false/null acknowledgment result. Executing the production helper's updated UTF-8-without-BOM/write/flush prelude makes the same probe parse and pass the original ownership/delivery checks. Wrong PID, failed helper, ambiguous window and unacknowledged zero exit remain failures.

The helper now emits deterministic UTF-8 bytes and flushes its acknowledgment. The caller adds only bounded status/error/protocol classifications; raw stdout, stderr and executable paths are excluded. No application, capture, queue, shutdown coordinator, native message, ownership or exit gate changed.

The original runner's raw helper output was not retained, so the reproduction establishes a concrete protocol defect but cannot prove that runner used Unicode output. A new exact-candidate installed smoke remains necessary. Local app/window launching was unavailable and has not been represented as passed.

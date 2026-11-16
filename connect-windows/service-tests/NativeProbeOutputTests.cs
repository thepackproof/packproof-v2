using System.Diagnostics;
using Xunit;

public sealed class NativeProbeOutputTests
{
    // Real child processes exceed the redirected pipe buffer on both Windows
    // and Linux. Draining stdout only, or draining after WaitForExit, hangs this
    // fixture because stderr fills independently too.
    private static Process StartOutputFixture()
    {
        var start = new ProcessStartInfo(OperatingSystem.IsWindows() ? "cmd.exe" : "/bin/sh")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        var text = new string('x', 128);
        if (OperatingSystem.IsWindows())
        {
            start.ArgumentList.Add("/d"); start.ArgumentList.Add("/q"); start.ArgumentList.Add("/c");
            start.ArgumentList.Add("for /L %i in (1,1,256) do @(echo fixture-stdout-" + text + " & echo fixture-stderr-012345678901234567890123456789 1>&2)");
        }
        else
        {
            start.ArgumentList.Add("-c");
            start.ArgumentList.Add("i=0; while [ $i -lt 256 ]; do printf 'fixture-stdout-" + text + "\\n'; printf 'fixture-stderr-012345678901234567890123456789\\n' >&2; i=$((i+1)); done");
        }
        return Process.Start(start) ?? throw new InvalidOperationException("The output fixture could not start.");
    }
    [Fact]
    public void Native_probe_drains_both_redirected_streams_before_waiting_for_exit()
    {
        using var child = StartOutputFixture();
        try
        {
            var capture = new ConnectNativeSecurityProbe.BoundedProcessCapture(child);
            var response = capture.WaitForResponse(5000);
            Assert.Equal(0, child.ExitCode); Assert.True(response.Length > 32768); Assert.Contains("fixture-stdout-", response); Assert.DoesNotContain("fixture-stderr-", response);
        }
        finally { if (!child.HasExited) { child.Kill(true); child.WaitForExit(5000); } }
    }
    [Fact]
    public void Native_probe_rejects_oversized_output_after_draining_without_deadlocking()
    {
        using var child = StartOutputFixture();
        try
        {
            var capture = new ConnectNativeSecurityProbe.BoundedProcessCapture(child, maximumOutputBytes: 2048);
            var error = Assert.Throws<InvalidOperationException>(() => capture.WaitForResponse(5000));
            Assert.Contains("oversized", error.Message); Assert.True(child.HasExited); Assert.Equal(0, child.ExitCode);
        }
        finally { if (!child.HasExited) { child.Kill(true); child.WaitForExit(5000); } }
    }
}

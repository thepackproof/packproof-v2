using System.Text;
using System.Text.Json;
using PackProof.Connect;
using Xunit;

public sealed class HostConfigurationTests
{
    private static readonly HostConfiguration Expected = new("development", "https://api.fixture.invalid", "https://thepackproof.com", "S-1-5-21-100-200-300-1001");

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Bootstrap_reads_packaged_or_windows_powershell_configuration(bool withBom)
    {
        var json = Json.Bytes(Expected);
        var bytes = withBom ? new byte[] { 0xEF, 0xBB, 0xBF }.Concat(json).ToArray() : json;
        var actual = HostConfiguration.Read(bytes);
        actual.Validate();
        Assert.Equal(Expected, actual);
    }

    [Fact]
    public void Host_compatibility_does_not_relax_protected_json_or_accept_invalid_configuration()
    {
        var marked = new byte[] { 0xEF, 0xBB, 0xBF }.Concat(Json.Bytes(Expected)).ToArray();
        Assert.Throws<JsonException>(() => Json.Read<HostConfiguration>(marked));
        Assert.Throws<JsonException>(() => HostConfiguration.Read(Encoding.UTF8.GetBytes("not JSON")));
        var invalid = HostConfiguration.Read(Json.Bytes(Expected with { ApiOrigin = "http://api.fixture.invalid" }));
        Assert.Throws<ConnectException>(() => invalid.Validate());
    }
}

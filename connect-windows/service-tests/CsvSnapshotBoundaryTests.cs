using System.Text;
using System.Text.Json;
using PackProof.Connect;
using Xunit;
public sealed class CsvSnapshotBoundaryTests
{
    [Fact]public void All_shared_controls_agree_with_hosted_parser_without_inventing_snapshot_metadata()
    {
        using var corpus=JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"csv-snapshot-boundary-corpus.json")));var cases=0;
        foreach(var fixture in corpus.RootElement.GetProperty("cases").EnumerateArray())
        {
            var bytes=Encoding.UTF8.GetBytes(fixture.GetProperty("original").GetProperty("content").GetString()!);var config=fixture.GetProperty("config");
            if(fixture.TryGetProperty("expected",out var expected))Assert.Equal(TypedSourceSemantics.CanonicalBytes(expected.GetProperty("completeness")),TypedSourceSemantics.CanonicalBytes(TypedSourceSemantics.Completeness(bytes,config)));
            else Assert.Equal(fixture.GetProperty("errorContains").GetString(),Assert.Throws<ConnectException>(()=>TypedSourceSemantics.Completeness(bytes,config)).Code);
            cases++;
        }
        Assert.Equal(31,cases);
    }
    [Fact]public void An_absent_binding_keeps_legacy_unknown_boundary_and_cannot_derive_a_marker_from_bytes()
    {
        var result=TypedSourceSemantics.Completeness("any retained original"u8.ToArray(),Json.Element(new{batchSchema="packproof.typed-source-batch/v1"}));Assert.Equal("{\"kind\":\"unknown\"}",result.GetRawText());
    }
}

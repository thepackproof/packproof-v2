using System.Text.Json;
using Xunit;
using PackProof.Connect;

public class ControlledOrderJourneyTests
{
    [Fact]
    public void Publish_controlled_projection()
    {
        string? path = Environment.GetEnvironmentVariable("PACKPROOF_JOURNEY_PROJECTED");
        string? output = Environment.GetEnvironmentVariable("PACKPROOF_JOURNEY_OUTPUT");
        if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(output)) return;
        var record = JsonSerializer.Deserialize<JsonElement>(File.ReadAllBytes(path));
        Directory.CreateDirectory(output);
        using var writer = new ProofOutputBundle(output, "controlled-sample-installation");
        var folder = writer.Publish(record,record.GetProperty("proofId").GetString()!,record.GetProperty("revision").GetInt32());
        Assert.True(File.Exists(Path.Combine(folder,"current.html")));
    }
    [Fact]
    public void Controlled_files_reach_the_approved_cross_format_profile()
    {
        var assetDir = new DirectoryInfo(AppContext.BaseDirectory);
        while (assetDir != null && !Directory.Exists(Path.Combine(assetDir.FullName, "examples", "multisource-journey", "fixtures")))
            assetDir = assetDir.Parent;
        Assert.NotNull(assetDir);
        var root = Path.Combine(assetDir!.FullName, "examples", "multisource-journey", "fixtures");
        (string File, string Role, int Count)[] samples = [
            ("orders.json","order",1), ("picking.csv","picking",2), ("packages.xml","packing",2),
            ("packing_photo.json","evidence",1), ("labels.json","shipping",2), ("handoff.json","handoff",2),
            ("delivery.jsonl","delivery",2), ("corrections.json","order",1), ("early_evidence.json","evidence",1),
            ("late_bridge.json","packing",1), ("second_order.json","order",1), ("consolidated.json","handoff",1),
            ("return.json","returns",1), ("cancellation.json","order",1), ("unrelated_order.json","order",1),
            ("orders.xlsx","order",2)
        ];
        var receipt = new Dictionary<string, object>();
        foreach (var sample in samples)
        {
            var bytes = File.ReadAllBytes(Path.Combine(root,sample.File));
            var parsed = SourceReaders.Read(sample.File,bytes);
            Assert.True(parsed.State=="parsed", sample.File+" "+string.Join("; ",parsed.Issues));
            var records = SourceReaders.Normalize(parsed,sample.Role);
            Assert.True(records.GetArrayLength()==sample.Count, sample.File+" normalized row count");
            foreach (var record in records.EnumerateArray())
            {
                Assert.False(string.IsNullOrEmpty(record.GetProperty("locator").GetString()));
                Assert.False(string.IsNullOrEmpty(record.GetProperty("entity").GetProperty("id").GetString()));
            }
            receipt[sample.File] = new {sourceId=sample.Role,sha256=parsed.ContentSha256,profileVersion=SourceReaders.ProfileId,records};
        }
        var path = Environment.GetEnvironmentVariable("PACKPROOF_JOURNEY_RECEIPT");
        if (!string.IsNullOrEmpty(path))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
            File.WriteAllText(path,JsonSerializer.Serialize(receipt));
        }
    }
}

using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PackProof.Connect;
using Xunit;

public class ProofOutputTests : IDisposable
{
    private readonly string root = Directory.CreateTempSubdirectory("packproof-output-").FullName;

    private static JsonElement Order(int revision, string reference="SO10482", string proofId="p_test", byte[]? original=null)
    {
        original ??= Encoding.UTF8.GetBytes("original sample");
        var hash = Convert.ToHexStringLower(SHA256.HashData(original));
        return Json.Element(new {proofId,revision,orderReference=reference,lines=new[]{new{lineId="20", sku="A100", orderedQuantity=revision}},
            events=new[]{new{kind="Order received",sourceId="ERP_A",occurredAt="2026-11-17T12:00:00Z"}},
            evidence=new object[]{new {kind="original",originalSha256=hash,bytesBase64=Convert.ToBase64String(original),sourceId="ERP_A"},
                new {kind="derived",originalSha256=hash,sourceId="WMS",locator="row 7"}}});
    }

    [Fact]
    public void RevisionsAreImmutableAndRetriesKeepTheLatestPointer()
    {
        using var writer=new ProofOutputBundle(root,"installation-a");
        var folder=writer.Publish(Order(1),"p_test",1);
        var first=File.ReadAllBytes(Path.Combine(folder,"revision-00000001","record.json"));
        Assert.Equal(folder,writer.Publish(Order(2,"SO10482 corrected"),"p_test",2));
        writer.Publish(Order(1),"p_test",1);
        Assert.Equal(first,File.ReadAllBytes(Path.Combine(folder,"revision-00000001","record.json")));
        Assert.Contains("revision-00000002/summary.html",File.ReadAllText(Path.Combine(folder,"current.html")));
        Assert.Equal(2,Directory.GetFiles(Path.Combine(folder,"evidence")).Length);
        var manifest=Json.Read<JsonElement>(File.ReadAllBytes(Path.Combine(folder,"revision-00000002","manifest.json")));
        Assert.Contains(manifest.GetProperty("files").EnumerateArray(), e=>e.GetProperty("kind").GetString()=="derived excerpt");
        Assert.Contains("A100",File.ReadAllText(Path.Combine(folder,"revision-00000002","summary.html")));
    }

    [Fact]
    public void InvalidCommittedBytesKeepThePriorPackageReadable()
    {
        using var writer=new ProofOutputBundle(root,"installation-a");
        var folder=writer.Publish(Order(1),"p_test",1);
        var prior=File.ReadAllBytes(Path.Combine(folder,"current.html"));
        var broken=Json.Element(new {proofId="p_test",revision=2,orderReference="SO10482",
            evidence=new[]{new{kind="original",originalSha256=new string('a',64),bytesBase64="Yg=="}}});
        Assert.Throws<ConnectException>(()=>writer.Publish(broken,"p_test",2));
        Assert.Equal(prior,File.ReadAllBytes(Path.Combine(folder,"current.html")));
        Assert.False(Directory.Exists(Path.Combine(folder,"revision-00000002")));
        writer.Publish(Order(2),"p_test",2);
        Assert.Contains("revision-00000002",File.ReadAllText(Path.Combine(folder,"current.html")));
    }

    [Fact]
    public void CompetingWritersCannotTakeOverAfterRelease()
    {
        using(var first=new ProofOutputBundle(root,"installation-a"))
            Assert.ThrowsAny<Exception>(()=>new ProofOutputBundle(root,"installation-b").Dispose());
        Assert.Equal("OUTPUT_WRITER_CONFLICT", Assert.Throws<ConnectException>(()=>new ProofOutputBundle(root,"installation-b").Dispose()).Code);
        using var resumed=new ProofOutputBundle(root,"installation-a");
        resumed.Publish(Order(1),"p_test",1);
    }

    [Fact]
    public void ServiceChecksOverlapInBothDirectionsAndCanReadWriteAndRename()
    {
        var source=Directory.CreateDirectory(Path.Combine(root,"source")).FullName;
        var output=Directory.CreateDirectory(Path.Combine(root,"proofs")).FullName;
        Assert.Throws<ConnectException>(()=>ProofOutputPaths.Verify(root,new[]{source}).Dispose());
        Assert.Throws<ConnectException>(()=>ProofOutputPaths.Verify(source,new[]{root}).Dispose());
        using var safe=ProofOutputPaths.Verify(output,new[]{source});
        ProofOutputBundle.Probe(output);
        Assert.Empty(Directory.GetFiles(output));
    }

    public void Dispose() => Directory.Delete(root,true);
}

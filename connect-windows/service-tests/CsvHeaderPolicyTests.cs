using System.Text;
using System.Text.Json;
using PackProof.Connect;
using Xunit;

public sealed class CsvHeaderPolicyTests
{
    private static readonly string[] Headers = ["Shipment reference","Description","Quantity","Shipment date","Unmapped"];
    private static JsonElement Config() => Json.Element(new {
        mapping = new {shipmentReference=Headers[0],itemTitle=Headers[1],quantity=Headers[2],shippedAt=Headers[3]},
        timeZone="source-offset",sourceContract=new {schema="packproof.scheduled-csv/v2",rulesVersion=CsvSemantics.Version,
            profileVersion=CsvSemantics.Profile,expectedHeaders=Headers,confirmedFields=Array.Empty<string>(),backfillFrom="2026-01-01T00:00:00Z"}
    });
    private static byte[] Bytes(string headers,string row) => Encoding.UTF8.GetBytes(headers+"\n"+row+"\n");
    [Fact] public void Only_an_expressly_proposed_and_supported_policy_accepts_permutations_of_the_complete_schema()
    {
        var proposal=Json.Element(new {allowColumnReordering=true});
        var capability=Json.Element(new {csvHeaderPolicies=new[]{CsvHeaderPolicy.Reorder}});
        var original=Config();
        Assert.Throws<ConnectException>(()=>CsvHeaderPolicy.WithRequestedPolicy(original,proposal,null));
        var configured=CsvHeaderPolicy.WithRequestedPolicy(original,proposal,capability);
        Assert.False(CsvHeaderPolicy.SourceCompatible(configured,null));
        Assert.True(CsvHeaderPolicy.SourceCompatible(configured,capability));
        var row="value,2026-10-20T13:00:00Z,8,Valve,00002";
        var reordered=string.Join(",",Headers.Reverse());
        var bytes=Bytes(reordered,row);
        Assert.Throws<ConnectException>(()=>FolderSource.ValidateContract(bytes,original));
        FolderSource.ValidateContract(bytes,configured);
        foreach(var changed in new[]{Bytes(reordered+",Employee email",row+",private"),
            Bytes(reordered.Replace("Unmapped","Payroll"),row),Bytes(reordered.Replace("Unmapped,",""),row[6..]),
            Bytes(reordered,row+",extra")})
            Assert.Throws<ConnectException>(()=>FolderSource.ValidateContract(changed,configured));
        Assert.False(original.GetProperty("sourceContract").TryGetProperty("headerPolicy",out _));
        var exactAgain=CsvHeaderPolicy.WithRequestedPolicy(configured,Json.Element(new{}),capability);
        Assert.Equal(original.GetRawText(),exactAgain.GetRawText());
        Assert.Throws<ConnectException>(()=>FolderSource.ValidateContract(bytes,exactAgain));
    }
    [Fact] public void Typed_and_scheduled_collectors_keep_exact_unnormalized_names()
    {
        var corpus=JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"source-contract-corpus.json")));
        var source=corpus.RootElement.GetProperty("cases").EnumerateArray().Single(c=>c.GetProperty("name").GetString()=="csv-leading-zero-identities-and-exact-locator").GetProperty("input");
        var records=source.GetProperty("original").GetProperty("content").GetString()!.TrimEnd().Split("\r\n");
        var names=records[0].Split(',');
        var config=Json.Element(new{sourceProfile=source.GetProperty("sourceProfile"),sourceNamespace=source.GetProperty("sourceNamespace"),
            mapping=source.GetProperty("mapping"),constants=source.GetProperty("constants"),expectedHeaders=names,headerPolicy=CsvHeaderPolicy.Reorder});
        var reordered=string.Join(",",names.Reverse());
        var row=string.Join(",",records[1].Split(',').Reverse());
        Assert.True(Assert.Single(TypedSourceSemantics.Preview(Bytes(reordered,row),config)).Valid);
        var error=Assert.Throws<ConnectException>(()=>TypedSourceSemantics.Preview(Bytes(reordered+",Private",row+",sensitive"),config));
        Assert.Equal("SOURCE_SCHEMA_CHANGED",error.Code);
        Assert.DoesNotContain("Private",error.Message);
        Assert.DoesNotContain("sensitive",error.Message);
    }
}

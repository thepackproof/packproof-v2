using System.Text;
using System.Text.Json;
using PackProof.Connect;
using Xunit;
public sealed class CsvSemanticsTests
{
    public static IEnumerable<object[]> Corpus()=>JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"connect-csv-corpus.json"))).RootElement.EnumerateArray().Select(f=>new object[]{f.GetProperty("name").GetString()!,f.Clone()});
    [Theory][MemberData(nameof(Corpus))]
    public void Original_values_follow_the_same_semantic_corpus_as_the_authoritative_server(string name,JsonElement fixture)
    {
        var text=fixture.GetProperty("csv").GetString()!;
        if(fixture.TryGetProperty("repeat",out var repetition)){
            var unit=repetition.GetProperty("unit").GetString()!;
            var count=repetition.GetProperty("count").GetInt32();
            var body=new StringBuilder(text);
            for(int i=0;i<count;i++)body.Append(unit.Contains("{i}")?unit.Replace("{i}",i.ToString(System.Globalization.CultureInfo.InvariantCulture)):unit);
            text=body.Append(repetition.GetProperty("suffix").GetString()).ToString();
        }
        var bytes=fixture.TryGetProperty("base64",out var raw)?Convert.FromBase64String(raw.GetString()!):Encoding.UTF8.GetBytes(text);
        if(fixture.TryGetProperty("byteSha256",out var digest))Assert.Equal(digest.GetString(),Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes)));
        if(fixture.TryGetProperty("encodingError",out _)){Assert.Equal("CSV_ENCODING_UNSUPPORTED",Assert.Throws<ConnectException>(()=>CsvSemantics.Analyze(bytes)).Code);return;}
        if(fixture.TryGetProperty("parseError",out var error)&&error.GetBoolean()){Assert.Throws<ConnectException>(()=>CsvSemantics.Analyze(bytes));return;}
        var map=fixture.TryGetProperty("mapping",out var m)?JsonSerializer.Deserialize<Dictionary<string,string>>(m,Json.Options):null;
        var confirmed=fixture.TryGetProperty("confirmedFields",out var f)?f.EnumerateArray().Select(x=>x.GetString()!).ToArray():[];
        var location=fixture.TryGetProperty("locationId",out var l)?l.GetString():null;
        var qualified=fixture.TryGetProperty("interpretation",out var expected);
        var result=CsvSemantics.Analyze(bytes,map,confirmed,location,interpret:qualified);
        if(qualified){
            Assert.Equal(CsvSemantics.InterpretationVersion,result.Interpretation!.Version);
            Assert.Equal(expected.GetProperty("grain").GetString(),result.Interpretation.Grain);
            Assert.Equal(expected.GetProperty("outcome").GetString(),result.Interpretation.Outcome);
            Assert.Equal(expected.GetProperty("reasonCodes").EnumerateArray().Select(v=>v.GetString()),result.Interpretation.ReasonCodes);
        }
        if(fixture.TryGetProperty("fieldCounts",out var counts))foreach(var field in counts.EnumerateObject()){
            var decision=result.Decisions.Single(d=>d.Field==field.Name);
            Assert.Equal(field.Value.GetProperty("valid").GetInt32(),decision.ValidRowCount);
            Assert.Equal(field.Value.GetProperty("invalid").GetInt32(),decision.InvalidRowCount);
        }
        Assert.Equal(fixture.GetProperty("ready").GetBoolean(),result.Ready);
        if(name=="screenshot-supported"){
            Assert.Equal("PP-TEST-20261113-001",result.Shipment!.Value.GetProperty("shipmentReference").GetString());
            Assert.Equal("TEST ONLY - PVC elbow 1 inch",result.Shipment.Value.GetProperty("itemTitle").GetString());
            Assert.Equal(12,result.Shipment.Value.GetProperty("quantity").GetInt32());
            Assert.Equal("2026-11-13T09:00:00-05:00",result.Shipment.Value.GetProperty("shippedAt").GetString());
        }
        if(name=="leading-zero-long-id")Assert.Equal(new string('0',70),result.Shipment!.Value.GetProperty("shipmentReference").GetString());
        if(name=="bound-location-provenance")Assert.Contains(result.Decisions,d=>d.Field=="locationId"&&d.Origin=="approved_binding"&&d.State=="validated");
    }
    [Fact] public void A_saved_mapping_cannot_use_the_active_label_as_validation()
    {
        var valid=Json.Element(new{mapping=new{shipmentReference="Shipment reference",itemTitle="Description",quantity="Quantity"}});
        var wrong=Json.Element(new{mapping=new{shipmentReference="Description",itemTitle="Shipment reference",quantity="Quantity"}});
        Assert.True(CsvSemantics.ConfigurationSupported(valid));Assert.False(CsvSemantics.ConfigurationSupported(wrong));
        Assert.False(CsvSemantics.ConfigurationSupported(Json.Element(new{mapping=new{shipmentReference="Order ID",itemTitle="Description",quantity="Quantity"}})));
    }
    [Fact] public void A_pinned_receipt_must_attest_the_same_original_policy_and_field_meanings()
    {
        var bytes=Encoding.UTF8.GetBytes("Shipment ID,Description,Quantity,Shipment date\n0007,Pipe,2,2026-11-13T09:00:00Z\n");
        var local=CsvSemantics.Analyze(bytes,interpret:true);
        var config=Json.Element(new{mapping=local.Mapping,timeZone="source-offset",sourceContract=new{confirmedFields=Array.Empty<string>(),interpretationVersion=CsvSemantics.InterpretationVersion,basedOnConfigRevision=0}});
        var digest=Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes));
        JsonElement Receipt(string policy,string field) => Json.Element(new{id="import",rows=new[]{new{rowNumber=2,normalized=local.Rows[0]}},
            interpretation=new{schema="packproof.automation-decision/v1",version=CsvSemantics.InterpretationVersion,kind="mapping",rulesVersion=CsvSemantics.Version,profileVersion=CsvSemantics.Profile,
                sourceId="installation",decisionId="import",policyRevision=policy,originalSha256=digest,configurationRevision=1,outcome="automatic",grain="shipment",rowCount=1,
                fields=local.Decisions.Select(d=>new{d.Field,sourceColumnId=d.Field=="shipmentReference"?field:d.SourceColumnId,d.State,d.Origin,d.ValidRowCount,d.InvalidRowCount,d.ReasonCodes})}});
        AgentRuntime.CheckPreviewParity(bytes,Receipt("approved","Shipment ID"),config,"approved","installation");
        foreach(var receipt in new[]{Receipt("former","Shipment ID"),Receipt("approved","Order number"),Json.Element(new{id="import"})})
            Assert.Equal("INTERPRETATION_MISMATCH",Assert.Throws<ConnectException>(()=>AgentRuntime.CheckPreviewParity(bytes,receipt,config,"approved","installation")).Code);
    }
    [Fact] public void Server_disagreement_is_never_promoted_to_a_commit()
    {
        var bytes=Encoding.UTF8.GetBytes("Shipment reference,Description,Quantity,Shipment date\nSHIP-1,Elbow,12,2026-11-13T09:00:00Z\n");
        var config=Json.Element(new{mapping=new{shipmentReference="Shipment reference",itemTitle="Description",quantity="Quantity",shippedAt="Shipment date"},timeZone="source-offset",sourceContract=new{confirmedFields=Array.Empty<string>()}});
        var wrong=Json.Element(new{rows=new[]{new{rowNumber=2,normalized=new{shipmentReference="SHIP-1",itemTitle="Elbow",quantity=1,shippedAt="2026-11-13T09:00:00Z",shipmentDate="2026-11-13"}}}});
        Assert.Equal("INTERPRETATION_MISMATCH",Assert.Throws<ConnectException>(()=>AgentRuntime.CheckPreviewParity(bytes,wrong,config)).Code);
    }
}

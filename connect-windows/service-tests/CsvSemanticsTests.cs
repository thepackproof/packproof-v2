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
        var bytes=Encoding.UTF8.GetBytes(fixture.GetProperty("csv").GetString()!);
        if(fixture.TryGetProperty("parseError",out var error)&&error.GetBoolean()){Assert.Throws<ConnectException>(()=>CsvSemantics.Analyze(bytes));return;}
        var map=fixture.TryGetProperty("mapping",out var m)?JsonSerializer.Deserialize<Dictionary<string,string>>(m,Json.Options):null;
        var confirmed=fixture.TryGetProperty("confirmedFields",out var f)?f.EnumerateArray().Select(x=>x.GetString()!).ToArray():[];
        var location=fixture.TryGetProperty("locationId",out var l)?l.GetString():null;
        var result=CsvSemantics.Analyze(bytes,map,confirmed,location);
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
    [Fact] public void Server_disagreement_is_never_promoted_to_a_commit()
    {
        var bytes=Encoding.UTF8.GetBytes("Shipment reference,Description,Quantity,Shipment date\nSHIP-1,Elbow,12,2026-11-13T09:00:00Z\n");
        var config=Json.Element(new{mapping=new{shipmentReference="Shipment reference",itemTitle="Description",quantity="Quantity",shippedAt="Shipment date"},timeZone="source-offset",sourceContract=new{confirmedFields=Array.Empty<string>()}});
        var wrong=Json.Element(new{rows=new[]{new{rowNumber=2,normalized=new{shipmentReference="SHIP-1",itemTitle="Elbow",quantity=1,shippedAt="2026-11-13T09:00:00Z",shipmentDate="2026-11-13"}}}});
        Assert.Equal("INTERPRETATION_MISMATCH",Assert.Throws<ConnectException>(()=>AgentRuntime.CheckPreviewParity(bytes,wrong,config)).Code);
    }
}

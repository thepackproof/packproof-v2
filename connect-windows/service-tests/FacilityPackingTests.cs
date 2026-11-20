using System.Text;
using System.Text.Json;
using PackProof.Connect;
using Xunit;

public class FacilityPackingTests
{
    [Fact]
    public void LocalCartonAliasKeepsRawWeightAndRequiresTestedLayoutAndUnit()
    {
        const string headers="SalesOrderID,Tote Tag,PackedAt,RowVersion,Measured,Scale Mark";
        SourceReadResult Read(string unit,string columns=headers)=>SourceReaders.Read("packing.csv",Encoding.UTF8.GetBytes(
            columns+"\nSO1,CTN-02,2026-11-19T14:19:00-05:00,1,2.50,"+unit+"\n"));
        var sample=Read("WP");
        var rule=new FacilityPacking("pack","erp",SourceReaders.PackingSchema(sample),"Tote Tag","Measured","Scale Mark","WP","lb");
        var reader=new FacilityPackingReader(rule,"company-a",1);
        var record=Assert.Single(SourceReaders.NormalizeFacilityPacking(sample,reader));
        Assert.Equal("CTN-02",record.GetProperty("entity").GetProperty("id").GetString());
        Assert.Equal("company-a",record.GetProperty("references")[0].GetProperty("namespace").GetString());
        var fields=record.GetProperty("fields");
        Assert.Equal("WP",fields.GetProperty("Scale Mark").GetString());
        Assert.Equal("lb",fields.GetProperty("qualifiedCartonWeightUnit").GetString());
        Assert.True(record.GetProperty("fieldLineage").TryGetProperty("qualifiedCartonWeight",out _));
        var uncertain=Assert.Single(SourceReaders.NormalizeFacilityPacking(Read("unknown"),reader));
        Assert.False(uncertain.GetProperty("fields").TryGetProperty("qualifiedCartonWeight",out _));
        Assert.Equal("unknown",uncertain.GetProperty("fields").GetProperty("Scale Mark").GetString());
        Assert.Empty(SourceReaders.NormalizeFacilityPacking(Read("WP",headers.Replace("Tote Tag","New Tote")),reader));
    }

    [Fact]
    public void RecordOnlyReassignmentIsIsolatedAndBindsTheExactOriginalGeneration()
    {
        object Ref(string space,string type,string id)=>new {@namespace=space,type,id};
        DraftPreviewEvent Event(string source,string kind,string eventId,object subject,params object[] refs)=>
            new(source,source,source+".csv",Json.Element(new {kind,eventId,version="1",entity=subject,references=refs,fields=new{},lines=Array.Empty<object>()}));
        var one=Ref("erp","order","A"); var two=Ref("erp","order","B");
        var receipt=Event("pod","delivery","r1",Ref("pod","delivery","receipt"),one) with {Generation=2,OriginalSha256="original"};
        DraftPreviewEvent[] records=[Event("erp","order","a",one),Event("erp","order","b",two),receipt];
        JsonElement[] Orders(DraftPreviewEvent[] events,FacilityRecordEdit[]? edits=null)=>Json.Element(WorkspacePreview.Build(events,3,0,false,edits))
            .GetProperty("examples").EnumerateArray().ToArray();
        var original=Orders(records);
        var evidence=original[0].GetProperty("events").EnumerateArray().Single(x=>x.GetProperty("kind").GetString()=="delivery");
        var edit=new FacilityRecordEdit("pod",evidence.GetProperty("recordHash").GetString()!,"erp","A","erp","B");
        Assert.Single(Orders(records,[edit])[0].GetProperty("events").EnumerateArray());
        Assert.Equal(2,Orders(records,[edit])[1].GetProperty("events").GetArrayLength());
        Assert.Equal(2,Orders(records)[0].GetProperty("events").GetArrayLength());
        records[2]=receipt with {Generation=3};
        Assert.Equal(2,Orders(records,[edit])[0].GetProperty("events").GetArrayLength());
    }
}

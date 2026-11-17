using System.Text.Json;
using PackProof.Connect;
using Xunit;

public class WorkspacePreviewTests
{
    static object Ref(string ns, string type, string id) => new {@namespace=ns,type,id};
    static DraftPreviewEvent Observation(string source,string kind,string eventId,object entity,
        object[]? references=null,object[]? lines=null) =>
        new(source,source,source+".json",Json.Element(new {
            eventId,version="1", kind,entity,references=references??[], fields=new { },lines=lines??[]
        }));

    [Fact]
    public void PreviewUsesExplicitReferencesBeforeActivationAndKeepsOwnersSeparate()
    {
        var sales=Ref("ERP-a","order","SO10482");
        var other=Ref("ERP-b","order","SO10482");
        var parcel=Ref("packing","package","PKG92");
        var tracking=Ref("carrier-account-period","tracking","001234");
        var inputs = new[] {
            Observation("Delivery","delivery","d1",Ref("carrier","event","drop"),[tracking]),
            Observation("Labels","label","l1",parcel,[tracking]),
            Observation("Warehouse","packing","w1",parcel,[sales]),
            Observation("Sales A","order","o1",sales,lines:[new {lineId="20",sku="A100",orderedQuantity="2",unit="EA"}]),
            Observation("Sales B","order","o1",other),
            Observation("Photos","evidence","p1",Ref("photos","photo","unmatched"))
        };
        var result=Json.Element(WorkspacePreview.Build(inputs,6,0,false));
        var examples=result.GetProperty("examples").EnumerateArray().ToArray();
        Assert.Equal(2,examples.Length);
        var a=examples.Single(e=>e.GetProperty("source").GetString()=="Sales A");
        var b=examples.Single(e=>e.GetProperty("source").GetString()=="Sales B");
        Assert.Equal(4,a.GetProperty("events").GetArrayLength());
        Assert.Equal(1,b.GetProperty("events").GetArrayLength());
        Assert.Equal("PKG92",a.GetProperty("packages")[0].GetString());
        Assert.Equal("2",a.GetProperty("lines")[0].GetProperty("quantity").GetString());
        Assert.Equal(1,result.GetProperty("unresolved").GetInt32());
    }
}


using System.Text;
using System.Text.Json;
using PackProof.Connect;
using Xunit;

public sealed class WorkflowProfileTests
{
    private static readonly Dictionary<string,string> Sources=new(){["order"]="sales",["picking"]="warehouse",["packing"]="packing",["shipping"]="ship"};
    private static SourceReadResult Parse(string csv)=>SourceReaders.Read("export.csv",Encoding.UTF8.GetBytes(csv));
    private static JsonElement Interpret(string csv,string role,string id)
    {
        var parsed=Parse(csv);var map=Assert.IsType<WorkflowColumnMap>(SourceReaders.ProposeWorkflowMap(parsed,role,id,Sources));
        var records=SourceReaders.NormalizeWorkflow(parsed,id,map);
        Assert.Equal(1,records.GetArrayLength());return records[0];
    }
    [Fact]
    public void Ordinary_reports_join_only_their_confirmed_source_instances()
    {
        var picked=Interpret("PickTicket,SalesOrderNumber,OrderLineID,ItemCode,QtyPicked,UOM,LastUpdated\nW-77,00010482,20,A100,2.5,EA,2026-11-17T11:29:00Z","picking","warehouse");
        Assert.Equal("warehouse",picked.GetProperty("entity").GetProperty("namespace").GetString());
        Assert.Equal("sales",picked.GetProperty("references")[0].GetProperty("namespace").GetString());
        Assert.Equal("2.5",picked.GetProperty("lines")[0].GetProperty("pickedQuantity").GetString());
        var packing=Interpret("CartonNumber,PickTicket,SalesOrderNumber,OrderLineID,PackedUnits,UOM,RecordVersion\nPKG92,W-77,00010482,20,2.5,EA,1","packing","packing");
        Assert.Equal("PKG92",packing.GetProperty("entity").GetProperty("id").GetString());
        Assert.True(packing.GetProperty("references").EnumerateArray().Any(r=>r.GetProperty("namespace").GetString()=="warehouse"&&r.GetProperty("id").GetString()=="W-77"));
        var shipping=Interpret("ShipmentNumber,CartonID,CarrierCode,CarrierAccount,ShipDate,TrackingNumber,LabelCreatedAt,Revision\nS-1,PKG92,TEST,ACC,2026-11-17,TRK-01,2026-11-17T12:00:00Z,1","shipping","ship");
        Assert.Equal("label",shipping.GetProperty("kind").GetString());var tracking=shipping.GetProperty("entity");
        var delivery=Interpret("DeliveryEventID,CarrierCode,CarrierAccount,ShipDate,TrackingNumber,DeliveredAt\nD-01,TEST,ACC,2026-11-17,TRK-01,2026-11-18T12:00:00Z","delivery","delivery");
        Assert.Equal(tracking.GetRawText(),delivery.GetProperty("references")[0].GetRawText());
        Assert.Equal("delivery",delivery.GetProperty("kind").GetString());
        var handoff=Interpret("DispatchEventID,ShipmentNumber,DepartedAt\nH-01,S-1,2026-11-17T17:40:00Z","handoff","dock");
        Assert.Equal("handoff",handoff.GetProperty("kind").GetString());
        var returned=Interpret("RMANumber,SalesOrderNumber,OrderLineID,QtyReturned,Unit,Version\nR-1,00010482,20,1,EA,2","returns","returns");
        Assert.Equal("1",returned.GetProperty("lines")[0].GetProperty("returnedQuantity").GetString());
    }
    [Fact]
    public void Delivery_schedule_and_label_issuance_never_imply_delivery_or_handoff()
    {
        var delivery=Interpret("DeliveryEventID,ShipmentNumber,DeliveryStatus,Version\nD-2,S-1,In Transit,3","delivery","delivery");
        Assert.Equal("evidence",delivery.GetProperty("kind").GetString());
        var shipping=Interpret("ShipmentNumber,CartonID,TrackingNumber,Revision\nS-1,P-1,TRK-1,1","shipping","ship");
        Assert.Equal("evidence",shipping.GetProperty("kind").GetString());
        Assert.False(shipping.GetProperty("references").EnumerateArray().Any(r=>r.GetProperty("type").GetString()=="tracking"));
    }
    [Fact]
    public void Tracking_reuse_and_schema_drift_cannot_rebind_an_order()
    {
        var csv="DeliveryEventID,CarrierCode,CarrierAccount,ShipDate,TrackingNumber,DeliveredAt\nD-1,TEST,A1,2026-09-01,T-1,2026-09-04T23:00:00Z";
        var first=Interpret(csv,"delivery","carrier");var newer=Interpret(csv.Replace("2026-09","2026-10"),"delivery","carrier");
        Assert.NotEqual(first.GetProperty("references")[0].GetProperty("namespace").GetString(),newer.GetProperty("references")[0].GetProperty("namespace").GetString());
        var parsed=Parse(csv);var map=SourceReaders.ProposeWorkflowMap(parsed,"delivery","carrier",Sources)!;
        Assert.Equal(0,SourceReaders.NormalizeWorkflow(Parse(csv.Replace("CarrierAccount","UnknownAccount")),"carrier",map).GetArrayLength());
        Assert.Null(SourceReaders.ProposeWorkflowMap(parsed,"delivery","carrier",new Dictionary<string,string>()));
    }
}

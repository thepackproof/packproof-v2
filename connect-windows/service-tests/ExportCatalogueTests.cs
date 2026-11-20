using System.Text;
using System.Text.Json;
using PackProof.Connect;
using Xunit;

public class ExportCatalogueTests
{
    private const string Dynamics = "SalesOrderNumber,InventoryLotId,ItemNumber,OrderedSalesQuantity,SalesUnitSymbol";
    private const string Shopify = "Name,Id,Created at,Lineitem quantity,Lineitem name,Lineitem SKU";
    private static SourceReadResult Csv(string text) => SourceReaders.Read("orders.csv", Encoding.UTF8.GetBytes(text));

    [Fact]
    public void Standard_vendor_headers_identify_exports_without_inventing_line_ids_or_versions()
    {
        var shop = Csv(Shopify + "\n#101,00073,2026-01-01,3,Gasket,GSK\n#101,,,4,Gasket,GSK");
        Assert.Equal("shopify-orders/v1", SourceReaders.RecognizeExport(shop)?.Id);
        Assert.Null(SourceReaders.ProposeOrderMap(shop));
        Assert.Null(ExportCatalogue.Match(["Name", "Id", "Created at"]));
        Assert.Null(ExportCatalogue.Match((Shopify + ",name").Split(',')));
        Assert.Null(ExportCatalogue.Match((Shopify + "," + Dynamics).Split(',')));
        var mixedHeaders = Shopify + "," + Dynamics + ",LineId,Version,Quantity,UOM";
        var mixed = Csv(mixedHeaders + "\n" + string.Join(",", mixedHeaders.Split(',').Select(_ => "1")));
        Assert.Null(SourceReaders.ProposeOrderMap(mixed));
        var shipping = Csv("Tracking Number,Manifest Number,Order No,Batch No,Shape,Service,Weight,Postage\n001,T1,002,B1,Parcel,Ground,4,2");
        Assert.Equal("shipping", SourceReaders.RecognizeExport(shipping)?.Role);
        Assert.Null(SourceReaders.ProposeWorkflowMap(shipping, "shipping", "carrier", new Dictionary<string, string> { ["order"] = "sales" }));
        var stock = Csv(Dynamics + "\nSO-001,0002,A5,3,EA");
        Assert.Equal("dynamics-365-sales-order-lines-v2/v1", SourceReaders.RecognizeExport(stock)?.Id);
        Assert.Null(SourceReaders.ProposeOrderMap(stock));
    }

    [Fact]
    public void Profile_preserves_identity_quantity_unit_and_lineage_and_pins_company()
    {
        string headers = Dynamics + ",dataAreaId,SourceRevision\n";
        var file = Csv(headers + "000017,007,A5,2.250,EA,USMF,9");
        var map = Assert.IsType<OrderColumnMap>(SourceReaders.ProposeOrderMap(file));
        var record = Assert.Single(SourceReaders.NormalizeOrderLines(file, "station-1", map).EnumerateArray());
        Assert.Equal("000017", record.GetProperty("entity").GetProperty("id").GetString());
        Assert.Equal("007", record.GetProperty("lines")[0].GetProperty("lineId").GetString());
        Assert.Equal("2.250", record.GetProperty("lines")[0].GetProperty("orderedQuantity").GetString());
        Assert.Equal("EA", record.GetProperty("lines")[0].GetProperty("unit").GetString());
        Assert.Equal("line 2/column 4", record.GetProperty("fieldLineage").GetProperty("orderedQuantity").GetString());

        var updated = Csv(headers + "000017,007,A5,1,EA,USMF,10");
        var later = Assert.Single(SourceReaders.NormalizeOrderLines(updated, "station-1", map).EnumerateArray());
        Assert.Equal(record.GetProperty("eventId").GetString(), later.GetProperty("eventId").GetString());
        Assert.Equal("10", later.GetProperty("version").GetString());
        var missing = Csv(headers + "000017,007,A5,,EA,USMF,11");
        Assert.Empty(SourceReaders.NormalizeOrderLines(missing, "station-1", map).EnumerateArray());
        var other = Csv(headers + "000017,007,A5,2.250,EA,DEMF,9");
        Assert.Empty(SourceReaders.NormalizeOrderLines(other, "station-1", map).EnumerateArray());
        var otherMap = Assert.IsType<OrderColumnMap>(SourceReaders.ProposeOrderMap(other));
        var otherRecord = Assert.Single(SourceReaders.NormalizeOrderLines(other, "station-1", otherMap).EnumerateArray());
        Assert.NotEqual(record.GetProperty("entity").GetProperty("namespace").GetString(),
            otherRecord.GetProperty("entity").GetProperty("namespace").GetString());
        Assert.NotEqual(SourceReaders.OrderProfileVersion(map), SourceReaders.OrderProfileVersion(otherMap));
        Assert.Null(SourceReaders.ProposeOrderMap(Csv(headers + "000017,7,A5,1,EA,USMF,1\n000017,8,A6,1,EA,DEMF,1")));
    }

    [Fact]
    public void Extra_canonical_columns_cannot_bypass_missing_approval_or_a_changed_company()
    {
        const string headers = Dynamics + ",DataAreaId,SourceRevision,entityNamespace,entityType,entityId,eventId,version,kind";
        var file = Csv(headers + "\nSO1,1,SKU,2,EA,USMF,9,other,order,SO2,e9,1,order");
        var source = new WorkspaceSource { Id = "sales", Folder = "sales", Roles = ["order"] };
        Assert.Empty(AgentRuntime.WorkspaceRecords(source, file));
        source.ConfirmedMap = SourceReaders.ProposeOrderMap(file);
        Assert.Equal("SO1", Assert.Single(AgentRuntime.WorkspaceRecords(source, file)).GetProperty("entity").GetProperty("id").GetString());
        var foreign = Csv(headers + "\nSO1,1,SKU,2,EA,DEMF,9,other,order,SO2,e9,1,order");
        Assert.Empty(AgentRuntime.WorkspaceRecords(source, foreign));
        var drift = Csv("entityNamespace,entityType,entityId,eventId,version,kind\nother,order,SO2,e9,1,order");
        Assert.Empty(AgentRuntime.WorkspaceRecords(source, drift));
    }

    [Theory]
    [InlineData("ReportAsOf", "2026-01-10T13:45:00-05:00", true)]
    [InlineData("ReportAsOf", "2026-01-10", false)]
    [InlineData("ReportAsOf", "7", false)]
    [InlineData("SourceRevision", "2026-01-10T13:45:00Z", false)]
    public void Revision_is_only_taken_from_its_declared_source(string column, string value, bool expected)
    {
        var file = Csv(Dynamics + ",DataAreaId," + column + "\nSO1,2,A5,1,EA,USMF," + value);
        var map = Assert.IsType<OrderColumnMap>(SourceReaders.ProposeOrderMap(file));
        Assert.Equal(expected, SourceReaders.NormalizeOrderLines(file, "station-1", map).GetArrayLength() == 1);
    }

    [Fact]
    public void Existing_column_maps_keep_their_approval_fingerprint()
    {
        var file = Csv("OrderNumber,LineId,Version,SKU,Quantity,UOM\nA,1,9,B,1,EA");
        var map = Assert.IsType<OrderColumnMap>(SourceReaders.ProposeOrderMap(file));
        var oldShape = new {map.Order, map.Line, map.Version, map.Quantity, map.Unit, map.Sku};
        var oldHash = System.Security.Cryptography.SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(oldShape));
        Assert.Equal("packproof.order-columns/v1/" + Convert.ToHexStringLower(oldHash), SourceReaders.OrderProfileVersion(map));
    }
}

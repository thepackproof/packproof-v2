using System.Text;
using PackProof.Connect;
using Xunit;

public sealed class WorkspaceDiscoveryTests
{
    private const string Order="OrderNumber,OrderLineID,SourceRevision,Quantity,UOM";
    private const string Shopify="Name,Id,Created at,Lineitem quantity,Lineitem name,Lineitem SKU";
    private static MemoryStream Bytes(string value) => new(Encoding.UTF8.GetBytes(value));

    [Fact]
    public void Reads_one_bounded_header_without_parsing_sample_data()
    {
        using var stream = Bytes("\uFEFF\"Name\",\"Id\",\"field,with \"\"quotes\"\"\"\r\nprivate data");
        Assert.Equal(new[]{"Name","Id","field,with \"quotes\""},WorkspaceDiscovery.Header(stream,".csv"));
        Assert.Equal((int)'\n',stream.ReadByte());
        Assert.Empty(WorkspaceDiscovery.Header(Bytes("a,b,B\nprivate"),".csv"));
        Assert.Empty(WorkspaceDiscovery.Header(Bytes("a,\"unclosed\nb,private"),".csv"));
        Assert.Empty(WorkspaceDiscovery.Header(Bytes("a,b;c\n"),".csv"));
        Assert.Empty(WorkspaceDiscovery.Header(Bytes("a,"+new string('x',9000)),".csv"));
        Assert.Equal(new[]{"Order","Quantity"},WorkspaceDiscovery.Header(Bytes("Order\tQuantity\n"),".tsv"));
    }

    [Fact]
    public void Classifies_by_one_role_and_exact_header_signatures()
    {
        Assert.Equal("Shopify orders",WorkspaceDiscovery.Classify("order",Shopify.Split(','))?.Label);
        Assert.Null(WorkspaceDiscovery.Classify("shipping",Shopify.Split(',')));
        Assert.Equal("Order records",WorkspaceDiscovery.Classify("order",Order.Split(','))?.Label);
        Assert.Null(WorkspaceDiscovery.Classify("order",["OrderNumber","Quantity"]));
        string[] packing=["OrderNumber","PackageId","PackedAt","SourceRevision"];
        Assert.Equal("Packing records",WorkspaceDiscovery.Classify("packing",packing)?.Label);
        Assert.Null(WorkspaceDiscovery.Classify("shipping",packing));
        Assert.Equal("Packing records",WorkspaceDiscovery.Classify("packing",
            ["CartonNumber","OrderID","LineID","PackedUnits","UOM","RecordVersion"])?.Label);
        Assert.Null(WorkspaceDiscovery.Classify("packing",[..packing,"PickTicket","PickedAt"]));
    }

    [WindowsFact]
    public void Windows_Enterprise_Shipper_default_requires_the_matching_header_and_dedicated_reports()
    {
        var folder = Directory.CreateTempSubdirectory("pp-enterprise-reports-");
        try
        {
            WorkspaceDiscovery.Suggestion[] Scan(string role) => WorkspaceDiscovery.Scan(role,[],null,[],folder.FullName);
            var report = Path.Combine(folder.FullName,"DailyShipping-20261101.csv");
            File.WriteAllText(report,"OrderNumber,ShipmentId,LabelCreatedAt,Revision\n");
            Assert.Empty(Scan("shipping"));
            File.WriteAllText(report,"Tracking Number,Manifest Number,Order No,Batch No,Shape,Service,Weight,Postage\n");
            File.WriteAllText(Path.Combine(folder.FullName,"DailyShipping-20261101.pdf"),"companion PDF");
            Assert.Single(Scan("shipping"));
            Assert.Empty(Scan("order"));
            File.WriteAllText(Path.Combine(folder.FullName,"configuration.ini"),"application data");
            Assert.Empty(Scan("shipping"));
        }
        finally { folder.Delete(true); }
    }

    [WindowsFact]
    public void Windows_discovery_ranks_dedicated_sources_and_excludes_output_and_broad_roots()
    {
        var root = Directory.CreateTempSubdirectory("pp-discovery-");
        try
        {
            var docs = root.CreateSubdirectory("Documents");
            var downloads = root.CreateSubdirectory("Downloads");
            var shopify = docs.CreateSubdirectory("Shopify").CreateSubdirectory("Exports");
            var orders = downloads.CreateSubdirectory("OrderExports");
            var output = docs.CreateSubdirectory("Order reports");
            var formerOutput = downloads.CreateSubdirectory("Exports");
            var unrelated = docs.CreateSubdirectory("Family");
            var prepared = root.CreateSubdirectory("Prepared");
            var linked = Path.Combine(docs.FullName,"Shipping reports");
            Directory.CreateSymbolicLink(linked,unrelated.FullName);
            var linkedFile = docs.CreateSubdirectory("Other reports");
            File.CreateSymbolicLink(Path.Combine(linkedFile.FullName,"order.csv"),Path.Combine(unrelated.FullName,"orders.csv"));
            foreach (var folder in new[]{docs,orders,output,formerOutput,unrelated,prepared})
                File.WriteAllText(Path.Combine(folder.FullName,"orders.csv"),Order+"\n");
            for (int i=0;i<8;i++) File.WriteAllText(Path.Combine(shopify.FullName,$"a{i}.csv"),"Unrelated,Column\n");
            File.WriteAllText(Path.Combine(shopify.FullName,"orders.csv"),Shopify+"\n");
            File.WriteAllText(Path.Combine(formerOutput.FullName,".packproof-writer.id"),"output");
            var choices = WorkspaceDiscovery.Scan("order",[docs.FullName,downloads.FullName],prepared.FullName,[output.FullName]);
            Assert.Equal(3,choices.Length);
            Assert.Equal("Shopify orders",choices[0].Label);
            Assert.Equal(shopify.FullName,choices[0].Folder);
            Assert.Equal("orders.csv",choices[0].SampleFile);
            Assert.Contains(choices,c=>c.Folder==orders.FullName);
            Assert.Contains(choices,c=>c.Folder==prepared.FullName);
        }
        finally { root.Delete(true); }
    }
    [Fact]
    public void Structured_sample_is_bounded_and_requires_canonical_identity_for_role()
    {
        var order = """
            {"kind":"order","eventId":"order-1","version":1,"occurredAt":"2026-11-17T12:00:00Z",
             "entityNamespace":"ERP_A","entityId":"SO10482",
             "lines":[{"lineId":"20","orderedQuantity":2,"unit":"each"}]}
            """;
        Assert.Equal("Order records",WorkspaceDiscovery.StructuredLayout("order",Bytes(order),".json")?.Label);
        Assert.Null(WorkspaceDiscovery.StructuredLayout("shipping",Bytes(order),".json"));
        Assert.Null(WorkspaceDiscovery.StructuredLayout("order",Bytes("""{"kind":"order","secret":"example"}"""),".json"));
        Assert.Null(WorkspaceDiscovery.StructuredLayout("order",Bytes(new string('x',33000)),".json"));
        var label = """
            [{"kind":"label","eventId":"label-1","version":1,"occurredAt":"2026-11-17T12:04:00Z",
              "entityNamespace":"TRACKING","entityId":"1Z123"}]
            """;
        Assert.Equal("Shipping records",WorkspaceDiscovery.StructuredLayout("shipping",Bytes(label),".json")?.Label);
        Assert.Null(WorkspaceDiscovery.StructuredLayout("order",Bytes(label),".json"));
        // JSONL is one complete JSON object per line; indented multiline JSON
        // is valid .json but must not be classified as .jsonl during discovery.
        var pick = """{"kind":"picking","eventId":"pick-1","version":1,"occurredAt":"2026-11-17T12:01:00Z","entityNamespace":"WMS","entityId":"WO01"}""";
        Assert.Equal("Picking records",WorkspaceDiscovery.StructuredLayout("picking",Bytes(pick+"\n"),".jsonl")?.Label);
        Assert.Equal("Picking records",WorkspaceDiscovery.StructuredLayout("picking",Bytes(pick),".jsonl")?.Label);
        Assert.Null(WorkspaceDiscovery.StructuredLayout("picking",Bytes(
            pick.Replace(",\"entityNamespace\"", ",\n\"entityNamespace\"")),".jsonl"));
    }

    [WindowsFact]
    public void Finds_matching_json_exports_in_dedicated_approved_discovery_roots()
    {
        var root = Directory.CreateTempSubdirectory("pp-discovery-json-");
        try
        {
            var docs = root.CreateSubdirectory("Documents");
            var exports = docs.CreateSubdirectory("PackProof Exports");
            var orders = exports.CreateSubdirectory("Orders");
            var shipping = exports.CreateSubdirectory("Shipping");
            File.WriteAllText(Path.Combine(orders.FullName,"not-an-order.json"),"""{"kind":"order","private":"unrelated"}""");
            File.WriteAllText(Path.Combine(orders.FullName,"orders.json"),"""
                {"kind":"order","eventId":"order-10482","version":1,"occurredAt":"2026-11-17T12:00:00Z",
                 "entityNamespace":"ERP_A","entityId":"SO10482",
                 "lines":[{"lineId":"20","orderedQuantity":2,"unit":"each"}]}
                """);
            File.WriteAllText(Path.Combine(shipping.FullName,"labels.json"),"""
                [{"kind":"label","eventId":"label-1","version":1,"occurredAt":"2026-11-17T12:04:00Z",
                  "entityNamespace":"CARRIER","entityId":"TRACK771","packageId":"PKG92"}]
                """);
            var orderResults = WorkspaceDiscovery.Scan("order",[docs.FullName],null,[]);
            Assert.Contains(orderResults,s=>s.Folder==orders.FullName && s.SampleFile=="orders.json");
            Assert.DoesNotContain(orderResults,s=>s.Folder==shipping.FullName);
            var shippingResults = WorkspaceDiscovery.Scan("shipping",[docs.FullName],null,[]);
            Assert.Contains(shippingResults,s=>s.Folder==shipping.FullName && s.SampleFile=="labels.json");
            Assert.DoesNotContain(shippingResults,s=>s.Folder==orders.FullName);
        }
        finally { root.Delete(true); }
    }

}

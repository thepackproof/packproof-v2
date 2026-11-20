using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using PackProof.Connect;
using Xunit;

public sealed class OdooOrderJourneyTests
{
    private const string Header = "id,order_id/id,company_id/id,product_uom_qty,product_uom/name,product_id/default_code,state,ReportAsOf,order_id/name";
    private const string OrderId = "__export__.sale_order_71_a04";
    private const string LineId = "__export__.sale_order_line_204_a33";
    private const string DisplayName = "S00071";
    private const string First = "2026-11-18T08:00:00-05:00";
    private const string Second = "2026-11-18T13:01:00Z";

    private static string Row(string company, string quantity, string time, string state = "sale") =>
        $"{LineId},{OrderId},{company},{quantity},Units,SKU-050,{state},{time},{DisplayName}";

    private static SourceReadResult Read(string csv) => SourceReaders.Read("sales.csv", Encoding.UTF8.GetBytes(csv));

    [Fact]
    public void Recognized_export_requires_confirmed_orders_and_a_source_qualified_revision()
    {
        var csv = Read(Header + "\n" + Row("base.main_company", "2.500", First));
        var map = Assert.IsType<OrderColumnMap>(SourceReaders.ProposeOrderMap(csv));
        Assert.Equal("odoo-sales-order-lines-v18/v1", map.Catalogue?.ProfileId);
        var record = Assert.Single(SourceReaders.NormalizeOrderLines(csv, "odoo-production", map).EnumerateArray());
        Assert.Equal(OrderId, record.GetProperty("entity").GetProperty("id").GetString());
        Assert.Equal(LineId, record.GetProperty("lines")[0].GetProperty("lineId").GetString());
        Assert.Equal("2.500", record.GetProperty("lines")[0].GetProperty("orderedQuantity").GetString());
        Assert.Equal(First, record.GetProperty("fields").GetProperty("ReportAsOf").GetString());
        Assert.False(record.TryGetProperty("sourceModifiedAt", out _));
        Assert.Equal(OrderId, record.GetProperty("fields").GetProperty("orderReference").GetString());
        Assert.Equal(DisplayName, record.GetProperty("fields").GetProperty("sourceOrderName").GetString());
        Assert.Equal("line 2/column 9", record.GetProperty("fieldLineage").GetProperty("sourceOrderName").GetString());
        Assert.Equal("line 2/column 2", record.GetProperty("fieldLineage").GetProperty("entityId").GetString());

        var blankName = Read(Header + "\n" + Row("base.main_company", "2.500", First).Replace(DisplayName, ""));
        var withoutName = Assert.Single(SourceReaders.NormalizeOrderLines(blankName, "odoo-production", map).EnumerateArray());
        Assert.False(withoutName.GetProperty("fields").TryGetProperty("sourceOrderName", out _));
        Assert.Equal(OrderId, withoutName.GetProperty("fields").GetProperty("orderReference").GetString());
        Assert.Equal("line 2/column 2", withoutName.GetProperty("fieldLineage").GetProperty("orderReference").GetString());

        var noDisplayHeading = Read(Header.Replace(",order_id/name", "") + "\n" +
            Row("base.main_company", "2.500", First).Replace("," + DisplayName, ""));
        var mapWithoutName = Assert.IsType<OrderColumnMap>(SourceReaders.ProposeOrderMap(noDisplayHeading));
        Assert.Null(mapWithoutName.DisplayOrderReference);
        Assert.Single(SourceReaders.NormalizeOrderLines(noDisplayHeading, "odoo-production", mapWithoutName).EnumerateArray());

        foreach (var invalid in new[] {
            Header + "\n" + Row("base.main_company", "2", First) + "\n" + Row("base.main_company", "3", Second, "cancel"),
            Header + "\n" + Row("base.main_company", "2", "2026-11-18 08:00:00"),
            Header.Replace("order_id/id", "order_id") + "\n" + Row("base.main_company", "2", First),
            Header.Replace("ReportAsOf", "write_date") + "\n" + Row("base.main_company", "2", First)
        })
        {
            Assert.Empty(SourceReaders.NormalizeOrderLines(Read(invalid), "odoo-production", map).EnumerateArray());
        }
    }

    [Fact]
    public void Parsed_orders_link_to_packing_only_with_the_confirmed_company_namespace()
    {
        JsonElement Order(string source, string company, string quantity, string asOf)
        {
            var file = Read(Header + "\n" + Row(company, quantity, asOf));
            var map = Assert.IsType<OrderColumnMap>(SourceReaders.ProposeOrderMap(file));
            return Assert.Single(SourceReaders.NormalizeOrderLines(file, source, map).EnumerateArray());
        }
        var first = Order("west", "company.west", "2", First);
        var corrected = Order("west", "company.west", "3", Second);
        var east = Order("east", "company.east", "8", First);
        var file = Read("CartonNumber,OrderID,LineID,PackedUnits,UOM,RecordVersion\n" +
            $"CT-07,{OrderId},{LineId},2,Units,1");
        var producers = new Dictionary<string,string> { ["order"] = first.GetProperty("entity").GetProperty("namespace").GetString()! };
        var packing = Assert.IsType<WorkflowColumnMap>(SourceReaders.ProposeWorkflowMap(file, "packing", "pack-west", producers));
        var carton = Assert.Single(SourceReaders.NormalizeWorkflow(file, "pack-west", packing).EnumerateArray());
        DraftPreviewEvent[] samples = [
            new("pack-west", "Packing-West", "cartons.csv", carton),
            new("west", "Sales-West", "correction.csv", corrected),
            new("east", "Sales-East", "order.csv", east),
            new("west", "Sales-West", "old.csv", first),
            new("west", "Sales-West", "replayed.csv", corrected)
        ];
        CheckDraft(Json.Element(WorkspacePreview.Build(samples, samples.Length, 0, false)));

        var byNameOnly = Read("CartonNumber,OrderID,LineID,PackedUnits,UOM,RecordVersion\n" +
            $"CT-08,{DisplayName},{LineId},2,Units,1");
        var unlinked = Assert.Single(SourceReaders.NormalizeWorkflow(byNameOnly, "pack-west", packing).EnumerateArray());
        var visibleNamePreview = Json.Element(WorkspacePreview.Build(
            [.. samples, new("pack-west", "Packing-West", "unlinked.csv", unlinked)], samples.Length + 1, 0, false));
        Assert.Equal(1, visibleNamePreview.GetProperty("unresolved").GetInt32());
    }

    private static void CheckDraft(JsonElement preview)
    {
        Assert.Equal(0, preview.GetProperty("unresolved").GetInt32());
        var proofs = preview.GetProperty("examples").EnumerateArray().ToArray();
        Assert.Equal(2, proofs.Length);
        Assert.All(proofs, proof => Assert.Equal(OrderId, proof.GetProperty("orderReference").GetString()));
        var west = proofs.Single(p => p.GetProperty("source").GetString() == "Sales-West");
        var east = proofs.Single(p => p.GetProperty("source").GetString() == "Sales-East");
        Assert.Equal("3", west.GetProperty("lines")[0].GetProperty("quantity").GetString());
        Assert.Equal("8", east.GetProperty("lines")[0].GetProperty("quantity").GetString());
        Assert.Equal("CT-07", Assert.Single(west.GetProperty("packages").EnumerateArray()).GetString());
        Assert.Empty(east.GetProperty("packages").EnumerateArray());
        Assert.Equal(2, west.GetProperty("events").GetArrayLength());
        Assert.Single(east.GetProperty("events").EnumerateArray());
    }

    [WindowsFact]
    public async Task Confirmed_sources_preview_a_correction_and_packing_against_only_the_selected_company()
    {
        var root = Directory.CreateTempSubdirectory("pp-odoo-journey-").FullName;
        try
        {
            var orders = Directory.CreateDirectory(Path.Combine(root, "Sales-West")).FullName;
            var other = Directory.CreateDirectory(Path.Combine(root, "Sales-East")).FullName;
            var packing = Directory.CreateDirectory(Path.Combine(root, "Packing-West")).FullName;
            File.WriteAllText(Path.Combine(orders, "sales-01.csv"), Header + "\n" + Row("company.west", "2", First));
            File.WriteAllText(Path.Combine(other, "sales-01.csv"), Header + "\n" + Row("company.east", "8", First));
            File.WriteAllText(Path.Combine(packing, "cartons.csv"),
                "CartonNumber,OrderID,LineID,PackedUnits,UOM,RecordVersion\n" + $"CT-07,{OrderId},{LineId},2,Units,1");

            var store = new ProtectedStore(Path.Combine(root, "state"), new ServiceIdentityProtector());
            store.Initialize();
            var host = new HostConfiguration("development", "https://api.example", "https://app.example", "S-1-5-32-545");
            using var app = new AgentRuntime(host, store, new PackProofClient(host, new NoNetwork()), new LocalState());
            async Task Confirm(string folder, string role)
            {
                var status = Json.Element(await app.Command("addWorkspaceSource", Json.Element(new { folder, role }), default));
                var source = status.GetProperty("workspace").GetProperty("sources").EnumerateArray()
                    .Single(s => s.GetProperty("folder").GetString() == folder);
                var confirmation = new {
                    sourceId = source.GetProperty("id").GetString(),
                    expectedGeneration = source.GetProperty("generation").GetInt32(),
                    profileVersion = source.GetProperty("recognition").GetProperty("profileVersion").GetString()
                };
                await app.Command("confirmWorkspaceOrderMap", Json.Element(confirmation), default);
            }

            await Confirm(orders, "order");
            await Confirm(packing, "packing");
            await Confirm(other, "order");
            string corrected = Header + "\n" + Row("company.west", "3", Second);
            File.WriteAllText(Path.Combine(orders, "sales-02.csv"), corrected);
            File.WriteAllText(Path.Combine(orders, "sales-02-copy.csv"), corrected);

            var preview = Json.Element(await app.Command("workspaceDraftPreview", null, default));
            CheckDraft(preview);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(root, recursive: true);
        }
    }

    private sealed class NoNetwork : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("A local setup preview should not contact a server.");
    }
}

using System.Text;
using PackProof.Connect;
using Xunit;

public sealed class WorkspaceEvidenceDiscoveryTests
{
    [Theory]
    [InlineData("Packing photos", true)]
    [InlineData("Shipping_Evidence", true)]
    [InlineData("shipment-photos", true)]
    [InlineData("Photos", false)]
    [InlineData("Family shipping photos", false)]
    [InlineData("Packing", false)]
    [InlineData("Camera Roll", false)]
    public void Only_dedicated_folder_names_qualify(string name, bool expected) =>
        Assert.Equal(expected, WorkspaceEvidenceDiscovery.IsEvidenceFolder(name));

    [Fact]
    public void Reads_only_bounded_signatures_and_checks_the_reported_file_type()
    {
        var pdf = new MemoryStream(Encoding.ASCII.GetBytes("%PDF-1.7\nprivate document"));
        Assert.True(WorkspaceEvidenceDiscovery.Match(pdf, ".PDF"));
        Assert.Equal(9, pdf.Position);
        pdf.Position = 0;
        Assert.False(WorkspaceEvidenceDiscovery.Match(pdf, ".jpeg"));
        var png = new MemoryStream([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1]);
        Assert.True(WorkspaceEvidenceDiscovery.Match(png, ".png"));
        Assert.Equal(16, png.Position);
        var jpg = new MemoryStream([255,216,255,224,0,4,0,0,255,217]);
        Assert.True(WorkspaceEvidenceDiscovery.Match(jpg, ".jpg"));
        Assert.Equal(6, jpg.Position);
        Assert.False(WorkspaceEvidenceDiscovery.Match(new MemoryStream([255,216,255,224,255,255]), ".jpeg"));
        Assert.False(WorkspaceEvidenceDiscovery.Match(new MemoryStream([137,80,78,71]), ".png"));
        Assert.False(WorkspaceEvidenceDiscovery.Match(new MemoryStream(Encoding.ASCII.GetBytes("%PDF-9.9\n")), ".pdf"));
        var oversized = new MemoryStream();
        oversized.SetLength(FolderSource.MaxCsvBytes + 1L);
        Assert.False(WorkspaceEvidenceDiscovery.Match(oversized, ".pdf"));
        Assert.Equal(0, oversized.Position);
    }

    [WindowsFact]
    public void Search_offers_only_matching_evidence_in_dedicated_folders_for_the_evidence_role()
    {
        var root = Directory.CreateTempSubdirectory("pp-proof-photos-");
        try
        {
            var photos = root.CreateSubdirectory("Packing photos");
            var unrelated = root.CreateSubdirectory("Family photos");
            var wrongType = root.CreateSubdirectory("Shipping evidence");
            foreach (var folder in new[] {root,photos,unrelated})
                File.WriteAllText(Path.Combine(folder.FullName, "order.pdf"), "%PDF-1.7\n");
            File.WriteAllText(Path.Combine(wrongType.FullName, "parcel.jpg"), "plain text");
            var hit = Assert.Single(WorkspaceDiscovery.Scan("evidence", [root.FullName], null, []));
            Assert.Equal(photos.FullName, hit.Folder);
            Assert.Equal("order.pdf", hit.SampleFile);
            Assert.Empty(WorkspaceDiscovery.Scan("order", [root.FullName], null, []));
        }
        finally { root.Delete(true); }
    }
}

using System.IO.Compression;
using System.Text;
using System.Text.Json;
using PackProof.Connect;
using Xunit;

public sealed class SourceReaderTests
{
    private static byte[] Bytes(string text)=>Encoding.UTF8.GetBytes(text);
    [Theory]
    [InlineData(",")]
    [InlineData(";")]
    [InlineData("|")]
    [InlineData("\t")]
    public void Delimited_data_keeps_quoted_multiline_and_exact_identifiers(string delimiter)
    {
        var text="Generated export\r\norder"+delimiter+"item\r\n00001"+delimiter+"\"part"+delimiter+"12\nline \"\"2\"\"\"\r\n";
        var result=SourceReaders.Read("source.csv",Encoding.UTF8.GetPreamble().Concat(Bytes(text)).ToArray(),new(SkipRows:1));
        var row=Assert.Single(result.Rows);Assert.Equal("00001",row.Fields["order"].GetString());
        Assert.Equal("part"+delimiter+"12\nline \"2\"",row.Fields["item"].GetString());Assert.Equal("line 3/column 2",row.Lineage["item"]);
        Assert.Equal("invalid",SourceReaders.Read("source.csv",Bytes("order,item\nA,\"open")).State);
    }
    [Fact]
    public void Jsonl_offset_ignores_torn_tail_and_retains_exact_number_and_null()
    {
        byte[] complete=Bytes("{\"id\":123456789012345678901234,\"zero\":0,\"clear\":null}\r\n");
        var parsed=SourceReaders.Read("records.jsonl",complete.Concat(Bytes("{\"id\":")).ToArray());
        Assert.Equal(complete.Length,parsed.CompleteOffset);var row=Assert.Single(parsed.Rows);
        Assert.Equal("123456789012345678901234",row.Fields["id"].GetRawText());
        Assert.Equal(JsonValueKind.Null,row.Fields["clear"].ValueKind);Assert.False(row.Fields.ContainsKey("missing"));
        Assert.Equal("invalid",SourceReaders.Read("file.json",Bytes("{\"id\":1,\"id\":2}")).State);
    }
    [Fact]
    public void Fixed_records_require_declared_layout_and_preserve_spaces()
    {
        var layouts=new[]{new FixedRecord("H",[new("type",0,1),new("date",1,8)]),new FixedRecord("D",[new("type",0,1),new("line",1,3),new("qty",4,2)])};
        var parsed=SourceReaders.Read("report.txt",Bytes("H20261117\nD020 2\n"),new(Layout:layouts));
        Assert.Equal(2,parsed.Rows.Count);Assert.Equal("020",parsed.Rows[1].Fields["line"].GetString());
        Assert.Equal(" 2",parsed.Rows[1].Fields["qty"].GetString());
        Assert.Equal("invalid",SourceReaders.Read("report.txt",Bytes("D02"),new(Layout:layouts)).State);
    }
    [Fact]
    public void Namespace_soap_embedded_and_hostile_declarations()
    {
        const string payload="<s:Envelope xmlns:s='http://schemas.xmlsoap.org/soap/envelope/' xmlns:r='urn:reports'><s:Body><r:export>id,qty\n0001,2</r:export></s:Body></s:Envelope>";
        var parsed=SourceReaders.Read("result.xml",Bytes(payload),new(RecordElement:"export",XmlNamespace:"urn:reports",EmbeddedFormat:"csv"));
        Assert.Equal("0001",Assert.Single(parsed.Rows).Fields["id"].GetString());
        Assert.Contains("{urn:reports}export",parsed.Rows[0].Lineage["qty"]);
        Assert.Equal("invalid",SourceReaders.Read("record.xml",Bytes("<!DOCTYPE d [<!ENTITY x 'bad'>]><d>&x;</d>")).State);
    }
    [Fact]
    public void Confirmed_order_profile_preserves_line_grain_and_rejects_ambiguous_headers()
    {
        var csv=Bytes("OrderNumber,LineId,Version,SKU,Quantity,UOM\n00001,20,1,ABC,2.250,EA\n00001,30,1,ABC,1,EA\n");
        var parsed=SourceReaders.Read("export.csv",csv);var map=Assert.IsType<OrderColumnMap>(SourceReaders.ProposeOrderMap(parsed));
        var records=SourceReaders.NormalizeOrderLines(parsed,"facility-system-a",map);
        Assert.Equal(2,records.GetArrayLength());Assert.NotEqual(records[0].GetProperty("eventId").GetString(),records[1].GetProperty("eventId").GetString());
        Assert.Equal("2.250",records[0].GetProperty("lines")[0].GetProperty("orderedQuantity").GetString());
        Assert.Equal("00001",records[0].GetProperty("entity").GetProperty("id").GetString());Assert.Equal("facility-system-a",records[0].GetProperty("entity").GetProperty("namespace").GetString());
        var ambiguous=SourceReaders.Read("export.csv",Bytes("OrderNumber,SalesOrderId,LineId,Version,Quantity,UOM\n1,A,2,1,0,EA"));
        Assert.Null(SourceReaders.ProposeOrderMap(ambiguous));
        Assert.Null(SourceReaders.ProposeOrderMap(SourceReaders.Read("export.csv",Bytes("PurchaseOrderNumber,LineId,Version,Quantity,UOM\n1,2,1,3,EA"))));
        var drift=SourceReaders.Read("export.csv",Bytes("OrderNumber,LineId,ThatVersion,SKU,Quantity,UOM\n00001,20,1,ABC,9,EA"));
        Assert.Equal(0,SourceReaders.NormalizeOrderLines(drift,"facility-system-a",map).GetArrayLength());
    }
    private static string Isa=>"ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *261117*0900*U*00401*000000001*0*T*:~";
    [Theory]
    [InlineData("850","BEG*00*NE*PO-007**20261117","purchase_order","PO-007")]
    [InlineData("856","BSN*00*ASN-007*20261117*0900","shipment_notice","ASN-007")]
    [InlineData("997","AK1*PO*700","functional_acknowledgment","700")]
    public void X12_4010_documents_keep_envelope_and_document_role(string id,string header,string kind,string reference)
    {
        string raw=Isa+"GS*PO*SENDER*RECV*20261117*0900*1*X*004010~ST*"+id+"*0001~"+header+"~SE*3*0001~GE*1*1~IEA*1*000000001~";
        var read=SourceReaders.Read("sample.x12",Bytes(raw));
        Assert.Equal("parsed",read.State);var fields=Assert.Single(read.Rows).Fields;Assert.Equal(kind,fields["documentType"].GetString());
        Assert.Equal(reference,fields["documentReference"].GetString());Assert.Equal(0,SourceReaders.Normalize(read,"handoff").GetArrayLength());
        Assert.Equal("invalid",SourceReaders.Read("sample.x12",Bytes(raw.Replace("SE*3","SE*5"))).State);
    }
    [Theory]
    [InlineData("ORDERS","BGM+220+PO?+007+9","purchase_order","PO+007")]
    [InlineData("DESADV","BGM+351+ASN-007+9","despatch_advice","ASN-007")]
    [InlineData("CONTRL","UCI+0007+S+R+7","syntax_acknowledgment","0007")]
    public void Edifact_D02B_documents_keep_release_and_escaped_values(string id,string header,string kind,string reference)
    {
        string raw="UNA:+.? 'UNB+UNOC:3+S+R+261117:0900+0007'UNH+1+"+id+":D:02B:UN'"+header+"'UNT+3+1'UNZ+1+0007'";
        var read=SourceReaders.Read("sample.edi",Bytes(raw));Assert.Equal("parsed",read.State);
        var fields=Assert.Single(read.Rows).Fields;Assert.Equal(reference,fields["documentReference"].GetString());
        Assert.Equal(kind,fields["documentType"].GetString());Assert.Equal("D:02B:UN",fields["directory"].GetString());
    }
    [Fact]
    public void Zpl_and_epcis_only_claim_observed_content()
    {
        var label=SourceReaders.Read("label.prn",Bytes("^XA^BCN,80,Y,N^FD00001234^FS^XZ"));
        Assert.Equal("00001234",Assert.Single(label.Rows).Fields["fieldData"].GetString());
        Assert.Equal("recognized",SourceReaders.Read("graphic.zpl",Bytes("^XA^GF,8^FS^XZ")).State);
        Assert.Equal("unsupported",SourceReaders.Read("unknown.prn",Bytes("unknown")).State);
        var events=SourceReaders.Read("epcis.jsonld",Bytes("{\"type\":\"EPCISDocument\",\"schemaVersion\":\"2.0\",\"epcisBody\":{\"eventList\":[{\"type\":\"AggregationEvent\",\"parentID\":\"P\",\"childEPCs\":[\"A\",\"B\"]}]}}"));
        Assert.Equal(2,Assert.Single(events.Rows).Fields["childEPCs"].GetArrayLength());
        Assert.Equal(0,SourceReaders.Normalize(events,"packing").GetArrayLength());
    }
    [Fact]
    public void Archive_lineage_and_unsafe_member()
    {
        byte[] Zip(string name)
        {
            using var target=new MemoryStream();using(var zip=new ZipArchive(target,ZipArchiveMode.Create,true))
            {var entry=zip.CreateEntry(name);using var output=entry.Open();output.Write(Bytes("id,item\nx,one"));}
            return target.ToArray();
        }
        var parsed=SourceReaders.Read("reports.zip",Zip("nested/picking.csv"));
        Assert.Contains("nested/picking.csv",Assert.Single(parsed.Rows).Lineage["id"]);
        Assert.Equal("invalid",SourceReaders.Read("reports.zip",Zip("../report.csv")).State);
    }
}

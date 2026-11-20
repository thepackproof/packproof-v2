using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PackProof.Connect;

public sealed record OrderColumnMap(string Order,string Line,string Version,string Quantity,string Unit,string? Sku,
    [property:System.Text.Json.Serialization.JsonIgnore(Condition=System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? BackorderedQuantity=null,
    [property:System.Text.Json.Serialization.JsonIgnore(Condition=System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    CatalogueScope? Catalogue=null,
    [property:System.Text.Json.Serialization.JsonIgnore(Condition=System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? DisplayOrderReference=null);

public static partial class SourceReaders
{
    private static string Heading(string value)=>Regex.Replace(value,@"[\s_-]","").ToLowerInvariant();
    public static OrderColumnMap? ProposeOrderMap(SourceReadResult file)
    {
        if(file.State!="parsed"||file.Rows.Count==0)return null;
        var profile = RecognizeExport(file, out bool ambiguous);
        if (ambiguous) return null;
        if (profile?.OrderColumns != null) return ProposeExportMap(file, profile);
        string? Find(params string[] choices)
        {
            var matches=file.Headers.Where(h=>choices.Contains(Heading(h),StringComparer.Ordinal)).ToArray();
            return matches.Length==1?matches[0]:null;
        }
        var order=Find("salesorder","salesorderid","salesordernumber","orderid","ordernumber");
        var line=Find("salesorderlineid","orderlineid","orderlinenumber","salesorderlinenumber","lineid","linenumber");
        var version=Find("recordversion","sourcerevision","rowversion","recordrevision","version","revision") ??
            Find("sourcemodifiedat","lastmodifiedat","updatedat","lastupdated","modifiedat","reportasof","snapshotat");
        var qty=Find("orderedquantity","orderedqty","qtyordered","quantityordered","quantity","qty");
        var unit=Find("unit","uom","unitofmeasure","quantityunit");
        return order!=null&&line!=null&&version!=null&&qty!=null&&unit!=null
            ?new(order,line,version,qty,unit,Find("sku","itemsku","itemcode"),
                Find("backorderedquantity","backorderedqty","qtybackordered","quantitybackordered")):null;
    }
    public static string OrderProfileVersion(OrderColumnMap map)=>"packproof.order-columns/v1/"+Convert.ToHexStringLower(
        SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(map)));
    public static JsonElement NormalizeOrderLines(SourceReadResult input,string sourceId,OrderColumnMap map)
    {
        if(input.State!="parsed"||!IdentityPart(sourceId))return Val(Array.Empty<object>());
        ExportOrderColumns? vendorColumns = null;
        if (map.Catalogue is { } scope)
        {
            var profile = RecognizeExport(input);
            if (profile?.Id != scope.ProfileId || profile.OrderColumns == null || ProposeExportMap(input, profile) != map)
                return Val(Array.Empty<object>());
            vendorColumns = profile.OrderColumns;
            sourceId = CompanyOrderNamespace(sourceId, scope);
        }
        string[] required=[map.Order,map.Line,map.Version,map.Quantity,map.Unit];
        if(required.Distinct(StringComparer.Ordinal).Count()!=required.Length || required.Any(k=>!input.Headers.Contains(k,StringComparer.Ordinal)) ||
            (map.Sku!=null&&!input.Headers.Contains(map.Sku,StringComparer.Ordinal)) ||
            (map.BackorderedQuantity!=null&&!input.Headers.Contains(map.BackorderedQuantity,StringComparer.Ordinal)))return Val(Array.Empty<object>());
        var rows=new List<SourceReaderRow>();
        foreach(var raw in input.Rows)
        {
            string? order=Scalar(raw.Fields,map.Order),line=Scalar(raw.Fields,map.Line),reported=Scalar(raw.Fields,map.Version);
            string? version = vendorColumns == null ? PublishedVersion(reported, reported, null, null) :
                string.Equals(map.Version.Trim(), vendorColumns.SourceRevision, StringComparison.OrdinalIgnoreCase)
                    ? PublishedVersion(reported, null, null, null) : PublishedVersion(null, reported, null, null);
            if (vendorColumns != null && string.IsNullOrWhiteSpace(Scalar(raw.Fields, map.Quantity)))
                return Val(Array.Empty<object>());
            if(!IdentityPart(order)||!IdentityPart(line)||version==null||!Regex.IsMatch(version,@"^[0-9]{1,30}$")||
                required.Any(k=>!raw.Fields.ContainsKey(k)))return Val(Array.Empty<object>());
            var fields=new Dictionary<string,JsonElement>{
                ["entityNamespace"]=Val(sourceId),["entityType"]=Val("order"),["entityId"]=Val(order),["kind"]=Val("order"),
                ["eventId"]=Val("line/"+Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new[]{sourceId,order,line})))),
                ["version"]=Val(version),["lineId"]=raw.Fields[map.Line],["orderedQuantity"]=raw.Fields[map.Quantity],
                ["unit"]=raw.Fields[map.Unit],["orderReference"]=Val(order)
            };
            // ReportAsOf describes a snapshot boundary, not the modification time of each line.
            if(vendorColumns==null && reported!=null && SourceInstant(reported,out _))fields["sourceModifiedAt"]=Val(reported);
            var paths=new Dictionary<string,string>{{"orderReference",raw.Lineage[map.Order]},{"entityId",raw.Lineage[map.Order]},
                {"version",raw.Lineage[map.Version]},{"lineId",raw.Lineage[map.Line]},{"orderedQuantity",raw.Lineage[map.Quantity]},{"unit",raw.Lineage[map.Unit]}};
            if (map.DisplayOrderReference is { } display && IdentityPart(Scalar(raw.Fields,display)))
            {
                fields["sourceOrderName"] = raw.Fields[display];
                paths["sourceOrderName"] = raw.Lineage[display];
            }
            if(map.Sku!=null && raw.Fields.TryGetValue(map.Sku,out var sku) &&
                (vendorColumns == null || !string.IsNullOrEmpty(Scalar(raw.Fields,map.Sku))))
            {
                fields["sku"]=sku;
                paths["sku"]=raw.Lineage[map.Sku];
            }
            if(map.BackorderedQuantity!=null && raw.Fields.TryGetValue(map.BackorderedQuantity,out var deferred))
            {
                fields["backorderedQuantity"]=deferred;
                paths["backorderedQuantity"]=raw.Lineage[map.BackorderedQuantity];
            }
            CopyFacility(raw,fields,paths);
            rows.Add(new(raw.Location,fields,paths));
        }
        return Normalize(input with {Rows=rows},"order",input.Rows);
    }
}

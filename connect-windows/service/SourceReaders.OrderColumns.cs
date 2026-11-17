using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PackProof.Connect;

public sealed record OrderColumnMap(string Order,string Line,string Version,string Quantity,string Unit,string? Sku);

public static partial class SourceReaders
{
    private static string Heading(string value)=>Regex.Replace(value,@"[\s_-]","").ToLowerInvariant();
    public static OrderColumnMap? ProposeOrderMap(SourceReadResult file)
    {
        if(file.State!="parsed"||file.Rows.Count==0)return null;
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
            ?new(order,line,version,qty,unit,Find("sku","itemsku","itemcode")):null;
    }
    public static string OrderProfileVersion(OrderColumnMap map)=>"packproof.order-columns/v1/"+Convert.ToHexStringLower(
        SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(map)));
    public static JsonElement NormalizeOrderLines(SourceReadResult input,string sourceId,OrderColumnMap map)
    {
        if(input.State!="parsed"||!IdentityPart(sourceId))return Val(Array.Empty<object>());
        string[] required=[map.Order,map.Line,map.Version,map.Quantity,map.Unit];
        if(required.Distinct(StringComparer.Ordinal).Count()!=required.Length || required.Any(k=>!input.Headers.Contains(k,StringComparer.Ordinal)) ||
            map.Sku!=null&&!input.Headers.Contains(map.Sku,StringComparer.Ordinal))return Val(Array.Empty<object>());
        var rows=new List<SourceReaderRow>();
        foreach(var raw in input.Rows)
        {
            string? order=Scalar(raw.Fields,map.Order),line=Scalar(raw.Fields,map.Line),reported=Scalar(raw.Fields,map.Version);
            string? version=PublishedVersion(reported,reported,null,null);
            if(!IdentityPart(order)||!IdentityPart(line)||version==null||!Regex.IsMatch(version,@"^[0-9]{1,30}$")||
                required.Any(k=>!raw.Fields.ContainsKey(k)))return Val(Array.Empty<object>());
            var fields=new Dictionary<string,JsonElement>{
                ["entityNamespace"]=Val(sourceId),["entityType"]=Val("order"),["entityId"]=Val(order),["kind"]=Val("order"),
                ["eventId"]=Val("line/"+Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new[]{sourceId,order,line})))),
                ["version"]=Val(version),["lineId"]=raw.Fields[map.Line],["orderedQuantity"]=raw.Fields[map.Quantity],
                ["unit"]=raw.Fields[map.Unit],["orderReference"]=Val(order)
            };
            if(reported!=null && SourceInstant(reported,out _))fields["sourceModifiedAt"]=Val(reported);
            var paths=new Dictionary<string,string>{{"orderReference",raw.Lineage[map.Order]},{"entityId",raw.Lineage[map.Order]},
                {"version",raw.Lineage[map.Version]},{"lineId",raw.Lineage[map.Line]},{"orderedQuantity",raw.Lineage[map.Quantity]},{"unit",raw.Lineage[map.Unit]}};
            if(map.Sku!=null && raw.Fields.TryGetValue(map.Sku,out var sku)){fields["sku"]=sku;paths["sku"]=raw.Lineage[map.Sku];}
            rows.Add(new(raw.Location,fields,paths));
        }
        return Normalize(input with {Rows=rows},"order");
    }
}

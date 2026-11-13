using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
namespace PackProof.Connect;

// The alias/profile definition is embedded from the same JSON the backend uses.
// This analyzer never uses the shortened renderer sample strings.
public static class CsvSemantics
{
    private static readonly JsonElement Rules = Load();
    public static string Version => Rules.GetProperty("version").GetString()!;
    public static string Profile => Rules.GetProperty("profile").GetString()!;
    public static readonly string[] Fields = ["shipmentReference","itemTitle","quantity","trackingNumber","carrier","shippedAt","locationId"];
    private static JsonElement Load()
    {
        var assembly = typeof(CsvSemantics).Assembly;
        using var stream = assembly.GetManifestResourceStream(assembly.GetManifestResourceNames().Single(n => n.EndsWith("connect-csv-rules.json")))!;
        return JsonDocument.Parse(stream).RootElement.Clone();
    }
    public static string Key(string value) => Regex.Replace(value.Trim().ToLowerInvariant(), @"[\s_-]+", "");
    public static bool Alias(string field,string header) => Rules.GetProperty("aliases").GetProperty(field).EnumerateArray().Any(a=>a.GetString()==Key(header));
    public static bool Eligible(string field,string header)
    {
        var key=Key(header);
        if(field=="shipmentReference" && Rules.GetProperty("forbiddenShipmentAliases").EnumerateArray().Any(x=>x.GetString()==key))return false;
        var roles=Fields.Where(f=>Alias(f,header)).ToArray(); return roles.Length==0||roles.Contains(field);
    }
    public static bool Instant(string value,out DateTimeOffset at)
    {
        at=default;
        return Regex.IsMatch(value,@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$")
            && DateTimeOffset.TryParse(value,CultureInfo.InvariantCulture,DateTimeStyles.None,out at);
    }
    public static bool ValueValid(string field,string value)
    {
        if(field=="quantity")return Regex.IsMatch(value,@"^[0-9]+$")&&int.TryParse(value,NumberStyles.None,CultureInfo.InvariantCulture,out var n)&&n>=Rules.GetProperty("quantityMin").GetInt32()&&n<=Rules.GetProperty("quantityMax").GetInt32();
        if(field=="shippedAt")return Instant(value,out _);
        if(value.Length==0)return !new[]{"shipmentReference","itemTitle"}.Contains(field);
        return value.Length<=Rules.GetProperty(field is "carrier" or "trackingNumber"?"shippingTextMax":"textMax").GetInt32()&&!value.Contains('\0')&&(field!="carrier"||!Regex.IsMatch(value,@"^[0-9]+$"));
    }
    public sealed record Decision(string Field,string? SourceColumnId,string State,string[] ReasonCodes,string Origin,string[] Candidates,Dictionary<string,string[]> Examples);
    public sealed record Result(bool Ready, Dictionary<string,string> Mapping, Decision[] Decisions, JsonElement? Shipment, JsonElement[] Rows, string[] Issues, string HeaderFingerprint, int RowCount);
    public static Result Analyze(byte[] bytes,Dictionary<string,string>? mapping=null,string[]? confirmed=null,string? boundLocation=null,bool requireTime=true,string timeZone="source-offset")
    {
        var parsed=FolderSource.Parse(bytes); var headers=parsed.Headers; var rows=parsed.Rows; confirmed??=[];
        if(mapping is not null&&mapping.Keys.Any(f=>!Fields.Contains(f)))throw new ConnectException("INVALID_MAPPING","Use only supported shipment fields.");
        var selected=mapping??Fields.Select(f=>(f,found:headers.Where(h=>Alias(f,h)).ToArray())).Where(x=>x.found.Length==1).ToDictionary(x=>x.f,x=>x.found[0]);
        var collision=headers.Select(Key).Distinct(StringComparer.Ordinal).Count()!=headers.Length;
        var decisions=Fields.Select(field=>{
            bool Compatible(string value)=>field=="shippedAt"&&!requireTime&&DateOnly.TryParseExact(value,"yyyy-MM-dd",CultureInfo.InvariantCulture,DateTimeStyles.None,out _)?true:ValueValid(field,value);
            var candidates=headers.Where(h=>Eligible(field,h)&&rows.All(r=>Compatible(r[h].Trim()))).ToArray();
            var has=selected.TryGetValue(field,out var header); var required=new[]{"shipmentReference","itemTitle","quantity"}.Contains(field)||field=="shippedAt"&&requireTime;
            string status,reason,origin=has?"source_column":"absent";
            if(!has&&field=="locationId"&&boundLocation is not null){status="validated";reason="APPROVED_LOCATION";origin="approved_binding";}
            else if(!has){status=required?"missing_required":"missing_optional";reason=headers.Count(h=>Alias(field,h))>1?"MULTIPLE_CANDIDATES":required?"REQUIRED_COLUMN_MISSING":"OPTIONAL_NOT_PROVIDED";}
            else if(collision||!headers.Contains(header!)||!Eligible(field,header!)||selected.Any(x=>x.Key!=field&&x.Value==header)){status="incompatible";reason=collision?"HEADER_COLLISION":"COLUMN_ROLE_CONFLICT";}
            else if(!rows.All(r=>Compatible(r[header!].Trim()))){status="incompatible";reason="VALUE_TYPE_OR_RANGE";}
            else if(field=="locationId"&&rows.Any(r=>r[header!].Trim()!=(boundLocation??""))){status="incompatible";reason="LOCATION_BINDING_CONFLICT";}
            else if(!Alias(field,header!)&&!confirmed.Contains(field)){status="needs_confirmation";reason="COLUMN_MEANING_REQUIRED";}
            else {status="validated";reason="SEMANTIC_AND_VALUE_CHECKS";}
            return new Decision(field,header,status,[reason],origin,candidates,candidates.Take(3).ToDictionary(h=>h,h=>rows.Take(2).Select(r=>r[h].Length>80?r[h][..80]+"…":r[h]).ToArray()));
        }).ToArray();
        var ready=decisions.All(d=>d.State is "validated" or "missing_optional"); var normalized=new List<JsonElement>();var issues=new List<string>();
        if(ready)foreach(var row in rows){
            string Value(string field)=>selected.TryGetValue(field,out var header)?row[header].Trim():"";
            string? Optional(string field)=>Value(field) is var v&&v.Length>0?v:null;
            var shipped=Optional("shippedAt"); string? day=shipped?[..10];
            if(shipped is not null&&shipped.Length>10&&timeZone!="source-offset")day=TimeZoneInfo.ConvertTime(DateTimeOffset.Parse(shipped,CultureInfo.InvariantCulture),TimeZoneInfo.FindSystemTimeZoneById(timeZone)).ToString("yyyy-MM-dd",CultureInfo.InvariantCulture);
            normalized.Add(Json.Element(new{shipmentReference=Value("shipmentReference"),itemTitle=Value("itemTitle"),quantity=int.Parse(Value("quantity"),CultureInfo.InvariantCulture),trackingNumber=Optional("trackingNumber"),carrier=Optional("carrier"),shippedAt=shipped,shipmentDate=day,locationId=Optional("locationId")??boundLocation}));
        }
        // The canonical importer currently supports one immutable shipment per
        // reference. Do not silently aggregate line-item exports into new semantics.
        if(normalized.GroupBy(r=>r.GetProperty("shipmentReference").GetString()).Any(g=>g.Count()>1)){ready=false;issues.Add("REPEATED_SHIPMENT_REFERENCE: This report has repeated shipment rows. Provide the supported one-shipment-per-row export; line items are not aggregated.");}
        var encoder=new JsonSerializerOptions{Encoder=System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping};
        var fingerprint=Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(headers,encoder)));
        var partial=new Dictionary<string,object?>();
        foreach(var decision in decisions.Where(d=>d.State=="validated")){
            if(decision.Origin=="approved_binding")partial[decision.Field]=boundLocation;
            else if(decision.SourceColumnId is not null){var value=rows[0][decision.SourceColumnId].Trim();partial[decision.Field]=decision.Field=="quantity"?(object)int.Parse(value,CultureInfo.InvariantCulture):value;}
        }
        return new(ready,selected,decisions,ready?normalized[0]:Json.Element(partial),normalized.ToArray(),issues.ToArray(),fingerprint,rows.Count);
    }
    public static void RequireValid(byte[] bytes,JsonElement config)
    {
        var map=JsonSerializer.Deserialize<Dictionary<string,string>>(config.GetProperty("mapping"),Json.Options)!;
        var contract=config.TryGetProperty("sourceContract",out var c)&&c.ValueKind==JsonValueKind.Object?c:(JsonElement?)null;
        var confirmed=contract?.TryGetProperty("confirmedFields",out var f)==true?f.EnumerateArray().Select(x=>x.GetString()!).ToArray():map.Keys.ToArray();
        var location=config.TryGetProperty("locationId",out var loc)&&loc.ValueKind==JsonValueKind.String?loc.GetString():null;
        var result=Analyze(bytes,map,confirmed,location,contract is not null,config.GetProperty("timeZone").GetString()!);
        if(!result.Ready)throw new ConnectException("MAPPING_NEEDS_REVIEW","This report needs review. Its full values or column meanings do not satisfy the approved shipment profile. The original and queue are preserved.");
    }
}

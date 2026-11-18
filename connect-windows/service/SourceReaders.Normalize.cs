using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PackProof.Connect;

public static partial class SourceReaders
{
    private static readonly Dictionary<string,string> RoleKinds = new(StringComparer.Ordinal)
    {
        ["order"]="order", ["picking"]="picking", ["packing"]="packing", ["evidence"]="evidence", ["shipping"]="label",
        ["handoff"]="handoff", ["delivery"]="delivery", ["returns"]="return"
    };
    private static readonly string[] ReferenceTypes=["order","warehouse","shipment","package","tracking","load","return"];
    private static readonly string[] AmountFields=["orderedQuantity","pickedQuantity","packedQuantity","loadedQuantity","shippedQuantity","acknowledgedQuantity","backorderedQuantity","returnedQuantity","cancelledQuantity"];
    private static string? Scalar(IReadOnlyDictionary<string,JsonElement> fields,string key)
    {
        if(!fields.TryGetValue(key,out var value))return null;
        return value.ValueKind switch {JsonValueKind.String=>value.GetString(),JsonValueKind.Number=>value.GetRawText(),_=>null};
    }
    private static bool IdentityPart(string? value) => value is {Length: >0 and <=200} && !string.IsNullOrWhiteSpace(value) && !value.Any(char.IsControl);
    private static object Reference(string ns,string type,string id)
    {
        Require(IdentityPart(ns)&&IdentityPart(type)&&IdentityPart(id),"A source reference lacks an explicit namespace, entity type or identifier.");
        return new { @namespace=ns,type,id };
    }
    public static JsonElement Normalize(SourceReadResult source,string role)=>Normalize(source,role,null);
    private static JsonElement Normalize(SourceReadResult source,string role,IReadOnlyList<SourceReaderRow>? originals)
    {
        var records=new List<Dictionary<string,object?>>();
        if(source.State!="parsed" || !RoleKinds.TryGetValue(role,out var defaultKind))return Val(records);
        // The whole original is one import. Never silently release a partially understood batch.
        try
        {
            for(int index=0;index<source.Rows.Count;index++)
            {
                var row=source.Rows[index];
                var fields=row.Fields;
                string? Get(string k)=>Scalar(fields,k);
                var eventId=Get("eventId");var version=Get("version");
                Require(IdentityPart(eventId)&&IdentityPart(version),"The explicit profile needs a stable event identity and version.");
                var kind=Get("kind")??defaultKind;
                Require(RoleKinds.ContainsValue(kind)||kind=="correction","The event type is outside the approved profile.");
                if(kind!=defaultKind && kind!="correction") continue;
                var entity=Reference(Get("entityNamespace")??"",Get("entityType")??"",Get("entityId")??"");
                var refs=new List<object>();
                foreach(string type in ReferenceTypes)
                {
                    string? id=Get(type+"Id"),ns=Get(type+"Namespace");
                    if(string.IsNullOrEmpty(id)&&string.IsNullOrEmpty(ns))continue;
                    refs.Add(Reference(ns??"",type,id??""));
                }
                if(fields.TryGetValue("references",out var declared))
                {
                    Require(declared.ValueKind==JsonValueKind.Array && declared.GetArrayLength()<=32,"The declared references must be a bounded list.");
                    foreach(var r in declared.EnumerateArray())
                    {
                        Require(r.ValueKind==JsonValueKind.Object,"An explicit relationship is malformed.");
                        var parts=r.EnumerateObject().ToDictionary(p=>p.Name,p=>p.Value,StringComparer.Ordinal);
                        refs.Add(Reference(Scalar(parts,"namespace")??"",Scalar(parts,"type")??"",Scalar(parts,"id")??""));
                    }
                }
                var matches=new List<Dictionary<string,string?>>();
                if(fields.TryGetValue("lines",out var lines))
                {
                    Require(lines.ValueKind==JsonValueKind.Array&&lines.GetArrayLength()<=128,"The order lines must be a bounded collection.");
                    foreach(var line in lines.EnumerateArray())
                    {
                        Require(line.ValueKind==JsonValueKind.Object,"An order line is malformed.");
                        matches.Add(MapLine(line.EnumerateObject().ToDictionary(p=>p.Name,p=>p.Value)));
                    }
                }
                else if(!string.IsNullOrEmpty(Get("lineId")))matches.Add(MapLine(fields));
                var projected=WireFields(fields);
                var paths=new Dictionary<string,string>(row.Lineage,StringComparer.Ordinal);
                // Preserve supplementary source facts only after interpreting the approved columns.
                // A vendor column cannot create a relationship or change facility scope.
                if(originals!=null)
                {
                    foreach(var (key,value) in WireFields(originals[index].Fields))projected.TryAdd(key,value);
                    foreach(var (key,path) in originals[index].Lineage)paths.TryAdd(key,path);
                }
                Require(projected.Count<=96 && paths.Count<=160 && row.Location.Length<=1600 && paths.Values.All(path=>path.Length<=1600),
                    "The record exceeds the bounded field or location limits.");
                var record=new Dictionary<string,object?> {["eventId"]=eventId,["version"]=version,["kind"]=kind,["entity"]=entity,
                    ["references"]=refs,["fields"]=projected,["lines"]=matches,["locator"]=row.Location,["fieldLineage"]=paths };
                if(fields.TryGetValue("packproofLocationId",out var facility) && facility.ValueKind!=JsonValueKind.Null)
                {
                    Require(facility.ValueKind==JsonValueKind.String && IdentityPart(facility.GetString()),"The declared PackProof location is invalid.");
                    record["facilityId"]=facility.GetString();
                }
                foreach(var key in new[]{"occurredAt","sourceModifiedAt"})
                {
                    var time=Get(key);
                    if(string.IsNullOrEmpty(time))continue;
                    Require(Regex.IsMatch(time,@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$")&&
                        DateTimeOffset.TryParse(time,CultureInfo.InvariantCulture,DateTimeStyles.None,out _),"The source time needs an explicit UTC offset.");
                    record[key]=time;
                }
                records.Add(record);
            }
        }
        catch(InvalidDataException){return Val(Array.Empty<object>());}
        return Val(records);
    }
    private static void CopyFacility(SourceReaderRow raw,Dictionary<string,JsonElement> canonical,Dictionary<string,string> lineage)
    {
        const string key="packproofLocationId";
        if(!raw.Fields.TryGetValue(key,out var value))return;
        canonical[key]=value;
        lineage[key]=raw.Lineage[key];
    }
    private static Dictionary<string,JsonElement> WireFields(Dictionary<string,JsonElement> fields)
    {
        var projected=new Dictionary<string,JsonElement>(StringComparer.Ordinal);
        foreach(var (key,value) in fields)
        {
            if(value.ValueKind is JsonValueKind.Object or JsonValueKind.Array)continue;
            Require(key.Length<=180 && key is not ("__proto__" or "constructor" or "prototype"),"Review the source field name.");
            var scalar=value.ValueKind==JsonValueKind.Number?Val(value.GetRawText()):value;
            Require(scalar.ValueKind!=JsonValueKind.String || scalar.GetString()!.Length<=4096,"The projected field exceeds the record limit.");
            projected.Add(key,scalar);
        }
        Require(projected.Count<=96,"The record has too many projected fields.");
        return projected;
    }
    private static Dictionary<string,string?> MapLine(Dictionary<string,JsonElement> fields)
    {
        string? id=Scalar(fields,"lineId");
        Require(IdentityPart(id),"An order line requires its explicit line identity.");
        var output=new Dictionary<string,string?>{["lineId"]=id!};
        foreach(var key in new[]{"sku","unit","title","description","shipmentReference"})
        {
            var value=Scalar(fields,key);if(value is not null){Require(IdentityPart(value),"The line has an invalid SKU or unit.");output[key]=value;}
        }
        foreach(var key in new[]{"pickedQuantityState","loadedQuantityState","acknowledgedQuantityState"})
        {
            var reported=Scalar(fields,key);
            if(reported is null)continue;
            Require(reported is "not_due" or "missing" or "unavailable" or "reported","The reported stage state is unsupported.");
            output[key]=reported;
        }
        foreach(var key in AmountFields)
        {
            if(!fields.TryGetValue(key,out var raw))continue;
            if(raw.ValueKind is JsonValueKind.Null || raw.ValueKind==JsonValueKind.String && raw.GetString()==""){output[key]=raw.ValueKind==JsonValueKind.Null?null:"";continue;}
            string? v=Scalar(fields,key);
            Require(v!=null && Regex.IsMatch(v,@"^(0|[1-9]\d{0,11})(\.\d{1,9})?$",RegexOptions.CultureInvariant) && output.ContainsKey("unit"),"A line quantity needs an exact nonnegative decimal and reported unit.");
            output[key]=v!;
        }
        return output;
    }
}

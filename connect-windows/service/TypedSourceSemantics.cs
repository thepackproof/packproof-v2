using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
namespace PackProof.Connect;

public sealed record TypedSourceRowPreview(int RowNumber, bool Valid, JsonElement? Normalized, string? PayloadSha256);
/// <summary>The local NTFS adapter supports the shared bounded CSV profiles.
/// The server repeats all validation against the exact preserved original.</summary>
public static class TypedSourceSemantics
{
    private static readonly JsonElement Rules = LoadRules();
    public static string Version => Rules.GetProperty("version").GetString()!;
    public static string Schema => Rules.GetProperty("schema").GetString()!;
    private static JsonElement LoadRules()
    {
        var assembly=typeof(TypedSourceSemantics).Assembly;
        var name=assembly.GetManifestResourceNames().Single(n=>n.EndsWith("typed-source-rules.json",StringComparison.Ordinal));
        using var stream=assembly.GetManifestResourceStream(name)!; using var parsed=JsonDocument.Parse(stream); return parsed.RootElement.Clone();
    }
    private static ConnectException Invalid(string message) => new("TYPED_SOURCE_NEEDS_REVIEW",message);
    private static string Text(string? value, string field, int max=200)
    {
        if(string.IsNullOrWhiteSpace(value)||value.Length>max||value.Contains('\0'))throw Invalid($"The source must report an explicit {field} within the supported bound.");return value;
    }
    private static string? Time(string? value)
    {
        if(value is null)return null;
        if(!Regex.IsMatch(value,@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$")||!DateTimeOffset.TryParse(value,CultureInfo.InvariantCulture,DateTimeStyles.None,out _))throw Invalid("Source time must contain a valid explicit UTC offset; missing time remains unknown.");return value;
    }
    private static string[] Strings(JsonElement values) => values.EnumerateArray().Select(v=>v.GetString()!).ToArray();
    private static Dictionary<string,object?> Reference(string ns,string type,string id) => new(){{"namespace",ns},{"type",type},{"externalId",Text(id,"entity identifier")}};
    public static IReadOnlyList<TypedSourceRowPreview> Preview(byte[] bytes,JsonElement configuration)
    {
        var parsed=FolderSource.Parse(bytes); var profileId=Text(configuration.GetProperty("sourceProfile").GetString(),"source profile");
        var profile=Rules.GetProperty("profiles").EnumerateArray().FirstOrDefault(p=>p.GetProperty("id").GetString()==profileId);
        if(profile.ValueKind!=JsonValueKind.Object)throw Invalid("Install the matching source profile version before collecting this export.");
        var ns=Text(configuration.GetProperty("sourceNamespace").GetString(),"source namespace");
        var mapping=configuration.GetProperty("mapping").EnumerateObject().ToDictionary(p=>p.Name,p=>Text(p.Value.GetString(),"mapped heading"),StringComparer.Ordinal);
        var constants=configuration.TryGetProperty("constants",out var c)?c.EnumerateObject().ToDictionary(p=>p.Name,p=>Text(p.Value.GetString(),"declared source constant",100),StringComparer.Ordinal):new Dictionary<string,string>(StringComparer.Ordinal);
        var fields=Strings(Rules.GetProperty("csvFields"));
        if(mapping.Keys.Any(k=>!fields.Contains(k))||mapping.Values.Distinct(StringComparer.Ordinal).Count()!=mapping.Count||mapping.Values.Any(h=>!parsed.Headers.Contains(h,StringComparer.Ordinal)))throw Invalid("The export headings differ from the approved mapping. Review this source before collection.");
        if(constants.Any(p=>p.Key is not("observationKind" or "property" or "timeQuality")||mapping.ContainsKey(p.Key)))throw Invalid("Only explicitly approved source constants may supplement mapped fields.");
        foreach(var key in new[]{"sourceEventId","sourceRevision"})if(!mapping.ContainsKey(key))throw Invalid("Stable source identity and revision columns are required.");
        foreach(var key in new[]{"observationKind","property","timeQuality"})if(!mapping.ContainsKey(key)&&!constants.ContainsKey(key))throw Invalid("Declare observation meaning, property and time quality explicitly.");
        if(configuration.TryGetProperty("expectedHeaders",out var expected)&&!parsed.Headers.SequenceEqual(Strings(expected),StringComparer.Ordinal))throw Invalid("Source headings changed. The approved mapping must be reviewed.");
        var result=new List<TypedSourceRowPreview>();
        for(var i=0;i<parsed.Rows.Count;i++)
        {
            try
            {
                var raw=parsed.Rows[i]; string? Get(string key)=>mapping.TryGetValue(key,out var heading)?raw[heading] is var value&&value.Length>0?value:null:constants.GetValueOrDefault(key);
                string? sourceEventId=Text(Get("sourceEventId"),"source event identity"),revision=Text(Get("sourceRevision"),"source revision",100),kind=Get("observationKind"),quality=Get("timeQuality"),property=Get("property");
                if(kind is not("event" or "snapshot" or "correction" or "tombstone")||quality is not("event_time" or "snapshot_time_only" or "unknown")||property is null||!Strings(profile.GetProperty("allowedProperties")).Contains(property))throw Invalid("The source property or observation meaning is not supported by its approved profile.");
                string? occurredAt=Time(Get("occurredAt")),asOf=Time(Get("sourceAsOf"));
                if(quality=="event_time"&&occurredAt is null||quality=="snapshot_time_only"&&(asOf is null||occurredAt is not null)||quality=="unknown"&&(occurredAt is not null||asOf is not null)||kind=="event"&&(quality!="event_time"||occurredAt is null))throw Invalid("The reported time and declared time quality disagree.");
                var references=new List<Dictionary<string,object?>>();
                foreach(var entry in Rules.GetProperty("csvReferenceFields").EnumerateObject())if(Get(entry.Name) is { } id){var reference=Reference(ns,entry.Value.GetString()!,id);if(entry.Value.GetString()=="order_line")reference["parentExternalId"]=Text(Get("orderId"),"parent order identifier");references.Add(reference);}
                Dictionary<string,object?>? Ref(string type)=>references.FirstOrDefault(r=>(string)r["type"]! == type);
                if(references.Count==0||Strings(profile.GetProperty("requiredReferences")).Any(type=>Ref(type) is null)||profileId=="packproof.operational-observations/v1"&&!new[]{"order","order_line","shipment","handling_unit","return"}.Any(t=>Ref(t)is not null))throw Invalid("The source lacks an explicit required operational identity.");
                var relationships=new List<Dictionary<string,object?>>();
                foreach(var relationship in Rules.GetProperty("csvRelationships").EnumerateArray())
                {
                    var fromTypes=relationship.GetProperty("from"); var from=fromTypes.ValueKind==JsonValueKind.Array?fromTypes.EnumerateArray().Select(t=>Ref(t.GetString()!)).FirstOrDefault(r=>r is not null):Ref(fromTypes.GetString()!);var to=Ref(relationship.GetProperty("to").GetString()!);
                    if(from is not null&&to is not null)relationships.Add(new(){{"from",from},{"to",to},{"type",relationship.GetProperty("type").GetString()},{"quantity",null}});
                }
                if(kind=="tombstone")relationships.Clear();
                var quantity=Strings(Rules.GetProperty("quantityProperties")).Contains(property);
                object? value;
                if(quantity && kind!="tombstone")
                {
                    string? amount=Get("amount"),unit=Get("unit");
                    if(amount is null||!Regex.IsMatch(amount,@"^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,9})?$"))throw Invalid("Quantities require an exact nonnegative decimal string.");
                    var validUnit=Text(unit?.Trim(),"reported quantity unit",30);if(validUnit.Any(char.IsControl))throw Invalid("Units cannot contain control characters.");
                    value=new Dictionary<string,object?>{{"amount",amount},{"unit",validUnit}};
                    if(property=="allocatedQuantity")foreach(var relation in relationships)if((string?)relation["type"] is "fulfills" or "allocated_to")relation["quantity"]=new Dictionary<string,object?>{{"amount",amount},{"unit",validUnit}};
                }
                else value=kind=="tombstone"?null:Text(Get("value"),"reported value",2000);
                var subject=Ref("order_line")??Ref("shipment")??Ref("handling_unit")??Ref("return")??Ref("order");
                if(kind!="tombstone"&&subject is null)throw Invalid("An assertion needs an explicit operational subject.");
                if(kind!="tombstone"&&(profileId=="packproof.order-lines/v1"&&(!quantity||Ref("order_line") is null)||profileId=="packproof.shipment-handling-units/v1"&&(property!="allocatedQuantity"||Ref("order_line") is null)))throw Invalid("The profile requires the appropriate explicit line quantity.");
                var superseded=Get("supersedesRevision");if(superseded is not null)superseded=Text(superseded,"superseded revision",100); if((kind is "correction" or "tombstone")&&superseded is null||superseded==revision)throw Invalid("A correction must explicitly identify a different source revision.");
                var assertions=new List<Dictionary<string,object?>>();if(kind!="tombstone")assertions.Add(new(){{"subjectReference",subject},{"property",property},{"value",value},{"sourceLocator",new Dictionary<string,object?>{{"row",i+2},{"field",mapping.GetValueOrDefault(quantity?"amount":"value")??"declared property"}}},{"assurance","source_reported"}});
                var normalized=Json.Element(new Dictionary<string,object?>{{"sourceEventId",sourceEventId},{"sourceRevision",revision},{"observationKind",kind},{"occurredAt",occurredAt},{"sourceAsOf",asOf},{"timeQuality",quality},{"references",references},{"assertions",assertions},{"relationships",relationships},{"supersedes",superseded is null?null:new Dictionary<string,object?>{{"sourceEventId",sourceEventId},{"sourceRevision",superseded}}},{"originSystem",Get("originSystem") is { } origin?Text(origin,"origin system"):null},{"copiedFromSource",Get("copiedFromSource") is { } copied?Text(copied,"copied source"):null}});
                result.Add(new(i+2,true,normalized,Convert.ToHexStringLower(SHA256.HashData(CanonicalBusinessBytes(normalized)))));
            }
            catch(ConnectException){result.Add(new(i+2,false,null,null));}
        }
        return result;
    }
    public static byte[] CanonicalBusinessBytes(JsonElement observation)
    {
        var value=observation.EnumerateObject().ToDictionary(p=>p.Name,p=>(object?)p.Value);
        JsonElement[] Sorted(IEnumerable<JsonElement> entries)=>entries.OrderBy(v=>Encoding.UTF8.GetString(CanonicalBytes(v)),StringComparer.Ordinal).ToArray();
        value["references"]=Sorted(observation.GetProperty("references").EnumerateArray());
        value["relationships"]=Sorted(observation.GetProperty("relationships").EnumerateArray());
        value["assertions"]=Sorted(observation.GetProperty("assertions").EnumerateArray().Select(a=>Json.Element(a.EnumerateObject().Where(p=>p.Name!="sourceLocator").ToDictionary(p=>p.Name,p=>(object?)p.Value))));
        return CanonicalBytes(Json.Element(value));
    }
    public static byte[] CanonicalBytes(JsonElement element)
    {
        using var stream=new MemoryStream();using(var writer=new Utf8JsonWriter(stream,new JsonWriterOptions{Encoder=JavaScriptEncoder.UnsafeRelaxedJsonEscaping}))Write(element,writer);return stream.ToArray();
    }
    private static void Write(JsonElement value,Utf8JsonWriter writer)
    {
        switch(value.ValueKind)
        {
            case JsonValueKind.Object:writer.WriteStartObject();foreach(var property in value.EnumerateObject().OrderBy(p=>p.Name,StringComparer.Ordinal)){writer.WritePropertyName(property.Name);Write(property.Value,writer);}writer.WriteEndObject();break;
            case JsonValueKind.Array:writer.WriteStartArray();foreach(var item in value.EnumerateArray())Write(item,writer);writer.WriteEndArray();break;
            default:value.WriteTo(writer);break;
        }
    }
}

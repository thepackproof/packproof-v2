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
public static partial class TypedSourceSemantics
{
    private static readonly JsonElement Rules = LoadRules();
    public static string Version => Rules.GetProperty("version").GetString()!;
    public static string Schema => Rules.GetProperty("schema").GetString()!;
    public static string SchemaV2 => Rules.GetProperty("schemaV2").GetString()!;
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
    private sealed record IdentityPolicy(string EventKind,string[] Fields,string RevisionKind);
    private static void Keys(JsonElement value,params string[] allowed)
    {
        if(value.ValueKind!=JsonValueKind.Object||value.EnumerateObject().Any(p=>!allowed.Contains(p.Name,StringComparer.Ordinal)))throw Invalid("The source identity policy contains undocumented fields.");
    }
    private static IdentityPolicy Identity(JsonElement configuration,Dictionary<string,string> mapping,Dictionary<string,string> constants,string profileId,bool v2)
    {
        if(!v2){if(configuration.TryGetProperty("identityPolicy",out var unsupported)&&unsupported.ValueKind!=JsonValueKind.Null)throw Invalid("Composite source identities require the explicitly approved v2 contract.");return new("column",[],"column");}
        if(!configuration.TryGetProperty("identityPolicy",out var policy))throw Invalid("Approve the v2 source identity and revision policy before collection.");
        Keys(policy,"schema","eventKey","revision");
        if(policy.GetProperty("schema").GetString()!=Rules.GetProperty("identityRulesV2").GetProperty("schema").GetString())throw Invalid("The source identity policy version is unsupported.");
        var key=policy.GetProperty("eventKey");var revision=policy.GetProperty("revision");Keys(key,"kind","fields");Keys(revision,"kind");
        var kind=key.GetProperty("kind").GetString();var revisionKind=revision.GetProperty("kind").GetString();
        if(kind is not("column" or "composite")||revisionKind is not("column" or "source_as_of" or "immutable_event"))throw Invalid("Choose a documented source identity and revision policy.");
        var fields=key.TryGetProperty("fields",out var values)?Strings(values):[];
        if(kind=="column"&&key.TryGetProperty("fields",out _))throw Invalid("A column identity cannot accept composite components.");
        if(kind=="composite")
        {
            if(fields.Length is <2 or >8||fields.Distinct(StringComparer.Ordinal).Count()!=fields.Length||fields.Any(f=>!Strings(Rules.GetProperty("identityFieldsV2")).Contains(f)))throw Invalid("Choose two to eight distinct mapped business identity components.");
            foreach(var field in fields)if(!mapping.ContainsKey(field)&&!(field=="property"&&constants.ContainsKey(field)))throw Invalid("Map every approved identity component to its actual source field.");
            string[] required=profileId=="packproof.order-lines/v1"?["orderId","orderLineId","property"]:profileId=="packproof.shipment-handling-units/v1"?["orderId","orderLineId","shipmentId","property"]:["shipmentId","property"];
            if(required.Any(f=>!fields.Contains(f)))throw Invalid("The composite key does not identify the approved source row grain.");
            if(mapping.ContainsKey("orderLineId")&&(!fields.Contains("orderId")||!fields.Contains("orderLineId")))throw Invalid("An order-line identity requires its explicit parent order and line components.");
            foreach(var field in Strings(Rules.GetProperty("identityFieldsV2")).Where(f=>f is not("sourceEventId" or "sourceSequence" or "property")))if(mapping.ContainsKey(field)&&!fields.Contains(field))throw Invalid("Every mapped entity identifier at the observed row grain must be retained in its composite identity.");
            if(constants.TryGetValue("property",out var property))
            {
                if(property is "labelStatus" or "carrierCode" or "carrierAccountReference" or "carrierService" or "carrierAcceptanceStatus" && !fields.Contains("trackingId"))throw Invalid("A tracking assertion requires its actual tracking identity component.");
                if(property is "expectedHandoffStatus" or "loadingHandoffStatus" or "receiptHandoffStatus" or "expectedHandoffAt" && !fields.Contains("handlingUnitId"))throw Invalid("A handoff assertion requires its actual handling-unit identity component.");
            }
        }
        else if(!mapping.ContainsKey("sourceEventId"))throw Invalid("Map the actual source event identity column.");
        if(revisionKind=="column"&&!mapping.ContainsKey("sourceRevision")||revisionKind!="column"&&mapping.ContainsKey("sourceRevision")||revisionKind=="source_as_of"&&!mapping.ContainsKey("sourceAsOf"))throw Invalid("Map the actual approved revision basis without silently discarding a source revision.");
        if(constants.TryGetValue("observationKind",out var observationKind))
        {
            if(observationKind=="event"&&revisionKind=="source_as_of"||observationKind!="event"&&revisionKind=="immutable_event")throw Invalid("The source observation and revision policy disagree.");
            if(observationKind=="event"&&kind=="composite"&&!fields.Any(f=>f is "sourceEventId" or "sourceSequence"))throw Invalid("An event composite needs an actual event ID or source sequence.");
        }
        return new(kind!,fields,revisionKind!);
    }
    private static string CompositeIdentity(string[] fields,Func<string,string?> get)
    {
        var result=new StringBuilder(Rules.GetProperty("identityRulesV2").GetProperty("prefix").GetString());
        foreach(var field in fields){var value=Text(get(field),field);result.Append(field.Length).Append(':').Append(field).Append(Encoding.UTF8.GetByteCount(value)).Append(':').Append(value);}
        var key=result.ToString();if(Encoding.UTF8.GetByteCount(key)>1024)throw Invalid("The composite source identity exceeds 1,024 UTF-8 bytes.");return key;
    }
    private static string SnapshotRevision(string? value)
    {
        var at=Time(value);if(at is null)throw Invalid("A snapshot revision requires its actual source-reported as-of boundary.");
        return "snapshot:"+DateTimeOffset.Parse(at,CultureInfo.InvariantCulture).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'",CultureInfo.InvariantCulture);
    }
    private static Dictionary<string,object?> Reference(string ns,string type,string id) => new(){{"namespace",ns},{"type",type},{"externalId",Text(id,"entity identifier")}};
    public static IReadOnlyList<TypedSourceRowPreview> Preview(byte[] bytes,JsonElement configuration)
    {
        var parsed=FolderSource.Parse(bytes); var profileId=Text(configuration.GetProperty("sourceProfile").GetString(),"source profile");
        var schema=configuration.TryGetProperty("batchSchema",out var configured)?configured.GetString():configuration.TryGetProperty("schema",out var envelopeSchema)?envelopeSchema.GetString():Schema;
        var v2=schema==SchemaV2;if(schema!=Schema&&!v2)throw Invalid("Install the collector matching this source contract version.");
        var profiles=Rules.GetProperty("profiles").EnumerateArray().ToArray().AsEnumerable();if(v2)profiles=profiles.Concat(Rules.GetProperty("profilesV2").EnumerateArray());
        var profile=profiles.FirstOrDefault(p=>p.GetProperty("id").GetString()==profileId);
        if(profile.ValueKind!=JsonValueKind.Object)throw Invalid("Install the matching source profile version before collecting this export.");
        var ns=Text(configuration.GetProperty("sourceNamespace").GetString(),"source namespace");
        if(v2&&(Encoding.UTF8.GetByteCount(ns)>200||configuration.TryGetProperty("locationId",out var site)&&site.ValueKind==JsonValueKind.String&&Encoding.UTF8.GetByteCount(site.GetString()!)>200))throw Invalid("Version two source namespace and site identity are bounded to 200 UTF-8 bytes each.");
        var mapping=configuration.GetProperty("mapping").EnumerateObject().ToDictionary(p=>p.Name,p=>Text(p.Value.GetString(),"mapped heading"),StringComparer.Ordinal);
        var constants=configuration.TryGetProperty("constants",out var c)?c.EnumerateObject().ToDictionary(p=>p.Name,p=>Text(p.Value.GetString(),"declared source constant",100),StringComparer.Ordinal):new Dictionary<string,string>(StringComparer.Ordinal);
        var fields=Strings(Rules.GetProperty(v2?"csvFieldsV2":"csvFields"));
        if(mapping.Keys.Any(k=>!fields.Contains(k))||mapping.Values.Distinct(StringComparer.Ordinal).Count()!=mapping.Count||mapping.Values.Any(h=>!parsed.Headers.Contains(h,StringComparer.Ordinal)))throw Invalid("The export headings differ from the approved mapping. Review this source before collection.");
        if(constants.Any(p=>p.Key is not("observationKind" or "property" or "timeQuality")||mapping.ContainsKey(p.Key)))throw Invalid("Only explicitly approved source constants may supplement mapped fields.");
        var identity=Identity(configuration,mapping,constants,profileId,v2);
        if(!v2)foreach(var key in new[]{"sourceEventId","sourceRevision"})if(!mapping.ContainsKey(key))throw Invalid("Stable source identity and revision columns are required.");
        foreach(var key in new[]{"observationKind","property","timeQuality"})if(!mapping.ContainsKey(key)&&!constants.ContainsKey(key))throw Invalid("Declare observation meaning, property and time quality explicitly.");
        if(configuration.TryGetProperty("expectedHeaders",out var expected)&&!parsed.Headers.SequenceEqual(Strings(expected),StringComparer.Ordinal))throw Invalid("Source headings changed. The approved mapping must be reviewed.");
        var result=new List<TypedSourceRowPreview>();
        for(var i=0;i<parsed.Rows.Count;i++)
        {
            try
            {
                var raw=parsed.Rows[i]; string? Get(string key)=>mapping.TryGetValue(key,out var heading)?raw[heading] is var value&&value.Length>0?value:null:constants.GetValueOrDefault(key);
                string? kind=Get("observationKind"),quality=Get("timeQuality"),property=Get("property");
                var tracking=v2&&property is "labelStatus" or "carrierCode" or "carrierAccountReference" or "carrierService" or "carrierAcceptanceStatus";
                var handoff=v2&&property is "expectedHandoffStatus" or "loadingHandoffStatus" or "receiptHandoffStatus" or "expectedHandoffAt";
                if(v2&&identity.EventKind=="composite"&&(kind=="event"&&!identity.Fields.Any(f=>f is "sourceEventId" or "sourceSequence")||tracking&&!identity.Fields.Contains("trackingId")||handoff&&!identity.Fields.Contains("handlingUnitId")))throw Invalid("The composite key does not identify this actual event or operational subject.");
                string? sourceEventId=v2&&identity.EventKind=="composite"?CompositeIdentity(identity.Fields,Get):Text(Get("sourceEventId"),"source event identity",v2?2048:200);
                if(v2&&Encoding.UTF8.GetByteCount(sourceEventId)>1024)throw Invalid("The source event identity exceeds 1,024 UTF-8 bytes.");
                string? revision=v2&&identity.RevisionKind=="source_as_of"?kind=="event"?throw Invalid("An event cannot use a snapshot revision."):SnapshotRevision(Get("sourceAsOf")):v2&&identity.RevisionKind=="immutable_event"?kind!="event"?throw Invalid("Immutable-event revisions require actual source events."):Rules.GetProperty("identityRulesV2").GetProperty("immutableRevision").GetString():Text(Get("sourceRevision"),"source revision",100);
                if(v2&&Encoding.UTF8.GetByteCount(revision!)>200)throw Invalid("The source revision exceeds 200 UTF-8 bytes.");
                if(kind is not("event" or "snapshot" or "correction" or "tombstone")||quality is not("event_time" or "snapshot_time_only" or "unknown")||property is null||!Strings(profile.GetProperty("allowedProperties")).Contains(property))throw Invalid("The source property or observation meaning is not supported by its approved profile.");
                string? occurredAt=Time(Get("occurredAt")),asOf=Time(Get("sourceAsOf"));
                if(quality=="event_time"&&occurredAt is null||quality=="snapshot_time_only"&&(asOf is null||occurredAt is not null)||quality=="unknown"&&(occurredAt is not null||asOf is not null)||kind=="event"&&(quality!="event_time"||occurredAt is null))throw Invalid("The reported time and declared time quality disagree.");
                var references=new List<Dictionary<string,object?>>();
                foreach(var entry in Rules.GetProperty("csvReferenceFields").EnumerateObject())if(Get(entry.Name) is { } id){var reference=Reference(ns,entry.Value.GetString()!,id);if(entry.Value.GetString()=="order_line")reference["parentExternalId"]=Text(Get("orderId"),"parent order identifier");references.Add(reference);}
                Dictionary<string,object?>? Ref(string type)=>references.FirstOrDefault(r=>(string)r["type"]! == type);
                if(references.Count==0||Strings(profile.GetProperty("requiredReferences")).Any(type=>Ref(type) is null)||profileId.StartsWith("packproof.operational-observations/",StringComparison.Ordinal)&&!new[]{"order","order_line","shipment","handling_unit","return"}.Any(t=>Ref(t)is not null))throw Invalid("The source lacks an explicit required operational identity.");
                var relationships=new List<Dictionary<string,object?>>();
                foreach(var relationship in Rules.GetProperty("csvRelationships").EnumerateArray())
                {
                    var fromTypes=relationship.GetProperty("from"); var from=fromTypes.ValueKind==JsonValueKind.Array?fromTypes.EnumerateArray().Select(t=>Ref(t.GetString()!)).FirstOrDefault(r=>r is not null):Ref(fromTypes.GetString()!);var to=Ref(relationship.GetProperty("to").GetString()!);
                    if(from is not null&&to is not null)relationships.Add(new(){{"from",from},{"to",to},{"type",relationship.GetProperty("type").GetString()},{"quantity",null}});
                }
                if(v2&&Ref("order_line") is null&&Ref("shipment") is { } containing&&Ref("handling_unit") is { } unitReference)relationships.Add(new(){{"from",containing},{"to",unitReference},{"type","contains"},{"quantity",null}});
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
                var subject=tracking?Ref("tracking"):handoff?Ref("handling_unit"):Ref("order_line")??Ref("shipment")??Ref("handling_unit")??Ref("return")??Ref("order");
                if(kind!="tombstone"&&subject is null)throw Invalid("An assertion needs an explicit operational subject.");
                if(kind!="tombstone"&&tracking&&(Ref("tracking") is null||Ref("shipment") is null))throw Invalid("Label and carrier assertions require their tracking unit and shipment.");
                if(kind!="tombstone"&&handoff&&(Ref("handling_unit") is null||Ref("shipment") is null||Ref("load") is null||Ref("stop") is null))throw Invalid("Handoff assertions require the explicit unit, shipment, load and stop.");
                if(property=="expectedHandoffAt"&&kind!="tombstone")_=Time(Get("value"))??throw Invalid("The expected handoff deadline must be an explicit-offset planned time.");
                if(kind!="tombstone"&&(profileId=="packproof.order-lines/v1"&&(!quantity||Ref("order_line") is null)||profileId=="packproof.shipment-handling-units/v1"&&(property!="allocatedQuantity"||Ref("order_line") is null)))throw Invalid("The profile requires the appropriate explicit line quantity.");
                var superseded=Get("supersedesRevision");if(superseded is not null)superseded=v2&&identity.RevisionKind=="source_as_of"?SnapshotRevision(superseded):Text(superseded,"superseded revision",100); if(v2&&superseded is not null&&Encoding.UTF8.GetByteCount(superseded)>200)throw Invalid("The superseded revision exceeds 200 UTF-8 bytes.");if((kind is "correction" or "tombstone")&&superseded is null||superseded==revision||v2&&identity.RevisionKind=="immutable_event"&&superseded is not null)throw Invalid("A correction must explicitly identify a different source revision; immutable events cannot be corrected.");
                var assertions=new List<Dictionary<string,object?>>();if(kind!="tombstone")assertions.Add(new(){{"subjectReference",subject},{"property",property},{"value",value},{"sourceLocator",new Dictionary<string,object?>{{"row",i+2},{"field",mapping.GetValueOrDefault(quantity?"amount":"value")??"declared property"}}},{"assurance","source_reported"}});
                var normalized=Json.Element(new Dictionary<string,object?>{{"sourceEventId",sourceEventId},{"sourceRevision",revision},{"observationKind",kind},{"occurredAt",occurredAt},{"sourceAsOf",asOf},{"timeQuality",quality},{"references",references},{"assertions",assertions},{"relationships",relationships},{"supersedes",superseded is null?null:new Dictionary<string,object?>{{"sourceEventId",sourceEventId},{"sourceRevision",superseded}}},{"originSystem",Get("originSystem") is { } origin?Text(origin,"origin system"):null},{"copiedFromSource",Get("copiedFromSource") is { } copied?Text(copied,"copied source"):null}});
                if(v2)
                {
                    object? Locator(string field)=>mapping.TryGetValue(field,out var heading)?new Dictionary<string,object?>{{"row",i+2},{"field",heading}}:null;
                    var components=(identity.EventKind=="composite"?identity.Fields:["sourceEventId"]).Select(field=>new Dictionary<string,object?>{{"field",field},{"value",Get(field)},{"sourceLocator",Locator(field)},{"approvedConstant",!mapping.ContainsKey(field)}}).ToArray();
                    var revisionField=identity.RevisionKind=="column"?"sourceRevision":identity.RevisionKind=="source_as_of"?"sourceAsOf":null;
                    var values=normalized.EnumerateObject().ToDictionary(p=>p.Name,p=>(object?)p.Value);
                    values["identityDerivation"]=new Dictionary<string,object?>{{"schema","packproof.source-identity-derivation/v1"},{"eventKey",new{kind=identity.EventKind,components}},{"revision",new Dictionary<string,object?>{{"kind",identity.RevisionKind},{"sourceValue",revisionField is null?null:Get(revisionField)},{"sourceLocator",revisionField is null?null:Locator(revisionField)}}}};
                    normalized=Json.Element(values);
                }
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
        if(observation.TryGetProperty("identityDerivation",out var derivation))
        {
            var key=derivation.GetProperty("eventKey");var revision=derivation.GetProperty("revision").EnumerateObject().Where(p=>p.Name!="sourceLocator").ToDictionary(p=>p.Name,p=>(object?)p.Value);
            if(derivation.GetProperty("revision").GetProperty("kind").GetString()=="source_as_of")
            {
                string Instant(string text)=>DateTimeOffset.Parse(text,CultureInfo.InvariantCulture).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'",CultureInfo.InvariantCulture);
                revision["sourceValue"]=Instant(derivation.GetProperty("revision").GetProperty("sourceValue").GetString()!);value["sourceAsOf"]=Instant(observation.GetProperty("sourceAsOf").GetString()!);
            }
            value["identityDerivation"]=new{schema=derivation.GetProperty("schema"),eventKey=new{kind=key.GetProperty("kind"),components=key.GetProperty("components").EnumerateArray().Select(c=>c.EnumerateObject().Where(p=>p.Name!="sourceLocator").ToDictionary(p=>p.Name,p=>(object?)p.Value)).ToArray()},revision};
        }
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

using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PackProof.Connect;

public sealed record WorkflowColumnMap(string Role,Dictionary<string,string> Columns,Dictionary<string,string> ReferenceSources);

public static partial class SourceReaders
{
    public static WorkflowColumnMap? ProposeWorkflowMap(SourceReadResult input,string role,string sourceId,IReadOnlyDictionary<string,string> relatedSources)
    {
        if(input.State!="parsed"||input.Rows.Count==0||!IdentityPart(sourceId))return null;
        var columns = WorkflowHeaders(input.Headers);
        if (columns == null || !FitsWorkflow(role,columns)) return null;
        bool fullTracking = TrackingColumns(columns);
        var references=new Dictionary<string,string>(StringComparer.Ordinal);
        foreach(var (entity,targetRole) in ReferenceRole)
        {
            if(targetRole==role || !columns.ContainsKey(entity+"Id") || entity=="tracking"&&!fullTracking)continue;
            if(relatedSources.TryGetValue(targetRole,out var target)&&IdentityPart(target))references[entity]=target;
        }
        // A foreign column without a confirmed producer is only a source fact. It cannot join orders.
        if(references.Count==0)return null;
        return new(role,columns,references);
    }
    public static string WorkflowProfileVersion(WorkflowColumnMap map)
    {
        var identity=new {map.Role,columns=map.Columns.OrderBy(p=>p.Key,StringComparer.Ordinal),relations=map.ReferenceSources.OrderBy(p=>p.Key,StringComparer.Ordinal)};
        return "packproof.workflow-columns/v1/"+Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(identity)));
    }

    // Source publication or actual monotonic revision orders updates. A file's local appearance time is insufficient.
    private static string? PublishedVersion(string? version,string? asOf,string? eventId,string? occurred)
    {
        if(version!=null && Regex.IsMatch(version,@"^[0-9]{1,30}$"))return version;
        if(asOf!=null && SourceInstant(asOf,out var parsed))return parsed.UtcTicks.ToString(CultureInfo.InvariantCulture);
        if(IdentityPart(eventId)&&occurred!=null && SourceInstant(occurred,out _))return "immutable";
        return null;
    }
    private static bool SourceInstant(string value,out DateTimeOffset result)
    {
        result=default;
        return Regex.IsMatch(value,@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$") &&
            DateTimeOffset.TryParse(value,CultureInfo.InvariantCulture,DateTimeStyles.None,out result);
    }
    private static string? TrackingSpace(string source,string? carrier,string? account,string? period)
    {
        if(!IdentityPart(source)||!IdentityPart(carrier)||!IdentityPart(account)||!IdentityPart(period))return null;
        // A date column must express the originating shipment period. A delivery timestamp is never substituted.
        string basis=period!;
        if(!DateOnly.TryParseExact(basis,"yyyy-MM-dd",CultureInfo.InvariantCulture,DateTimeStyles.None,out _) &&
            !DateOnly.TryParseExact(basis+"-01","yyyy-MM-dd",CultureInfo.InvariantCulture,DateTimeStyles.None,out _))return null;
        return "tracking/"+Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new[]{source,carrier!.ToUpperInvariant(),account,basis})));
    }

    public static JsonElement NormalizeWorkflow(SourceReadResult input,string sourceId,WorkflowColumnMap map)
    {
        if(input.State!="parsed"||!IdentityPart(sourceId)||!OperationalRoles.TryGetValue(map.Role,out var rule)||
            map.Columns.Values.Any(c=>!input.Headers.Contains(c,StringComparer.Ordinal)))return Val(Array.Empty<object>());
        var records=new List<JsonElement>();
        try
        {
            foreach(var raw in input.Rows)
            {
                string? Get(string semantic)=>map.Columns.TryGetValue(semantic,out var key)?Scalar(raw.Fields,key):null;
                var utc=Get(rule.time)??Get("eventAt");
                var immutableId=Get("eventId")??(map.Role is "handoff" or "delivery"?Get(rule.subject+"Id"):null);
                var version=PublishedVersion(Get("version"),Get("asOf"),immutableId,utc);
                Require(version!=null,"The source requires a stable version or published update time.");
                var subject=rule.subject;
                string? id=Get(subject+"Id"),ns=sourceId;
                if(map.Role=="shipping" && TrackingColumns(map.Columns))
                {
                    string? track=Get("trackingId");
                    string? candidate=TrackingSpace(sourceId,Get("trackingCarrier"),Get("trackingAccount"),Get("trackingPeriod"));
                    if(IdentityPart(track)&&candidate!=null){subject="tracking";id=track;ns=candidate;}
                }
                if(map.Role is "delivery" or "handoff")id??=Get("eventId");
                Require(IdentityPart(id)&&ns!=null,"The operational entity is missing its stable source identity.");
                var kind=RoleKinds[map.Role];string status=Heading(Get("state")??"");
                bool confirmed= !string.IsNullOrWhiteSpace(Get(rule.time));
                bool reportedPositive=rule.quantity!=""&&decimal.TryParse(Get(rule.quantity),NumberStyles.AllowDecimalPoint,CultureInfo.InvariantCulture,out var reported)&&reported>0;
                if(map.Role=="picking" && !confirmed && !reportedPositive && status is not("picked" or "pickcomplete"))kind="evidence";
                if(map.Role=="packing" && !confirmed && !reportedPositive && status is not("packed" or "sealed"))kind="evidence";
                if(map.Role=="shipping" && !confirmed && status is not("labelcreated" or "labelprinted"))kind="evidence";
                if(map.Role=="delivery" && !confirmed && status is not("delivered" or "signed" or "receivedbyconsignee"))kind="evidence";
                if(map.Role=="handoff" && !confirmed && status is not("handedoff" or "dispatched" or "departed"))kind="evidence";
                if(map.Role=="returns" && !confirmed && status is not("received" or "inspected")&&!reportedPositive)kind="evidence";

                var links=new List<object>();
                foreach(var (entity,target) in map.ReferenceSources)
                {
                    var external=Get(entity+"Id");if(string.IsNullOrEmpty(external))continue;
                    string? space=entity=="tracking"?TrackingSpace(target,Get("trackingCarrier"),Get("trackingAccount"),Get("trackingPeriod")):target;
                    if(space!=null)links.Add(Reference(space,entity,external));
                }
                if(subject=="tracking" && Get("shipmentId") is {} shipment)links.Add(Reference(sourceId,"shipment",shipment));
                Require(links.Count>0,"A record needs an explicit reference to its related source.");
                var eventId=Get("eventId")??"row/"+Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(
                    new[]{sourceId,map.Role,subject,id,Get("orderId"),Get("lineId"),Get("packageId"),Get("shipmentId"),Get("trackingId")})));
                var fields=new Dictionary<string,JsonElement>(raw.Fields,StringComparer.Ordinal);
                var canonical=new Dictionary<string,JsonElement>{
                    ["kind"]=Val(kind),["eventId"]=Val(eventId),["version"]=Val(version),["entityNamespace"]=Val(ns),
                    ["entityType"]=Val(subject),["entityId"]=Val(id),["references"]=Val(links)
                };
                if(utc!=null)canonical["occurredAt"]=Val(utc);
                if(Get("asOf") is {} modified)canonical["sourceModifiedAt"]=Val(modified);
                foreach(var key in new[]{"lineId","sku","unit"}.Concat(WorkflowAmounts(map.Role,rule.quantity)))
                    if(map.Columns.TryGetValue(key,out var sourceField)&&raw.Fields.TryGetValue(sourceField,out var val))canonical[key]=val;
                // The normalizer enforces exact decimals, time offsets and bounded references for every representation.
                var lineage=new Dictionary<string,string>(StringComparer.Ordinal);
                foreach(var (key,heading) in map.Columns)if(raw.Lineage.TryGetValue(heading,out var location))lineage[key]=location;
                CopyFacility(raw,canonical,lineage);
                var translated=new SourceReaderRow(raw.Location,canonical,lineage);
                string normalizedRole=kind=="evidence"?"evidence":map.Role;
                var canonicalRecords=Normalize(input with {Rows=[translated]},normalizedRole);
                Require(canonicalRecords.GetArrayLength()==1,"A source row is missing its approved semantics.");
                var record=canonicalRecords[0].EnumerateObject().ToDictionary(p=>p.Name,p=>p.Value.Clone(),StringComparer.Ordinal);
                record["fields"]=Val(WireFields(fields));records.Add(Val(record));
            }
        }
        catch(InvalidDataException){return Val(Array.Empty<object>());}
        return Val(records);
    }
}

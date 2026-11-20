using System.Diagnostics;
using System.Globalization;
using System.Text.Json;

namespace PackProof.Connect;

public sealed partial class AgentRuntime
{
    // Preview is interactive and local. It never advances inventory, creates a receipt,
    // or uploads files while the operation's scope is awaiting approval.
    private object FacilityComparisonPreview(JsonElement p,CancellationToken ct)
    {
        if(p.ValueKind!=JsonValueKind.Object || !p.TryGetProperty("expectedRevision",out var revision)) return WorkspaceDraftPreview(ct);
        var workspace=Draft();
        var draft=FacilityDraft(workspace);
        if(revision.GetInt32()!=draft.Revision || p.GetProperty("draftId").GetString()!=draft.Id)
            throw new ConnectException("DRAFT_CHANGED","Reopen the current draft before comparing source rules.");
        if(!p.TryGetProperty("previous",out var previous)) return WorkspaceDraftPreview(ct);
        var alternative=draft.Inputs with {
            Rules=previous.GetProperty("rules").Deserialize<FacilityRule[]>(Json.Options) ?? [],
            Packing=previous.GetProperty("packing").Deserialize<FacilityPacking[]>(Json.Options) ?? []
        };
        FacilityProfile.Validate(alternative,workspace.Sources);
        var preview=new FacilityProfile {ScopeKey=draft.ScopeKey,Inputs=alternative};
        return WorkspaceDraftPreview(ct,profileOverride:preview);
    }

    private object WorkspaceDraftPreview(CancellationToken ct, WorkspaceSource[]? selected=null, List<SourceCheck>? checks=null, FacilityExample[]? expected=null,FacilityProfile? profileOverride=null)
    {
        if (ServerState == "revoked" || checkpointed || state.CredentialRecoveryConfirmedAt is not null || state.Token is not null && !CurrentInstallation)
            throw new ConnectException("AUTH_REQUIRED", "Reconnect the computer to preview these sources.");
        var inputs = new List<DraftPreviewEvent>();
        var originals=new List<string[]>();
        var scanned = 0;
        var unread = 0;
        var sampled = false;
        long totalBytes = 0;
        var clock = Stopwatch.StartNew();
        FacilityRecordEdit[]? previewEdits=null;
        if (selected is null && GuidedSetupAvailable)
        {
            var draft=profileOverride ?? FacilityDraft(Draft());
            selected=draft.Candidates(Draft());
            previewEdits=draft.Inputs.RecordEdits;
            expected=draft.Inputs.Examples;
        }
        var references=expected?.Select(e=>e.Reference).Where(r=>!string.IsNullOrWhiteSpace(r)).ToHashSet(StringComparer.Ordinal);
        var targeted=references is {Count:>0};
        int fileLimit=targeted?24:3;
        foreach (var source in (selected ?? Draft().Sources.ToArray()).Where(s => !s.Paused && s.Roles.Count > 0))
        {
            ct.ThrowIfCancellationRequested();
            if (source.Transport!="folder") {
                checks?.Add(new(source.Id,false,"This connection needs a representative read through its approved transport. Defer it to test the available exports.")); continue;
            }
            if (clock.Elapsed > TimeSpan.FromSeconds(10) || totalBytes >= 16L * 1024 * 1024) {
                sampled = true; checks?.Add(new(source.Id,false,"This source was outside the bounded sample. Choose a smaller sample.")); continue;
            }
            bool qualified=false,failedRead=false,meaningSeen=source.ShippedAtMeaning is null or "unknown",
                weightSeen=source.PackingReader?.Rule.Unit is null;
            var sampleDigests=checks is null?null:new List<string>();
            try
            {
                var folder = FolderSource.ValidateWorkspaceRoot(source.Folder);
                ValidateProofSourceFolder(folder);
                using var pin = new ProofOutputPaths.DirectoryPin(folder);
                if(source.PhysicalRoot is { } prior && pin.KeyStrings.FirstOrDefault()!=prior)
                    throw new ConnectException("SOURCE_REPLACED","Choose the replacement source again.");
                var sample = Optional(source.Recognition, "fileName")?.GetString();
                var candidates = PrioritizeSample(WorkspaceFiles(folder), sample).Take(fileLimit+1).ToArray();
                if (candidates.Length > fileLimit) sampled = true;
                foreach (var path in candidates.Take(fileLimit))
                {
                    ct.ThrowIfCancellationRequested();
                    if (totalBytes >= 16L * 1024 * 1024 || clock.Elapsed > TimeSpan.FromSeconds(10)) { sampled = true; break; }
                    try
                    {
                        var name = Path.GetFileName(path);
                        var bytes = FolderSource.WorkspaceSnapshot(folder, name);
                        scanned++;
                        totalBytes += bytes.Length;
                        var parsed = SourceReaders.Read(name, bytes);
                        originals.Add([source.Id,name,parsed.ContentSha256]);
                        sampleDigests?.Add(parsed.ContentSha256);
                        var rows = WorkspaceRecords(source, parsed);
                        if(source.PackingReader!=null && rows.Any(r=>Optional(Optional(r,"fields"),"qualifiedCartonWeightUnit")?.ValueKind==JsonValueKind.String))
                            weightSeen=true;
                        var role=source.ShippedAtMeaning=="label"?"shipping":"handoff";
                        if (source.ApprovedWorkflows().Any(m=>m.Role==role) &&
                            parsed.Headers.Count(h=>h.Replace(" ","",StringComparison.Ordinal).Equals("ShippedAt",StringComparison.OrdinalIgnoreCase))==1 &&
                            rows.Any(r=>Optional(r,"kind")?.GetString()==source.ShippedAtMeaning && Optional(r,"occurredAt")?.ValueKind==JsonValueKind.String)) meaningSeen=true;
                        if(rows.Length>0 || source.Roles.Contains("evidence") && parsed.State=="recognized") qualified=true;
                        var rowLimit=targeted?Math.Max(0,4096-inputs.Count):8;
                        if (rows.Length > rowLimit) sampled = true;
                        foreach (var row in rows.Take(rowLimit)) inputs.Add(new(source.Id, Path.GetFileName(folder), name, row,
                            source.Generation, parsed.ContentSha256, source.ProfileVersion, source.PackingReader!=null));
                        if (rows.Length == 0) unread++;
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ConnectException) { unread++; failedRead=true; }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ConnectException) { unread++; failedRead=true; }
            checks?.Add(new(source.Id,qualified && !failedRead && meaningSeen && weightSeen,failedRead ?
                "The collection service could not read this sample. Restore access or defer this source." :
                !meaningSeen ? "The selected meaning did not match a confirmed source field and event. Review the source mapping." :
                !weightSeen ? "The sample did not confirm the chosen weight value and unit. Check the source fields or leave the unit unknown." :
                qualified ? "The collection service read a representative record." : "Confirm a supported mapping and stable identifiers, or defer this source.",sampleDigests?.ToArray()));
        }
        var basis=HashBytes(Json.Bytes(originals.OrderBy(o=>o[0],StringComparer.Ordinal).ThenBy(o=>o[1],StringComparer.Ordinal)));
        return WorkspacePreview.Build(inputs, scanned, unread, sampled, previewEdits,targeted?references:null,includeOtherExamples:checks==null,sampleBasis:basis);
    }
}

internal sealed record DraftPreviewEvent(string SourceId, string SourceName, string Filename, JsonElement Record,
    int Generation=0,string OriginalSha256="",string ProfileVersion="",bool VerifiedPacking=false);

internal static class WorkspacePreview
{
    // No filename, displayed order number, time, SKU or location is a relationship.
    // Namespaces and entity types come exclusively from the validated source profile.
    private sealed record Reference(string Space, string Type, string Id);
    private static string Text(JsonElement value, string key) =>
        value.TryGetProperty(key, out var field) && field.ValueKind == JsonValueKind.String ? field.GetString()! : "";
    private static Reference Ref(JsonElement item) => new(Text(item,"namespace"), Text(item,"type"), Text(item,"id"));
    private static Reference Entity(DraftPreviewEvent e) => Ref(e.Record.GetProperty("entity"));
    private static IEnumerable<Reference> References(DraftPreviewEvent e) => e.Record.GetProperty("references").EnumerateArray().Select(Ref);
    private static string Kind(DraftPreviewEvent e) => Text(e.Record,"kind");

    private static string RecordHash(DraftPreviewEvent e) => Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(
        Json.Bytes(new {e.SourceId,e.Generation,e.OriginalSha256,e.Record})));

    internal static object Build(IEnumerable<DraftPreviewEvent> inputs, int scanned, int unread, bool sampled,FacilityRecordEdit[]? edits=null,
        IReadOnlySet<string>? wanted=null,bool includeOtherExamples=false,string? sampleBasis=null)
    {
        var events = new List<DraftPreviewEvent>();
        var uncertain = 0;
        foreach (var group in inputs.GroupBy(e => (e.SourceId, Event: Text(e.Record,"eventId"))))
        {
            var versions = group.GroupBy(e => Text(e.Record,"version")).ToArray();
            if (versions.Any(v=>v.Select(e=>e.Record.GetRawText()).Distinct().Skip(1).Any())) { uncertain++; continue; }
            if (versions.Length == 1) { events.Add(versions[0].First()); continue; }
            // Incomparable source versions need review; choosing a row by file order
            // could attach an earlier observation after a source correction.
            if (versions.Any(v => !System.Numerics.BigInteger.TryParse(v.Key, NumberStyles.None,
                CultureInfo.InvariantCulture, out _))) { uncertain++; continue; }
            events.Add(versions.OrderByDescending(v => System.Numerics.BigInteger.Parse(v.Key,CultureInfo.InvariantCulture)).First().First());
        }
        var roots = events.Where(e => Kind(e)=="order" && Entity(e).Type=="order")
            .GroupBy(Entity).Where(g=>g.Select(e=>e.SourceId).Distinct().Count()==1)
            .ToDictionary(g=>g.Key,g=>g.First());
        var parents = new Dictionary<Reference,HashSet<Reference>>();
        var direct = new Dictionary<Reference,HashSet<Reference>>();
        static void Add(Dictionary<Reference,HashSet<Reference>> map,Reference from,Reference to)
        {
            if(!map.TryGetValue(from,out var targets))map[from]=targets=[];
            targets.Add(to);
        }
        foreach(var e in events)
        {
            var entity=Entity(e);
            if (Kind(e)=="order" && roots.ContainsKey(entity))Add(direct,entity,entity);
            foreach(var target in References(e))
            {
                if(target.Type=="order") { if(roots.ContainsKey(target))Add(direct,entity,target); continue; }
                if(entity.Type=="order") { if(roots.ContainsKey(entity))Add(direct,target,entity); continue; }
                Add(parents,entity,target);
                if(Kind(e) is "picking" or "packing" or "label" && target.Type is "warehouse_order" or "warehouse" or "shipment" or "package" or "tracking")
                    Add(parents,target,entity);
            }
        }
        HashSet<Reference> Resolve(DraftPreviewEvent entry)
        {
            var targets=References(entry).Where(r=>r.Type=="order").ToArray();
            if(targets.Length>0)return targets.Where(roots.ContainsKey).ToHashSet();
            var entity=Entity(entry);
            if(entity.Type=="order")return roots.TryGetValue(entity,out var origin)&&origin.SourceId==entry.SourceId ? [entity] : [];
            var matches=new HashSet<Reference>();
            var queue=new Queue<Reference>();queue.Enqueue(entity);
            var seen=new HashSet<Reference>();
            while(queue.TryDequeue(out var node))
            {
                if(!seen.Add(node))continue;
                if(direct.TryGetValue(node,out var orders)){matches.UnionWith(orders);continue;}
                if(parents.TryGetValue(node,out var links))foreach(var link in links)queue.Enqueue(link);
            }
            return matches;
        }
        var members=events.Select(e=>(Event:e,Orders:Resolve(e))).ToArray();
        foreach(var (record,orders) in members)
        {
            if(edits is not {Length:>0} || orders.Count!=1 || Kind(record)=="order") continue;
            var from=orders.Single();
            var hash=RecordHash(record);
            var change=edits.FirstOrDefault(x=>x.SourceId==record.SourceId && x.RecordHash==hash && x.FromSpace==from.Space && x.FromId==from.Id);
            if(change is null) continue;
            var target=new Reference(change.ToSpace,"order",change.ToId);
            if(!roots.ContainsKey(target)) continue;
            orders.Clear(); orders.Add(target);
        }
        var matches=roots.Keys.ToHashSet();
        if(wanted is {Count:>0})
        {
            matches.Clear();
            foreach(var (key,origin) in roots)
            {
                var fields=origin.Record.GetProperty("fields");
                if(wanted.Contains(key.Id) || wanted.Contains(Text(fields,"orderReference")) || wanted.Contains(Text(fields,"sourceOrderName"))) matches.Add(key);
            }
            foreach(var (e,orders) in members)
                if(References(e).Append(Entity(e)).Any(r=>r.Type is "warehouse" or "warehouse_order" or "package" or "shipment" or "tracking" && wanted.Contains(r.Id)))
                    matches.UnionWith(orders);
        }
        var examples=roots.Where(p=>includeOtherExamples || matches.Contains(p.Key)).OrderByDescending(p=>matches.Contains(p.Key))
            .ThenBy(p=>p.Key.Space,StringComparer.Ordinal).ThenBy(p=>p.Key.Id,StringComparer.Ordinal).Take(6).Select(pair=>{
            var origin=pair.Value;
            var related=members.Where(m=>m.Orders.Contains(pair.Key)).ToArray();
            var orderReference=Text(origin.Record.GetProperty("fields"),"orderReference");
            var displayReference=Text(origin.Record.GetProperty("fields"),"sourceOrderName");
            var entities=related.Where(m=>m.Orders.Count==1).SelectMany(m=>References(m.Event).Append(Entity(m.Event)))
                .Where(r=>r.Type!="order" || r==pair.Key).Distinct().ToArray();
            var packages=entities.Where(r=>r.Type=="package").ToArray();
            var lines=related.Where(m=>m.Orders.Count==1 && Kind(m.Event)=="order")
                .SelectMany(m=>m.Event.Record.GetProperty("lines").EnumerateArray())
                .Select(l=>new {lineId=Text(l,"lineId"),sku=Text(l,"sku"),quantity=Text(l,"orderedQuantity"),unit=Text(l,"unit")})
                .Distinct().Take(12).ToArray();
            return new {
                orderReference=orderReference.Length>0?orderReference:pair.Key.Id,
                displayReference=displayReference.Length>0?displayReference:null,
                orderNamespace=pair.Key.Space,orderId=pair.Key.Id,
                lookupReferences=entities.Where(r=>r.Type is "order" or "warehouse" or "warehouse_order" or "package" or "shipment" or "tracking").Select(r=>r.Id).Prepend(displayReference).Where(id=>id.Length>0).Distinct().Take(128).ToArray(),
                cartonCount=packages.Length,labelCount=related.Count(m=>m.Orders.Count==1 && Kind(m.Event)=="label"),
                cartons=packages.Take(12).Select(p=>{
                    var observations=related.Where(m=>m.Orders.Count==1 && (Entity(m.Event)==p || References(m.Event).Contains(p)))
                        .Select(m=>m.Event).ToArray();
                    var last=observations.Where(e=>Kind(e) is "packing" or "label" or "handoff" or "delivery").OrderByDescending(e=>
                        DateTimeOffset.TryParse(Text(e.Record,"occurredAt"),CultureInfo.InvariantCulture,DateTimeStyles.None,out var t)?t:DateTimeOffset.MinValue).FirstOrDefault();
                    return new {id=p.Id,@namespace=p.Space,status=observations.Any(e=>Kind(e)=="delivery")?"delivered":"awaiting_evidence",
                        lastKind=last==null?null:Kind(last),occurredAt=last==null?null:Text(last.Record,"occurredAt")};
                }),
                source=origin.SourceName, lines,
                packages=packages.Select(r=>r.Id).Distinct().Take(12),
                events=related.OrderBy(m=>Text(m.Event.Record,"occurredAt"),StringComparer.Ordinal).Take(16).Select(m=>{
                    var e=m.Event;
                    var shared=m.Orders.Count>1;
                    var subject=Entity(e);
                    var references=References(e).Where(r=>r.Type!="order" || r==pair.Key)
                        .Take(32).Select(r=>new {@namespace=r.Space,r.Type,r.Id});
                    var lineage=e.Record.TryGetProperty("fieldLineage",out var fields) && fields.ValueKind==JsonValueKind.Object
                        ? fields.EnumerateObject().Where(f=>f.Value.ValueKind==JsonValueKind.String)
                            .Take(32).ToDictionary(f=>f.Name,f=>f.Value.GetString())
                        : null;
                    return new {
                        kind=Kind(e),source=e.SourceName,sourceId=e.SourceId,fileName=e.Filename,occurredAt=Text(e.Record,"occurredAt"),shared,
                        locator=Text(e.Record,"locator"),profileVersion=e.ProfileVersion,version=Text(e.Record,"version"),recordHash=RecordHash(e),
                        qualifiedWeight=e.VerifiedPacking && e.Record.TryGetProperty("fields",out var measured) ?
                            Text(measured,"qualifiedCartonWeight") : null,
                        qualifiedWeightUnit=e.VerifiedPacking && e.Record.TryGetProperty("fields",out var measuredUnit) ?
                            Text(measuredUnit,"qualifiedCartonWeightUnit") : null,
                        lines=shared || !e.Record.TryGetProperty("lines",out var amounts) || amounts.ValueKind!=JsonValueKind.Array?[]:amounts.EnumerateArray().Take(12)
                            .Select(l=>l.EnumerateObject().Where(f=>f.Value.ValueKind==JsonValueKind.String &&
                                f.Name is "lineId" or "sku" or "unit" or "orderedQuantity" or "pickedQuantity" or "packedQuantity" or "loadedQuantity"
                                    or "shippedQuantity" or "acknowledgedQuantity" or "backorderedQuantity" or "returnedQuantity" or "cancelledQuantity"
                                    or "packageId" or "cartonId" or "packageReference" or "shipmentReference").ToDictionary(f=>f.Name,f=>f.Value.GetString())).ToArray(),
                        entity=new {@namespace=subject.Space, subject.Type,subject.Id}, references, fieldLineage=lineage
                    };
                })
            };
        }).ToArray();
        return new {examples,sampleBasis,scannedFiles=scanned,unreadFiles=unread,unresolved=uncertain+members.Count(m=>m.Orders.Count==0),
            limited=sampled || matches.Count>examples.Length};
    }
}


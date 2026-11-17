using System.Diagnostics;
using System.Globalization;
using System.Text.Json;

namespace PackProof.Connect;

public sealed partial class AgentRuntime
{
    // Preview is interactive and local. It never advances inventory, creates a receipt,
    // or uploads files while the operation's scope is awaiting approval.
    private object WorkspaceDraftPreview(CancellationToken ct)
    {
        if (ServerState == "revoked" || checkpointed || state.CredentialRecoveryConfirmedAt is not null || state.Token is not null && !CurrentInstallation)
            throw new ConnectException("AUTH_REQUIRED", "Reconnect the computer to preview these sources.");
        var inputs = new List<DraftPreviewEvent>();
        var scanned = 0;
        var unread = 0;
        var sampled = false;
        long totalBytes = 0;
        var clock = Stopwatch.StartNew();
        foreach (var source in Draft().Sources.Where(s => !s.Paused && s.Roles.Count > 0 && !string.IsNullOrWhiteSpace(s.Folder)))
        {
            ct.ThrowIfCancellationRequested();
            if (clock.Elapsed > TimeSpan.FromSeconds(10) || totalBytes >= 16L * 1024 * 1024) { sampled = true; break; }
            try
            {
                var folder = FolderSource.ValidateWorkspaceRoot(source.Folder);
                ValidateProofSourceFolder(folder);
                var candidates = WorkspaceFiles(folder).Take(4).ToArray();
                if (candidates.Length > 3) sampled = true;
                foreach (var path in candidates.Take(3))
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
                        var rows = WorkspaceRecords(source, parsed);
                        if (rows.Length > 8) sampled = true;
                        foreach (var row in rows.Take(8)) inputs.Add(new(source.Id, Path.GetFileName(folder), name, row));
                        if (rows.Length == 0) unread++;
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ConnectException) { unread++; }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ConnectException) { unread++; }
        }
        return WorkspacePreview.Build(inputs, scanned, unread, sampled);
    }
}

internal sealed record DraftPreviewEvent(string SourceId, string SourceName, string Filename, JsonElement Record);

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

    internal static object Build(IEnumerable<DraftPreviewEvent> inputs, int scanned, int unread, bool sampled)
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
        var examples=roots.OrderBy(p=>p.Key.Space,StringComparer.Ordinal).ThenBy(p=>p.Key.Id,StringComparer.Ordinal).Take(6).Select(pair=>{
            var origin=pair.Value;
            var related=members.Where(m=>m.Orders.Contains(pair.Key)).ToArray();
            var orderReference=Text(origin.Record.GetProperty("fields"),"orderReference");
            var lines=related.Where(m=>m.Orders.Count==1 && Kind(m.Event)=="order")
                .SelectMany(m=>m.Event.Record.GetProperty("lines").EnumerateArray())
                .Select(l=>new {lineId=Text(l,"lineId"),sku=Text(l,"sku"),quantity=Text(l,"orderedQuantity"),unit=Text(l,"unit")})
                .Distinct().Take(12).ToArray();
            return new {
                orderReference=orderReference.Length>0?orderReference:pair.Key.Id,
                source=origin.SourceName, lines,
                packages=related.SelectMany(m=>References(m.Event).Append(Entity(m.Event))).Where(r=>r.Type=="package").Select(r=>r.Id).Distinct().Take(12),
                events=related.OrderBy(m=>Text(m.Event.Record,"occurredAt"),StringComparer.Ordinal).Take(16).Select(m=> new {
                    kind=Kind(m.Event),source=m.Event.SourceName,fileName=m.Event.Filename,occurredAt=Text(m.Event.Record,"occurredAt"),shared=m.Orders.Count>1
                })
            };
        }).ToArray();
        return new {examples,scannedFiles=scanned,unreadFiles=unread,unresolved=uncertain+members.Count(m=>m.Orders.Count==0),
            limited=sampled || roots.Count>examples.Length};
    }
}


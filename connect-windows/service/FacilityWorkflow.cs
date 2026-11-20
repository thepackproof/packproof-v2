using System.Text.Json;
using System.Text.Json.Serialization;

namespace PackProof.Connect;

public sealed record FacilityRecord(string Identifier, string TimeField, string Unit, string Format);
public sealed record FacilityStep(string Id, string Name, string Scope, string System, string Device,
    bool Optional, string[] After, FacilityRecord? Record = null);
public sealed record FacilityExample(string Kind, string Reference,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] int? Cartons,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] int? LabelCount);
public sealed record FacilityRule(string SourceId, string ShippedAt);
public sealed record FacilityTiming(string SourceId,int? ExpectedCheckIntervalSeconds,int? ExpectedDeliveryAfterLabelSeconds);
public record FacilityInputs(FacilityStep[] Steps, FacilityExample[] Examples, FacilityRule[] Rules, string[] ExcludedSourceIds,
    FacilityTiming[]? Timing=null,FacilityPacking[]? Packing=null,FacilityRecordEdit[]? RecordEdits=null);
public sealed record ReplayCheck(string Kind, string Reference, bool Passed, string Message);
public sealed record SourceCheck(string SourceId, bool Readable, string Message);
public sealed record FacilityReplay(bool Passed, string Digest, ReplayCheck[] Checks, SourceCheck[] Sources, DateTimeOffset TestedAt);

public sealed class FacilityProfile
{
    public const string Compiler = "packproof.facility-workflow/v1";
    public int Version { get; set; } = 1;
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public required string ScopeKey { get; set; }
    public int Revision { get; set; } = 1;
    public FacilityInputs Inputs { get; set; } = new(SeedSteps(), [], [], []);
    public FacilityReplay? Replay { get; set; }

    public object View() => new {Id, Revision, ScopeKey, Inputs.Steps, Inputs.Examples, Inputs.Rules, Inputs.ExcludedSourceIds,Inputs.Timing,Inputs.Packing,Inputs.RecordEdits,
        replay = Replay is null ? Json.Element((object?)null) : Json.Element(Replay)};

    private static FacilityStep[] SeedSteps() => [
        new("release","Release","order","","",false,[]),
        new("pick","Pick","line","","",false,["release"]),
        new("pack","Pack","carton","","",false,["pick"]),
        new("label","Print label","carton","","",false,["pack"]),
        new("handoff","Carrier handoff","shipment","","",false,["label"]),
        new("delivery","Delivery","carton","","",false,["handoff"])
    ];

    public static void Validate(FacilityInputs next, IEnumerable<WorkspaceSource> sources)
    {
        static bool Text(string? s) => s is {Length: <= 160} && !s.Any(char.IsControl);
        static bool Id(string? s) => s is {Length: >0 and <=160} && s.All(c=>char.IsAsciiLetterOrDigit(c)||c is '_' or '-');
        static void Require(bool condition)
        {
            if (!condition) throw new ConnectException("DRAFT_INVALID","Check the workflow steps, source choices and known-order expectations.");
        }
        Require(next.Steps is {Length: >0 and <=32} && next.Examples is {Length: <=3} &&
            next.Rules is {Length: <=24} && next.ExcludedSourceIds is {Length: <=24});
        var steps = new Dictionary<string,string[]>(StringComparer.Ordinal);
        foreach (var s in next.Steps)
        {
            Require(s is not null && Id(s.Id) && Text(s.Name) && !string.IsNullOrWhiteSpace(s.Name) && Text(s.System) && Text(s.Device) &&
                s.Scope is "order" or "line" or "carton" or "shipment" && s.After is {Length: <=32} &&
                s.After.All(Id) && s.After.Distinct().Count()==s.After.Length &&
                (s.Record is null || new[]{s.Record.Identifier,s.Record.TimeField,s.Record.Unit,s.Record.Format}.All(Text)));
            Require(steps.TryAdd(s!.Id,s.After));
        }
        var done = new HashSet<string>();
        bool Visit(string id, HashSet<string> pending)
        {
            if (done.Contains(id)) return true;
            if (!steps.TryGetValue(id,out var after) || !pending.Add(id)) return false;
            if (!after.All(p=>Visit(p,pending))) return false;
            pending.Remove(id); done.Add(id); return true;
        }
        Require(steps.Keys.All(id=>Visit(id,[])));
        Require(next.Examples.All(e=>e is not null && e.Kind is "ordinary" or "split" or "reprint" &&
            Text(e.Reference) && e.Cartons is not (<0 or >1000) && e.LabelCount is not (<0 or >1000)) &&
            next.Examples.Select(e=>e.Kind).Distinct().Count()==next.Examples.Length);
        var choices=sources.Where(s=>s.Roles.Count>0).ToDictionary(s=>s.Id);
        if (next.Packing is { } packing)
            Require(packing.Length<=24 && packing.Select(r=>r.SourceId).Distinct().Count()==packing.Length &&
                packing.All(r=>r!=null && choices.TryGetValue(r.SourceId,out var s) && s.Transport=="folder" && s.Roles.SequenceEqual(["packing"]) &&
                    choices.TryGetValue(r.OrderSourceId,out var order) && order.Roles.Contains("order") && order.Id!=s.Id &&
                    r.Schema is {Length:64} && r.Schema.All(char.IsAsciiHexDigit) && Text(r.CartonField) && r.CartonField.Length>0 &&
                    (r.WeightField==null || Text(r.WeightField) && r.WeightField!=r.CartonField) &&
                    (r.UnitField==null || Text(r.UnitField) && r.UnitField!=r.CartonField && r.UnitField!=r.WeightField && r.WeightField!=null) &&
                    (r.Unit==null || r.Unit is "kg" or "g" or "lb" or "oz" && r.UnitField!=null && Text(r.UnitValue) && r.UnitValue!.Length>0)));
        if(next.RecordEdits is { } edits)
            Require(edits.Length<=24 && edits.All(e=>e!=null && choices.ContainsKey(e.SourceId) && e.RecordHash is {Length:64}
                && e.RecordHash.All(char.IsAsciiHexDigit) && new[]{e.FromSpace,e.FromId,e.ToSpace,e.ToId}.All(v=>Text(v)&&v.Length>0) &&
                (e.FromSpace!=e.ToSpace || e.FromId!=e.ToId)) && edits.Select(e=>(e.SourceId,e.RecordHash)).Distinct().Count()==edits.Length);
        if (next.Timing is { } timing)
            Require(timing.Length<=24 && timing.All(t=>t!=null && t.SourceId!=null && choices.TryGetValue(t.SourceId,out var s) &&
                (t.ExpectedCheckIntervalSeconds!=null || t.ExpectedDeliveryAfterLabelSeconds!=null) &&
                t.ExpectedCheckIntervalSeconds is not (<60 or >86400) &&
                (t.ExpectedDeliveryAfterLabelSeconds is null || s.Roles.Contains("delivery") && t.ExpectedDeliveryAfterLabelSeconds is >=60 and <=31536000)) &&
                timing.Select(t=>t.SourceId).Distinct().Count()==timing.Length);
        Require(next.ExcludedSourceIds.All(id=>id!=null && choices.ContainsKey(id)) && next.ExcludedSourceIds.Distinct().Count()==next.ExcludedSourceIds.Length);
        Require(next.Rules.All(r=>r!=null && r.SourceId!=null && choices.TryGetValue(r.SourceId,out var s) && s.Transport=="folder" &&
            r.ShippedAt is "label" or "handoff" or "unknown") && next.Rules.Select(r=>r.SourceId).Distinct().Count()==next.Rules.Length);
    }

    public WorkspaceSource[] Candidates(OrderWorkspaceState workspace)
    {
        var candidates=workspace.Sources
        .Where(s=>s.Roles.Count>0 && !s.Paused && !Inputs.ExcludedSourceIds.Contains(s.Id))
        .OrderBy(s=>s.Id,StringComparer.Ordinal)
        .Select(s=>{
            var rule=Inputs.Packing?.FirstOrDefault(r=>r.SourceId==s.Id);
            FacilityPackingReader? reader=null;
            if(rule!=null)
            {
                var order=workspace.Sources.FirstOrDefault(x=>x.Id==rule.OrderSourceId && x.Roles.Contains("order"));
                if(order==null || order.Paused || Inputs.ExcludedSourceIds.Contains(order.Id))
                    throw new ConnectException("ORDER_SOURCE_REQUIRED","Include the order source for this carton mapping or remove the mapping.");
                string ns=order.ConfirmedMap?.Catalogue is { } catalogue ? SourceReaders.CompanyOrderNamespace(order.Id,catalogue) :
                    order.SourceNamespace ?? order.ObservedNamespace ?? order.Id;
                reader=new(rule,ns,order.Generation);
            }
            return s.WithRules(Inputs.Rules.FirstOrDefault(r=>r.SourceId==s.Id)?.ShippedAt,Inputs.Timing?.FirstOrDefault(t=>t.SourceId==s.Id),reader);
        }).ToArray();
        var current=workspace.Sources.ToDictionary(s=>s.Id);
        var proposed=candidates.ToDictionary(s=>s.Id);
        foreach(var source in candidates)
        {
            // The draft may advance an already-confirmed target generation in the same
            // atomic proposal. A dependency stale before this draft still requires review.
            source.ConfirmedDependencies=source.ConfirmedDependencies.ToDictionary(p=>p.Key,p=>
                current.TryGetValue(p.Key,out var before) && before.Generation==p.Value &&
                proposed.TryGetValue(p.Key,out var after)?after.Generation:p.Value);
        }
        return candidates;
    }

    public static ReplayCheck[] CheckExamples(FacilityExample[] expected, JsonElement preview)
    {
        var examples=preview.GetProperty("examples").EnumerateArray().ToArray();
        return new[]{"ordinary","split","reprint"}.Select(kind=>{
            var e=expected.FirstOrDefault(x=>x.Kind==kind);
            if (e is null || string.IsNullOrWhiteSpace(e.Reference) || e.Cartons is null ||
                kind=="ordinary" && e.Cartons!=1 || kind=="split" && e.Cartons<2 || kind=="reprint" && (e.LabelCount??0)<2)
                return new ReplayCheck(kind,e?.Reference??"",false,"Record the expected cartons and any reprinted labels first.");
            if (expected.Any(x=>x.Kind!=kind && x.Reference==e.Reference))
                return new ReplayCheck(kind,e.Reference,false,"Use a distinct reference order for each example.");
            var matches=examples.Where(x=>x.GetProperty("orderReference").GetString()==e.Reference ||
                x.GetProperty("lookupReferences").EnumerateArray().Any(r=>r.GetString()==e.Reference)).ToArray();
            if(matches.Length!=1)return new ReplayCheck(kind,e.Reference,false,matches.Length==0?
                "This order was not found in the permitted sample.":"This reference matches multiple orders. Choose an unambiguous reference.");
            var x=matches[0];
            var cartons=x.GetProperty("cartonCount").GetInt32();
            var labels=x.GetProperty("labelCount").GetInt32();
            bool pass=cartons==e.Cartons && (e.LabelCount is null || e.LabelCount==labels);
            return new ReplayCheck(kind,e.Reference,pass,$"Observed {cartons} carton(s) and {labels} label event(s).");
        }).ToArray();
    }
}

using System.Text.Json;

namespace PackProof.Connect;

public sealed partial class AgentRuntime
{
    private bool InspectWorkflowColumns(WorkspaceSource source, SourceReadResult parsed, string fileName, Dictionary<string,string>? preview)
    {
        var role = source.InspectRole ?? source.Roles.LastOrDefault();
        if (role is null || !source.Roles.Contains(role) || source.ApprovedWorkflows().Any(m=>m.Role==role) || state.Workspace is not { } w) return false;
        var possible = new Dictionary<string,WorkspaceSource[]>(StringComparer.Ordinal);
        foreach (var producerRole in new[] { "order", "picking", "packing", "shipping" })
        {
            var options = w.Sources.Where(s => s.Id != source.Id && s.Roles.Contains(producerRole) && !s.Paused).ToArray();
            if (options.Length > 0) possible.Add(producerRole,options);
        }
        // Ask about producers only when the actual report has a relationship column for that role.
        var markers = possible.Keys.ToDictionary(r=>r,r=>"candidate-"+r);
        var probe = SourceReaders.ProposeWorkflowMap(parsed,role,source.Id,markers);
        if (probe == null) return false;
        var relatesTo = markers.Where(p => probe.ReferenceSources.Values.Contains(p.Value)).Select(p=>p.Key).ToArray();
        var choices = new List<object>();
        var targets = new Dictionary<string,string>();
        var names = new List<string>();
        foreach (var targetRole in relatesTo)
        {
            var options = possible[targetRole];
            var selected = options.Length == 1 ? options[0] : options.FirstOrDefault(s => s.Id == source.RelatedSources.GetValueOrDefault(targetRole));
            if (selected == null)
            {
                choices.Add(new {role=targetRole,options=options.Select(s=>new {id=s.Id,displayName=s.DisplayName}).ToArray()});
                continue;
            }
            source.RelatedSources[targetRole]=selected.Id;
            targets[targetRole]=selected.SourceNamespace ?? selected.ObservedNamespace ?? selected.Id;
            names.Add(selected.Transport == "api" ? selected.DisplayName : Path.GetFileName(selected.Folder));
        }
        if (choices.Count > 0)
        {
            source.Recognition = Json.Element(new {state="ambiguous",message=$"Found relationship fields in {fileName}.",
                question="Which connected system supplies these references?",relatedChoices=choices,fields=probe.Columns.Values,sample=preview});
            return true;
        }
        var proposal = SourceReaders.ProposeWorkflowMap(parsed,role,source.Id,targets);
        if (proposal == null || SourceReaders.NormalizeWorkflow(parsed,source.Id,proposal).GetArrayLength() == 0) return false;
        source.ProposedWorkflow=proposal;
        source.Recognition = Json.Element(new {state="ambiguous",message=$"Found matching references in {fileName}.",
            question="Do those references come from "+string.Join(", ",names)+"?",profileVersion=SourceReaders.WorkflowProfileVersion(proposal),
            fields=proposal.Columns.Values,sample=preview,fileName});
        return true;
    }
}


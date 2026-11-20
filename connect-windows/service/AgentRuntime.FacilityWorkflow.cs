using System.Text.Json;

namespace PackProof.Connect;

public sealed partial class AgentRuntime
{
    private bool GuidedSetupAvailable => CurrentInstallation && !string.IsNullOrEmpty(state.InstallationId) &&
        Optional(state.ServerConfig,"locationId")?.ValueKind == JsonValueKind.String &&
        Optional(state.ServerConfig,"organizationId")?.ValueKind == JsonValueKind.String &&
        Optional(Optional(state.ServerConfig,"capabilities"),"guidedFacilitySetup")?.ValueKind == JsonValueKind.True;

    private string FacilityScopeKey() => HashBytes(Json.Bytes(new[]{host.Environment,state.InstallationId,
        Optional(state.ServerConfig,"organizationId")?.GetString(),Optional(state.ServerConfig,"locationId")?.GetString(),
        Optional(state.ServerConfig,"operatorMembershipId")?.GetString(),Optional(state.ServerConfig,"integrationAccountId")?.GetString()}));

    // An enrolled installation normally has one binding. If the server changes it, keep opaque
    // local source handles, output cursor, samples and pending draft with their original facility.
    private void SelectFacilityContext()
    {
        if(!CurrentInstallation || state.ServerConfig is null || state.FacilityContextKey is null && !GuidedSetupAvailable) return;
        var key=FacilityScopeKey();
        if(state.FacilityContextKey==key)return;
        if(state.FacilityContextKey is { } previous)
        {
            StopWorkspaceWatchers();
            state.OtherFacilities[previous]=new(state.Workspace,state.ProofOutput);
            state.OtherFacilities.Remove(key,out var saved);
            state.Workspace=saved?.Workspace ?? new();
            state.ProofOutput=saved?.Output;
            if(state.Workspace.ActiveGrant is { } grant) state.Workspace.ActiveGrant=grant with {CheckedAt=DateTimeOffset.MinValue};
            ordersCurrent=false; ordersScope=null; workspaceOrders=[]; orderPageCursor=null;
            nextWorkspacePoll=nextOrderRefresh=nextOutputFetch=DateTimeOffset.MinValue;
        }
        state.FacilityContextKey=key;
        Save();
    }

    private FacilityProfile FacilityDraft(OrderWorkspaceState w)
    {
        if (!GuidedSetupAvailable) throw new ConnectException("FACILITY_UNAVAILABLE","Sign in to an enrolled facility with guided setup enabled.");
        var scope=FacilityScopeKey();
        if (w.FacilityDrafts.TryGetValue(scope,out var found))
        {
            if(found.Version!=1) throw new ConnectException("DRAFT_VERSION_UNSUPPORTED","Update PackProof to resume this workflow.");
            return found;
        }
        var draft=new FacilityProfile {ScopeKey=scope};
        w.FacilityDrafts.Add(scope,draft);
        Save();
        return draft;
    }

    private string ProfileDigest(FacilityProfile draft, WorkspaceSource[] sources) => HashBytes(Json.Bytes(new {
        draft.ScopeKey,draft.Id,draft.Revision,draft.Inputs, compiler=FacilityProfile.Compiler,
        reader=SourceReaders.Version,catalogue=ExportCatalogue.Digest,
        output=ProofOutputFolder is { } folder ? SourceFolderDigest(folder) : null,
        sources=sources.Select(s=>new {s.Id,s.Generation,s.Transport,s.PhysicalRoot,folder=s.Folder.Length>0?SourceFolderDigest(s.Folder):null,
            s.SourceNamespace,roles=s.Roles.Order(StringComparer.Ordinal),s.ProfileVersion,
            dependencies=s.ConfirmedDependencies.OrderBy(p=>p.Key,StringComparer.Ordinal)})
    }));

    private async Task WithdrawPendingProfile(OrderWorkspaceState w,CancellationToken ct)
    {
        if (w.Phase!="awaiting_approval" || w.ScopeDigest is not { } scope || w.SubmittedProfileDigest is null) return;
        var result=await api.Request("POST",WorkspaceApi+"/withdraw",new {scopeDigest=scope},state.Token,null,ct);
        if(Optional(result,"withdrawn")?.ValueKind!=JsonValueKind.True)
            throw new ConnectException("REVIEW_IN_PROGRESS","Refresh the approval result before changing the draft.");
        w.Invalidate();
        Save();
    }

    private async Task<object> FacilityCommand(string operation,JsonElement p,CancellationToken ct)
    {
        var w=Draft();
        var draft=FacilityDraft(w);
        if(operation=="getFacilityDraft") return draft.View();
        if(p.GetProperty("expectedRevision").GetInt32()!=draft.Revision)
            throw new ConnectException("DRAFT_CHANGED","This workflow was edited. Reopen it to use the latest answers.");
        if(operation=="saveFacilityDraft")
        {
            var input=p.GetProperty("changes").Deserialize<FacilityInputs>(Json.Options)
                ?? throw new ConnectException("DRAFT_INVALID","Choose a facility workflow.");
            FacilityProfile.Validate(input,w.Sources);
            if(Json.Bytes(input).SequenceEqual(Json.Bytes(draft.Inputs))) return draft.View();
            await WithdrawPendingProfile(w,ct);
            draft.Revision=checked(draft.Revision+1);
            draft.Inputs=input;
            draft.Replay=null;
            w.Invalidate();
        }
        else
        {
            var candidates=draft.Candidates(w);
            var sources=new List<SourceCheck>();
            var preview=Json.Element(WorkspaceDraftPreview(ct,candidates,sources));
            var checks=FacilityProfile.CheckExamples(draft.Inputs.Examples,preview);
            if(draft.Inputs.RecordEdits is {Length:>0})
                checks=[..checks,new("preview_correction","",false,"A record was reassigned in the preview. Correct the source mapping and clear preview changes before activation.")];
            var complete=!preview.GetProperty("limited").GetBoolean() && preview.GetProperty("unresolved").GetInt32()==0;
            var dependencyMatch=candidates.All(s=>s.ConfirmedDependencies.All(d=>candidates.Any(target=>target.Id==d.Key && target.Generation==d.Value)));
            var passed=complete && dependencyMatch && ProofOutputFolder is not null && ProofOutputState is "ready" or "current" or "pending" &&
                sources.Count>0 && sources.All(s=>s.Readable) && checks.All(c=>c.Passed);
            if(!complete || !dependencyMatch) checks=[..checks,new("scope","",false,
                !complete?"Use a smaller, fully linked set of reference exports to complete replay.":"Confirm related-source mappings for these source generations.")];
            if(ProofOutputFolder is null || ProofOutputState is not ("ready" or "current" or "pending"))
                checks=[..checks,new("output","",false,"Select a writable proof folder before testing.")];
            draft.Replay=new(passed,ProfileDigest(draft,candidates),checks,sources.ToArray(),DateTimeOffset.UtcNow);
        }
        Save();
        return draft.View();
    }

    private void EnsureTested(FacilityProfile profile,WorkspaceSource[] candidates)
    {
        if(profile.Replay is not {Passed:true} replay || ProfileDigest(profile,candidates)!=replay.Digest)
            throw new ConnectException("REPLAY_REQUIRED","Test the known orders with the current sources, rules and output before requesting approval.");
    }

    private void ApplyFacilityRules(OrderWorkspaceState w,FacilityProfile profile)
    {
        foreach(var candidate in profile.Candidates(w))
        {
            var s=w.Sources.Single(x=>x.Id==candidate.Id);
            s.ConfirmedDependencies=candidate.ConfirmedDependencies;
            if(s.Generation==candidate.Generation) continue;
            s.Generation=candidate.Generation;
            s.ShippedAtMeaning=candidate.ShippedAtMeaning;
            s.PackingReader=candidate.PackingReader;
            s.ExpectedCheckIntervalSeconds=candidate.ExpectedCheckIntervalSeconds;
            s.ExpectedDeliveryAfterLabelSeconds=candidate.ExpectedDeliveryAfterLabelSeconds;
            // Previously observed, unchanged bytes belong to their original interpretation.
            foreach(var key in s.Inventory.Keys.ToArray()) s.Inventory[key]=s.Inventory[key] with {Generation=s.Generation};
        }
    }
}

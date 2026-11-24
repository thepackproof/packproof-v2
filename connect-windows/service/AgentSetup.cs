using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
namespace PackProof.Connect;

public sealed record FileReviewRenewal(string InstallationId, string OrganizationId, string Environment,
    string PreviousDigest, JsonElement Configuration, string[] ExcludedFileNames);

public sealed partial class AgentRuntime
{
    private void InvalidateAnalysis()
    {
        state.LocalAnalysis=null;state.ExcludedFileNames=null;state.BaselineSha256=null;state.BaselineObservedAt=null;state.FileReviewRenewal=null;
        state.GuidedSetup=false;state.GuidedPhase=null;state.GuidedProposalSha256=null;state.GuidedFileSha256=null;state.VerifiedSetupImportId=null;state.DraftRevision++;
    }
    private (string[] Files, string Digest, string ObservedAt) ReadBaseline()
    {
        var files=Directory.EnumerateFiles(state.Folder!,"*",SearchOption.TopDirectoryOnly)
            .Where(p=>Path.GetExtension(p).Equals(".csv",StringComparison.OrdinalIgnoreCase))
            .Select(p=>Path.GetFileName(p)!).Take(10001).OrderBy(n=>n,StringComparer.OrdinalIgnoreCase).ToArray();
        if(files.Length>10000)throw new ConnectException("SOURCE_CAPACITY_REACHED","Use the approved bounded shipment folder.");
        return (files,Hash(JsonSerializer.Serialize(files)),DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ",CultureInfo.InvariantCulture));
    }
    private void CaptureBaseline() => (state.ExcludedFileNames,state.BaselineSha256,state.BaselineObservedAt)=ReadBaseline();
    private static ConnectException ReviewChanged() => new("PREVIEW_CHANGED","This review no longer matches the saved report. Open the latest review or choose the original report again.");
    private static bool ReviewDigest(string? value) => value?.Length == 64 && value.All(c => c is >= 'a' and <= 'f' or >= '0' and <= '9');
    private static void RequireFileReviewPrerequisites(JsonElement live,JsonElement contract)
    {
        if (Optional(live,"locationId") is not {ValueKind:JsonValueKind.String} location || string.IsNullOrWhiteSpace(location.GetString()))
            throw new ConnectException("FACILITY_REQUIRED","Choose this computer's facility in PackProof before renewing the saved report. Your saved report is preserved.");
        if (!CsvSemantics.AdmissionSupported(contract,Optional(live,"capabilities")))
            throw new ConnectException("SOURCE_CONTRACT_UNSUPPORTED","The PackProof server does not currently support renewing this report for this computer. Your saved report is preserved. Check the connection again after server support is available.");
    }

    private async Task<object> RefreshPendingFileReview(JsonElement input, CancellationToken ct)
    {
        RequireCredential();
        RequireReasonableClock(DateTimeOffset.UtcNow);
        if (!input.TryGetProperty("wholeFileUploadApproved",out var consent) || consent.ValueKind != JsonValueKind.True ||
            input.EnumerateObject().Any(p=>p.Name is not ("installationId" or "organizationId" or "environment" or "expectedProposalSha256" or "wholeFileUploadApproved")))
            throw new ConnectException("UPLOAD_CONSENT_REQUIRED","Confirm that you want a new browser review of this entire saved shipment report.");
        var installation = input.GetProperty("installationId").GetString();
        var organization = input.GetProperty("organizationId").GetString();
        var environment = input.GetProperty("environment").GetString();
        var expected = input.GetProperty("expectedProposalSha256").GetString();
        if (installation is null || organization is null || environment is not ("sandbox" or "live") || !ReviewDigest(expected) ||
            installation != state.InstallationId || state.CredentialRecoveryConfirmedAt is not null ||
            state.CredentialExpiresAt is null || state.CredentialExpiresAt <= DateTimeOffset.UtcNow || state.Folder is null || state.FileName is null ||
            !ReviewDigest(state.FileDigest) || state.SetupQueueId is not null || !state.LocalPaused) throw ReviewChanged();

        // Fetch the installation's current state with its own credential while the native command gate is held.
        var live = await api.Request("GET","/v1/partner/agent/config",null,state.Token,null,ct);
        RequireReasonableClock(DateTimeOffset.UtcNow);
        if (Optional(live,"installationId")?.GetString()!=installation || Optional(live,"organizationId")?.GetString()!=organization ||
            Optional(live,"environment")?.GetString()!=environment || Optional(live,"state")?.GetString()!="setup" ||
            !live.TryGetProperty("configRevision",out var revision) || revision.GetInt32()!=0 ||
            Optional(live,"config") is {ValueKind:JsonValueKind.Object} ||
            Optional(live,"pendingProposal") is not {ValueKind:JsonValueKind.Object} proposal ||
            Optional(live,"pendingProposalSha256")?.GetString() is not string digest || !ReviewDigest(digest))
            throw ReviewChanged();
        if (Optional(proposal,"sourceContract") is not {ValueKind:JsonValueKind.Object} contract ||
            Optional(contract,"schema")?.GetString()!="packproof.scheduled-csv/v2" ||
            Optional(contract,"rulesVersion")?.GetString()!=CsvSemantics.Version ||
            Optional(contract,"profileVersion")?.GetString()!=CsvSemantics.Profile ||
            Optional(contract,"historyPolicy") is not {ValueKind:JsonValueKind.Object} history ||
            Optional(history,"mode")?.GetString()!="selected_then_new" ||
            Optional(history,"initialFileName")?.GetString()!=state.FileName || Optional(history,"initialFileSha256")?.GetString()!=state.FileDigest ||
            Optional(proposal,"folderDigest")?.GetString()!=state.FolderDigest || state.FolderDigest!=Hash(state.Folder.ToUpperInvariant()) ||
            new[]{"integrationAccountId","operatorMembershipId","sourceName","locationId"}.Any(field=>Comparable(proposal,field)!=Comparable(live,field)))
            throw ReviewChanged();
        if (!DateTimeOffset.TryParse(Optional(history,"observedAt")?.GetString(),out var oldObservation)) throw ReviewChanged();
        var previous=state.FileReviewRenewal;
        var isOurReplacement=previous is not null && previous.InstallationId==installation && previous.OrganizationId==organization &&
            previous.Environment==environment && JsonElement.DeepEquals(previous.Configuration,proposal) && digest!=previous.PreviousDigest;
        if (digest!=expected && !(isOurReplacement && expected==previous!.PreviousDigest)) throw ReviewChanged();
        if (DateTimeOffset.UtcNow<=oldObservation.AddMinutes(30) && !isOurReplacement) throw ReviewChanged();

        // Renewal requires a current facility and the interpretation the renewed proposal will pin.
        // Check the fresh server response before opening the original or changing protected state.
        var candidate=JsonNode.Parse(proposal.GetRawText())!.AsObject();
        var refreshed=candidate["sourceContract"]!.AsObject();
        refreshed["interpretationVersion"]=CsvSemantics.InterpretationVersion;
        refreshed["basedOnConfigRevision"]=0;
        var currentContract=JsonSerializer.SerializeToElement(refreshed);
        RequireFileReviewPrerequisites(live,currentContract);

        byte[] ReadSavedOriginal()
        {
            var bytes=setupSnapshot(state.Folder,state.FileName);
            if (HashBytes(bytes)!=state.FileDigest) throw new ConnectException("SOURCE_CHANGED","The saved report changed. Choose it again and review its updated contents.");
            return bytes;
        }
        var original=ReadSavedOriginal();
        FolderSource.ValidateContract(original,proposal);
        if (isOurReplacement && DateTimeOffset.UtcNow<=oldObservation.AddMinutes(30))
            return FinishFileReviewRenewal(previous!,digest);
        if (digest!=expected || state.BaselineSha256 is not null && Optional(history,"baselineSha256")?.GetString()!=state.BaselineSha256 ||
            state.GuidedFileSha256 is not null && state.GuidedFileSha256!=state.FileDigest ||
            state.GuidedProposalSha256 is not null && state.GuidedProposalSha256!=digest) throw ReviewChanged();
        // A protected filename and byte identity survive even in releases without the cached analysis.
        // Reject conflicting cached bindings, but an absent preview is rebuilt below from the original.
        var binding=Optional(state.LocalAnalysis,"binding");
        if (binding is {ValueKind:JsonValueKind.Object} saved &&
            ((Optional(saved,"sourceBindingId")?.GetString() is string priorId && priorId!=installation) ||
             (Optional(saved,"fileSha256")?.GetString() is string priorFile && priorFile!=state.FileDigest) ||
             (Optional(saved,"folderDigest")?.GetString() is string priorFolder && priorFolder!=state.FolderDigest)))
            throw ReviewChanged();
        if (Optional(state.LocalAnalysis,"configuration") is {ValueKind:JsonValueKind.Object} local &&
            Optional(local,"mapping") is {ValueKind:JsonValueKind.Object} priorMapping &&
            !JsonElement.DeepEquals(priorMapping,proposal.GetProperty("mapping"))) throw ReviewChanged();

        // Older initial configurations may predate interpretation pinning. Requalify the same mapping and pin
        // revision zero only for a still-unconfigured installation. The API checks this revision under its row lock.
        if (contract.TryGetProperty("basedOnConfigRevision",out var oldRevision) && oldRevision.GetInt32()!=0) throw ReviewChanged();
        var mapping=JsonSerializer.Deserialize<Dictionary<string,string>>(proposal.GetProperty("mapping"),Json.Options)!;
        var confirmed=contract.GetProperty("confirmedFields").EnumerateArray().Select(v=>v.GetString()!).ToArray();
        var parsed=FolderSource.Parse(original);
        if (!contract.GetProperty("expectedHeaders").EnumerateArray().Select(h=>h.GetString()).SequenceEqual(parsed.Headers)) throw ReviewChanged();
        var result=CsvSemantics.Analyze(parsed,mapping,confirmed,Optional(proposal,"locationId")?.GetString(),interpret:true);
        if (!result.Ready || result.Interpretation?.Outcome!="automatic" || result.Interpretation.Grain!="shipment" ||
            result.Mapping.Count!=mapping.Count || mapping.Any(pair=>result.Mapping.GetValueOrDefault(pair.Key)!=pair.Value) ||
            binding is {ValueKind:JsonValueKind.Object} cached && Optional(cached,"headerFingerprint")?.GetString() is string fingerprint &&
            fingerprint!=result.HeaderFingerprint) throw ReviewChanged();
        var baseline=ReadBaseline();
        if (!baseline.Files.Contains(state.FileName,StringComparer.OrdinalIgnoreCase)) throw ReviewChanged();
        refreshed["historyPolicy"]!["observedAt"]=baseline.ObservedAt;
        refreshed["historyPolicy"]!["baselineSha256"]=baseline.Digest;
        var replacement=JsonSerializer.SerializeToElement(candidate);
        var attempt=new FileReviewRenewal(installation,organization,environment,digest,replacement,baseline.Files);
        if (previous is not null && previous.InstallationId==installation && previous.OrganizationId==organization &&
            previous.Environment==environment && previous.PreviousDigest==digest && previous.ExcludedFileNames.SequenceEqual(baseline.Files))
        {
            var priorHistory=previous.Configuration.GetProperty("sourceContract").GetProperty("historyPolicy");
            if (DateTimeOffset.TryParse(priorHistory.GetProperty("observedAt").GetString(),out var captured) &&
                DateTimeOffset.UtcNow<=captured.AddMinutes(30)) attempt=previous;
        }
        var checkedPolicy=await api.Request("GET","/v1/partner/agent/config",null,state.Token,null,ct);
        if (Comparable(checkedPolicy,"pendingProposalSha256")!=digest || Comparable(checkedPolicy,"state")!="setup" ||
            Comparable(checkedPolicy,"installationId")!=installation || Comparable(checkedPolicy,"organizationId")!=organization ||
            Comparable(checkedPolicy,"environment")!=environment || checkedPolicy.GetProperty("configRevision").GetInt32()!=0)
            throw ReviewChanged();
        RequireFileReviewPrerequisites(checkedPolicy,currentContract);
        if (new[]{"integrationAccountId","operatorMembershipId","sourceName","locationId"}.Any(field=>Comparable(proposal,field)!=Comparable(checkedPolicy,field)))
            throw ReviewChanged();
        _=ReadSavedOriginal();
        state.FileReviewRenewal=attempt;
        state.GuidedSetup=false;
        state.GuidedPhase=null;
        Save();
        var reply=await api.Request("POST","/v1/partner/agent/config-proposals",attempt.Configuration,state.Token,null,ct);
        var next=Optional(reply,"proposalSha256")?.GetString();
        if (!ReviewDigest(next) || next==digest) throw ReviewChanged();
        return FinishFileReviewRenewal(attempt,next!);
    }
    private object FinishFileReviewRenewal(FileReviewRenewal attempt,string digest)
    {
        var history=attempt.Configuration.GetProperty("sourceContract").GetProperty("historyPolicy");
        state.ExcludedFileNames=attempt.ExcludedFileNames;
        state.BaselineSha256=history.GetProperty("baselineSha256").GetString();
        state.BaselineObservedAt=history.GetProperty("observedAt").GetString();
        if (state.LocalAnalysis is JsonElement analysis)
        {
            var updated=JsonNode.Parse(analysis.GetRawText())!.AsObject();
            updated["configuration"]=JsonNode.Parse(attempt.Configuration.GetRawText());
            state.LocalAnalysis=JsonSerializer.SerializeToElement(updated);
        }
        // Renewal authorizes publishing the description only. A subsequent tick must never stage an original.
        state.GuidedSetup=false;
        state.GuidedPhase=null;
        state.GuidedFileSha256=state.FileDigest;
        state.GuidedProposalSha256=digest;
        state.LocalPaused=true;
        state.ApprovalPath="/app/records/connect/approve?installationId="+Uri.EscapeDataString(attempt.InstallationId);
        Save();
        return new {installationId=attempt.InstallationId,organizationId=attempt.OrganizationId,environment=attempt.Environment,proposalSha256=digest,approvalPath=state.ApprovalPath};
    }
    private byte[] CurrentSnapshot()
    {
        if(state.Folder is null||state.FileName is null||state.FileDigest is null)throw new ConnectException("SOURCE_FILE_REQUIRED","Choose a completed shipment report first.");
        var bytes=setupSnapshot(state.Folder,state.FileName);
        if(HashBytes(bytes)!=state.FileDigest){state.GuidedSetup=false;state.LocalAnalysis=null;state.VerifiedRecordId=null;throw new ConnectException("SOURCE_CHANGED","This report changed. Review its updated shipment before continuing.");}
        return bytes;
    }
    private static string HashBytes(byte[] bytes)=>Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes));
    private void AnalyzeSelected(JsonElement? request)
    {
        var bytes=CurrentSnapshot(); state.DraftRevision++;
        var map=request?.TryGetProperty("mapping",out var m)==true?JsonSerializer.Deserialize<Dictionary<string,string>>(m,Json.Options):null;
        var confirmed=request?.TryGetProperty("confirmedFields",out var f)==true?f.EnumerateArray().Select(x=>x.GetString()!).ToArray():Array.Empty<string>();
        var location=Optional(state.ServerConfig,"locationId") is {ValueKind:JsonValueKind.String} loc?loc.GetString():null;
        var parsed=FolderSource.Parse(bytes);
        bool reused = false;
        if (map is null && ReusableShipmentConfiguration(parsed.Headers) is JsonElement existing)
        {
            map = JsonSerializer.Deserialize<Dictionary<string,string>>(existing.GetProperty("mapping"),Json.Options);
            confirmed = existing.GetProperty("sourceContract").GetProperty("confirmedFields").EnumerateArray().Select(v => v.GetString()!).ToArray();
            reused = true;
        }
        var result=CsvSemantics.Analyze(parsed,map,confirmed,location,interpret:true);
        var instants=parsed.Rows.Where(r=>result.Mapping.TryGetValue("shippedAt",out var h)&&r.TryGetValue(h,out var value)&&CsvSemantics.Instant(value.Trim(),out _)).Select(r=>DateTimeOffset.Parse(r[result.Mapping["shippedAt"]].Trim(),CultureInfo.InvariantCulture)).ToArray();
        var backfill=instants.Length>0?instants.Min().ToString("yyyy-MM-ddTHH:mm:ss.fffzzz",CultureInfo.InvariantCulture):null;
        if(request?.TryGetProperty("backfillFrom",out var cutoff)==true){if(!CsvSemantics.Instant(cutoff.GetString()!,out var at)||instants.Any(t=>t<at))throw new ConnectException("SOURCE_BACKFILL_BOUNDARY","The chosen history date excludes shipments in this selected report.");backfill=cutoff.GetString();}
        var config=new {sourceName=Optional(state.ServerConfig,"sourceName")?.GetString(),integrationAccountId=Optional(state.ServerConfig,"integrationAccountId")?.GetString(),operatorMembershipId=Optional(state.ServerConfig,"operatorMembershipId")?.GetString(),locationId=location,folderDigest=state.FolderDigest,mapping=result.Mapping,timeZone="source-offset",importValidRows=false,offlineWindowHours=24,sourceContract=new{schema="packproof.scheduled-csv/v2",exporterName=(string?)null,exporterVersion=(string?)null,expectedHeaders=parsed.Headers,expectedIntervalSeconds=(int?)null,backfillFrom=backfill,rulesVersion=CsvSemantics.Version,profileVersion=CsvSemantics.Profile,interpretationVersion=CsvSemantics.InterpretationVersion,basedOnConfigRevision=ConfigRevision,confirmedFields=confirmed,analysisRevision=state.DraftRevision,historyPolicy=new{mode="selected_then_new",baselineSha256=state.BaselineSha256,observedAt=state.BaselineObservedAt,initialFileName=state.FileName,initialFileSha256=state.FileDigest}}};
        // Null metadata is an explicit part of the v2 contract, not an invented exporter.
        var configJson=JsonSerializer.SerializeToElement(config,new JsonSerializerOptions(Json.Options){DefaultIgnoreCondition=System.Text.Json.Serialization.JsonIgnoreCondition.Never});
        state.LocalAnalysis=Json.Element(new{ready=result.Ready,interpretation=result.Interpretation,reusedConfigRevision=reused?(int?)ConfigRevision:null,decisions=result.Decisions,shipment=result.Shipment,issues=result.Issues,headers=parsed.Headers,rowCount=result.RowCount,configuration=configJson,binding=new{sourceBindingId=state.InstallationId,folderDigest=state.FolderDigest,fileSha256=state.FileDigest,headerFingerprint=result.HeaderFingerprint,draftRevision=state.DraftRevision,profileVersion=CsvSemantics.Profile,rulesVersion=CsvSemantics.Version}});
        state.GuidedSetup=false;state.VerifiedRecordId=null;state.VerifiedSetupImportId=null;
    }
    private JsonElement? ReusableShipmentConfiguration(string[] headers)
    {
        if (state.Token is null || state.CredentialExpiresAt is null || state.CredentialExpiresAt<=DateTimeOffset.UtcNow ||
            state.InstallationId is null || state.ServerConfig is not JsonElement server || ServerState is not ("ready" or "active" or "paused") ||
            Optional(server,"installationId")?.GetString()!=state.InstallationId || ConfigRevision<1 || !ConfigMatches || !MappingSupported ||
            Approved is not JsonElement config || !config.TryGetProperty("sourceContract",out var contract) || contract.ValueKind!=JsonValueKind.Object ||
            Optional(contract,"schema")?.GetString()!="packproof.scheduled-csv/v2" || !contract.GetProperty("expectedHeaders").EnumerateArray().Select(v=>v.GetString()).SequenceEqual(headers)) return null;
        return config;
    }

    private async Task BeginGuidedSetup(JsonElement request,CancellationToken ct)
    {
        RequireCredential();RequireReasonableClock(DateTimeOffset.UtcNow);
        if(!request.TryGetProperty("wholeFileUploadApproved",out var consent)||consent.ValueKind!=JsonValueKind.True)throw new ConnectException("UPLOAD_CONSENT_REQUIRED","Approve uploading and preserving the entire selected original, including unmapped columns.");
        if(state.LocalAnalysis?.GetProperty("ready").GetBoolean()!=true)throw new ConnectException("MAPPING_NEEDS_REVIEW","Resolve the shipment details before requesting approval.");
        if(request.GetProperty("draftRevision").GetInt32()!=state.DraftRevision)throw new ConnectException("PREVIEW_CHANGED","Review the current report before approving.");
        await Refresh(ct);
        if(CapabilityState(Optional(state.ServerConfig,"capabilities"))!="compatible")throw new ConnectException("SOURCE_CONTRACT_UNSUPPORTED","The server and this installation need matching source-validation support. No original was uploaded.");
        if(!DateTimeOffset.TryParse(state.BaselineObservedAt,out var reviewedAt)||DateTimeOffset.UtcNow-reviewedAt>TimeSpan.FromMinutes(30))throw new ConnectException("APPROVAL_EXPIRED","This local source review expired. Choose the report again to request a fresh approval.");
        var config=state.LocalAnalysis.Value.GetProperty("configuration");
        var contract=config.GetProperty("sourceContract");
        if(!CsvSemantics.UsesInterpretation(contract))throw new ConnectException("PREVIEW_CHANGED","Check this report again to review its current shipment interpretation.");
        if(!CsvSemantics.AdmissionSupported(contract,Optional(state.ServerConfig,"capabilities")))
            throw new ConnectException("SOURCE_CONTRACT_UNSUPPORTED","Shipment interpretation is unavailable for this workspace and collector. Your local review is saved.");
        if(contract.GetProperty("basedOnConfigRevision").GetInt32()!=ConfigRevision)
            throw new ConnectException("CONFIGURATION_CHANGED","The source configuration changed. Check the report again with its current mapping.");
        config=CsvHeaderPolicy.WithRequestedPolicy(config, request, Optional(state.ServerConfig,"capabilities"));
        var bytes=CurrentSnapshot();
        FolderSource.ValidateContract(bytes,config);
        var previousConfig=state.LocalAnalysis.Value.GetProperty("configuration");
        if(state.GuidedSetup && state.GuidedProposalSha256 is not null && state.GuidedFileSha256==state.FileDigest &&
            JsonElement.DeepEquals(previousConfig,config))return;
        var analysis=JsonNode.Parse(state.LocalAnalysis.Value.GetRawText())!.AsObject();
        analysis["configuration"]=JsonNode.Parse(config.GetRawText());
        state.LocalAnalysis=JsonSerializer.SerializeToElement(analysis);
        state.GuidedProposalSha256=null;
        state.LocalPaused=true;state.GuidedSetup=true;state.GuidedFileSha256=state.FileDigest;state.GuidedPhase="permission_review";Save();
        // A lost proposal response can be retried. It cannot authorize anything;
        // the server's exact proposal digest remains the only approval target.
        var result=await api.Request("POST","/v1/partner/agent/config-proposals",config,state.Token,null,ct);
        state.GuidedProposalSha256=result.GetProperty("proposalSha256").GetString();state.ApprovalPath=result.GetProperty("approvalPath").GetString();Save();await Refresh(ct);
    }
    internal static void RequireInitialOriginal(byte[] bytes,string name,JsonElement config)
    {
        if(!config.TryGetProperty("sourceContract",out var contract)||contract.ValueKind!=JsonValueKind.Object||contract.GetProperty("schema").GetString()!="packproof.scheduled-csv/v2")return;
        var history=contract.GetProperty("historyPolicy");
        if(history.GetProperty("initialFileSha256").GetString()!=HashBytes(bytes)||history.GetProperty("initialFileName").GetString()!=name)throw new ConnectException("SOURCE_CHANGED","The initial upload must be the exact report approved for this source. No original was uploaded.");
    }
    internal bool EligibleNewFile(string name)
    {
        if(Approved?.TryGetProperty("sourceContract",out var c)!=true||c.GetProperty("schema").GetString()!="packproof.scheduled-csv/v2")return true;
        var baseline=c.GetProperty("historyPolicy").GetProperty("baselineSha256").GetString();
        if(state.ExcludedFileNames is null||state.BaselineSha256!=baseline){state.LocalPaused=true;state.LastErrorCode="SOURCE_BASELINE_UNAVAILABLE";return false;}
        return !state.ExcludedFileNames.Contains(name,StringComparer.OrdinalIgnoreCase);
    }
    private async Task AdvanceGuidedSetup(CancellationToken ct)
    {
        if(!state.GuidedSetup)return;
        if(ServerState=="revoked"){state.GuidedSetup=false;state.GuidedPhase="revoked";Save();return;}
        if(state.GuidedProposalSha256 is null){state.GuidedSetup=false;state.GuidedPhase="needs_retry";Save();return;}
        if(Optional(state.ServerConfig,"pendingProposal")?.ValueKind==JsonValueKind.Object)return;
        if(ConfigDigest!=state.GuidedProposalSha256||state.FileDigest!=state.GuidedFileSha256){state.GuidedSetup=false;throw new ConnectException("CONFIGURATION_CHANGED","This approval belongs to a different source revision. Review the selected shipment again.");}
        RequireConfig();
        if(state.SetupQueueId is null && !MappingSupported){state.GuidedSetup=false;state.GuidedPhase="needs_review";state.LastErrorCode="SOURCE_ADMISSION_PAUSED";Save();return;}
        if(state.SetupQueueId is null){RequireOriginalAdmission();var bytes=CurrentSnapshot();FolderSource.ValidateContract(bytes,Approved!.Value);var staged=queue.Stage(bytes,state.FileName!,new(Approved.Value),Generation,QueueConfigIdentity,false);state.SetupQueueId=staged.Id;state.GuidedPhase="cloud_preview_pending";Save();}
        var entry=SetupEntry();if(entry.State is "action_needed" or "partial"){state.GuidedSetup=false;state.GuidedPhase="needs_review";Save();return;}
        if(entry.NextAttemptAt>DateTimeOffset.UtcNow)return;
        if(entry.State is not("complete" or "awaiting_review" or "server_processing")){await Process(entry,ct);entry=SetupEntry();}
        if(entry.State=="awaiting_review"){
            state.GuidedPhase="batch_review";Save();
            if(Optional(state.ServerConfig,"testImportId")?.GetString()!=entry.ImportId)return;
            _=CurrentSnapshot();
            var payload=queue.Payload(entry);payload.CommitApproved=true;queue.Save(entry,payload,"commit_pending");await Process(SetupEntry(),ct);
        }
        entry=SetupEntry();if(entry.State!="complete"){state.GuidedPhase="first_import_pending";Save();return;}
        if(state.VerifiedRecordId is null){await Verify(ct);await Refresh(ct);}
        if(Optional(state.ServerConfig,"verifiedImportId")?.GetString()!=state.VerifiedSetupImportId){
            ApplyServerConfig(await api.Request("POST","/v1/partner/agent/heartbeat",new{version=InstalledVersion,queueCount=CurrentPendingCount(),verifiedImportId=state.VerifiedSetupImportId},state.Token,null,ct));
            state.LastPolicyCheckAt=DateTimeOffset.UtcNow;Save();
        }
        state.GuidedPhase="recurring_approval_pending";Save();
        if(ServerState!="active")return;
        state.LocalPaused=false;state.PauseAuthorizationTimestamp=null;state.GuidedSetup=false;state.GuidedPhase="active";Save();
    }
    private static string Comparable(JsonElement obj,string property)=>obj.TryGetProperty(property,out var value)&&value.ValueKind!=JsonValueKind.Null?value.ToString():"";
    internal static void CheckPreviewParity(byte[] bytes,JsonElement receipt,JsonElement config,string? configDigest=null,string? installationId=null)
    {
        var map=JsonSerializer.Deserialize<Dictionary<string,string>>(config.GetProperty("mapping"),Json.Options)!;
        var contract=config.GetProperty("sourceContract");var confirmed=contract.GetProperty("confirmedFields").EnumerateArray().Select(x=>x.GetString()!).ToArray();
        var location=config.TryGetProperty("locationId",out var l)&&l.ValueKind==JsonValueKind.String?l.GetString():null;
        var local=CsvSemantics.Analyze(bytes,map,confirmed,location,true,config.GetProperty("timeZone").GetString()!,CsvSemantics.UsesInterpretation(contract));
        if (local.Interpretation is not null && !DecisionMatches(receipt,local,contract,HashBytes(bytes),configDigest,installationId))
            throw new ConnectException("INTERPRETATION_MISMATCH","The receipt does not match the original, source revision and locally checked field meanings. No batch will be committed.");
        var remote=receipt.GetProperty("rows").EnumerateArray().ToArray();
        if(!local.Ready||remote.Length!=local.Rows.Length)throw new ConnectException("INTERPRETATION_MISMATCH","Local and server shipment interpretations differ. No batch will be committed.");
        for(var i=0;i<remote.Length;i++){
            if(remote[i].GetProperty("rowNumber").GetInt32()!=i+2||!remote[i].TryGetProperty("normalized",out var n)||n.ValueKind!=JsonValueKind.Object||new[]{"shipmentReference","itemTitle","quantity","trackingNumber","carrier","shippedAt","shipmentDate","locationId"}.Any(f=>Comparable(n,f)!=Comparable(local.Rows[i],f)))throw new ConnectException("INTERPRETATION_MISMATCH","Local and server shipment interpretations differ. Preserve the original for review.");
        }
    }
    private static bool DecisionMatches(JsonElement receipt,CsvSemantics.Result local,JsonElement contract,string digest,string? configDigest,string? installationId)
    {
        if (configDigest is null || installationId is null || !receipt.TryGetProperty("interpretation",out var decision) ||
            decision.ValueKind!=JsonValueKind.Object) return false;
        try {
            if (Comparable(decision,"schema")!="packproof.automation-decision/v1" || Comparable(decision,"version")!=CsvSemantics.InterpretationVersion ||
                Comparable(decision,"kind")!="mapping" || Comparable(decision,"rulesVersion")!=CsvSemantics.Version || Comparable(decision,"profileVersion")!=CsvSemantics.Profile ||
                Comparable(decision,"sourceId")!=installationId || Comparable(decision,"decisionId")!=Comparable(receipt,"id") ||
                Comparable(decision,"policyRevision")!=configDigest || Comparable(decision,"originalSha256")!=digest ||
                decision.GetProperty("configurationRevision").GetInt32()!=contract.GetProperty("basedOnConfigRevision").GetInt32()+1 ||
                Comparable(decision,"outcome")!="automatic" || Comparable(decision,"grain")!="shipment" ||
                decision.GetProperty("rowCount").GetInt32()!=local.RowCount) return false;
            var fields=decision.GetProperty("fields").EnumerateArray().ToArray();
            return fields.Length==local.Decisions.Length && local.Decisions.All(expected=>fields.Any(field=>
                Comparable(field,"field")==expected.Field && Comparable(field,"sourceColumnId")== (expected.SourceColumnId??"") &&
                Comparable(field,"state")==expected.State && Comparable(field,"origin")==expected.Origin &&
                field.GetProperty("validRowCount").GetInt32()==expected.ValidRowCount &&
                field.GetProperty("invalidRowCount").GetInt32()==expected.InvalidRowCount &&
                field.GetProperty("reasonCodes").EnumerateArray().Select(code=>code.GetString()).SequenceEqual(expected.ReasonCodes)));
        } catch(Exception e) when(e is KeyNotFoundException or InvalidOperationException or FormatException) { return false; }
    }
    internal static void CheckCanonicalRecord(JsonElement response,JsonElement expected)
    {
        var proof=response.GetProperty("proof");var transaction=proof.GetProperty("transaction");
        if(Comparable(transaction,"itemTitle")!=Comparable(expected,"itemTitle")||Comparable(transaction,"quantity")!=Comparable(expected,"quantity"))throw new ConnectException("RECORD_VALUE_MISMATCH","The retrieved shipment does not match the approved source values. Automatic collection stays paused.");
        var shipping=transaction.GetProperty("shipping");
        if(new[]{"trackingNumber","carrier","shipmentDate"}.Any(f=>Comparable(shipping,f)!=Comparable(expected,f)))throw new ConnectException("RECORD_VALUE_MISMATCH","The retrieved shipping details do not match the approved source.");
    }
}

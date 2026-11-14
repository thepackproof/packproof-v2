using System.Globalization;
using System.Text;
using System.Text.Json;
namespace PackProof.Connect;

public sealed partial class AgentRuntime
{
    private void InvalidateAnalysis()
    {
        state.LocalAnalysis=null;state.ExcludedFileNames=null;state.BaselineSha256=null;state.BaselineObservedAt=null;
        state.GuidedSetup=false;state.GuidedPhase=null;state.GuidedProposalSha256=null;state.GuidedFileSha256=null;state.VerifiedSetupImportId=null;state.DraftRevision++;
    }
    private void CaptureBaseline()
    {
        state.ExcludedFileNames=Directory.EnumerateFiles(state.Folder!,"*",SearchOption.TopDirectoryOnly).Where(p=>Path.GetExtension(p).Equals(".csv",StringComparison.OrdinalIgnoreCase)).Select(Path.GetFileName).Select(n=>n!).OrderBy(n=>n,StringComparer.OrdinalIgnoreCase).ToArray();
        if(state.ExcludedFileNames.Length>10000)throw new ConnectException("SOURCE_CAPACITY_REACHED","Use the approved bounded shipment folder.");
        state.BaselineSha256=Hash(JsonSerializer.Serialize(state.ExcludedFileNames));state.BaselineObservedAt=DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ",CultureInfo.InvariantCulture);
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
        var result=CsvSemantics.Analyze(bytes,map,confirmed,location);
        var parsed=FolderSource.Parse(bytes);
        var instants=parsed.Rows.Where(r=>result.Mapping.TryGetValue("shippedAt",out var h)&&CsvSemantics.Instant(r[h].Trim(),out _)).Select(r=>DateTimeOffset.Parse(r[result.Mapping["shippedAt"]].Trim(),CultureInfo.InvariantCulture)).ToArray();
        var backfill=instants.Length>0?instants.Min().ToString("yyyy-MM-ddTHH:mm:ss.fffzzz",CultureInfo.InvariantCulture):null;
        if(request?.TryGetProperty("backfillFrom",out var cutoff)==true){if(!CsvSemantics.Instant(cutoff.GetString()!,out var at)||instants.Any(t=>t<at))throw new ConnectException("SOURCE_BACKFILL_BOUNDARY","The chosen history date excludes shipments in this selected report.");backfill=cutoff.GetString();}
        var config=new {sourceName=Optional(state.ServerConfig,"sourceName")?.GetString(),integrationAccountId=Optional(state.ServerConfig,"integrationAccountId")?.GetString(),operatorMembershipId=Optional(state.ServerConfig,"operatorMembershipId")?.GetString(),locationId=location,folderDigest=state.FolderDigest,mapping=result.Mapping,timeZone="source-offset",importValidRows=false,offlineWindowHours=24,sourceContract=new{schema="packproof.scheduled-csv/v2",exporterName=(string?)null,exporterVersion=(string?)null,expectedHeaders=parsed.Headers,expectedIntervalSeconds=(int?)null,backfillFrom=backfill,rulesVersion=CsvSemantics.Version,profileVersion=CsvSemantics.Profile,confirmedFields=confirmed,analysisRevision=state.DraftRevision,historyPolicy=new{mode="selected_then_new",baselineSha256=state.BaselineSha256,observedAt=state.BaselineObservedAt,initialFileName=state.FileName,initialFileSha256=state.FileDigest}}};
        // Null metadata is an explicit part of the v2 contract, not an invented exporter.
        var configJson=JsonSerializer.SerializeToElement(config,new JsonSerializerOptions(Json.Options){DefaultIgnoreCondition=System.Text.Json.Serialization.JsonIgnoreCondition.Never});
        state.LocalAnalysis=Json.Element(new{ready=result.Ready,decisions=result.Decisions,shipment=result.Shipment,issues=result.Issues,headers=parsed.Headers,rowCount=result.RowCount,configuration=configJson,binding=new{sourceBindingId=state.InstallationId,folderDigest=state.FolderDigest,fileSha256=state.FileDigest,headerFingerprint=result.HeaderFingerprint,draftRevision=state.DraftRevision,profileVersion=CsvSemantics.Profile,rulesVersion=CsvSemantics.Version}});
        state.GuidedSetup=false;state.VerifiedRecordId=null;state.VerifiedSetupImportId=null;
    }
    private async Task BeginGuidedSetup(JsonElement request,CancellationToken ct)
    {
        RequireCredential();RequireReasonableClock(DateTimeOffset.UtcNow);
        if(!request.TryGetProperty("wholeFileUploadApproved",out var consent)||consent.ValueKind!=JsonValueKind.True)throw new ConnectException("UPLOAD_CONSENT_REQUIRED","Approve uploading and preserving the entire selected original, including unmapped columns.");
        if(state.LocalAnalysis?.GetProperty("ready").GetBoolean()!=true)throw new ConnectException("MAPPING_NEEDS_REVIEW","Resolve the shipment details before requesting approval.");
        if(request.GetProperty("draftRevision").GetInt32()!=state.DraftRevision)throw new ConnectException("PREVIEW_CHANGED","Review the current report before approving.");
        await Refresh(ct);
        if(Optional(Optional(state.ServerConfig,"capabilities"),"rulesVersion")?.GetString()!=CsvSemantics.Version)throw new ConnectException("SOURCE_CONTRACT_UNSUPPORTED","The server and this installation need matching source-validation support. No original was uploaded.");
        if(!DateTimeOffset.TryParse(state.BaselineObservedAt,out var reviewedAt)||DateTimeOffset.UtcNow-reviewedAt>TimeSpan.FromMinutes(30))throw new ConnectException("APPROVAL_EXPIRED","This local source review expired. Choose the report again to request a fresh approval.");
        var bytes=CurrentSnapshot();var config=state.LocalAnalysis.Value.GetProperty("configuration");FolderSource.ValidateContract(bytes,config);
        if(state.GuidedSetup && state.GuidedProposalSha256 is not null && state.GuidedFileSha256==state.FileDigest)return;
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
        if(state.SetupQueueId is null){var bytes=CurrentSnapshot();FolderSource.ValidateContract(bytes,Approved!.Value);var staged=queue.Stage(bytes,state.FileName!,new(Approved.Value),Generation,QueueConfigIdentity,false);state.SetupQueueId=staged.Id;state.GuidedPhase="cloud_preview_pending";Save();}
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
            state.ServerConfig=await api.Request("POST","/v1/partner/agent/heartbeat",new{version=InstalledVersion,queueCount=CurrentPendingCount(),verifiedImportId=state.VerifiedSetupImportId},state.Token,null,ct);
            state.LastPolicyCheckAt=DateTimeOffset.UtcNow;Save();
        }
        state.GuidedPhase="recurring_approval_pending";Save();
        if(ServerState!="active")return;
        state.LocalPaused=false;state.PauseAuthorizationTimestamp=null;state.GuidedSetup=false;state.GuidedPhase="active";Save();
    }
    private static string Comparable(JsonElement obj,string property)=>obj.TryGetProperty(property,out var value)&&value.ValueKind!=JsonValueKind.Null?value.ToString():"";
    internal static void CheckPreviewParity(byte[] bytes,JsonElement receipt,JsonElement config)
    {
        var map=JsonSerializer.Deserialize<Dictionary<string,string>>(config.GetProperty("mapping"),Json.Options)!;
        var contract=config.GetProperty("sourceContract");var confirmed=contract.GetProperty("confirmedFields").EnumerateArray().Select(x=>x.GetString()!).ToArray();
        var location=config.TryGetProperty("locationId",out var l)&&l.ValueKind==JsonValueKind.String?l.GetString():null;
        var local=CsvSemantics.Analyze(bytes,map,confirmed,location,true,config.GetProperty("timeZone").GetString()!);
        var remote=receipt.GetProperty("rows").EnumerateArray().ToArray();
        if(!local.Ready||remote.Length!=local.Rows.Length)throw new ConnectException("INTERPRETATION_MISMATCH","Local and server shipment interpretations differ. No batch will be committed.");
        for(var i=0;i<remote.Length;i++){
            if(remote[i].GetProperty("rowNumber").GetInt32()!=i+2||!remote[i].TryGetProperty("normalized",out var n)||n.ValueKind!=JsonValueKind.Object||new[]{"shipmentReference","itemTitle","quantity","trackingNumber","carrier","shippedAt","shipmentDate","locationId"}.Any(f=>Comparable(n,f)!=Comparable(local.Rows[i],f)))throw new ConnectException("INTERPRETATION_MISMATCH","Local and server shipment interpretations differ. Preserve the original for review.");
        }
    }
    internal static void CheckCanonicalRecord(JsonElement response,JsonElement expected)
    {
        var proof=response.GetProperty("proof");var transaction=proof.GetProperty("transaction");
        if(Comparable(transaction,"itemTitle")!=Comparable(expected,"itemTitle")||Comparable(transaction,"quantity")!=Comparable(expected,"quantity"))throw new ConnectException("RECORD_VALUE_MISMATCH","The retrieved shipment does not match the approved source values. Automatic collection stays paused.");
        var shipping=transaction.GetProperty("shipping");
        if(new[]{"trackingNumber","carrier","shipmentDate"}.Any(f=>Comparable(shipping,f)!=Comparable(expected,f)))throw new ConnectException("RECORD_VALUE_MISMATCH","The retrieved shipping details do not match the approved source.");
    }
}

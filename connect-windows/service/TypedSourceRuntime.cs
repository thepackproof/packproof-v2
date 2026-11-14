using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
namespace PackProof.Connect;

public sealed partial class AgentRuntime
{
    private bool typedSourceSubscriptions;
    private bool TypedDiscoveryAdvertised => Optional(state.ServerConfig,"capabilities") is { } capabilities && capabilities.TryGetProperty("typedSourceSubscriptions",out var enabled) && enabled.ValueKind==JsonValueKind.True && capabilities.TryGetProperty("sourceSubscriptionsSchema",out var schema) && schema.GetString()=="packproof.source-subscriptions/v1";
    private SourceSubscriptionState Subscription(string id) => state.SourceSubscriptions.SingleOrDefault(s=>s.Id==id&&id!=SourceSubscriptionState.LegacyId) ?? throw new ConnectException("SOURCE_SUBSCRIPTION_REQUIRED","Refresh and approve this source in PackProof before configuring local collection.");
    private static string SourceFolderDigest(string folder) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(folder.ToUpperInvariant())));
    private JsonElement SourceConfig(SourceSubscriptionState source) => source.ApprovedConfiguration is { } config ? config : throw new ConnectException("SOURCE_APPROVAL_REQUIRED","Review the source configuration in PackProof first.");
    // A source grant cannot override a known global installation hold. Ready
    // installations may have independent typed grants without legacy CSV active.
    private bool TypedInstallationMayRead => !checkpointed && state.Token is not null && state.PendingToken is null && state.RenewalKey is null && state.CredentialExpiresAt>DateTimeOffset.UtcNow && ServerState is "ready" or "active";
    private void RequireTypedInstallationRead()
    {
        RequireCredential();if(!TypedInstallationMayRead)throw new ConnectException("AGENT_AUTHORIZATION_REQUIRED","Approve and resume this installation in PackProof before reading source exports.");
    }
    private bool SourcePolicyCurrent(SourceSubscriptionState source,DateTimeOffset now)
    {
        if(!TypedInstallationMayRead)return false;
        var config=SourceConfig(source);
        return source.CapabilityApproved && source.ServerState=="active" && !source.LocalPaused && source.Folder is not null && source.FolderDigest==config.GetProperty("folderDigest").GetString() && CollectionPolicy.IsWithinApprovedWindow(now,source.LastPolicyCheckAt,state.CredentialExpiresAt,config.GetProperty("offlineWindowHours").GetDouble(),networkOnline);
    }
    private async Task RefreshSubscriptions(CancellationToken ct)
    {
        typedSourceSubscriptions=false;
        if(!TypedDiscoveryAdvertised){foreach(var source in state.SourceSubscriptions.Where(s=>s.Id!=SourceSubscriptionState.LegacyId))source.CapabilityApproved=false;return;}
        string? cursor=null;var seen=new HashSet<string>(StringComparer.Ordinal);var views=new List<JsonElement>();
        do
        {
            var path="/v1/partner/source-subscriptions"+(cursor is null?"":"?cursor="+Uri.EscapeDataString(cursor));
            var response=await api.Request("GET",path,null,state.Token,null,ct);
            if(response.GetProperty("schema").GetString()!="packproof.source-subscriptions/v1"||Optional(response,"capabilities")?.TryGetProperty("typedCollection",out var capability)!=true||capability.ValueKind!=JsonValueKind.True)throw new ConnectException("SOURCE_CAPABILITY_UNSUPPORTED","The installed collector and hosted source profiles are not compatible. Existing work remains preserved.");
            views.AddRange(response.GetProperty("subscriptions").EnumerateArray().Select(v=>v.Clone()));
            if(views.Count>1000)throw new ConnectException("SOURCE_SUBSCRIPTION_LIMIT","This installation exceeds its qualified source limit. No source state was replaced.");
            cursor=response.TryGetProperty("nextCursor",out var next)&&next.ValueKind==JsonValueKind.String?next.GetString():null;
            if(cursor is not null&&(cursor.Length>200||!seen.Add(cursor)))throw new ConnectException("SOURCE_PAGINATION_INVALID","Source discovery did not return complete, advancing pages. Existing source work remains preserved.");
        }while(cursor is not null);
        var present=new HashSet<string>(StringComparer.Ordinal);
        foreach(var view in views)
        {
            var id=view.GetProperty("id").GetString()!; if(!present.Add(id)||id==SourceSubscriptionState.LegacyId)throw new ConnectException("SOURCE_CONFIGURATION_INVALID","Source discovery returned an ambiguous identity.");
            var config=view.GetProperty("config");if(config.GetProperty("transport").GetString()!="local_ntfs")continue;
            if(view.GetProperty("installationId").GetString()!=state.InstallationId)continue;
            var source=state.SourceSubscriptions.SingleOrDefault(s=>s.Id==id);
            if(source is null){source=new(){Id=id};state.SourceSubscriptions.Add(source);}
            var revision=view.GetProperty("configurationRevision").GetInt32();var grant=view.GetProperty("grantRevision").GetInt32();var digest=view.GetProperty("configurationSha256").GetString()!;
            if(source.ConfigurationSha256!="none"&&(source.ConfigurationSha256!=digest||source.ConfigurationRevision!=revision||source.GrantRevision!=grant))
            {
                source.LocalPaused=true;
                if(source.ConfigurationSha256!=digest||source.ConfigurationRevision!=revision){source.SelectedFileName=null;source.SelectedFileSha256=null;source.SetupQueueId=null;source.VerifiedCaseId=null;source.LocalPreview=null;source.LastErrorCode="SOURCE_REVISION_REVIEW_REQUIRED";}
            }
            source.SourceProfile=config.GetProperty("sourceProfile").GetString()!;source.ApprovedConfiguration=config.Clone();source.ConfigurationSha256=digest;source.ConfigurationRevision=revision;source.GrantRevision=grant;source.ServerState=view.GetProperty("state").GetString()!;source.ServerView=view.Clone();source.LastPolicyCheckAt=DateTimeOffset.UtcNow;
            var capabilities=view.GetProperty("capabilities");source.CapabilityApproved=(source.ServerState=="active"&&capabilities.GetProperty("typedCollection").GetBoolean())||(source.ServerState=="approved"&&capabilities.GetProperty("preview").GetBoolean());
            if(source.ServerState is "paused" or "revoked" or "proposed")source.LocalPaused=true;
        }
        foreach(var source in state.SourceSubscriptions.Where(s=>s.Id!=SourceSubscriptionState.LegacyId&&!present.Contains(s.Id))){source.CapabilityApproved=false;source.LocalPaused=true;source.LastErrorCode="SOURCE_AUTHORIZATION_REQUIRED";}
        typedSourceSubscriptions=true;
        await ApplyApprovedCompactionCommands(ct);
    }
    internal static bool CompactionCommandMatches(JsonElement command,SourceSubscriptionState source,QueueEntry entry,string installationId,string environment,string generation,DateTimeOffset now,bool historicalAcknowledgement=false)
    {
        try
        {
            if(source.ServerView is not { } view||!source.CapabilityApproved||source.ServerState is not("approved" or "active")||Optional(Optional(view,"capabilities"),"disposition")?.ValueKind!=JsonValueKind.True)return false;
            var receiptGrantRevision=command.GetProperty("receiptGrantRevision").GetInt32();if(receiptGrantRevision<1)return false;
            if(command.GetProperty("schema").GetString()!="packproof.collector-compaction-command/v1"||command.GetProperty("compactAfterAcknowledgement").ValueKind!=JsonValueKind.True||entry.State!="complete"||entry.ImportId!=command.GetProperty("batchId").GetString()||entry.Digest!=command.GetProperty("originalSha256").GetString()||entry.SourceId!=source.Id||entry.ConfigDigest!=source.QueueConfigurationIdentity(installationId,receiptGrantRevision)||entry.GrantRevision!=receiptGrantRevision||entry.CredentialGeneration!=generation)return false;
            if(command.GetProperty("subscriptionId").GetString()!=source.Id||command.GetProperty("installationId").GetString()!=installationId||command.GetProperty("environment").GetString()!=environment||command.GetProperty("configurationRevision").GetInt32()!=source.ConfigurationRevision||command.GetProperty("grantRevision").GetInt32()!=source.GrantRevision)return false;
            foreach(var field in new[]{"organizationId","environment","principalId","installationId","connectionId","locationId","operatorMembershipId"})if(command.GetProperty(field).GetString()!=view.GetProperty(field).GetString())return false;
            if(!historicalAcknowledgement&&(now<command.GetProperty("retainUntil").GetDateTimeOffset()||now>=command.GetProperty("expiresAt").GetDateTimeOffset()))return false;
            var expected=command.GetProperty("commandSha256").GetString();var body=Json.Element(command.EnumerateObject().Where(p=>p.Name!="commandSha256").ToDictionary(p=>p.Name,p=>(object?)p.Value));
            return expected==Convert.ToHexStringLower(SHA256.HashData(TypedSourceSemantics.CanonicalBytes(body)));
        }
        catch(Exception error)when(error is KeyNotFoundException or InvalidOperationException or FormatException){return false;}
    }
    internal static DateTimeOffset CompactionPermitTime(JsonElement permit,JsonElement command,QueueEntry entry,DateTimeOffset projectedServerTime)
    {
        try
        {
            var issued=permit.GetProperty("issuedAt").GetDateTimeOffset();var expires=permit.GetProperty("expiresAt").GetDateTimeOffset();var server=permit.GetProperty("serverTime").GetDateTimeOffset();
            var now=projectedServerTime>server?projectedServerTime:server;
            if(permit.GetProperty("id").ValueKind!=JsonValueKind.String||string.IsNullOrWhiteSpace(permit.GetProperty("id").GetString())||permit.GetProperty("commandId").GetString()!=command.GetProperty("id").GetString()||permit.GetProperty("commandSha256").GetString()!=command.GetProperty("commandSha256").GetString()||permit.GetProperty("batchId").GetString()!=entry.ImportId||permit.GetProperty("originalSha256").GetString()!=entry.Digest||expires<=issued||expires-issued>TimeSpan.FromSeconds(30)||server<issued||now>=expires||Math.Abs((projectedServerTime-server).TotalSeconds)>2)throw new InvalidOperationException();
            return now;
        }
        catch(Exception error)when(error is KeyNotFoundException or InvalidOperationException or FormatException){throw new ConnectException("SOURCE_COMPACTION_UNSAFE","A current online preservation permit is required before this completed original can be compacted.");}
    }
    private async Task ApplyApprovedCompactionCommands(CancellationToken ct)
    {
        if(!state.SourceSubscriptions.Any(s=>Optional(Optional(s.ServerView,"capabilities"),"disposition")?.ValueKind==JsonValueKind.True))return;
        var response=await api.Request("GET","/v1/partner/agent/source-dispositions/compaction-commands",null,state.Token,null,ct);
        if(!api.LastResponseHadServerDate||api.LastServerDate is not { } serverNow)return;
        if(response.GetProperty("schema").GetString()!="packproof.collector-compaction-commands/v1")throw new ConnectException("SOURCE_COMPACTION_UNSAFE","The source compaction contract is unsupported; originals remain retained.");
        foreach(var command in response.GetProperty("commands").EnumerateArray().Take(100))
        {
            var source=state.SourceSubscriptions.SingleOrDefault(s=>s.Id==Optional(command,"subscriptionId")?.GetString());if(source is null)continue;
            var entry=queue.Entries().SingleOrDefault(e=>e.ImportId==Optional(command,"batchId")?.GetString()&&e.SourceId==source.Id);if(entry is null)continue;
            var retained=queue.Payload(entry);var historical=retained.OriginalCompacted&&retained.CompactionCommandId==Optional(command,"id")?.GetString()&&retained.CompactionCommandSha256==Optional(command,"commandSha256")?.GetString()&&retained.CompactionPermitId is not null&&retained.CompactedAt is not null;
            if(!CompactionCommandMatches(command,source,entry,state.InstallationId??"",(host.Environment=="live"?"live":"sandbox"),Generation,serverNow,historical))continue;
            var receipt=await api.Request("GET","/v1/partner/typed-imports/"+Uri.EscapeDataString(entry.ImportId!),null,state.Token,null,ct);
            if(!api.LastResponseHadServerDate||api.LastServerDate is not { } receiptNow||!CompactionCommandMatches(command,source,entry,state.InstallationId??"",(host.Environment=="live"?"live":"sandbox"),Generation,receiptNow,historical))continue;
            RequireTypedReceipt(receipt,entry,source);if(receipt.GetProperty("state").GetString()!="succeeded")continue;ValidateTypedAccounting(receipt);
            var payload=queue.Payload(entry);
            if(!payload.OriginalCompacted)
            {
                payload.Receipt=receipt;queue.Save(entry,payload,"complete");entry=queue.Find(entry.Id)!;
                var permit=await api.Request("POST","/v1/partner/agent/source-dispositions/compaction-commands/"+Uri.EscapeDataString(command.GetProperty("id").GetString()!)+"/permit",new{commandSha256=command.GetProperty("commandSha256").GetString(),batchId=entry.ImportId,originalSha256=entry.Digest},state.Token,command.GetProperty("id").GetString()+"-permit-"+Guid.NewGuid().ToString("N"),ct);
                if(permit.TryGetProperty("value",out var permitted))permit=permitted;
                if(!api.LastResponseHadServerDate||api.LastServerDate is not { } permitServerTime)continue;
                var compactAt=CompactionPermitTime(permit,command,entry,permitServerTime);
                if(!CompactionCommandMatches(command,source,entry,state.InstallationId??"",(host.Environment=="live"?"live":"sandbox"),Generation,compactAt))continue;
                _=queue.CompactApprovedTyped(entry,command.GetProperty("id").GetString()!,command.GetProperty("commandSha256").GetString()!,compactAt,permit.GetProperty("id").GetString()!);
            }
            var compacted=queue.Payload(entry);if(compacted.CompactionPermitId is null)throw new ConnectException("SOURCE_COMPACTION_UNSAFE","The retained compaction acknowledgement has no preservation permit.");
            await api.Request("POST","/v1/partner/agent/source-dispositions/compaction-commands/"+Uri.EscapeDataString(command.GetProperty("id").GetString()!)+"/ack",new{permitId=compacted.CompactionPermitId,commandSha256=command.GetProperty("commandSha256").GetString(),batchId=entry.ImportId,originalSha256=entry.Digest,serverReceiptReconciled=true,localDisposition="compacted",compactedAt=compacted.CompactedAt!.Value.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'",System.Globalization.CultureInfo.InvariantCulture)},state.Token,command.GetProperty("id").GetString()+"-"+command.GetProperty("commandSha256").GetString(),ct);
        }
    }
    private object[] SubscriptionViews()
    {
        var historyDisplayBytes=64*1024;
        return state.SourceSubscriptions.Where(s=>s.Id!=SourceSubscriptionState.LegacyId).Select(source=>
    {
        var config=source.ApprovedConfiguration;JsonElement? receipt=null;
        if(source.SetupQueueId is not null&&queue.Find(source.SetupQueueId) is { } setup)receipt=queue.Payload(setup).Receipt;
        object[] files=[];
        if(TypedInstallationMayRead&&source.CapabilityApproved&&(source.ServerState is "approved" or "active")&&source.Folder is not null)try{files=FolderSource.Inventory(source.Folder).Take(100).ToArray();}catch(ConnectException){ }
        var metrics=queue.Metrics(source.Id);var backfillJobs=BackfillViews(source,ref historyDisplayBytes);
        return (object)new {pendingCount=metrics.PendingCount,oldestPendingAt=metrics.OldestPendingAt,pendingAgeUnknownCount=metrics.PendingAgeUnknownCount,retainedBytes=metrics.RetainedBytes,originalBytesKnown=metrics.OriginalBytesKnown,originalBytesUnknownCount=metrics.OriginalBytesUnknownCount,organizationId=Optional(source.ServerView,"organizationId"),environment=Optional(source.ServerView,"environment"),backfillAvailable=BackfillAvailable(source),backfillSemantics=Optional(Optional(source.ServerView,"capabilities"),"backfillSemantics"),backfillJobTotal=source.BackfillJobs.Count,backfillJobKnownTotal=source.BackfillJobs.Count,backfillJobsShown=backfillJobs.Length,backfillJobsTruncated=source.BackfillJobs.Count>backfillJobs.Length,backfillDraft=source.BackfillDraft,backfillJobs,source.Id,source.SourceProfile,displayName=Optional(config,"displayName"),state=source.ServerState,source.LocalPaused,source.ConfigurationRevision,source.GrantRevision,source.Folder,source.FolderDigest,source.LastCheckAt,source.LastCollectedAt,source.LastReceiptAt,source.LastErrorCode,queue=queue.Counts(source.Id),source.VerifiedCaseId,source.SetupQueueId,files,selectedFileName=source.SelectedFileName,fileSha256=source.SelectedFileSha256,headers=Optional(source.LocalPreview,"headers"),rowCount=Optional(source.LocalPreview,"rowCount"),samples=Optional(source.LocalPreview,"samples"),receipt=receipt is null?null:new {id=Optional(receipt,"id"),state=Optional(receipt,"state"),counts=Optional(receipt,"counts"),caseIds=Optional(receipt,"caseIds"),original=Optional(receipt,"original")},approvalPath=$"/app/records/connect/approve?installationId={Uri.EscapeDataString(state.InstallationId??"")}&subscriptionId={Uri.EscapeDataString(source.Id)}"};
    }).ToArray();
    }
    private void BindSubscriptionSource(SourceSubscriptionState source,string input)
    {
        RequireTypedInstallationRead();
        if(!typedSourceSubscriptions||!source.CapabilityApproved)throw new ConnectException("SOURCE_APPROVAL_REQUIRED","Approve this exact source in PackProof before selecting its local folder.");
        var folder=FolderSource.Validate(input);var digest=SourceFolderDigest(folder);var config=SourceConfig(source);
        if(digest!=config.GetProperty("folderDigest").GetString())throw new ConnectException("SOURCE_SCOPE_REVIEW_REQUIRED","The selected folder differs from its browser-approved source. Review the source path before collection.");
        _=FolderSource.Inventory(folder);
        // Rechecking an already bound folder must not redefine its historical
        // boundary and silently exclude exports waiting to be collected.
        if(source.Folder is not null&&source.Folder.Equals(folder,StringComparison.OrdinalIgnoreCase)&&source.FolderDigest==digest)return;
        source.Folder=folder;source.FolderDigest=digest;source.LocalPaused=true;source.SelectedFileName=null;source.SelectedFileSha256=null;source.LocalPreview=null;
        // Existing files other than the exact approved initial original remain
        // excluded. Periodic scans admit only subsequently published filenames.
        source.PublishedFileDigests.Clear();source.ExcludedFileNames=Directory.EnumerateFiles(folder,"*.csv",SearchOption.TopDirectoryOnly).Select(Path.GetFileName).Cast<string>().Order(StringComparer.OrdinalIgnoreCase).ToArray();
    }
    private IReadOnlyList<TypedSourceRowPreview> ValidateTypedOriginal(SourceSubscriptionState source,byte[] bytes)
    {
        var config=SourceConfig(source);if(bytes.Length>config.GetProperty("maxBytes").GetInt32())throw new ConnectException("TYPED_SOURCE_TOO_LARGE","This original exceeds the approved source byte limit. It has not been split.");
        var rows=TypedSourceSemantics.Preview(bytes,config);if(rows.Count>config.GetProperty("maxRows").GetInt32())throw new ConnectException("TYPED_SOURCE_TOO_LARGE","This source exceeds its approved row limit.");
        var from=config.GetProperty("historyFrom").GetDateTimeOffset();var to=Optional(config,"historyTo");
        foreach(var row in rows.Where(r=>r.Valid))
        {
            var normalized=row.Normalized!.Value;var reported=Optional(normalized,"occurredAt");if(reported is null||reported.Value.ValueKind==JsonValueKind.Null)reported=Optional(normalized,"sourceAsOf");
            // Unknown business time remains unknown. The exact initial original
            // and subsequent immutable-file boundary still constrain collection.
            if(reported is { ValueKind:JsonValueKind.String }){var at=reported.Value.GetDateTimeOffset();if(at<from||to is {ValueKind:JsonValueKind.String}&&at>to.Value.GetDateTimeOffset())throw new ConnectException("SOURCE_BACKFILL_BOUNDARY","This export includes source times outside the approved history interval.");}
        }
        return rows;
    }
    private JsonElement TypedRequest(SourceSubscriptionState source,string name,byte[] bytes,object? collectionContext=null)
    {
        var config=SourceConfig(source);var view=source.ServerView!.Value;
        var schema=Optional(config,"batchSchema")?.GetString()??TypedSourceSemantics.Schema;
        var request=new Dictionary<string,object?>{{"schema",schema},{"subscriptionId",source.Id},{"configurationRevision",source.ConfigurationRevision},{"grantRevision",source.GrantRevision},{"connectionId",view.GetProperty("connectionId").GetString()},{"locationId",view.GetProperty("locationId").GetString()},{"sourceProfile",source.SourceProfile},{"mappingVersion",config.GetProperty("mappingVersion").GetString()},{"sourceNamespace",config.GetProperty("sourceNamespace").GetString()},{"mapping",config.GetProperty("mapping")},{"constants",config.GetProperty("constants")},{"wholeFileConsent",true},{"original",new{name,mediaType="text/csv",content=new UTF8Encoding(false,true).GetString(bytes),sha256=Convert.ToHexStringLower(SHA256.HashData(bytes))}},{"completeness",TypedSourceSemantics.Completeness(bytes,config)}};
        if(schema==TypedSourceSemantics.SchemaV2)request["identityPolicy"]=config.GetProperty("identityPolicy");
        if(collectionContext is not null)request["collectionContext"]=collectionContext;
        return Json.Element(request);
    }
    private async Task ProcessTyped(SourceSubscriptionState source,QueueEntry entry,CancellationToken ct,bool readOnly=false)
    {
        if(entry.SourceId!=source.Id||entry.SourceProfile!=source.SourceProfile||entry.GrantRevision!=source.GrantRevision||entry.ConfigDigest!=source.QueueConfigurationIdentity(state.InstallationId)||entry.CredentialGeneration!=Generation)throw new ConnectException("SOURCE_QUEUE_AUTHORITY_CHANGED","This original belongs to an earlier source approval or credential. Preserve it for explicit recovery.");
        if(!source.CapabilityApproved||source.ServerState is not("approved" or "active"))throw new ConnectException("SOURCE_AUTHORIZATION_REQUIRED","This source no longer has current approval.");
        if(readOnly&&entry.ImportId is null){queue.YieldRetry(entry);return;}
        var payload=queue.Payload(entry);var historical=payload.PreviewBody.TryGetProperty("collectionContext",out _);
        try
        {
            if(historical&&!readOnly)
            {
                var jobId=payload.PreviewBody.GetProperty("collectionContext").GetProperty("jobId").GetString()!;var local=source.BackfillJobs.SingleOrDefault(j=>j.Id==jobId);
                // Exact-byte live overlap preserves this historical wire body.
                // Its job pause and current approval still govern every replay.
                readOnly=local?.LocalPaused==true||!BackfillCurrent(source,await FreshBackfill(source,jobId,ct));
                if(readOnly&&entry.ImportId is null){queue.YieldRetry(entry);return;}
            }
            JsonElement receipt;
            if(entry.ImportId is null)
            {
                queue.Save(entry,payload,"preview_pending");entry=queue.Find(entry.Id)!;
                receipt=await api.Request("POST","/v1/partner/typed-imports/preview",new ExactJsonBody(payload.PreviewWireBody!,payload.PreviewBodySha256!),state.Token,entry.PreviewKey,ct);if(receipt.TryGetProperty("value",out var value))receipt=value;
                payload.Receipt=receipt;queue.Save(entry,payload,"awaiting_review",receipt.GetProperty("id").GetString());entry=queue.Find(entry.Id)!;
            }
            else{receipt=await api.Request("GET","/v1/partner/typed-imports/"+Uri.EscapeDataString(entry.ImportId),null,state.Token,null,ct);payload.Receipt=receipt;}
            RequireTypedReceipt(receipt,entry,source);
            var phase=receipt.GetProperty("state").GetString();
            if(readOnly&&phase=="previewed"){queue.Save(entry,payload,entry.State);queue.YieldRetry(entry);return;}
            if(phase=="previewed")
            {
                var local=ValidateTypedOriginal(source,Encoding.UTF8.GetBytes(payload.Csv));var server=receipt.GetProperty("rows").EnumerateArray().ToArray();
                if(local.Count!=server.Length||local.Where((row,i)=>row.RowNumber!=server[i].GetProperty("rowNumber").GetInt32()||row.Valid!=(server[i].GetProperty("normalized").ValueKind!=JsonValueKind.Null)||row.Valid&&!TypedSourceSemantics.CanonicalBytes(row.Normalized!.Value).SequenceEqual(TypedSourceSemantics.CanonicalBytes(server[i].GetProperty("normalized")))).Any())throw new ConnectException("SOURCE_PREVIEW_PARITY_FAILED","Local and hosted interpretations differ. The original is retained; review the compatible profile and mapping before activation.");
                if(payload.CommitApproved)
                {
                    if(local.Any(row=>!row.Valid))throw new ConnectException("TYPED_SOURCE_NEEDS_REVIEW","Review all invalid source rows before collecting this feed.");
                    payload.CommitWireBody??=Json.Bytes(new{previewVersion=receipt.GetProperty("previewVersion").GetString(),originalSha256=entry.Digest,importValidRows=false});payload.CommitBodySha256??=Convert.ToHexStringLower(SHA256.HashData(payload.CommitWireBody));queue.Save(entry,payload,"commit_pending");entry=queue.Find(entry.Id)!;
                    receipt=await api.Request("POST","/v1/partner/typed-imports/"+Uri.EscapeDataString(entry.ImportId!)+"/commit",new ExactJsonBody(payload.CommitWireBody,payload.CommitBodySha256),state.Token,entry.CommitKey,ct);if(receipt.TryGetProperty("value",out var value))receipt=value;payload.Receipt=receipt;RequireTypedReceipt(receipt,entry,source);phase=receipt.GetProperty("state").GetString();
                }
            }
            var next=phase switch{"succeeded"=>"complete","partially_succeeded"=>"partial","failed" or "blocked_policy"=>"action_needed","previewed"=>"awaiting_review",_=>"server_processing"};
            if(next=="complete")ValidateTypedAccounting(receipt);
            if(payload.OriginalCompacted&&payload.Receipt is { } compactedReceipt)payload.Receipt=DurableQueue.ReceiptWithoutRaw(compactedReceipt);
            queue.Save(entry,payload,next);if(readOnly&&next=="server_processing")queue.YieldRetry(entry);if(next=="complete")source.LastReceiptAt=DateTimeOffset.UtcNow;
        }
        catch(ApiException error){queue.Save(queue.Find(entry.Id)??entry,payload,error.Transient?entry.State:"action_needed",error:error.Code,failed:error.Transient,retryAfter:error.RetryAfter);source.LastErrorCode=error.Code;throw;}
        catch(ConnectException error){queue.Save(queue.Find(entry.Id)??entry,payload,"action_needed",error:error.Code);source.LastErrorCode=error.Code;if(!historical)source.LocalPaused=true;throw;}
        catch(Exception error)when(error is HttpRequestException or TaskCanceledException){queue.Save(queue.Find(entry.Id)??entry,payload,entry.State,error:"NETWORK_UNAVAILABLE",failed:true);networkOnline=false;throw;}
        catch(Exception error)when(error is KeyNotFoundException or InvalidOperationException or FormatException){queue.Save(queue.Find(entry.Id)??entry,payload,"action_needed",error:"TYPED_RECEIPT_INVALID");if(!historical)source.LocalPaused=true;throw new ConnectException("TYPED_RECEIPT_INVALID","The source receipt is incomplete. Preserve the original and reconcile its durable outcomes before collection.");}
    }
    private static void RequireTypedReceipt(JsonElement receipt,QueueEntry entry,SourceSubscriptionState source)
    {
        if(receipt.GetProperty("original").GetProperty("sha256").GetString()!=entry.Digest||receipt.GetProperty("subscriptionId").GetString()!=source.Id||receipt.GetProperty("configurationRevision").GetInt32()!=source.ConfigurationRevision)throw new ConnectException("TYPED_RECEIPT_SCOPE_MISMATCH","The hosted receipt differs from its exact source original or approved revision.");
    }
    internal static void ValidateTypedAccounting(JsonElement receipt)
    {
        var rows=receipt.GetProperty("rows").EnumerateArray().ToArray();var counts=receipt.GetProperty("counts");var map=new Dictionary<string,string>{{"processing","processing"},{"accepted_linked","acceptedLinked"},{"accepted_unlinked","acceptedUnlinked"},{"duplicate","duplicate"},{"conflict","conflict"},{"quarantined","quarantined"},{"rejected","rejected"}};
        if(rows.Length!=receipt.GetProperty("rowCount").GetInt32()||rows.Length==0||rows.Select(r=>r.GetProperty("index").GetInt32()).Distinct().Count()!=rows.Length||rows.Any(r=>!map.ContainsKey(r.GetProperty("status").GetString()!))||map.Any(p=>counts.GetProperty(p.Value).GetInt32()!=rows.Count(r=>r.GetProperty("status").GetString()==p.Key))||counts.GetProperty("processing").GetInt32()!=0)throw new ConnectException("TYPED_RECEIPT_ACCOUNTING_FAILED","Every source row must have one reconciled durable outcome. The original remains retained.");
    }
    internal static string ValidateTypedStoredRecords(JsonElement receipt,JsonElement subset,string batchId,string digest)
    {
        try
        {
            if(subset.GetProperty("schema").GetString()!="packproof.typed-import-records/v1"||subset.GetProperty("batchId").GetString()!=batchId||subset.GetProperty("originalSha256").GetString()!=digest)throw new InvalidOperationException();
            var stored=subset.GetProperty("rows").EnumerateArray().ToArray();var accepted=receipt.GetProperty("rows").EnumerateArray().Where(row=>row.GetProperty("status").GetString() is "accepted_linked" or "duplicate").ToArray();
            if(stored.Length==0||accepted.Length==0||stored.Select(row=>(row.GetProperty("rowNumber").GetInt32(),row.GetProperty("caseId").GetString())).Distinct().Count()!=stored.Length||stored.Any(s=>!accepted.Any(r=>r.GetProperty("rowNumber").GetInt32()==s.GetProperty("rowNumber").GetInt32())))throw new InvalidOperationException();
            bool Same(JsonElement a,JsonElement b)=>TypedSourceSemantics.CanonicalBytes(a).SequenceEqual(TypedSourceSemantics.CanonicalBytes(b));
            bool Assertion(JsonElement actual,JsonElement expected)=>actual.GetProperty("id").ValueKind==JsonValueKind.String&&actual.GetProperty("property").GetString()==expected.GetProperty("property").GetString()&&Same(actual.GetProperty("subjectReference"),expected.GetProperty("subjectReference"))&&Same(actual.GetProperty("value"),expected.GetProperty("value"));
            bool Relation(JsonElement actual,JsonElement expected)=>actual.GetProperty("id").ValueKind==JsonValueKind.String&&actual.GetProperty("type").GetString()==expected.GetProperty("type").GetString()&&Same(actual.GetProperty("from"),expected.GetProperty("from"))&&Same(actual.GetProperty("to"),expected.GetProperty("to"))&&Same(actual.GetProperty("quantity"),expected.GetProperty("quantity"));
            string? firstCase=null;
            foreach(var row in accepted)
            {
                var original=row.GetProperty("normalized");var current=stored.Where(r=>r.GetProperty("rowNumber").GetInt32()==row.GetProperty("rowNumber").GetInt32()).ToArray();
                var declared=row.TryGetProperty("caseIds",out var ids)&&ids.ValueKind==JsonValueKind.Array?ids.EnumerateArray().Select(i=>i.GetString()).ToArray():row.TryGetProperty("caseId",out var legacyCase)&&legacyCase.ValueKind==JsonValueKind.String?[legacyCase.GetString()]:null;
                if(current.Length==0||(declared is null?current.Length!=1:declared.Length!=current.Length||declared.Any(id=>!current.Any(c=>c.GetProperty("caseId").GetString()==id))))throw new InvalidOperationException();
                foreach(var projection in current)
                {
                    var caseId=projection.GetProperty("caseId").GetString();
                    if(string.IsNullOrEmpty(caseId)||projection.GetProperty("projectionRevision").GetInt32()<1||projection.GetProperty("observationId").ValueKind!=JsonValueKind.String||!receipt.GetProperty("caseIds").EnumerateArray().Any(c=>c.GetString()==caseId))throw new InvalidOperationException();
                    if(row.TryGetProperty("id",out var rowId)&&rowId.ValueKind==JsonValueKind.String){var sourceId=row.TryGetProperty("duplicateOf",out var duplicate)&&duplicate.ValueKind==JsonValueKind.String?duplicate.GetString():rowId.GetString();if(projection.GetProperty("observationId").GetString()!=sourceId)throw new InvalidOperationException();}
                    var projectedAssertions=projection.GetProperty("assertions").EnumerateArray().ToArray();
                    if(projectedAssertions.Select(a=>a.GetProperty("id").GetString()).Distinct().Count()!=projectedAssertions.Length||projectedAssertions.Select(a=>a.GetProperty("property").GetString()+":"+System.Text.Encoding.UTF8.GetString(TypedSourceSemantics.CanonicalBytes(a.GetProperty("subjectReference")))).Distinct().Count()!=projectedAssertions.Length)throw new InvalidOperationException();
                    if(current.Length>1||projection.TryGetProperty("sourceRootReference",out var suppliedRoot)&&suppliedRoot.ValueKind==JsonValueKind.Object)
                    {
                        var sourceRoot=projection.GetProperty("sourceRootReference");var targetRoot=projection.GetProperty("rootReference");
                        if(sourceRoot.ValueKind!=JsonValueKind.Object||sourceRoot.GetProperty("type").GetString()!="order"||!original.GetProperty("references").EnumerateArray().Any(r=>Same(r,sourceRoot)))throw new InvalidOperationException();
                        var rootId=sourceRoot.GetProperty("externalId").GetString();var rootNamespace=sourceRoot.GetProperty("namespace").GetString();
                        if(!Same(sourceRoot,targetRoot))
                        {
                            var basis=projection.GetProperty("associationBasis");
                            if(basis.GetProperty("ruleVersion").GetString()!="packproof.case-partition/v1"||basis.GetProperty("kind").GetString()!="approved_crosswalk"||!Same(basis.GetProperty("root"),sourceRoot)||!basis.GetProperty("crosswalks").EnumerateArray().Any(c=>c.GetProperty("caseId").GetString()==caseId&&c.GetProperty("id").ValueKind==JsonValueKind.String))throw new InvalidOperationException();
                        }
                        string Key(JsonElement r)=>System.Text.Encoding.UTF8.GetString(TypedSourceSemantics.CanonicalBytes(r));
                        bool OwnLine(JsonElement r)=>r.GetProperty("type").GetString()=="order_line"&&r.GetProperty("namespace").GetString()==rootNamespace&&r.GetProperty("parentExternalId").GetString()==rootId;
                        void Scope(JsonElement r){var type=r.GetProperty("type").GetString();if(type=="order"&&!Same(r,sourceRoot)||type=="order_line"&&!OwnLine(r))throw new InvalidOperationException();}
                        var relations=projection.GetProperty("relationships").EnumerateArray().ToArray();var reachable=new HashSet<string>(original.GetProperty("references").EnumerateArray().Where(r=>Same(r,sourceRoot)||OwnLine(r)).Select(Key),StringComparer.Ordinal);
                        foreach(var relation in relations){Scope(relation.GetProperty("from"));Scope(relation.GetProperty("to"));}
                        bool changed;do{changed=false;foreach(var relation in relations){var from=Key(relation.GetProperty("from"));var to=Key(relation.GetProperty("to"));if(reachable.Contains(from))changed|=reachable.Add(to);if(reachable.Contains(to))changed|=reachable.Add(from);}}while(changed);
                        foreach(var assertion in projectedAssertions){var subject=assertion.GetProperty("subjectReference");Scope(subject);if(!reachable.Contains(Key(subject)))throw new InvalidOperationException();}
                        if(relations.Any(r=>!reachable.Contains(Key(r.GetProperty("from")))||!reachable.Contains(Key(r.GetProperty("to")))))throw new InvalidOperationException();
                    }
                    firstCase??=caseId;
                }
                var assertions=current.SelectMany(c=>c.GetProperty("assertions").EnumerateArray()).ToArray();var expected=original.GetProperty("assertions").EnumerateArray().ToArray();
                if(assertions.Any(a=>!expected.Any(e=>Assertion(a,e)))||expected.Any(e=>!assertions.Any(a=>Assertion(a,e))))throw new InvalidOperationException();
                // Version two exposes every case partition. Verify the union of
                // its materialized relations as well as its scalar assertions.
                if(original.TryGetProperty("identityDerivation",out _)||current.Any(c=>c.TryGetProperty("relationships",out _)))
                {
                    var relationships=current.SelectMany(c=>c.GetProperty("relationships").EnumerateArray()).ToArray();var expectedRelations=original.GetProperty("relationships").EnumerateArray().ToArray();
                    if(relationships.Any(r=>!expectedRelations.Any(e=>Relation(r,e)))||expectedRelations.Any(e=>!relationships.Any(r=>Relation(r,e))))throw new InvalidOperationException();
                }
            }
            return firstCase!;
        }
        catch(Exception error)when(error is KeyNotFoundException or InvalidOperationException or FormatException){throw new ConnectException("SOURCE_CASE_VERIFICATION_FAILED","Stored source assertions did not match this exact accepted batch. Collection remains paused and originals are retained.");}
    }
    private int PreservedQueueCount()
    {
        static int Pending(Dictionary<string,int> values)=>values.Where(p=>p.Key!="complete").Sum(p=>p.Value);
        var current=Pending(queue.Counts(SourceSubscriptionState.LegacyId,Generation,QueueConfigIdentity));
        foreach(var source in state.SourceSubscriptions.Where(s=>s.Id!=SourceSubscriptionState.LegacyId))current+=Pending(queue.Counts(source.Id,Generation,source.QueueConfigurationIdentity(state.InstallationId)));
        return Math.Max(0,Pending(queue.Counts())-current);
    }
    private bool HasCurrentTypedWork()
    {
        foreach(var source in state.SourceSubscriptions.Where(s=>s.Id!=SourceSubscriptionState.LegacyId))
            if(queue.Counts(source.Id,Generation,source.QueueConfigurationIdentity(state.InstallationId)).Any(p=>p.Key is not("complete" or "partial" or "action_needed")&&p.Value>0))return true;
        return false;
    }
    private async Task ReconcileSubscriptionBeforeRenewal(SourceSubscriptionState source,CancellationToken ct)
    {
        if(!networkOnline||!source.CapabilityApproved||!TypedInstallationMayRead)return;
        var identity=source.QueueConfigurationIdentity(state.InstallationId);var now=DateTimeOffset.UtcNow;
        var next=queue.NextDueLane(source.Id,Generation,identity,now,history:false)??queue.NextDueLane(source.Id,Generation,identity,now,history:true);
        if(next is null||source.LocalPaused&&next.State!="server_processing")return;
        try
        {
            await ProcessTyped(source,next,ct);
        }
        catch(ApiException error)when(error.Code.StartsWith("SOURCE_BACKFILL_",StringComparison.Ordinal)){source.LastErrorCode=error.Code;Save();}
        catch(ConnectException error)when(error.Code.StartsWith("SOURCE_BACKFILL_",StringComparison.Ordinal)){source.LastErrorCode=error.Code;Save();}
    }
    private async Task CollectSubscription(SourceSubscriptionState source,CancellationToken ct)
    {
        var now=DateTimeOffset.UtcNow;
        var processed=false;
        if(TypedInstallationMayRead&&networkOnline&&source.SetupQueueId is not null&&source.CapabilityApproved&&queue.Find(source.SetupQueueId) is {State:"server_processing"} setup&&setup.NextAttemptAt<=now&&setup.ConfigDigest==source.QueueConfigurationIdentity(state.InstallationId)){await ProcessTyped(source,setup,ct);processed=true;}
        if(!SourcePolicyCurrent(source,now))return;
        var identity=source.QueueConfigurationIdentity(state.InstallationId);var collected=false;
        // Reserve live discovery even when old work is due. One actual live
        // file read plus one due receipt operation bounds this source's turn.
        if(source.LastCheckAt is null||now-source.LastCheckAt>=TimeSpan.FromSeconds(30))
        {
            using var adapter=sourceAdapterFactory();var files=adapter.Inspect(source);
            foreach(var name in files)
            {
                if(!SourcePolicyCurrent(source,DateTimeOffset.UtcNow))break;
                if(source.ExcludedFileNames.Contains(name,StringComparer.OrdinalIgnoreCase)){source.CursorFileName=name;continue;}
                var file=adapter.Read(source,name);var digest=Convert.ToHexStringLower(SHA256.HashData(file.Bytes));
                if(source.PublishedFileDigests.TryGetValue(name,out var previousDigest)&&previousDigest==digest){source.CursorFileName=name;break;}
                QueueEntry staged;
                try{if(previousDigest is not null)throw new ConnectException("SOURCE_FILE_REPLACED","A published immutable export was replaced; both retained versions require review.");_=ValidateTypedOriginal(source,file.Bytes);staged=queue.StageRequest(file.Bytes,name,TypedRequest(source,name,file.Bytes),Generation,identity,true,new(source.Id,source.SourceProfile,source.GrantRevision));}
                catch(ConnectException error)when(!SourceScheduler.IsSharedSafetyFailure(error)){staged=queue.Quarantine(file.Bytes,name,Generation,identity,error.Code,new(source.Id,source.SourceProfile,source.GrantRevision));source.LastErrorCode=error.Code;source.LocalPaused=true;}
                source.PublishedFileDigests[name]=digest;source.CursorFileName=name;source.LastCollectedAt=DateTimeOffset.UtcNow;Save();collected=true;break;
            }
            source.LastCheckAt=DateTimeOffset.UtcNow;Save();
            if(networkOnline){var metrics=queue.Metrics(source.Id);await api.Request("POST","/v1/partner/source-subscriptions/"+Uri.EscapeDataString(source.Id)+"/heartbeat",new{configurationRevision=source.ConfigurationRevision,grantRevision=source.GrantRevision,state=source.LocalPaused?"mapping_drift":collected?"checked":"quiet",sourceAsOf=(string?)null,checkpoint=source.CursorFileName is null?null:Hash(source.CursorFileName),errorCode=source.LastErrorCode,backlog=metrics.PendingCount,oldestPendingAt=metrics.OldestPendingAt,pendingAgeUnknownCount=metrics.PendingAgeUnknownCount,retainedBytes=metrics.RetainedBytes},state.Token,Guid.NewGuid().ToString("N"),ct);}
        }
        if(!processed&&networkOnline&&SourcePolicyCurrent(source,DateTimeOffset.UtcNow)&&queue.NextDueLane(source.Id,Generation,identity,DateTimeOffset.UtcNow,history:false) is { } next)
        {
            try{await ProcessTyped(source,next,ct);}
            catch(ApiException error)when(error.Code.StartsWith("SOURCE_BACKFILL_",StringComparison.Ordinal)){source.LastErrorCode=error.Code;Save();}
            catch(ConnectException error)when(error.Code.StartsWith("SOURCE_BACKFILL_",StringComparison.Ordinal)){source.LastErrorCode=error.Code;Save();}
        }
    }
    private async Task TypedCommand(string operation,JsonElement payload,CancellationToken ct)
    {
        RequireCredential();if(operation!="pauseSubscription")RequireTypedInstallationRead();if(!typedSourceSubscriptions)await RefreshSubscriptions(ct);var source=Subscription(payload.GetProperty("id").GetString()??"");
        if(operation is "inspectSubscriptionFile" or "previewSubscription" or "commitSubscription" or "verifySubscription")
            if(!typedSourceSubscriptions||!source.CapabilityApproved||source.ServerState is not("approved" or "active"))throw new ConnectException("SOURCE_AUTHORIZATION_REQUIRED","Approve and resume this exact source in PackProof before reading or submitting another original.");
        switch(operation)
        {
            case "selectSubscriptionSource":BindSubscriptionSource(source,payload.GetProperty("folder").GetString()??"");break;
            case "inspectSubscriptionFile":
            {
                using var adapter=sourceAdapterFactory();var name=payload.GetProperty("fileName").GetString()??"";var file=adapter.Read(source,name);var digest=Convert.ToHexStringLower(SHA256.HashData(file.Bytes));
                if(source.ServerState=="approved"&&(name!=SourceConfig(source).GetProperty("initialFileName").GetString()||digest!=SourceConfig(source).GetProperty("initialOriginalSha256").GetString()))throw new ConnectException("SOURCE_INITIAL_ORIGINAL_CHANGED","Select the exact browser-approved first file before uploading.");
                _=ValidateTypedOriginal(source,file.Bytes);source.SelectedFileName=name;source.SelectedFileSha256=digest;source.LocalPreview=Json.Element(FolderSource.Preview(file.Bytes));source.LocalPaused=true;break;
            }
            case "previewSubscription":
            {
                if(!payload.TryGetProperty("wholeFileUploadApproved",out var consent)||consent.ValueKind!=JsonValueKind.True)throw new ConnectException("UPLOAD_CONSENT_REQUIRED","Approve upload of the entire exact source original first.");
                var name=payload.GetProperty("fileName").GetString()??"";if(name!=source.SelectedFileName||source.SelectedFileSha256 is null)throw new ConnectException("SOURCE_FILE_REVIEW_REQUIRED","Inspect this exact local file before approving upload.");
                using var adapter=sourceAdapterFactory();var file=adapter.Read(source,name);if(Convert.ToHexStringLower(SHA256.HashData(file.Bytes))!=source.SelectedFileSha256)throw new ConnectException("SOURCE_CHANGED","The selected original changed. Inspect it and approve its exact bytes again.");
                _=ValidateTypedOriginal(source,file.Bytes);var entry=queue.StageRequest(file.Bytes,name,TypedRequest(source,name,file.Bytes),Generation,source.QueueConfigurationIdentity(state.InstallationId),false,new(source.Id,source.SourceProfile,source.GrantRevision));source.SetupQueueId=entry.Id;Save();await ProcessTyped(source,entry,ct);break;
            }
            case "commitSubscription":
            {
                if(!payload.TryGetProperty("wholeBatchApproved",out var consent)||consent.ValueKind!=JsonValueKind.True)throw new ConnectException("BATCH_CONSENT_REQUIRED","Approve every displayed source row before importing.");
                var entry=source.SetupQueueId is null?null:queue.Find(source.SetupQueueId);if(entry is null)throw new ConnectException("PREVIEW_REQUIRED","Preview the approved source original first.");var data=queue.Payload(entry);data.CommitApproved=true;queue.Save(entry,data,"commit_pending");await ProcessTyped(source,queue.Find(entry.Id)!,ct);break;
            }
            case "verifySubscription":
            {
                var entry=source.SetupQueueId is null?null:queue.Find(source.SetupQueueId);if(entry is null)throw new ConnectException("PREVIEW_REQUIRED","Import the exact initial source original first.");await ProcessTyped(source,entry,ct);entry=queue.Find(entry.Id)!;var receipt=queue.Payload(entry).Receipt;
                if(entry.State!="complete"||receipt is null)throw new ConnectException("SOURCE_FIRST_RECORD_REQUIRED","Wait for every source row to reconcile before verifying the first case.");ValidateTypedAccounting(receipt.Value);var counts=receipt.Value.GetProperty("counts");
                if(counts.GetProperty("acceptedLinked").GetInt32()<1||new[]{"acceptedUnlinked","conflict","quarantined","rejected"}.Any(key=>counts.GetProperty(key).GetInt32()>0))throw new ConnectException("SOURCE_FIRST_RECORD_REQUIRED","The first source batch needs complete authorized associations before recurring collection.");
                var subset=await api.Request("GET","/v1/partner/typed-imports/"+Uri.EscapeDataString(entry.ImportId!)+"/record",null,state.Token,null,ct);
                source.VerifiedCaseId=ValidateTypedStoredRecords(receipt.Value,subset,entry.ImportId!,entry.Digest);break;
            }
            case "pauseSubscription":source.LocalPaused=true;source.PauseAuthorizationTimestamp=Optional(source.ServerView,"updatedAt")?.GetString()??DateTimeOffset.UtcNow.ToString("O");break;
            case "resumeSubscription":
            {
                await RefreshSubscriptions(ct);source=Subscription(source.Id);var updated=Optional(source.ServerView,"updatedAt")?.GetString();
                if(source.ServerState!="active"||!source.CapabilityApproved||source.VerifiedCaseId is null||source.PauseAuthorizationTimestamp is not null&&(updated is null||string.CompareOrdinal(updated,source.PauseAuthorizationTimestamp)<=0))throw new ConnectException("SOURCE_RESUME_APPROVAL_REQUIRED","Verify the first case and approve this source's recurring collection or resume in PackProof first.");
                source.LocalPaused=false;source.PauseAuthorizationTimestamp=null;source.LastErrorCode=null;break;
            }
        }
    }
    private object? SubscriptionDraftView()
    {
        var draft=state.SubscriptionDraft;if(draft is null)return null;object[] files=[];
        if(TypedInstallationMayRead)try{files=FolderSource.Inventory(draft.Folder).Take(100).ToArray();}catch(ConnectException){ }
        return new {draft.Folder,draft.FolderDigest,files,selectedFileName=draft.SelectedFileName,fileSha256=draft.SelectedFileSha256,headers=Optional(draft.LocalPreview,"headers"),rowCount=Optional(draft.LocalPreview,"rowCount"),samples=Optional(draft.LocalPreview,"samples"),proposal=draft.Proposal,approvalPath=draft.ApprovalPath};
    }
    private object StatusCapabilities()
    {
        var values=Optional(state.ServerConfig,"capabilities") is {ValueKind:JsonValueKind.Object} caps?caps.EnumerateObject().ToDictionary(p=>p.Name,p=>(object?)p.Value):new Dictionary<string,object?>();
        values["typedSourceSubscriptions"]=typedSourceSubscriptions;return values;
    }
    private async Task TypedDraftCommand(string operation,JsonElement payload,CancellationToken ct)
    {
        RequireTypedInstallationRead();if(!typedSourceSubscriptions)await RefreshSubscriptions(ct);
        if(!typedSourceSubscriptions)throw new ConnectException("SOURCE_CAPABILITY_UNSUPPORTED","Install and approve the matching source-capable API and desktop before adding an operational source.");
        if(operation=="beginSubscriptionSource")
        {
            var folder=FolderSource.Validate(payload.GetProperty("folder").GetString()??"");_=FolderSource.Inventory(folder);
            state.SubscriptionDraft=new(){Folder=folder,FolderDigest=SourceFolderDigest(folder),ExcludedFileNames=Directory.EnumerateFiles(folder,"*.csv",SearchOption.TopDirectoryOnly).Select(Path.GetFileName).Cast<string>().Order(StringComparer.OrdinalIgnoreCase).ToArray()};return;
        }
        var draft=state.SubscriptionDraft??throw new ConnectException("SOURCE_REQUIRED","Select the dedicated local export folder first.");
        if(operation=="inspectSubscriptionDraft")
        {
            var name=payload.GetProperty("fileName").GetString()??"";var bytes=FolderSource.Snapshot(draft.Folder,name);draft.LocalPreview=Json.Element(FolderSource.Preview(bytes));draft.SelectedFileName=name;draft.SelectedFileSha256=Convert.ToHexStringLower(SHA256.HashData(bytes));draft.Proposal=null;draft.ApprovalPath=null;return;
        }
        if(draft.SelectedFileName is null||draft.SelectedFileSha256 is null||draft.LocalPreview is null)throw new ConnectException("SOURCE_FILE_REQUIRED","Inspect an exact local source export before proposing its mapping.");
        if(!payload.TryGetProperty("wholeFileUploadApproved",out var consent)||consent.ValueKind!=JsonValueKind.True)throw new ConnectException("UPLOAD_CONSENT_REQUIRED","Review the whole-original policy before proposing source approval.");
        var original=FolderSource.Snapshot(draft.Folder,draft.SelectedFileName);if(Convert.ToHexStringLower(SHA256.HashData(original))!=draft.SelectedFileSha256)throw new ConnectException("SOURCE_CHANGED","The selected local original changed. Inspect its exact bytes again.");
        var from=payload.GetProperty("historyFrom").GetString();if(from is null||!DateTimeOffset.TryParse(from,System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.None,out _)||!System.Text.RegularExpressions.Regex.IsMatch(from,@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$"))throw new ConnectException("SOURCE_HISTORY_REQUIRED","Confirm the source history start with an explicit UTC offset.");
        var config=Json.Element(new Dictionary<string,object?>{{"transport","local_ntfs"},{"displayName",payload.GetProperty("displayName")},{"sourceProfile",payload.GetProperty("sourceProfile")},{"sourceNamespace",payload.GetProperty("sourceNamespace")},{"mappingVersion",payload.GetProperty("mappingVersion")},{"mapping",payload.GetProperty("mapping")},{"constants",Optional(payload,"constants")??Json.Element(new{})},{"wholeFileConsent",true},{"folderDigest",draft.FolderDigest},{"initialFileName",draft.SelectedFileName},{"initialOriginalSha256",draft.SelectedFileSha256},{"expectedHeaders",draft.LocalPreview.Value.GetProperty("headers")},{"historyFrom",from},{"historyTo",Optional(payload,"historyTo")},{"unknownTimePolicy",Optional(payload,"unknownTimePolicy")??Json.Element("quarantine")},{"maxBytes",FolderSource.MaxCsvBytes},{"maxRows",1000},{"offlineWindowHours",24},{"expectedIntervalSeconds",Optional(payload,"expectedIntervalSeconds")},{"completenessPolicy",new{kind="unknown",scope="shipment_line",sourceOwnerQualified=false,qualificationReference=(string?)null}}});
        if(payload.TryGetProperty("batchSchema",out var batchSchema))
        {
            if(batchSchema.GetString()!=TypedSourceSemantics.SchemaV2||Optional(Optional(state.ServerConfig,"capabilities"),"typedSourceBatchSchemas") is not {ValueKind:JsonValueKind.Array} accepted||!accepted.EnumerateArray().Any(v=>v.GetString()==TypedSourceSemantics.SchemaV2))throw new ConnectException("SOURCE_CAPABILITY_UNSUPPORTED","Approve the matching source identity contract in PackProof before using this identity policy.");
            var values=config.EnumerateObject().ToDictionary(p=>p.Name,p=>(object?)p.Value);values["batchSchema"]=batchSchema;values["identityPolicy"]=payload.GetProperty("identityPolicy");config=Json.Element(values);
        }
        else if(payload.TryGetProperty("identityPolicy",out _))throw new ConnectException("TYPED_SOURCE_NEEDS_REVIEW","Choose the explicit source contract before approving a source identity policy.");
        if(TypedSourceSemantics.Preview(original,config).Any(row=>!row.Valid))throw new ConnectException("TYPED_SOURCE_NEEDS_REVIEW","The proposed source mapping does not validate every bounded row. Review its field meaning before approval.");
        var proposed=await api.Request("POST","/v1/partner/source-subscriptions/proposals",new{config},state.Token,Guid.NewGuid().ToString("N"),ct);if(proposed.TryGetProperty("value",out var wrapped))proposed=wrapped;
        draft.Proposal=proposed.Clone();var id=Optional(proposed,"subscriptionId")?.GetString()??Optional(proposed,"id")?.GetString();draft.ApprovalPath=Optional(proposed,"approvalPath")?.GetString()??(id is null?null:$"/app/records/connect/approve?installationId={Uri.EscapeDataString(state.InstallationId??"")}&subscriptionId={Uri.EscapeDataString(id)}");Save();
        await RefreshSubscriptions(ct);
        if(id is not null&&state.SourceSubscriptions.SingleOrDefault(s=>s.Id==id) is { } source){source.Folder=draft.Folder;source.FolderDigest=draft.FolderDigest;source.ExcludedFileNames=draft.ExcludedFileNames;source.SelectedFileName=draft.SelectedFileName;source.SelectedFileSha256=draft.SelectedFileSha256;source.LocalPreview=draft.LocalPreview;}
    }

}

using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
namespace PackProof.Connect;

public sealed partial class AgentRuntime
{
    private bool BackfillAvailable(SourceSubscriptionState source)=>BackfillAdvertised&&Optional(Optional(source.ServerView,"capabilities"),"backfillProposal")?.ValueKind==JsonValueKind.True;
    private bool BackfillAdvertised=>Optional(Optional(state.ServerConfig,"capabilities"),"sourceBackfillJobs")?.ValueKind==JsonValueKind.True;
    private static JsonElement Unwrap(JsonElement value)=>value.TryGetProperty("value",out var inner)?inner:value;
    private void RequireBackfillSource(SourceSubscriptionState source)
    {
        RequireTypedInstallationRead();if(!BackfillAvailable(source)||!typedSourceSubscriptions||!source.CapabilityApproved||source.ServerState!="active"||Optional(SourceConfig(source),"batchSchema")?.GetString()!=TypedSourceSemantics.SchemaV2)throw new ConnectException("SOURCE_BACKFILL_UNSUPPORTED","Use a current approved version-two source and backfill-capable installation.");
    }
    private static DateTimeOffset BackfillInstant(string value)
    {
        if(!System.Text.RegularExpressions.Regex.IsMatch(value,@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$")||!DateTimeOffset.TryParse(value,CultureInfo.InvariantCulture,DateTimeStyles.None,out var time))throw new ConnectException("SOURCE_BACKFILL_INTERVAL_INVALID","Approve a finite interval with explicit source-time offsets.");return time;
    }
    private IReadOnlyList<TypedSourceRowPreview> ValidateBackfillOriginal(SourceSubscriptionState source,byte[] bytes,string from,string to,string semantics)
    {
        var start=BackfillInstant(from);var end=BackfillInstant(to);if(end<start)throw new ConnectException("SOURCE_BACKFILL_INTERVAL_INVALID","The history end must follow its start.");
        var config=SourceConfig(source);var constants=config.GetProperty("constants");var kind=Optional(constants,"observationKind")?.GetString();var policy=config.GetProperty("identityPolicy").GetProperty("revision").GetProperty("kind").GetString();
        if(semantics=="cumulative_snapshot"?(kind!="snapshot"||policy!="source_as_of"):semantics!="event_delta"||kind!="event"||policy is not("column" or "immutable_event"))throw new ConnectException("SOURCE_BACKFILL_SEMANTICS_UNQUALIFIED","The source must explicitly declare qualified snapshot or event semantics.");
        var rows=ValidateTypedOriginal(source,bytes);if(TypedSourceSemantics.RawBusinessRowCount(bytes)!=rows.Count)throw new ConnectException("SOURCE_BACKFILL_ROW_INVALID","Every raw historical row must be interpreted without dropping records.");
        foreach(var row in rows)
        {
            if(!row.Valid)throw new ConnectException("SOURCE_BACKFILL_ROW_INVALID","Every historical row must validate under its approved source meaning.");
            var normalized=row.Normalized!.Value;var at=Optional(normalized,semantics=="event_delta"?"occurredAt":"sourceAsOf");
            if(at is not {ValueKind:JsonValueKind.String}||BackfillInstant(at.Value.GetString()!)<start||BackfillInstant(at.Value.GetString()!)>end)throw new ConnectException("SOURCE_BACKFILL_INTERVAL_INVALID","Every original row needs its actual source time inside the exact approved history interval.");
        }
        return rows;
    }
    private SourceBackfillState SaveBackfillView(SourceSubscriptionState source,JsonElement job)
    {
        if(job.GetProperty("schema").GetString()!="packproof.source-backfill/v1"||job.GetProperty("subscriptionId").GetString()!=source.Id||job.GetProperty("installationId").GetString()!=state.InstallationId||job.GetProperty("organizationId").GetString()!=Optional(source.ServerView,"organizationId")?.GetString()||job.GetProperty("environment").GetString()!=(host.Environment=="live"?"live":"sandbox"))throw new ConnectException("SOURCE_BACKFILL_SCOPE_CHANGED","The historical job belongs to another source or installation.");
        foreach(var field in new[]{"principalId","connectionId","locationId","operatorMembershipId"})if(job.GetProperty(field).GetString()!=Optional(source.ServerView,field)?.GetString())throw new ConnectException("SOURCE_BACKFILL_SCOPE_CHANGED","The historical job differs from the current approved source scope.");
        var id=job.GetProperty("id").GetString()!;var local=source.BackfillJobs.SingleOrDefault(j=>j.Id==id);
        if(local is null){local=new(){Id=id};source.BackfillJobs.Add(local);}
        else if(local.Job.ValueKind==JsonValueKind.Object&&local.Job.GetProperty("manifestSha256").GetString()!=job.GetProperty("manifestSha256").GetString())throw new ConnectException("SOURCE_BACKFILL_MANIFEST_CHANGED","A historical job cannot replace its approved original manifest.");
        local.Job=job.Clone();return local;
    }
    private bool BackfillCurrent(SourceSubscriptionState source,JsonElement job)
    {
        return job.GetProperty("state").GetString()=="approved"&&job.GetProperty("capabilities").GetProperty("collect").ValueKind==JsonValueKind.True&&job.GetProperty("configurationRevision").GetInt32()==source.ConfigurationRevision&&job.GetProperty("grantRevision").GetInt32()==source.GrantRevision&&job.GetProperty("configurationSha256").GetString()==source.ConfigurationSha256&&Optional(job,"approvalExpiresAt") is {ValueKind:JsonValueKind.String} expires&&api.LastResponseHadServerDate&&api.LastServerDate is { } now&&now<expires.GetDateTimeOffset();
    }
    private async Task<JsonElement> FreshBackfill(SourceSubscriptionState source,string id,CancellationToken ct)
    {
        var job=Unwrap(await api.Request("GET","/v1/partner/source-backfills/"+Uri.EscapeDataString(id),null,state.Token,null,ct));SaveBackfillView(source,job);Save();return job;
    }
    private async Task RefreshSourceBackfills(SourceSubscriptionState source,CancellationToken ct,bool completeInventory=false)
    {
        string? cursor=completeInventory?null:source.BackfillDiscoveryCursor;var seen=new HashSet<string>(StringComparer.Ordinal);var total=0;
        do
        {
            var response=await api.Request("GET","/v1/partner/source-subscriptions/"+Uri.EscapeDataString(source.Id)+"/backfills"+(cursor is null?"":"?cursor="+Uri.EscapeDataString(cursor)),null,state.Token,null,ct);
            if(response.GetProperty("schema").GetString()!="packproof.source-backfills/v1")throw new ConnectException("SOURCE_BACKFILL_UNSUPPORTED","The hosted historical-job contract is unsupported.");
            foreach(var job in response.GetProperty("jobs").EnumerateArray()){if(++total>1000)throw new ConnectException("SOURCE_BACKFILL_LIMIT","The historical-job inventory exceeds the qualified bound.");SaveBackfillView(source,job);}
            var previous=cursor;cursor=Optional(response,"nextCursor") is {ValueKind:JsonValueKind.String} next?next.GetString():null;if(cursor is not null&&(cursor==previous||!seen.Add(cursor)))throw new ConnectException("SOURCE_PAGINATION_INVALID","The historical inventory did not advance.");
            if(!completeInventory){source.BackfillDiscoveryCursor=cursor;break;}
        }while(cursor is not null);
        Save();
    }
    private async Task BackfillCommand(string operation,JsonElement payload,CancellationToken ct)
    {
        RequireCredential();if(operation is not("pauseBackfill" or "refreshBackfills"))RequireTypedInstallationRead();if(!typedSourceSubscriptions)await RefreshSubscriptions(ct);var source=Subscription(payload.GetProperty("id").GetString()!);
        if(operation=="refreshBackfills")
        {
            if(!BackfillAdvertised||Optional(Optional(source.ServerView,"capabilities"),"sourceBackfillJobs")?.ValueKind!=JsonValueKind.True)throw new ConnectException("SOURCE_BACKFILL_UNSUPPORTED","This installation does not advertise historical-job review.");
            await RefreshSourceBackfills(source,ct,completeInventory:true);return;
        }
        if(operation!="pauseBackfill")RequireBackfillSource(source);
        if(operation=="inspectBackfill")
        {
            source.BackfillDraft=null;Save();
            var names=payload.GetProperty("fileNames").EnumerateArray().Select(v=>v.GetString()!).ToArray();if(names.Length is <1 or >100||names.Distinct(StringComparer.OrdinalIgnoreCase).Count()!=names.Length)throw new ConnectException("SOURCE_BACKFILL_LIMIT","Choose one to 100 distinct completed originals.");
            var from=payload.GetProperty("historyFrom").GetString()!;var to=payload.GetProperty("historyTo").GetString()!;var semantics=payload.GetProperty("semantics").GetString()!;var originals=new List<object>();var digests=new HashSet<string>(StringComparer.Ordinal);long total=0;
            using var adapter=sourceAdapterFactory();
            foreach(var name in names.Order(StringComparer.OrdinalIgnoreCase))
            {
                if(name!=Path.GetFileName(name)||name.Contains('\\')||name.Contains('/')||!name.EndsWith(".csv",StringComparison.OrdinalIgnoreCase))throw new ConnectException("SOURCE_BACKFILL_FILE_INVALID","Choose completed CSV names from this exact approved folder.");
                var file=adapter.Read(source,name);if((total+=file.Bytes.Length)>200L*1024*1024)throw new ConnectException("SOURCE_BACKFILL_LIMIT","The reviewed historical originals exceed 200 MiB.");_=ValidateBackfillOriginal(source,file.Bytes,from,to,semantics);
                var sha=Convert.ToHexStringLower(SHA256.HashData(file.Bytes));if(!digests.Add(sha))throw new ConnectException("SOURCE_BACKFILL_DUPLICATE_ORIGINAL","Choose each exact original once; byte-identical copies require one manifest item.");
                originals.Add(new{name,mediaType="text/csv",sha256=sha,byteSize=file.Bytes.Length});
            }
            var fingerprint=Json.Element(new{subscriptionId=source.Id,installationId=state.InstallationId,configurationRevision=source.ConfigurationRevision,configurationSha256=source.ConfigurationSha256,grantRevision=source.GrantRevision,historyFrom=from,historyTo=to,semantics,originals});var hash=Convert.ToHexStringLower(SHA256.HashData(TypedSourceSemantics.CanonicalBytes(fingerprint)));
            var values=fingerprint.EnumerateObject().ToDictionary(p=>p.Name,p=>(object?)p.Value);values["inspectionSha256"]=hash;values["originalCount"]=names.Length;values["totalBytes"]=total;values["inspectedAt"]=DateTimeOffset.UtcNow.ToString("O");source.BackfillDraft=Json.Element(values);Save();return;
        }
        if(operation=="proposeBackfill")
        {
            var draft=source.BackfillDraft??throw new ConnectException("SOURCE_BACKFILL_INSPECTION_REQUIRED","Inspect the exact historical originals first.");
            if(payload.GetProperty("wholeFileUploadApproved").ValueKind!=JsonValueKind.True||payload.GetProperty("inspectionSha256").GetString()!=draft.GetProperty("inspectionSha256").GetString()||Optional(draft,"subscriptionId")?.GetString()!=source.Id||Optional(draft,"installationId")?.GetString()!=state.InstallationId||draft.GetProperty("configurationRevision").GetInt32()!=source.ConfigurationRevision||draft.GetProperty("grantRevision").GetInt32()!=source.GrantRevision||draft.GetProperty("configurationSha256").GetString()!=source.ConfigurationSha256)throw new ConnectException("SOURCE_BACKFILL_INSPECTION_CHANGED","Review the exact current source, originals and history interval again.");
            using(var adapter=sourceAdapterFactory())foreach(var original in draft.GetProperty("originals").EnumerateArray())CheckBackfillBytes(adapter.Read(source,original.GetProperty("name").GetString()!).Bytes,original);
            var response=Unwrap(await api.Request("POST","/v1/partner/source-subscriptions/"+Uri.EscapeDataString(source.Id)+"/backfills/proposals",new{configurationRevision=source.ConfigurationRevision,grantRevision=source.GrantRevision,historyFrom=draft.GetProperty("historyFrom"),historyTo=draft.GetProperty("historyTo"),semantics=draft.GetProperty("semantics"),originals=draft.GetProperty("originals")},state.Token,"backfill-"+draft.GetProperty("inspectionSha256").GetString(),ct));SaveBackfillView(source,response);source.BackfillDraft=null;Save();return;
        }
        var jobId=payload.GetProperty("jobId").GetString()!;var local=source.BackfillJobs.SingleOrDefault(j=>j.Id==jobId)??throw new ConnectException("SOURCE_BACKFILL_REQUIRED","Refresh the exact historical job first.");
        if(operation=="pauseBackfill"){local.LocalPaused=true;Save();return;}
        if(operation=="resumeBackfill"){var job=await FreshBackfill(source,jobId,ct);if(!BackfillCurrent(source,job))throw new ConnectException("SOURCE_BACKFILL_APPROVAL_REQUIRED","Approve this current historical job in the browser before resuming it.");queue.RetryBackfill(jobId);local.LocalPaused=false;local.LastErrorCode=null;Save();}
    }
    private static void CheckBackfillBytes(byte[] bytes,JsonElement original)
    {
        if(bytes.LongLength!=original.GetProperty("byteSize").GetInt64()||Convert.ToHexStringLower(SHA256.HashData(bytes))!=original.GetProperty("sha256").GetString())throw new ConnectException("SOURCE_BACKFILL_ORIGINAL_CHANGED","A reviewed historical original changed; the immutable manifest remains preserved.");
    }
    private async Task CollectBackfillSource(SourceSubscriptionState source,CancellationToken ct)
    {
        if(!BackfillAvailable(source)||!networkOnline||!SourcePolicyCurrent(source,DateTimeOffset.UtcNow))return;
        try
        {
            await RefreshSourceBackfills(source,ct);
            var candidates=source.BackfillJobs.Where(j=>!j.LocalPaused&&j.Job.ValueKind==JsonValueKind.Object&&j.Job.GetProperty("state").GetString()=="approved").OrderBy(j=>j.Id,StringComparer.Ordinal).ToArray();
            // Closed-job receipt polling has its own alternating turn and cursor.
            // An uncertain preview can remain previewed indefinitely; it cannot
            // consume every turn or steal admission from another approved job.
            var reconcile=new List<QueueEntry>();
            foreach(var known in source.BackfillJobs.Where(j=>j.Job.ValueKind==JsonValueKind.Object&&(j.LocalPaused||j.Job.GetProperty("state").GetString()!="approved")))
            foreach(var item in known.Job.GetProperty("originals").EnumerateArray())
            {
                var linked=queue.BackfillQueueId(known.Id,item.GetProperty("id").GetString()!);var pending=linked is null?null:queue.Find(linked);
                if(pending is {ImportId:not null}&&pending.State is not("complete" or "partial" or "action_needed")&&pending.NextAttemptAt<=DateTimeOffset.UtcNow&&pending.ConfigDigest==source.QueueConfigurationIdentity(state.InstallationId)&&pending.GrantRevision==source.GrantRevision&&pending.CredentialGeneration==Generation&&pending.SourceProfile==source.SourceProfile)reconcile.Add(pending);
            }
            var pendingReceipts=reconcile.DistinctBy(e=>e.Id).OrderBy(e=>e.Id,StringComparer.Ordinal).ToArray();
            if(pendingReceipts.Length>0&&(source.BackfillReconcileNext||candidates.Length==0))
            {
                var pending=pendingReceipts.FirstOrDefault(e=>source.LastReconciledBackfillQueueId is null||string.CompareOrdinal(e.Id,source.LastReconciledBackfillQueueId)>0)??pendingReceipts[0];source.LastReconciledBackfillQueueId=pending.Id;source.BackfillReconcileNext=false;Save();await ProcessTyped(source,pending,ct,readOnly:true);Save();return;
            }
            var local=candidates.FirstOrDefault(j=>source.LastScheduledBackfillJobId is null||string.CompareOrdinal(j.Id,source.LastScheduledBackfillJobId)>0)??candidates.FirstOrDefault();if(local is null)return;
            // A blocked or delayed job still yields its next turn. Persist this
            // independently from live discovery and the paged job inventory.
            source.LastScheduledBackfillJobId=local.Id;source.BackfillReconcileNext=true;Save();
            var job=await FreshBackfill(source,local.Id,ct);if(!BackfillCurrent(source,job))return;
            foreach(var original in job.GetProperty("originals").EnumerateArray())
            {
                var itemId=original.GetProperty("id").GetString()!;if(Optional(original,"receiptState") is {ValueKind:JsonValueKind.String} terminal&&terminal.GetString() is "succeeded" or "partially_succeeded" or "failed")continue;
                if(queue.BackfillItemError(local.Id,itemId) is not null)continue;
                try
                {
                    var queueId=queue.BackfillQueueId(local.Id,itemId);var entry=queueId is null?null:queue.Find(queueId);
                    if(entry is null)
                    {
                        entry=queue.FindOriginalForSource(original.GetProperty("sha256").GetString()!,source.QueueConfigurationIdentity(state.InstallationId),new(source.Id,source.SourceProfile,source.GrantRevision));
                        if(entry is null)
                        {
                            // No cached job approval authorizes this read: refresh immediately.
                            if(!BackfillCurrent(source,job)||!SourcePolicyCurrent(source,DateTimeOffset.UtcNow))return;
                            using var adapter=sourceAdapterFactory();var name=original.GetProperty("name").GetString()!;var file=adapter.Read(source,name);CheckBackfillBytes(file.Bytes,original);_=ValidateBackfillOriginal(source,file.Bytes,job.GetProperty("historyFrom").GetString()!,job.GetProperty("historyTo").GetString()!,job.GetProperty("semantics").GetString()!);
                            entry=queue.StageRequest(file.Bytes,name,TypedRequest(source,name,file.Bytes,new{kind="historical_backfill",jobId=local.Id,itemId}),Generation,source.QueueConfigurationIdentity(state.InstallationId),true,new(source.Id,source.SourceProfile,source.GrantRevision),history:true);
                        }
                        var retained=queue.Payload(entry);var retainedName=retained.FileName;if(string.IsNullOrEmpty(retainedName)&&retained.Receipt is { } receipt&&Optional(receipt,"original") is { } recorded)retainedName=Optional(recorded,"name")?.GetString();
                        if(retainedName!=original.GetProperty("name").GetString())throw new ConnectException("SOURCE_BACKFILL_ORIGINAL_NAME_MISMATCH","These exact bytes were retained under another original name; review that original explicitly.");
                        queue.LinkBackfillItem(local.Id,itemId,job.GetProperty("manifestSha256").GetString()!,entry.Id);
                    }
                    if(entry.State is not("complete" or "partial" or "action_needed" or "awaiting_review")&&entry.NextAttemptAt>DateTimeOffset.UtcNow)continue;
                    if(entry.State=="action_needed"&&entry.ImportId is null)throw new ConnectException(entry.ErrorCode??"SOURCE_BACKFILL_ITEM_BLOCKED","The retained historical item needs explicit review before submission.");
                    if(entry.State is not("complete" or "partial" or "action_needed" or "awaiting_review")&&entry.NextAttemptAt<=DateTimeOffset.UtcNow)await ProcessTyped(source,entry,ct);
                    entry=queue.Find(entry.Id)!;
                    if(entry.ImportId is not null)await api.Request("POST","/v1/partner/source-backfills/"+Uri.EscapeDataString(local.Id)+"/items/"+Uri.EscapeDataString(itemId)+"/bind",new{batchId=entry.ImportId,manifestSha256=job.GetProperty("manifestSha256").GetString(),configurationRevision=source.ConfigurationRevision,grantRevision=source.GrantRevision},state.Token,"backfill-bind-"+local.Id+"-"+itemId+"-"+entry.ImportId,ct);
                    local.LastErrorCode=null;Save();return; // One history original per pass.
                }
                catch(ConnectException error)when(!SourceScheduler.IsSharedSafetyFailure(error)){local.LastErrorCode=error.Code;if(error.Code!="BACKFILL_LIVE_RESERVE")queue.BackfillFailure(local.Id,itemId,job.GetProperty("manifestSha256").GetString()!,error.Code);Save();return;}
                catch(ApiException error)when(error.Status!=401&&error.Code!="AGENT_AUTHORIZATION_REQUIRED"){local.LastErrorCode=error.Code;Save();return;}
            }
        }
        catch(ApiException error)when(error.Status!=401&&error.Code!="AGENT_AUTHORIZATION_REQUIRED"){source.LastErrorCode=error.Code;Save();}
        catch(ConnectException error)when(!SourceScheduler.IsSharedSafetyFailure(error)){source.LastErrorCode=error.Code;Save();}
    }
    private object[] BackfillViews(SourceSubscriptionState source,ref int remainingBytes)
    {
        var result=new List<object>();
        foreach(var local in source.BackfillJobs.Where(j=>j.Job.ValueKind==JsonValueKind.Object).OrderByDescending(j=>j.Job.GetProperty("createdAt").GetString(),StringComparer.Ordinal))
        {
            // Display projections never replace the full protected approval or
            // manifest. Decision history is reviewed in the browser.
            var values=local.Job.EnumerateObject().Where(p=>p.Name is not("originals" or "decisions" or "decisionsComplete" or "decisionLimit" or "credentialId")).ToDictionary(p=>p.Name,p=>(object?)p.Value);
            var originals=local.Job.GetProperty("originals").EnumerateArray().ToArray();var shown=new List<JsonElement>();var items=new List<object>();
            values["localPaused"]=local.LocalPaused;values["lastErrorCode"]=local.LastErrorCode;values["originals"]=shown;values["localItems"]=items;values["originalsShown"]=0;values["originalsTotal"]=originals.Length;values["originalsTruncated"]=originals.Length>0;
            if(Json.Bytes(values).Length+1>remainingBytes)continue;
            foreach(var original in originals)
            {
                var itemId=original.GetProperty("id").GetString()!;shown.Add(original);items.Add(new{itemId,queueId=queue.BackfillQueueId(local.Id,itemId),errorCode=queue.BackfillItemError(local.Id,itemId)});values["originalsShown"]=shown.Count;values["originalsTruncated"]=shown.Count<originals.Length;
                if(Json.Bytes(values).Length+1<=remainingBytes)continue;
                shown.RemoveAt(shown.Count-1);items.RemoveAt(items.Count-1);values["originalsShown"]=shown.Count;values["originalsTruncated"]=true;break;
            }
            remainingBytes-=Json.Bytes(values).Length+1;result.Add(values);if(remainingBytes<1024)break;
        }
        return result.ToArray();
    }
}

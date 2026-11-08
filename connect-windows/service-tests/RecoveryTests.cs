using System.Net;
using System.Security.Cryptography;
using System.Text;
using PackProof.Connect;
using Xunit;

public sealed class RecoveryTests : IDisposable {
    private readonly string root=Path.Combine(Path.GetTempPath(),"packproof-connect-test-"+Guid.NewGuid().ToString("N"));
    private static readonly byte[] Original=Encoding.UTF8.GetBytes("\uFEFFShipment reference,Description,Quantity\r\n0000123,\"Fixture, private 6fd1\",2\r\n");
    private static JsonElementBody Body=>new(Json.Element(new{integrationAccountId="integration",operatorMembershipId="operator",sourceName="Fixture",mapping=new{shipmentReference="Shipment reference",itemTitle="Description",quantity="Quantity"},timeZone="UTC"}));
    private ProtectedStore Store(){var store=new ProtectedStore(root,new TestProtector());store.Initialize();return store;}
    [Fact] public void Restart_preserves_original_keys_and_source_content_identity(){
        string id,key,commit;using(var queue=new DurableQueue(Store())){var staged=queue.Stage(Original,"first.csv",Body,"generation","config",false);id=staged.Id;key=staged.PreviewKey;commit=staged.CommitKey;}
        using var reopened=new DurableQueue(Store());var recovered=reopened.Find(id)!;Assert.Equal(key,recovered.PreviewKey);Assert.Equal(commit,recovered.CommitKey);Assert.Equal(Original,Encoding.UTF8.GetBytes(reopened.Payload(recovered).Csv));Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(reopened.Payload(recovered).PreviewWireBody!)),reopened.Payload(recovered).PreviewBodySha256);
        var renamed=reopened.Stage(Original,"renamed.csv",Body,"generation","config",false);Assert.Equal(id,renamed.Id);Assert.Single(reopened.Entries());
        var changed=reopened.Stage(Encoding.UTF8.GetBytes("Shipment reference\nDIFFERENT\n"),"first.csv",Body,"generation","config",false);Assert.NotEqual(id,changed.Id);
    }
    [Fact] public void Unknown_commit_response_keeps_same_operation_and_receipt(){
        string id;using(var queue=new DurableQueue(Store())){var e=queue.Stage(Original,"source.csv",Body,"credential-a","config",true);var p=queue.Payload(e);p.Receipt=Json.Element(new{id="import-a",previewVersion="v1",state="previewed"});queue.Save(e,p,"commit_pending","import-a", "NETWORK_UNAVAILABLE",true);id=e.Id;}
        using var recovered=new DurableQueue(Store());var work=recovered.Find(id)!;Assert.Equal("commit_pending",work.State);Assert.Equal("import-a",work.ImportId);Assert.True(recovered.Payload(work).CommitApproved);Assert.Equal(1,work.Attempts);Assert.NotEqual(work.PreviewKey,work.CommitKey);
    }
    [Fact] public void Sensitive_original_and_names_do_not_appear_in_database_WAL_or_spool(){
        using var queue=new DurableQueue(Store());queue.Stage(Original,"secret-customer-name.csv",Body,"credential-fingerprint","config",false);queue.Checkpoint();foreach(var path in Directory.EnumerateFiles(root,"*",SearchOption.AllDirectories)){using var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete);using var snapshot=new MemoryStream();stream.CopyTo(snapshot);var text=Encoding.UTF8.GetString(snapshot.ToArray());Assert.DoesNotContain("Fixture, private 6fd1",text);Assert.DoesNotContain("secret-customer-name.csv",text);Assert.DoesNotContain("0000123",text);}
    }
    [Fact] public void Spool_tampering_and_identity_swapping_fail_authenticated_decryption(){
        var spool=new EncryptedSpool(RandomNumberGenerator.GetBytes(32));var encrypted=spool.Encrypt(Original,"queue-a");Assert.Equal(Original,spool.Decrypt(encrypted,"queue-a"));Assert.Throws<ConnectException>(()=>spool.Decrypt(encrypted,"queue-b"));encrypted[^1]^=1;Assert.Throws<ConnectException>(()=>spool.Decrypt(encrypted,"queue-a"));
    }
    [Fact] public void Completed_original_cleanup_preserves_receipt_identity_and_pending_originals(){
        using var queue=new DurableQueue(Store());var completed=queue.Stage(Original,"completed-private.csv",Body,"generation","config",false);var payload=queue.Payload(completed);payload.Receipt=Receipt("succeeded");payload.CompletedAt=DateTimeOffset.UtcNow.AddHours(-25);queue.Save(completed,payload,"complete","import-a");
        var pending=queue.Stage(Encoding.UTF8.GetBytes("reference,description,quantity\n0002,Private pending,1\n"),"pending-private.csv",Body,"generation","config",false);
        Assert.Equal(1,queue.CompactCompleted(DateTimeOffset.UtcNow));var retained=queue.Payload(queue.Find(completed.Id)!);Assert.True(retained.OriginalCompacted);Assert.Equal("",retained.Csv);Assert.Equal("",retained.FileName);Assert.Null(retained.PreviewWireBody);Assert.Equal("import-a",retained.Receipt!.Value.GetProperty("id").GetString());Assert.Equal(completed.Id,queue.Stage(Original,"renamed.csv",Body,"generation","config",false).Id);Assert.Contains("Private pending",queue.Payload(pending).Csv);Assert.Equal(0,queue.CompactCompleted(DateTimeOffset.UtcNow));
    }
    [Fact] public void Missing_spool_key_never_replaces_retained_queue_key(){
        using(var queue=new DurableQueue(Store())){queue.Stage(Original,"source.csv",Body,"generation","config",false);}File.Delete(Path.Combine(root,"spool-key.bin"));Assert.Equal("SPOOL_KEY_MISSING",Assert.Throws<ConnectException>(()=>new DurableQueue(Store())).Code);Assert.False(File.Exists(Path.Combine(root,"spool-key.bin")));
    }
    [Fact] public void Completed_summary_retention_releases_original_file_admission_capacity(){
        using var queue=new DurableQueue(Store(),1);var completed=queue.Stage(Original,"completed.csv",Body,"generation","config",false);var payload=queue.Payload(completed);payload.Receipt=Receipt("succeeded");payload.CompletedAt=DateTimeOffset.UtcNow.AddHours(-25);queue.Save(completed,payload,"complete","import-a");var next=Encoding.UTF8.GetBytes("reference,description,quantity\n0002,Next private,1\n");
        Assert.Equal("SPOOL_CAPACITY_REACHED",Assert.Throws<ConnectException>(()=>queue.Stage(next,"next.csv",Body,"generation","config",false)).Code);Assert.Equal(1,queue.CompactCompleted(DateTimeOffset.UtcNow));var admitted=queue.Stage(next,"next.csv",Body,"generation","config",false);Assert.Equal(2,queue.Entries().Count);Assert.Equal("",queue.Payload(queue.Find(completed.Id)!).Csv);Assert.Equal(next,Encoding.UTF8.GetBytes(queue.Payload(admitted).Csv));Assert.Equal(2,Directory.EnumerateFiles(Path.Combine(root,"spool"),"*.bin").Count());
    }
    [Fact] public async Task Explicit_policy_refresh_cannot_extend_approval_after_clock_rollback(){
        var calls=0;using var runtime=new AgentRuntime(Host(),Store(),new PackProofClient(Host(),new FakeHandler(_=>{calls++;throw new Exception("Clock rollback must pause before policy refresh");})),new LocalState{Token="secret",LastPolicyCheckAt=DateTimeOffset.UtcNow.AddHours(1)});
        var error=await Assert.ThrowsAsync<ConnectException>(()=>runtime.Command("refresh",null,default));Assert.Equal("CLOCK_UNCERTAIN",error.Code);Assert.Equal(0,calls);Assert.True(Store().Read<LocalState>("state.bin")!.LocalPaused);
    }
    [Fact] public async Task Recovery_requires_expiry_or_fresh_policy_denial_and_explicit_preservation_consent(){
        using var runtime=new AgentRuntime(Host(),Store(),new PackProofClient(Host(),new FakeHandler(_=>throw new Exception("Recovery must not send HTTP"))),new LocalState{Token="current-secret",InstallationId="current",CredentialExpiresAt=DateTimeOffset.UtcNow.AddDays(20)});
        Assert.Equal("RECOVERY_CONSENT_REQUIRED",(await Assert.ThrowsAsync<ConnectException>(()=>runtime.Command("recoverEnrollment",Json.Element(new{preservePendingWorkApproved=false}),default))).Code);
        Assert.Equal("RECOVERY_NOT_AVAILABLE",(await Assert.ThrowsAsync<ConnectException>(()=>runtime.Command("recoverEnrollment",Json.Element(new{preservePendingWorkApproved=true}),default))).Code);Assert.Empty(Directory.EnumerateFiles(root,"recovery-*.bin"));
    }
    [Fact] public async Task Recovery_archives_old_authority_and_receipts_before_clearing_current_state(){
        string id,previewKey;using(var queue=new DurableQueue(Store())){var e=queue.Stage(Original,"old-source.csv",Body,"old-generation","old-config",true);var payload=queue.Payload(e);payload.Receipt=Receipt("queued");queue.Save(e,payload,"server_processing","old-import");id=e.Id;previewKey=e.PreviewKey;}
        using var runtime=new AgentRuntime(Host(),Store(),new PackProofClient(Host(),new FakeHandler(_=>throw new Exception("Recovery must not transfer receipts"))),new LocalState{Token="expired-secret",InstallationId="former-installation",Folder="C:\\ApprovedExport",CredentialExpiresAt=DateTimeOffset.UtcNow.AddMinutes(-1)});
        var status=Json.Element(await runtime.Command("recoverEnrollment",Json.Element(new{preservePendingWorkApproved=true}),default));Assert.Equal(0,status.GetProperty("health").GetProperty("queueCount").GetInt32());Assert.Equal(1,status.GetProperty("health").GetProperty("preservedQueueCount").GetInt32());Assert.False(status.GetProperty("recoveryAvailable").GetBoolean());
        var archive=Path.GetFileName(Assert.Single(Directory.EnumerateFiles(root,"recovery-*.bin")));var preserved=Store().Read<System.Text.Json.JsonElement>(archive);Assert.Equal("expired-secret",preserved.GetProperty("previousState").GetProperty("token").GetString());Assert.Equal("former-installation",preserved.GetProperty("previousState").GetProperty("installationId").GetString());Assert.Equal("old-import",preserved.GetProperty("preservedQueue")[0].GetProperty("importId").GetString());
        var current=Store().Read<LocalState>("state.bin")!;Assert.Null(current.Token);Assert.Null(current.InstallationId);Assert.True(current.RecoveryPrepared);using var inspected=new DurableQueue(Store());var entry=inspected.Find(id)!;Assert.Equal("old-import",entry.ImportId);Assert.Equal(previewKey,entry.PreviewKey);Assert.Equal(Original,Encoding.UTF8.GetBytes(inspected.Payload(entry).Csv));
    }
    [Fact] public async Task Failed_protected_recovery_archive_keeps_current_authority_and_queue(){
        var storage=new ProtectedStore(root,new ArchiveFailProtector());storage.Initialize();using var runtime=new AgentRuntime(Host(),storage,new PackProofClient(Host(),new FakeHandler(_=>throw new Exception("No HTTP expected"))),new LocalState{Token="expired-secret",InstallationId="former",CredentialExpiresAt=DateTimeOffset.UtcNow.AddMinutes(-1)});
        await Assert.ThrowsAsync<IOException>(()=>runtime.Command("recoverEnrollment",Json.Element(new{preservePendingWorkApproved=true}),default));Assert.Equal("expired-secret",storage.Read<LocalState>("state.bin")!.Token);Assert.True(storage.Read<LocalState>("state.bin")!.LocalPaused);Assert.Empty(Directory.EnumerateFiles(root,"recovery-*.bin"));
    }
    [Fact] public async Task Fresh_installation_never_processes_preserved_old_generation_or_receipts(){
        using(var queue=new DurableQueue(Store())){var e=queue.Stage(Original,"old.csv",Body,"old-generation","old-configuration",true);var payload=queue.Payload(e);payload.Receipt=Receipt("queued");queue.Save(e,payload,"server_processing","old-import");}
        var config=Json.Element(new{folderDigest="folder",integrationAccountId="integration",operatorMembershipId="operator",sourceName="Fixture",mapping=new{shipmentReference="Shipment reference",itemTitle="Description",quantity="Quantity"},timeZone="UTC",locationId=(string?)null,importValidRows=false,offlineWindowHours=24});
        var policy=Json.Element(new{state="active",config,configSha256="new-config",configRevision=1,pendingProposal=(object?)null,integrationAccountId="integration",operatorMembershipId="operator",sourceName="Fixture",locationId=(string?)null,credentialExpiresAt=DateTimeOffset.UtcNow.AddDays(20)});var calls=0;
        using var runtime=new AgentRuntime(Host(),Store(),new PackProofClient(Host(),new FakeHandler(request=>{calls++;Assert.Equal("/v1/partner/agent/heartbeat",request.RequestUri!.AbsolutePath);return new(HttpStatusCode.OK){Content=new StringContent(policy.GetRawText())};})),new LocalState{Token="new-secret",InstallationId="new-installation",ServerConfig=policy,FolderDigest="folder",CredentialExpiresAt=DateTimeOffset.UtcNow.AddDays(20),LastPolicyCheckAt=DateTimeOffset.UtcNow,LocalPaused=false,RecoveryPrepared=true});
        await runtime.Tick(default);Assert.Equal(1,calls);using var inspected=new DurableQueue(Store());Assert.Equal("server_processing",Assert.Single(inspected.Entries()).State);Assert.Equal("old-import",Assert.Single(inspected.Entries()).ImportId);
    }
    [Fact] public async Task Lost_commit_response_recovers_current_persisted_phase_without_duplicate_commit(){
        var config=Json.Element(new{folderDigest="folder",integrationAccountId="integration",operatorMembershipId="operator",sourceName="Fixture",mapping=new{shipmentReference="Shipment reference",itemTitle="Description",quantity="Quantity"},timeZone="UTC",locationId=(string?)null,importValidRows=false,offlineWindowHours=24});
        var generation=Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("secret")));string id;using(var queue=new DurableQueue(Store())){var e=queue.Stage(Original,"source.csv",Body,generation,Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("installation:config:1"))),true);var payload=queue.Payload(e);payload.Receipt=Receipt("previewed");queue.Save(e,payload,"awaiting_review","import-a");id=e.Id;}
        var commits=0;var accepted=false;var server=Json.Element(new{state="active",config,configSha256="config",configRevision=1,pendingProposal=(object?)null,integrationAccountId="integration",operatorMembershipId="operator",sourceName="Fixture",locationId=(string?)null,credentialExpiresAt=DateTimeOffset.UtcNow.AddDays(20)});
        using var runtime=new AgentRuntime(Host(),Store(),new PackProofClient(Host(),new FakeHandler(request=>{if(request.RequestUri!.AbsolutePath.EndsWith("heartbeat"))return new(HttpStatusCode.OK){Content=new StringContent(server.GetRawText())};if(request.Method==HttpMethod.Get)return new(HttpStatusCode.OK){Content=new StringContent(Receipt(accepted?"succeeded":"previewed").GetRawText())};commits++;accepted=true;throw new HttpRequestException("Lost response after server accepted");})),new LocalState{Token="secret",InstallationId="installation",CredentialExpiresAt=DateTimeOffset.UtcNow.AddDays(20),FolderDigest="folder",ServerConfig=server,LastPolicyCheckAt=DateTimeOffset.UtcNow,SetupQueueId=id,LocalPaused=false});
        await Assert.ThrowsAsync<HttpRequestException>(()=>runtime.Command("commit",Json.Element(new{wholeBatchApproved=true}),default));using(var inspect=new DurableQueue(Store()))Assert.Equal("commit_pending",inspect.Find(id)!.State);
        // Advance only the durable scheduling fixture; preserve the failed command's body, keys and receipt.
        using(var due=new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={Path.Combine(root,"queue.sqlite")}")){due.Open();using var command=due.CreateCommand();command.CommandText="UPDATE queue SET next_attempt_at=$now WHERE id=$id";command.Parameters.AddWithValue("$now",DateTimeOffset.UtcNow.AddSeconds(-1).ToString("O"));command.Parameters.AddWithValue("$id",id);command.ExecuteNonQuery();}
        await runtime.Tick(default);using(var inspect=new DurableQueue(Store()))Assert.Equal("complete",inspect.Find(id)!.State);Assert.Equal(1,commits);
    }
    private static System.Text.Json.JsonElement Receipt(string state)=>Json.Element(new{id="import-a",state,previewVersion="preview-v1",counts=new{valid=state=="succeeded"?0:1,invalid=0,ambiguous=0,duplicate=0,imported=state=="succeeded"?1:0,failed=0},original=new{sha256=Convert.ToHexStringLower(SHA256.HashData(Original)),byteSize=Original.Length},rows=new[]{new {rowNumber=2,status=state=="succeeded"?"imported":"valid",proofId=state=="succeeded"?"proof-fixture":null}},recordIds=state=="succeeded"?new[]{"proof-fixture"}:Array.Empty<string>()});
    [Fact] public async Task Identical_configuration_reapproval_invalidates_old_preview_and_verification(){
        var config=Json.Element(new{folderDigest="folder",integrationAccountId="integration",operatorMembershipId="operator",sourceName="Fixture",mapping=new{shipmentReference="Shipment reference",itemTitle="Description",quantity="Quantity"},timeZone="UTC",locationId=(string?)null,importValidRows=false,offlineWindowHours=24});
        object Policy(int revision)=>new{state="active",config,configSha256="unchanged",configRevision=revision,pendingProposal=(object?)null,integrationAccountId="integration",operatorMembershipId="operator",sourceName="Fixture",locationId=(string?)null,credentialExpiresAt=DateTimeOffset.UtcNow.AddDays(20)};
        using var runtime=new AgentRuntime(Host(),Store(),new PackProofClient(Host(),new FakeHandler(_=>new(HttpStatusCode.OK){Content=new StringContent(Json.Element(Policy(2)).GetRawText())})),new LocalState{Token="secret",FolderDigest="folder",ServerConfig=Json.Element(Policy(1)),VerifiedRecordId="old-record",SetupQueueId="old-queue",CredentialExpiresAt=DateTimeOffset.UtcNow.AddDays(20)});
        var status=Json.Element(await runtime.Command("refresh",null,default));Assert.Equal(2,status.GetProperty("configRevision").GetInt32());Assert.False(status.GetProperty("verification").GetProperty("complete").GetBoolean());Assert.False(status.TryGetProperty("preview",out _));
    }
    [Fact] public async Task Unknown_renewal_response_replays_persisted_key_before_old_token_heartbeat(){
        var calls=new List<string>();var policy=Json.Element(new{state="active",configSha256="config",configRevision=1,config=(object?)null});
        using var runtime=new AgentRuntime(Host(),Store(),new PackProofClient(Host(),new FakeHandler(request=>{if(request.RequestUri!.AbsolutePath.EndsWith("credential-renewals")){calls.Add("renewal");Assert.Equal("saved-renewal-key",request.Headers.GetValues("Idempotency-Key").Single());return new(HttpStatusCode.OK){Content=new StringContent(Json.Element(new{installationId="installation",credentialId="successor",token="new-secret",expiresAt=DateTimeOffset.UtcNow.AddDays(30)}).GetRawText())};}calls.Add("ack");Assert.Equal("new-secret",request.Headers.Authorization!.Parameter);return new(HttpStatusCode.OK){Content=new StringContent(policy.GetRawText())};})),new LocalState{Token="old-secret",InstallationId="installation",CredentialExpiresAt=DateTimeOffset.UtcNow.AddDays(3),ServerConfig=policy,RenewalKey="saved-renewal-key"});
        await runtime.Tick(default);Assert.Equal(new[]{"renewal","ack"},calls);var persisted=Store().Read<LocalState>("state.bin")!;Assert.Equal("new-secret",persisted.Token);Assert.Null(persisted.RenewalKey);Assert.Null(persisted.PendingToken);
    }
    [Fact] public void Cached_policy_stops_after_window_clock_rollback_or_credential_expiry(){
        var now=DateTimeOffset.Parse("2026-11-06T12:00:00Z");Assert.True(CollectionPolicy.IsWithinApprovedWindow(now,now.AddHours(-23),now.AddDays(1),24,false));Assert.False(CollectionPolicy.IsWithinApprovedWindow(now,now.AddHours(-25),now.AddDays(1),24,false));Assert.False(CollectionPolicy.IsWithinApprovedWindow(now,now.AddSeconds(1),now.AddDays(1),24,true));Assert.False(CollectionPolicy.IsWithinApprovedWindow(now,now,now,24,true));
    }
    [Fact] public void Zero_offline_window_allows_current_online_policy_but_denies_network_loss(){
        var now=DateTimeOffset.Parse("2026-11-06T12:00:00Z");Assert.True(CollectionPolicy.IsWithinApprovedWindow(now,now.AddSeconds(-30),now.AddDays(1),0,true));Assert.False(CollectionPolicy.IsWithinApprovedWindow(now,now.AddSeconds(-30),now.AddDays(1),0,false));Assert.False(CollectionPolicy.IsWithinApprovedWindow(now,now.AddSeconds(-66),now.AddDays(1),0,true));
    }
    [Fact] public void Unknown_future_schema_is_rejected_before_queue_mutation(){
        using(var q=new DurableQueue(Store())){}using(var db=new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={Path.Combine(root,"queue.sqlite")}")){db.Open();using var command=db.CreateCommand();command.CommandText="PRAGMA user_version=2";command.ExecuteNonQuery();}
        Assert.Equal("QUEUE_SCHEMA_UNSUPPORTED",Assert.Throws<ConnectException>(()=>new DurableQueue(Store())).Code);
    }
    [Fact] public void Orphan_after_snapshot_write_is_retained_and_not_reported_as_queued(){
        using(var q=new DurableQueue(Store())){}var orphan=Path.Combine(root,"spool","crash-before-db.bin");File.WriteAllBytes(orphan,RandomNumberGenerator.GetBytes(128));using var reopened=new DurableQueue(Store());Assert.Empty(reopened.Entries());Assert.True(File.Exists(orphan));
    }
    [Fact] public void Spool_quota_blocks_admission_without_deleting_pending_payload(){
        using var q=new DurableQueue(Store());var first=q.Stage(Original,"first.csv",Body,"generation","config",false);var sparse=Path.Combine(root,"spool","capacity-fixture.bin");using(var f=new FileStream(sparse,FileMode.CreateNew)){f.SetLength(DurableQueue.MaxSpoolBytes);}
        Assert.Equal("SPOOL_CAPACITY_REACHED",Assert.Throws<ConnectException>(()=>q.Stage(Encoding.UTF8.GetBytes("reference\nnext\n"),"next.csv",Body,"generation","config",false)).Code);Assert.Equal(Original,Encoding.UTF8.GetBytes(q.Payload(first).Csv));Assert.Single(q.Entries());
    }
    [Fact] public void Local_preview_preserves_leading_zeros_BOM_quoted_cells_and_full_bytes_digest(){
        var preview=Json.Element(FolderSource.Preview(Original));Assert.Equal("0000123",preview.GetProperty("samples")[0].GetProperty("Shipment reference").GetString());Assert.Equal("Fixture, private 6fd1",preview.GetProperty("samples")[0].GetProperty("Description").GetString());Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(Original)),preview.GetProperty("fileSha256").GetString());
    }
    [Fact] public async Task Transport_does_not_follow_redirects_or_treat_202_as_record_completion(){
        var calls=0;var handler=new FakeHandler(request=>{calls++;Assert.Equal("persisted-key",request.Headers.GetValues("Idempotency-Key").Single());Assert.Equal("Bearer",request.Headers.Authorization!.Scheme);return new HttpResponseMessage(HttpStatusCode.Accepted){Content=new StringContent("{\"id\":\"receipt\",\"state\":\"queued\"}")};});using var client=new PackProofClient(Host(),handler);var result=await client.Request("POST","/v1/partner/imports/preview",new{csv="a"},"secret","persisted-key",default);Assert.Equal("queued",result.GetProperty("state").GetString());Assert.Equal(1,calls);
    }
    [Theory][InlineData(401,false)][InlineData(403,false)][InlineData(409,false)][InlineData(429,true)][InlineData(503,true)]public async Task Transport_classifies_retry_authority_and_conflict(int status,bool transient){
        using var client=new PackProofClient(Host(),new FakeHandler(_=>new HttpResponseMessage((HttpStatusCode)status){Content=new StringContent("{\"code\":\"SAFE_CODE\"}")}));var error=await Assert.ThrowsAsync<ApiException>(()=>client.Request("GET","/v1/partner/agent/config",null,"secret",null,default));Assert.Equal(transient,error.Transient);Assert.Equal("SAFE_CODE",error.Code);
    }
    [Theory][InlineData("//host/credentials")][InlineData("https://host/credentials")][InlineData("/proofs?token=secret")][InlineData("/proofs\\other")]
    public async Task Transport_rejects_arbitrary_targets_before_HTTP(string path){using var client=new PackProofClient(Host(),new FakeHandler(_=>throw new Exception("must not call")));await Assert.ThrowsAsync<ConnectException>(()=>client.Request("GET",path,null,"secret",null,default));}
    [Fact] public void Malformed_UTF8_is_preserved_as_an_encrypted_quarantined_original_without_blocking_valid_work()
    {
        var malformed=new byte[]{0xff,0xfe,0x00,0x80}; using var queue=new DurableQueue(Store());
        var rejected=queue.Quarantine(malformed,"malformed.csv","generation","config","CSV_ENCODING_UNSUPPORTED");
        Assert.Equal("action_needed",rejected.State);Assert.Equal("CSV_ENCODING_UNSUPPORTED",rejected.ErrorCode);Assert.Equal(malformed,queue.Payload(rejected).QuarantinedOriginalBytes);
        Assert.Equal(rejected.Id,queue.Quarantine(malformed,"renamed.csv","generation","config","CSV_ENCODING_UNSUPPORTED").Id);
        var valid=queue.Stage(Original,"valid.csv",Body,"generation","config",true);Assert.Equal("staged",valid.State);Assert.Equal(2,queue.Entries().Count);
    }
    [Fact] public void Completed_import_reconciliation_requires_every_source_row_and_record_before_acknowledgement()
    {
        var valid=Receipt("succeeded");var digest=Convert.ToHexStringLower(SHA256.HashData(Original));AgentRuntime.ValidateReconciledReceipt(valid,digest);
        Assert.Equal("ORIGINAL_DIGEST_MISMATCH",Assert.Throws<ConnectException>(()=>AgentRuntime.ValidateReconciledReceipt(valid,new string('0',64))).Code);
        var missing=Json.Element(new{original=new{sha256=digest},counts=new{valid=0,imported=1,duplicate=0,invalid=0,ambiguous=0,failed=0},rows=Array.Empty<object>(),recordIds=new[]{"proof-fixture"}});
        Assert.Equal("IMPORT_RECONCILIATION_FAILED",Assert.Throws<ConnectException>(()=>AgentRuntime.ValidateReconciledReceipt(missing,digest)).Code);
        Assert.Equal("IMPORT_RECONCILIATION_FAILED",Assert.Throws<ConnectException>(()=>AgentRuntime.ValidateReconciledReceipt(Json.Element(new{state="succeeded"}),digest)).Code);
    }
    [Fact] public void Approved_source_contract_holds_schema_drift_and_ambiguous_or_pre_cutoff_timestamps()
    {
        var approved=Json.Element(new{mapping=new{shippedAt="Reported at"},sourceContract=new{schema="packproof.scheduled-csv/v1",expectedHeaders=new[]{"Reference","Reported at"},backfillFrom="2026-11-01T00:00:00Z"}});
        FolderSource.ValidateContract(Encoding.UTF8.GetBytes("Reference,Reported at\r\n000045,2026-11-07T08:00:00-05:00\r\n"),approved);
        Assert.Equal("MAPPING_NEEDS_REVIEW",Assert.Throws<ConnectException>(()=>FolderSource.ValidateContract(Encoding.UTF8.GetBytes("Reference,Reported at,New field\r\n000045,2026-11-07T08:00:00Z,extra\r\n"),approved)).Code);
        Assert.Equal("MAPPING_NEEDS_REVIEW",Assert.Throws<ConnectException>(()=>FolderSource.ValidateContract(Encoding.UTF8.GetBytes("Reference,Reported at\r\n000045,2026-11-07\r\n"),approved)).Code);
        Assert.Equal("SOURCE_BACKFILL_BOUNDARY",Assert.Throws<ConnectException>(()=>FolderSource.ValidateContract(Encoding.UTF8.GetBytes("Reference,Reported at\r\n000045,2026-10-31T23:59:59Z\r\n"),approved)).Code);
    }
    [Fact] public void Bounded_backfill_scan_reaches_later_files_and_revisits_the_full_source_without_starvation()
    {
        var files=Enumerable.Range(0,205).Select(n=>$"shipment-{n:000}.csv").ToArray();var first=FolderSource.ScanBatch(files,null);
        Assert.Equal(100,first.Length);var second=FolderSource.ScanBatch(files,Path.GetFileName(first[^1]));var third=FolderSource.ScanBatch(files,Path.GetFileName(second[^1]));
        Assert.Equal(files.Length,first.Concat(second).Concat(third).Distinct().Count());Assert.Empty(FolderSource.ScanBatch([],null));
    }
    private static HostConfiguration Host()=>new("development","https://api.thepackproof.com","https://thepackproof.com","S-1-5-32-544");
    public void Dispose(){Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();if(Directory.Exists(root))Directory.Delete(root,true);}
    private sealed class TestProtector:ISecretProtector{public byte[] Protect(byte[] data)=>data.Select(x=>(byte)(x^0xA6)).ToArray();public byte[] Unprotect(byte[] data)=>Protect(data);}
    private sealed class ArchiveFailProtector:ISecretProtector{public byte[] Protect(byte[] data){if(Encoding.UTF8.GetString(data).Contains("packproof.connect-recovery/v1",StringComparison.Ordinal))throw new IOException("Injected archive persistence failure");return data.Select(x=>(byte)(x^0xA6)).ToArray();}public byte[] Unprotect(byte[] data)=>data.Select(x=>(byte)(x^0xA6)).ToArray();}
    private sealed class FakeHandler(Func<HttpRequestMessage,HttpResponseMessage> response):HttpMessageHandler{protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellationToken)=>Task.FromResult(response(request));}
}

public sealed class WindowsFactAttribute : FactAttribute { public WindowsFactAttribute() { if(!OperatingSystem.IsWindows())Skip="Requires a native Windows NTFS runner; not validated on Linux."; } }
public sealed class NativeFolderTests : IDisposable {
    private readonly string root=Path.Combine(Path.GetTempPath(),"packproof-native-folder-"+Guid.NewGuid().ToString("N"));
    [WindowsFact] public void Immutable_NTFS_snapshot_preserves_exact_BOM_and_original_bytes(){Directory.CreateDirectory(root);var original=Encoding.UTF8.GetBytes("\uFEFFreference,description,quantity\r\n0001,Fixture,1\r\n");File.WriteAllBytes(Path.Combine(root,"source.csv"),original);Assert.Equal(original,FolderSource.Snapshot(root,"source.csv"));}
    [WindowsFact] public void Concurrent_writer_is_rejected_instead_of_staging_mutable_bytes(){Directory.CreateDirectory(root);var path=Path.Combine(root,"source.csv");File.WriteAllText(path,"reference\nfirst\n");using var writer=new FileStream(path,FileMode.Open,FileAccess.Write,FileShare.ReadWrite|FileShare.Delete);Assert.Throws<ConnectException>(()=>FolderSource.Snapshot(root,"source.csv"));}
    [WindowsFact] public void Reparse_source_and_file_escape_are_rejected(){Directory.CreateDirectory(root);var outside=root+"-outside";Directory.CreateDirectory(outside);try{File.WriteAllText(Path.Combine(outside,"source.csv"),"reference\noutside\n");Directory.CreateSymbolicLink(Path.Combine(root,"linked"),outside);Assert.Throws<ConnectException>(()=>FolderSource.Validate(Path.Combine(root,"linked")));File.CreateSymbolicLink(Path.Combine(root,"source.csv"),Path.Combine(outside,"source.csv"));Assert.Throws<ConnectException>(()=>FolderSource.Snapshot(root,"source.csv"));}finally{if(Directory.Exists(outside))Directory.Delete(outside,true);}}
    public void Dispose(){if(Directory.Exists(root))Directory.Delete(root,true);}
}
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class NativeProtectedAncestryTests
{
    private static System.Security.AccessControl.DirectorySecurity Acl(string owner="S-1-5-32-544") { var acl=new System.Security.AccessControl.DirectorySecurity();acl.SetOwner(new System.Security.Principal.SecurityIdentifier(owner));acl.SetAccessRuleProtection(true,false);return acl; }
    [WindowsFact] public void User_owned_or_replaceable_ancestor_is_denied_without_changing_its_permissions()
    {
        var service="S-1-5-80-1-2-3-4-5";var owned=Acl("S-1-5-21-1-2-3-1001");Assert.Equal("PROTECTED_STORAGE_PERMISSIONS",Assert.Throws<ConnectException>(()=>ProtectedAncestry.AssertAcl(owned,service,false)).Code);
        var replaceable=Acl();replaceable.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(new System.Security.Principal.SecurityIdentifier("S-1-5-32-545"),System.Security.AccessControl.FileSystemRights.DeleteSubdirectoriesAndFiles,System.Security.AccessControl.AccessControlType.Allow));Assert.Equal("PROTECTED_STORAGE_PERMISSIONS",Assert.Throws<ConnectException>(()=>ProtectedAncestry.AssertAcl(replaceable,service,false)).Code);Assert.Single(replaceable.GetAccessRules(true,true,typeof(System.Security.Principal.SecurityIdentifier)).Cast<System.Security.AccessControl.FileSystemAccessRule>());
    }
    [WindowsFact] public void Inherit_only_creator_rule_is_safe_but_service_replacement_rights_apply_only_to_data_leaf()
    {
        var service="S-1-5-80-1-2-3-4-5";var acl=Acl();acl.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(new System.Security.Principal.SecurityIdentifier("S-1-3-0"),System.Security.AccessControl.FileSystemRights.FullControl,System.Security.AccessControl.InheritanceFlags.ContainerInherit|System.Security.AccessControl.InheritanceFlags.ObjectInherit,System.Security.AccessControl.PropagationFlags.InheritOnly,System.Security.AccessControl.AccessControlType.Allow));ProtectedAncestry.AssertAcl(acl,service,false);
        acl.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(new System.Security.Principal.SecurityIdentifier(service),System.Security.AccessControl.FileSystemRights.Modify,System.Security.AccessControl.AccessControlType.Allow));ProtectedAncestry.AssertAcl(acl,service,true);Assert.Throws<ConnectException>(()=>ProtectedAncestry.AssertAcl(acl,service,false));
    }
}

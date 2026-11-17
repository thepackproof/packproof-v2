using System.Text.Json;
using Microsoft.Data.Sqlite;
using PackProof.Connect;
using Xunit;

public sealed class LegacyRuntimeStateTests : IDisposable
{
    private readonly string root=Path.Combine(Path.GetTempPath(),"connect-legacy-runtime-state-"+Guid.NewGuid().ToString("N"));
    private static HostConfiguration Host()=>new("development","https://api.example","https://app.example","S-1-5-21-1-2-3-1001");
    private sealed class PlainProtector:ISecretProtector {public byte[] Protect(byte[] value)=>value.ToArray();public byte[] Unprotect(byte[] value)=>value.ToArray();}
    private sealed class NoNetwork:HttpMessageHandler {protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)=>throw new InvalidOperationException("No network operation is authorized by this test.");}
    private ProtectedStore Store(){var storage=new ProtectedStore(root,new PlainProtector());storage.Initialize();return storage;}
    [Fact]
    public async Task A_supported_legacy_state_retains_opaque_source_metadata_and_unknown_fields_across_a_real_runtime_save()
    {
        var original=JsonDocument.Parse("""
        {"installationId":"synthetic-legacy","localPaused":true,"stateVersion":2,"subscriptionDraft":null,
         "sourceSubscriptions":[{"id":"legacy","sourceProfile":"shipment-csv/v1","grantRevision":0,"capabilityApproved":false,"opaqueMetadata":{"reference":"0000123","sourceTime":"2026-11-13T09:00:00-05:00"}}],
         "lastScheduledSourceId":"legacy","unknownSafetyMetadata":{"keep":["original","receipt"],"revision":47}}
        """).RootElement.Clone();
        var storage=Store();storage.Write("state.bin",original);
        var state=storage.Read<LocalState>("state.bin")!;
        using(var runtime=new AgentRuntime(Host(),storage,new PackProofClient(Host(),new NoNetwork()),state))
        {
            runtime.RequireLocalInitialization();
            var key=File.ReadAllBytes(Path.Combine(root,"spool-key.bin"));
            await runtime.Command("pause",null,default);
            Assert.Equal(key,File.ReadAllBytes(Path.Combine(root,"spool-key.bin")));
        }
        var saved=storage.Read<JsonElement>("state.bin");
        foreach(var name in new[]{"lastScheduledSourceId","unknownSafetyMetadata"})
            Assert.True(JsonElement.DeepEquals(original.GetProperty(name),saved.GetProperty(name)),name+" was not retained.");
        Assert.Equal(SourceStateMigration.Version,saved.GetProperty("stateVersion").GetInt32());
        Assert.False(saved.TryGetProperty("subscriptionDraft",out var draft) && draft.ValueKind!=JsonValueKind.Null);
        var savedSource=Assert.Single(saved.GetProperty("sourceSubscriptions").EnumerateArray());
        foreach(var property in original.GetProperty("sourceSubscriptions")[0].EnumerateObject())
            Assert.True(JsonElement.DeepEquals(property.Value,savedSource.GetProperty(property.Name)),property.Name);
        Assert.True(saved.GetProperty("localPaused").GetBoolean());Assert.False(saved.TryGetProperty("preservedFields",out _));
    }
    [Fact]
    public void Unsupported_source_state_is_rejected_before_queue_or_key_creation_and_its_original_bytes_remain_untouched()
    {
        var storage=Store();storage.Write("state.bin",Json.Element(new{stateVersion=5,sourceSubscriptions=new[]{new{id="typed-source",sourceProfile="typed-observation/v1",grantRevision=1}},unknownSafetyMetadata=new{preserve=true}}));
        var original=File.ReadAllBytes(Path.Combine(root,"state.bin"));
        using var client=new PackProofClient(Host(),new NoNetwork());
        Assert.Equal("LOCAL_STATE_UNSUPPORTED",Assert.Throws<ConnectException>(()=>new AgentRuntime(Host(),storage,client,storage.Read<LocalState>("state.bin")!)).Code);
        Assert.Equal(original,File.ReadAllBytes(Path.Combine(root,"state.bin")));Assert.False(File.Exists(Path.Combine(root,"queue.sqlite")));Assert.False(File.Exists(Path.Combine(root,"spool-key.bin")));
    }
    public void Dispose(){using var connection=new SqliteConnection(new SqliteConnectionStringBuilder{DataSource=Path.Combine(root,"queue.sqlite"),Mode=SqliteOpenMode.ReadWriteCreate}.ToString());SqliteConnection.ClearPool(connection);if(Directory.Exists(root))Directory.Delete(root,true);}
}

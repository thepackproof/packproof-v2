using System.Net;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using PackProof.Connect;

internal static class FacilityWorkflowScenario
{
    private static void Check(bool value,string message)
    {
        if(!value) throw new InvalidOperationException(message);
    }
    private sealed class ApprovalServer : HttpMessageHandler
    {
        public bool Approved;
        public int Proposals;
        public int Withdrawals;
        public JsonElement Scope;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req,CancellationToken ct)
        {
            var path=req.RequestUri!.AbsolutePath;
            object result;
            if(path.EndsWith("/withdraw")) {Withdrawals++;result=new {withdrawn=true};}
            else if(path.EndsWith("/proposals") || path.EndsWith("/order-workspace"))
            {
                if(path.EndsWith("/proposals")){Proposals++;Scope=Json.Read<JsonElement>(await req.Content!.ReadAsByteArrayAsync(ct));}
                result=new {state=Approved?"active":"pending",scope=Scope,scopeDigest=new string('a',64),offlineWindowSeconds=Approved?3600:0,
                    expiresAt=DateTimeOffset.UtcNow.AddMinutes(15),approvalPath="/app/records/connect/approve?workspaceSession=sample"};
            }
            else throw new InvalidOperationException("An unexpected network request occurred during setup: "+path);
            return new(HttpStatusCode.OK){Content=new ByteArrayContent(Json.Bytes(result))};
        }
    }
    public static async Task Run(string fixtures)
    {
        var root=Directory.CreateTempSubdirectory("pp-facility-workflow-").FullName;
        try
        {
            var store=new ProtectedStore(Path.Combine(root,"state"),new ServiceIdentityProtector());
            store.Initialize();
            var host=new HostConfiguration("development","https://api.example","https://app.example","S-1-5-32-545");
            var server=new ApprovalServer();
            static JsonElement Config(string location)=>Json.Element(new {state="ready",organizationId="sample-org",locationId=location,
                integrationAccountId="erp",operatorMembershipId="owner",sourceName="Sample",configRevision=0,capabilities=new {guidedFacilitySetup=true}});
            var state=new LocalState {InstallationId="sample-device",Token="sample-token",CredentialExpiresAt=DateTimeOffset.UtcNow.AddDays(14),
                ServerConfig=Config("west")};
            AgentRuntime Open(LocalState s)=>new(host,store,new(host,server),s);
            string id;
            int revision;
            using(var app=Open(state))
            {
                async Task<JsonElement> Send(string op,object? payload=null)=>Json.Element(await app.Command(op,Json.Element(payload??new{}),default));
                var first=await Send("getFacilityDraft");
                id=first.GetProperty("id").GetString()!;
                async Task<string> Add(string input,string role)
                {
                    var path=Directory.CreateDirectory(Path.Combine(root,role)).FullName;
                    File.Copy(Path.Combine(fixtures,input),Path.Combine(path,input));
                    var status=await Send("addWorkspaceSource",new {folder=path,role});
                    var s=status.GetProperty("workspace").GetProperty("sources").EnumerateArray().Single(s=>s.GetProperty("folder").GetString()==path);
                    var sourceId=s.GetProperty("id").GetString()!;
                    await Send("confirmWorkspaceOrderMap",new {sourceId,expectedGeneration=s.GetProperty("generation").GetInt32(),
                        profileVersion=s.GetProperty("recognition").GetProperty("profileVersion").GetString()});
                    return sourceId;
                }
                await Add("orders.csv","order"); await Add("cartons.csv","packing");
                var labels=await Add("labels.csv","shipping");
                await Add("dispatch-initial.csv","delivery");
                var aside=Directory.CreateDirectory(Path.Combine(root,"deferred")).FullName;
                var extra=(await Send("addWorkspaceSource",new {folder=aside,role="evidence"})).GetProperty("workspace").GetProperty("sources").EnumerateArray().Single(s=>s.GetProperty("folder").GetString()==aside).GetProperty("id").GetString();
                var output=Directory.CreateDirectory(Path.Combine(root,"output")).FullName;
                await Send("setWorkspaceOutput",new {folder=output});
                var input=new {steps=first.GetProperty("steps"),examples=new[] {
                    new FacilityExample("ordinary","SO-10481",1,0),new FacilityExample("split","CTN-02",2,1),new FacilityExample("reprint","SO-10483",1,2)},
                    rules=new[]{new FacilityRule(labels,"label")},excludedSourceIds=new[]{extra}};
                var saved=await Send("saveFacilityDraft",new {expectedRevision=1,changes=input});
                revision=saved.GetProperty("revision").GetInt32();
                Check(revision==2,"Expected a new draft revision");
                try{await Send("saveFacilityDraft",new {expectedRevision=1,changes=input});throw new Exception("Stale edit accepted");}
                catch(ConnectException error) when(error.Code=="DRAFT_CHANGED"){}
                var replay=(await Send("replayFacilityDraft",new {expectedRevision=revision})).GetProperty("replay");
                Check(replay.GetProperty("passed").GetBoolean(),replay.GetRawText());
                Check(replay.GetProperty("sources").GetArrayLength()==4,"Deferred source entered replay");
                Check(server.Proposals==0 && !Directory.EnumerateFiles(output,"*",SearchOption.AllDirectories).Any(f=>Path.GetExtension(f)==".json"),"Draft preview affected live outputs");
                await Send("activateWorkspace");
                Check(server.Proposals==1 && server.Scope.GetProperty("testedProfile").GetProperty("digest").GetString()==replay.GetProperty("digest").GetString(),"Replay was not bound to proposal");
                var edited=await Send("saveFacilityDraft",new {expectedRevision=revision,changes=new {steps=input.steps,examples=input.examples,
                    rules=new[]{new FacilityRule(labels,"unknown")},excludedSourceIds=input.excludedSourceIds}});
                revision=edited.GetProperty("revision").GetInt32();
                Check(server.Withdrawals==1 && edited.GetProperty("replay").ValueKind==JsonValueKind.Null,"Edit retained approval eligibility");
                try{await Send("activateWorkspace");throw new Exception("Untested profile activated");}
                catch(ConnectException e) when(e.Code=="REPLAY_REQUIRED"){}
                var incomplete=(await Send("replayFacilityDraft",new {expectedRevision=revision})).GetProperty("replay");
                Check(!incomplete.GetProperty("passed").GetBoolean(),"Unknown label meaning established delivery or label evidence");
                saved=await Send("saveFacilityDraft",new {expectedRevision=revision,changes=input});
                revision=saved.GetProperty("revision").GetInt32();
                await Send("replayFacilityDraft",new {expectedRevision=revision});
            }
            var restored=store.Read<LocalState>("state.bin")!;
            using(var app=Open(restored))
            {
                async Task<JsonElement> Send(string op,object? payload=null)=>Json.Element(await app.Command(op,Json.Element(payload??new{}),default));
                var current=await Send("getFacilityDraft");
                Check(current.GetProperty("id").GetString()==id && current.GetProperty("revision").GetInt32()==revision,"Lost draft on restart");
                restored.ServerConfig=Config("east");
                Check((await Send("getFacilityDraft")).GetProperty("id").GetString()!=id,"Cross-facility draft disclosure");
                var east=(await Send("status")).GetProperty("workspace");
                Check(east.GetProperty("sources").GetArrayLength()==0 && !east.TryGetProperty("outputFolder",out _),"Cross-facility source or output disclosure");
                restored.ServerConfig=Config("west");
                var destination=Directory.CreateDirectory(Path.Combine(root,"second-output")).FullName;
                await Send("setWorkspaceOutput",new {folder=destination});
                try{await Send("activateWorkspace");throw new Exception("Stale destination activated");}
                catch(ConnectException e) when(e.Code=="REPLAY_REQUIRED"){}
                await Send("replayFacilityDraft",new {expectedRevision=revision});
                server.Approved=true;
                var status=await Send("activateWorkspace");
                Check(status.GetProperty("workspace").GetProperty("phase").GetString()=="active","The exact re-tested scope failed to activate");
                var active=restored.Workspace!.Sources.Single(s=>s.Roles.Contains("shipping"));
                Check(active.ShippedAtMeaning=="label" && restored.Workspace.ActiveGrant!.Generations[active.Id]==active.Generation,"Mismatch between approved rules and live generation");
            }
        }
        finally {SqliteConnection.ClearAllPools();Directory.Delete(root,true);}
    }
}

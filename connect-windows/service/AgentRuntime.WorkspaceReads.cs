using System.Text.Json;

namespace PackProof.Connect;

public sealed partial class AgentRuntime
{
    // A revision retrieved for local output is already authenticated against the
    // operation. Update an existing card without exposing a historical job as a
    // new order or carrying cards across a change of scope.
    private void RememberWorkspaceRevision(JsonElement document, string proofId, int revision)
    {
        if (!WorkspaceGrantCurrent || ordersScope != state.Workspace?.ActiveGrant?.ScopeDigest ||
            !document.TryGetProperty("proofId",out var id) || id.GetString() != proofId ||
            !document.TryGetProperty("revision",out var version) || version.GetInt32() != revision) return;
        var index = Array.FindIndex(workspaceOrders,item=>item.GetProperty("proofId").GetString()==proofId);
        if (index < 0 || workspaceOrders[index].GetProperty("revision").GetInt32() >= revision) return;
        workspaceOrders[index] = SummaryForDesktop(document);
        ordersCurrent=false;
        nextOrderRefresh=DateTimeOffset.MinValue;
    }

    private async Task<object> WorkspaceSearchOrders(JsonElement payload,CancellationToken ct)
    {
        if (!WorkspaceGrantCurrent) throw new ConnectException("AUTH_REQUIRED","Reconnect this workspace to search orders.");
        var query=payload.GetProperty("query").GetString();
        if (string.IsNullOrWhiteSpace(query) || query.Length>200 || query.Any(char.IsControl))
            throw new ConnectException("ORDER_QUERY_INVALID","Enter an order reference of up to 200 characters.");
        var result=await api.Request("GET","/v1/partner/agent/order-proofs?q="+Uri.EscapeDataString(query)+"&referenceType=any",null,state.Token,null,ct);
        return result.GetProperty("orders").EnumerateArray().Take(20).Select(SummaryForDesktop).ToArray();
    }
    private static long? OrderCursor(JsonElement result,string key="nextBefore") =>
        Optional(result,key) is {ValueKind:JsonValueKind.Number} value && value.TryGetInt64(out var n)
            && n is >0 and <=9007199254740991 ? n:null;
    private async Task<object> WorkspaceOrderPage(JsonElement payload,CancellationToken ct)
    {
        if(!WorkspaceGrantCurrent)throw new ConnectException("AUTH_REQUIRED","Reconnect this workspace to browse more orders.");
        var before=payload.GetProperty("before").GetInt64();
        if(before is <1 or >9007199254740991)throw new ConnectException("ORDER_QUERY_INVALID","Refresh the order list.");
        var page=await api.Request("GET",$"/v1/partner/agent/order-proofs?before={before}",null,state.Token,null,ct);
        return new{orders=page.GetProperty("orders").EnumerateArray().Take(20).Select(SummaryForDesktop).ToArray(),nextBefore=OrderCursor(page)};
    }
    private async Task<object> WorkspaceAttention(JsonElement request,CancellationToken ct)
    {
        if(!WorkspaceGrantCurrent)throw new ConnectException("AUTH_REQUIRED","Reconnect this workspace to check records that need review.");
        var path="/v1/partner/agent/order-attention?includeOrderIssues=1";
        if(Optional(request,"before") is {} cursor)
        {
            if(!cursor.TryGetInt64(out var before) || before is <1 or >9007199254740991)
                throw new ConnectException("ORDER_QUERY_INVALID","Refresh the list of orders that need attention.");
            path+=$"&before={before}";
        }
        var result=await api.Request("GET",path,null,state.Token,null,ct);
        var items=result.GetProperty("items");
        return new {
            items=items.EnumerateArray().Take(20).Select(row=>SmallFields(row,["sourceId","fileName","locator","kind","reason","proofId","revision","orderReference"])),
            orderIssueCount=OptionalCount(result,"orderIssueCount"),
            nextIssuesBefore=OrderCursor(result,"nextIssuesBefore"),
            orderIssues=Optional(result,"orderIssues") is {ValueKind:JsonValueKind.Array} issues
                ? issues.EnumerateArray().Take(20).Select(SummaryForDesktop).ToArray() : null,
            hasMore=items.GetArrayLength()>20 || (result.TryGetProperty("hasMore",out var more)&&more.ValueKind==JsonValueKind.True)
        };
    }
    private static Dictionary<string,JsonElement> SmallFields(JsonElement row,string[] keys)
    {
        var output=new Dictionary<string,JsonElement>();
        foreach(var key in keys)
            if(row.TryGetProperty(key,out var v) && v.ValueKind is JsonValueKind.String or JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False)
                output[key]=v.ValueKind==JsonValueKind.String&&v.GetString()!.Length>256?Json.Element(v.GetString()![..256]):v;
        return output;
    }
    private static int? OptionalCount(JsonElement value,string key) =>
        Optional(value,key) is {ValueKind:JsonValueKind.Number} number && number.TryGetInt32(out var n) && n>=0 ? n:null;
    private static JsonElement SummaryForDesktop(JsonElement row)
    {
        var summary=SmallFields(row,["proofId","revision","orderReference","updatedAt","customerName","latestKind","issue","fulfillmentStatus","locationId"]);
        if (Optional(row,"matchedSubjects") is {ValueKind:JsonValueKind.Array} subjects)
            summary["matchedSubjects"]=Json.Element(subjects.EnumerateArray().Take(64).Select(s=>SmallFields(s,["id","type","namespace"])));
        return Json.Element(summary);
    }
    private (string id,int revision) RequireOrderRead(JsonElement request)
    {
        if(!WorkspaceGrantCurrent)throw new ConnectException("AUTH_REQUIRED","Reconnect this workspace to read this proof.");
        var id=request.GetProperty("proofId").GetString();
        var revision=request.GetProperty("revision").GetInt32();
        if(!IsProofId(id)||revision<1)throw new ConnectException("ORDER_INVALID","Choose an order from the current list.");
        return(id!,revision);
    }
    private static string RevisionPath(string id,int revision)=>$"/v1/partner/agent/order-proofs/{id}/revisions/{revision}";

    // All allocations are retained across deliveries. Raw fields and original bytes
    // require a separate per-event check against the effective source grant.
    internal static object OrderForDesktop(JsonElement proof)
    {
        var output=SmallFields(proof,["proofId","orderReference","revision","updatedAt","integrity","customerName","purchaseOrder","fulfillmentStatus"]);
        var totals=new Dictionary<string,int>();
        var packages=new HashSet<string>(StringComparer.Ordinal);
        string[] eventFields=["kind","sourceId","fileName","eventKey","eventId","version","receiptId","profileVersion",
            "sourceModifiedAt","originalSha256","locator","occurredAt","observedAt","associationScope","originalStatus","facilityId",
            "entity","references","lines","eventKind"];
        foreach(var lane in new[]{"lines","events","evidence"})
        {
            var rows=proof.GetProperty(lane);
            totals[lane]=rows.GetArrayLength();
            if(lane=="lines"){output[lane]=rows;continue;}
            var entries=new List<Dictionary<string,JsonElement>>();
            foreach(var row in rows.EnumerateArray())
            {
                var entry=SelectFields(row,eventFields);
                if(row.TryGetProperty("fields",out var fields) && fields.ValueKind==JsonValueKind.Object &&
                    (!row.TryGetProperty("associationScope",out var assoc)||assoc.GetString()!="shared"))
                    entry["fields"]=Json.Element(SmallFields(fields,["customerName","CustomerName","customer","Customer","SoldToName","ShipToName",
                        "purchaseOrder","purchaseOrderNumber","PurchaseOrderNumber","PONumber","skuDescription","description","ItemDescription",
                        "plannedAt","scheduledAt","scheduledDeliveryAt","expectedDeliveryAt","status","deliveryStatus","orderReference",
                        "facilityName","deliveryId","shipmentId","packageId","lineId","unit","sku","fulfillmentStatus","orderStatus",
                        "plannedShipmentReference","plannedDeliveryDate","followUpStatus","followUpRequest","followUpOwner",
                        "followUpRequestedAt","followUpEvidenceState","itemCounts","handoff","purchaseOrderReference"]));
                if(lane=="events" && entry.TryGetValue("entity",out var entity))
                {
                    RememberPackage(entity);
                    if(entry.TryGetValue("references",out var refs) && refs.ValueKind==JsonValueKind.Array)
                        foreach(var reference in refs.EnumerateArray())RememberPackage(reference);
                }
                entries.Add(entry);
            }
            output[lane]=Json.Element(entries);
        }
        void RememberPackage(JsonElement reference)
        {
            if(Optional(reference,"type")?.GetString()=="package" && Optional(reference,"id")?.GetString() is {Length:>0} key)packages.Add(key);
        }
        output["packages"]=Json.Element(packages.Select(id=>new{packageId=id}));
        output["totals"]=Json.Element(totals);
        foreach(var key in new[]{"facilities","conflicts","originalArtifacts"})
            if(Optional(proof,key) is {ValueKind:JsonValueKind.Array} list)output[key]=list;
        return output;
    }
    private static Dictionary<string,JsonElement> SelectFields(JsonElement row,string[] keys)
    {
        var selected=new Dictionary<string,JsonElement>(StringComparer.Ordinal);
        foreach(var key in keys)
            if(row.TryGetProperty(key,out var value))selected[key]=value;
        return selected;
    }

    private async Task<object> WorkspaceSourceRecord(JsonElement request,CancellationToken ct)
    {
        var(id,revision)=RequireOrderRead(request);
        var eventKey=request.GetProperty("eventKey").GetString();
        if(!IsProofId(eventKey))throw new ConnectException("SOURCE_NOT_FOUND","Choose a record in this proof.");
        var path=RevisionPath(id,revision);
        var record=await api.Request("GET",$"{path}/sources/{eventKey}",null,state.Token,null,ct);
        var kind=Optional(record,"kind")?.GetString();
        if(kind is not ("derived_excerpt" or "original") || Optional(record,"eventKey")?.GetString()!=eventKey)throw InvalidFeed();
        var result=SelectFields(record,["kind","eventKey","receiptId","originalSha256","fileName","fields","fieldLineage","locator","sourceId",
            "observedAt","occurredAt","version","profileVersion","lines","eventKind","originalText","mediaType","reason"]);
        if(Optional(record,"artifactReceiptId")?.GetString() is {} receipt)
        {
            if(!IsProofId(receipt))throw InvalidFeed();
            var artifact=await api.Request("GET",$"{path}/artifacts/{receipt}",null,state.Token,null,ct);
            if(Optional(artifact,"receiptId")?.GetString()!=receipt)throw InvalidFeed();
            if(Optional(artifact,"kind")?.GetString()=="original")
            {
                var mediaType=Optional(artifact,"mediaType")?.GetString();
                if(mediaType is not ("image/jpeg" or "image/png" or "application/zpl"))throw InvalidFeed();
                var bytes=artifact.GetProperty("bytesBase64").GetBytesFromBase64();
                if(bytes.Length>3*1024*1024 || HashBytes(bytes)!=Optional(artifact,"originalSha256")?.GetString())throw InvalidFeed();
                result["artifact"]=Json.Element(SelectFields(artifact,["receiptId","fileName","originalSha256","mediaType","bytesBase64"]));
            }
        }
        return result;
    }
}

using System.Text.Json;

namespace PackProof.Connect;

public sealed partial class AgentRuntime
{
    private async Task<object> WorkspaceSearchOrders(JsonElement payload,CancellationToken ct)
    {
        if (!WorkspaceGrantCurrent) throw new ConnectException("AUTH_REQUIRED","Reconnect this workspace to search orders.");
        var query=payload.GetProperty("query").GetString();
        if (string.IsNullOrWhiteSpace(query) || query.Length>200 || query.Any(char.IsControl))
            throw new ConnectException("ORDER_QUERY_INVALID","Enter an order reference of up to 200 characters.");
        var result=await api.Request("GET","/v1/partner/agent/order-proofs?q="+Uri.EscapeDataString(query),null,state.Token,null,ct);
        return result.GetProperty("orders").EnumerateArray().Take(20).Select(row=>new {
            proofId=row.GetProperty("proofId"), revision=row.GetProperty("revision"), orderReference=row.GetProperty("orderReference")
        }).ToArray();
    }
    private async Task<object> WorkspaceAttention(CancellationToken ct)
    {
        if (!WorkspaceGrantCurrent) throw new ConnectException("AUTH_REQUIRED","Reconnect this workspace to check records that need review.");
        var result=await api.Request("GET","/v1/partner/agent/order-attention",null,state.Token,null,ct);
        var items=result.GetProperty("items");
        return new {
            items=items.EnumerateArray().Take(20).Select(row=>SmallFields(row,["sourceId","fileName","locator","kind","reason"])),
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
    // The renderer needs the business view, not source payloads or binary
    // attachments. Each lane gets a byte budget below the trusted pipe limit.
    internal static object OrderForDesktop(JsonElement proof)
    {
        const int budget=42000;
        var output=SmallFields(proof,["proofId","orderReference","revision","updatedAt"]);
        var totals=new Dictionary<string,int>();
        var packages=new HashSet<string>(StringComparer.Ordinal);
        void Read(string property,string[] keys)
        {
            var rows=new List<Dictionary<string,JsonElement>>();
            var size=0;
            var all=proof.GetProperty(property);
            totals[property]=all.GetArrayLength();
            foreach(var row in all.EnumerateArray())
            {
                var item=SmallFields(row,keys);
                size+=Json.Bytes(item).Length+1;
                if(size>budget||rows.Count>=100)break;
                rows.Add(item);
                if(property=="events"){
                    IEnumerable<JsonElement> refs=row.TryGetProperty("references",out var values)&&values.ValueKind==JsonValueKind.Array?values.EnumerateArray():[];
                    if(row.TryGetProperty("entity",out var entity))refs=refs.Prepend(entity);
                    foreach(var r in refs)if(packages.Count<20 && r.ValueKind==JsonValueKind.Object && r.TryGetProperty("type",out var type)&&type.GetString()=="package"
                        && r.TryGetProperty("id",out var id)&&id.GetString() is {Length:>0 and <=200} key)packages.Add(key);
                }
            }
            output[property]=Json.Element(rows);
        }
        Read("lines",["lineId","sku","unit","orderedQuantity","pickedQuantity","packedQuantity","shippedQuantity","returnedQuantity","orderedMinusShippedQuantity","orderedShippedDiscrepancy"]);
        Read("events",["kind","sourceId","fileName","occurredAt","observedAt","associationScope"]);
        Read("evidence",["kind","sourceId","fileName","locator","originalStatus","originalSha256"]);
        output["packages"]=Json.Element(packages.Select(id=>new{packageId=id}));
        output["totals"]=Json.Element(totals);
        if(proof.TryGetProperty("conflicts",out var conflicts))output["conflicts"]=Json.Element(conflicts.EnumerateArray().Take(20).Select(c=>c.GetString()));
        return output;
    }
}


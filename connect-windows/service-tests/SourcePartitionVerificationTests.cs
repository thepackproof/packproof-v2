using System.Text.Json;
using PackProof.Connect;
using Xunit;
public sealed class SourcePartitionVerificationTests
{
    [Fact]public void Multi_order_JSON_receipt_verifies_exact_case_partitions_and_their_source_assertion_union()
    {
        object Ref(string type,string id,string? parent=null)=>parent is null?new Dictionary<string,object?>{{"namespace","source"},{"type",type},{"externalId",id}}:new Dictionary<string,object?>{{"namespace","source"},{"type",type},{"externalId",id},{"parentExternalId",parent}};
        object Assertion(string id,string order,string value)=>new{id,subjectReference=Ref("order_line","001",order),property="orderedQuantity",value=new{amount=value,unit="each"}};
        object Relation(string id,string order)=>new Dictionary<string,object?>{{"id",id},{"from",Ref("order",order)},{"to",Ref("order_line","001",order)},{"type","has_line"},{"quantity",null}};
        object a=Assertion("assert-a","ORDER-A","4"),b=Assertion("assert-b","ORDER-B","6");object ra=Relation("relation-a","ORDER-A"),rb=Relation("relation-b","ORDER-B");
        var original=Json.Element(new{references=new[]{Ref("order","ORDER-A"),Ref("order_line","001","ORDER-A"),Ref("order","ORDER-B"),Ref("order_line","001","ORDER-B")},identityDerivation=new{schema="packproof.source-identity-derivation/v1"},assertions=new[]{a,b},relationships=new[]{ra,rb}});
        var receipt=Json.Element(new{caseIds=new[]{"case-a","case-b"},rows=new[]{new{id="row-a",rowNumber=1,status="accepted_linked",caseIds=new[]{"case-a","case-b"},normalized=original}}});
        object Projection(string caseId,object[] assertions,object[] relationships)=>new{rowNumber=1,caseId,rootReference=Ref("order",caseId=="case-a"?"ORDER-A":"ORDER-B"),sourceRootReference=Ref("order",caseId=="case-a"?"ORDER-A":"ORDER-B"),projectionRevision=2,observationId="row-a",assertions,relationships};
        JsonElement Stored(object[] rows)=>Json.Element(new{schema="packproof.typed-import-records/v1",batchId="batch-a",originalSha256="digest",rows});
        var exact=new[]{Projection("case-a",[a],[ra]),Projection("case-b",[b],[rb])};Assert.Equal("case-a",AgentRuntime.ValidateTypedStoredRecords(receipt,Stored(exact),"batch-a","digest"));
        Assert.Throws<ConnectException>(()=>AgentRuntime.ValidateTypedStoredRecords(receipt,Stored([exact[0]]),"batch-a","digest"));
        Assert.Throws<ConnectException>(()=>AgentRuntime.ValidateTypedStoredRecords(receipt,Stored([exact[0],Projection("case-a",[b],[rb])]),"batch-a","digest"));
        Assert.Throws<ConnectException>(()=>AgentRuntime.ValidateTypedStoredRecords(receipt,Stored([exact[0],Projection("case-b",[Assertion("wrong","ORDER-B","99")],[rb])]),"batch-a","digest"));
        Assert.Throws<ConnectException>(()=>AgentRuntime.ValidateTypedStoredRecords(receipt,Stored([exact[0],Projection("case-b",[b],[])]),"batch-a","digest"));
        Assert.Throws<ConnectException>(()=>AgentRuntime.ValidateTypedStoredRecords(receipt,Stored([Projection("case-a",[b],[rb]),Projection("case-b",[a],[ra])]),"batch-a","digest"));
    }
}

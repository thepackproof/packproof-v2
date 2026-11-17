namespace PackProof.Connect;

public static partial class SourceReaders
{
    private static List<object> X12Claims(string type,string[][] segments,int first)
    {
        var claims=new List<object>();
        for(var index=1;index<segments.Length-1;index++)
        {
            string[] s=segments[index];string? V(int i)=>s.ElementAtOrDefault(i);
            void Claim(string field,int position,string? qualifier=null)
            {
                if(V(position) is {Length:>0} value)claims.Add(new{field,value,qualifier,locator=$"segment {first+index+1}/{s[0]}{position:D2}"});
            }
            switch(s[0])
            {
                case "PO1" when type=="850":Claim("orderLine",1);Claim("orderedQuantity",2,V(3));for(var i=6;i+1<s.Length;i+=2)Claim("productIdentifier",i+1,V(i));break;
                case "ACK" when type=="855":Claim("lineAcknowledgmentCode",1);Claim("acknowledgedQuantity",2,V(3));break;
                case "HL" when type=="856":Claim("hierarchyNode",1,V(3));Claim("parentHierarchyNode",2);break;
                case "MAN" when type=="856":Claim("containerMark",2,V(1));break;
                case "W01" when type=="940":Claim("requestedWarehouseQuantity",1,V(2));break;
                case "W12" when type=="945":Claim("warehouseStatusCode",1);Claim("reportedShippedQuantity",3,V(5));break;
                case "AT7" when type=="214":Claim("reportedShipmentStatusCode",1);Claim("reportedAppointmentStatusCode",3);Claim("reportedDate",5);Claim("reportedTime",6,V(7));break;
                case "AK9" when type is "997" or "999":Claim("functionalGroupResponseCode",1);break;
                case "REF":Claim("reportedReference",2,V(1));break;
                case "L11":Claim("reportedReference",1,V(2));break;
            }
            Require(claims.Count<=4096,"The transaction exceeds the interpreted claim limit.");
        }
        return claims;
    }
    private static List<object> EdifactClaims(string[][] segments,int first,char component,char release)
    {
        var claims=new List<object>();
        for(int index=1;index<segments.Length-1;index++)
        {
            var s=segments[index];
            string? V(int pos,int part)
            {
                if(pos>=s.Length)return null;
                var values=SplitReleased(s[pos],component,release);
                return part<values.Length?Unescape(values[part],release):null;
            }
            void Claim(string field,int pos,int part,string? qualifier=null,string? unit=null)
            {
                if(V(pos,part) is {Length:>0} value)claims.Add(new {field,value,qualifier,unit,locator=$"segment {first+index+1}/{s[0]}[{pos}][{part+1}]"});
            }
            switch(s[0])
            {
                case "LIN":Claim("lineIdentifier",1,0);Claim("productIdentifier",3,0,V(3,1));break;
                case "QTY":Claim("reportedQuantity",1,1,V(1,0),V(1,2));break;
                case "RFF":Claim("reportedReference",1,1,V(1,0));break;
                case "DTM":Claim("reportedTime",1,1,V(1,0),V(1,2));break;
                case "CPS":Claim("hierarchyNode",1,0);Claim("parentHierarchyNode",2,0);break;
                case "GIN":Claim("reportedIdentity",2,0,V(1,0));break;
                case "UCI":Claim("syntaxActionCode",4,0);break;
            }
            Require(claims.Count<=4096,"The EDIFACT message exceeds its claim limit.");
        }
        return claims;
    }
}

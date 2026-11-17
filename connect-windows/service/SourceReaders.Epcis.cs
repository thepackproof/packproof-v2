using System.Text.Json;
using System.Xml.Linq;

namespace PackProof.Connect;

public static partial class SourceReaders
{
    private static readonly HashSet<string> EpcisTypes=new(StringComparer.Ordinal){
        "ObjectEvent","AggregationEvent","TransformationEvent","TransactionEvent","AssociationEvent"};
    private static void EpcisJson(List<SourceReaderRow> rows,int first)
    {
        for(int index=first;index<rows.Count;index++)
        {
            var row=rows[index];var f=row.Fields;
            string? type=Scalar(f,"type");Require(type!=null&&EpcisTypes.Contains(type),"The EPCIS event type needs its own profile.");
            var rels=new List<object>();
            if(type is "AggregationEvent" or "AssociationEvent" && Scalar(f,"parentID") is {} parent && f.TryGetValue("childEPCs",out var children))
            {
                Require(children.ValueKind==JsonValueKind.Array,"Child EPCs must be an array.");
                foreach(var child in children.EnumerateArray())
                {
                    Require(child.ValueKind==JsonValueKind.String,"A child EPC must be a published identifier.");
                    rels.Add(new{parent,child=child.GetString(),action=Scalar(f,"action"),eventType=type});
                }
            }
            Require(!f.ContainsKey("epcisRelationships"),"The event conflicts with this EPCIS profile's field names.");
            f["epcisRelationships"]=Val(rels);row.Lineage["epcisRelationships"]=row.Location+"[parentID,childEPCs,action]";
        }
    }
    private static void EpcisXml(XElement element, SourceReaderRow row)
    {
        string type=element.Name.LocalName;row.Fields["epcisEventType"]=Val(type);row.Lineage["epcisEventType"]=XmlLocation(element);
        var rels=new List<object>();
        XNamespace eventNs=element.Name.Namespace;
        string? parent=element.Element(eventNs+"parentID")?.Value;
        if(type is "AggregationEvent" or "AssociationEvent" && parent!=null)
            foreach(var child in element.Element(eventNs+"childEPCs")?.Elements(eventNs+"epc")??[])
                rels.Add(new{parent,child=child.Value,action=element.Element(eventNs+"action")?.Value,eventType=type});
        row.Fields["epcisRelationships"]=Val(rels);row.Lineage["epcisRelationships"]=row.Location+"/parentID,childEPCs/epc,action";
    }
}

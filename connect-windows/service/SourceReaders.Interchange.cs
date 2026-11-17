using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace PackProof.Connect;

public static partial class SourceReaders
{
    // Mappings are scoped to the document role. A purchase order is not an ERP sales-order alias.
    private static readonly IReadOnlyDictionary<string,(string Group,string Title,string Segment,int Field)> X12Documents =
        new Dictionary<string,(string,string,string,int)> {
            ["850"]=("PO","purchase_order","BEG",3),
            ["855"]=("PR","purchase_order_response","BAK",3),
            ["860"]=("PC","purchase_order_change","BCH",3),
            ["865"]=("CA","purchase_order_change_response","BCA",3),
            ["940"]=("OW","warehouse_shipping_order","W05",2),
            ["945"]=("SW","warehouse_shipping_advice","W06",4),
            ["943"]=("AR","stock_transfer_shipment","W06",4),
            ["944"]=("RE","stock_transfer_receipt","W17",3),
            ["856"]=("SH","shipment_notice","BSN",2),
            ["846"]=("IB","inventory_advice","BIA",3),
            ["947"]=("AW","inventory_adjustment","W15",2),
            ["204"]=("SM","load_tender","B2",4),
            ["990"]=("GF","load_tender_response","B1",2),
            ["214"]=("QM","transport_status","B10",2),
            ["210"]=("IM","freight_invoice","B3",2),
            ["997"]=("FA","functional_acknowledgment","AK1",2),
            ["999"]=("FA","implementation_acknowledgment","AK1",2)
        };
    private static readonly IReadOnlyDictionary<string,string> EdifactDocuments = new Dictionary<string,string> {
        ["ORDERS"]="purchase_order",
        ["ORDRSP"]="purchase_order_response",
        ["ORDCHG"]="purchase_order_change",
        ["DESADV"]="despatch_advice",
        ["RECADV"]="receiving_advice",
        ["INVRPT"]="inventory_report",
        ["IFTMIN"]="transport_instruction",
        ["IFTSTA"]="transport_status",
        ["INVOIC"]="invoice",
        ["CONTRL"]="syntax_acknowledgment"
    };
    private static void ReadEdi(string input,List<SourceReaderRow> rows,List<string> issues,ref string state)
    {
        string text=input.TrimStart('\r','\n',' ','\t');
        if(text.StartsWith("ISA",StringComparison.Ordinal))ReadX12(text,rows,issues);
        else if(text.StartsWith("UNA",StringComparison.Ordinal)||text.StartsWith("UNB",StringComparison.Ordinal))ReadEdifact(text,rows,issues);
        else {state="unsupported";issues.Add("No supported X12 or EDIFACT interchange envelope was found.");}
    }
    private static void ReadX12(string text,List<SourceReaderRow> rows,List<string> issues)
    {
        Require(text.Length>=106 && text[103]==text[3],"The X12 interchange header is incomplete.");
        char element=text[3],term=text[105]; Require(element!=term,"The X12 separators are inconsistent.");
        Require(text.Count(c=>c==term)<=12000,"The interchange exceeds the segment limit.");
        string[][] segments=text.Split(term,StringSplitOptions.RemoveEmptyEntries|StringSplitOptions.TrimEntries)
            .Select(segment=>{Require(segment.Count(c=>c==element)<=128,"An X12 segment exceeds its element limit.");return segment.Split(element);}).ToArray();
        Require(segments.Length is >=6 and <=12000 && segments[0].Length==17 && segments[^1][0]=="IEA","The X12 interchange is incomplete.");
        int groups=0,groupDocs=0,start=-1;string? group=null,groupType=null,release=null,type=null,control=null;
        for(int i=0;i<segments.Length;i++)
        {
            var s=segments[i];string V(int k)=>s.ElementAtOrDefault(k)??"";
            switch(s[0])
            {
                case "ISA":Require(i==0,"Use one interchange per bounded input.");break;
                case "GS":Require(group==null&&s.Length>=9,"The X12 group is incomplete.");groups++;groupDocs=0;group=V(6);groupType=V(1);release=V(8);break;
                case "ST":Require(group!=null&&start<0&&s.Length>=3,"The X12 transaction header is incomplete.");groupDocs++;start=i;type=V(1);control=V(2);break;
                case "SE":
                    Require(start>=0 && V(2)==control && int.TryParse(V(1),out int count)&&count==i-start+1,"The X12 transaction trailer does not match its header.");
                    var transaction=segments[start..(i+1)];var values=new Dictionary<string,System.Text.Json.JsonElement>{
                        ["transaction"]=Val(type),["release"]=Val(release),["control"]=Val(control),["segments"]=Val(transaction)};
                    bool supportedRelease=type=="999"?release is "005010" or "005010X231" or "005010X231A1":release=="004010";
                    if(supportedRelease && X12Documents.TryGetValue(type!,out var selected) && selected.Group==groupType)
                    {
                        var header=transaction.FirstOrDefault(r=>r[0]==selected.Segment);var reference=header?.ElementAtOrDefault(selected.Field);
                        Require(!string.IsNullOrWhiteSpace(reference),"A supported X12 document is missing its document reference.");
                        values["documentType"]=Val(selected.Title);values["documentReference"]=Val(reference);
                        values["claims"]=Val(X12Claims(type!,transaction,start));
                    }
                    else issues.Add("The transaction was parsed. Its guide and business mapping require qualification.");
                    Add(rows,Row($"X12/GS[{groups}]/ST[{groupDocs}]",values,k=>k=="documentReference"&&X12Documents.TryGetValue(type!,out var p)
                        ?$"segment {start+Array.FindIndex(transaction,r=>r[0]==p.Segment)+1}/element {p.Field}":$"segments {start+1}-{i+1}/{k}"));
                    start=-1;break;
                case "GE":Require(start<0&&group!=null&&V(2)==group&&V(1)==groupDocs.ToString(CultureInfo.InvariantCulture),"The X12 group trailer does not match.");group=null;break;
                case "IEA":Require(i==segments.Length-1&&group==null&&V(2)==segments[0][13]&&V(1)==groups.ToString(CultureInfo.InvariantCulture),"The X12 interchange trailer does not match.");break;
            }
        }
        Require(rows.Count>0,"The X12 interchange contains no complete transactions.");
    }
    private static void ReadEdifact(string text,List<SourceReaderRow> rows,List<string> issues)
    {
        char component=':',element='+',release='?',term='\'';
        if(text.StartsWith("UNA",StringComparison.Ordinal))
        {
            Require(text.Length>=9,"The EDIFACT service string is incomplete.");
            component=text[3];element=text[4];release=text[6];term=text[8];text=text[9..];
        }
        Require(new[]{component,element,release,term}.Distinct().Count()==4,"The EDIFACT separators conflict.");
        var segments=SplitReleased(text,term,release).Select(s=>s.Trim()).Where(s=>s!="").Select(s=>SplitReleased(s,element,release)).ToArray();
        Require(segments.Length is >=4 and <=12000&&segments[0][0]=="UNB"&&segments[^1][0]=="UNZ","The EDIFACT interchange is incomplete.");
        int start=-1,messages=0;string? control=null;string[]? id=null;
        for(int i=1;i<segments.Length-1;i++)
        {
            var s=segments[i];
            if(s[0]=="UNH"){Require(start<0&&s.Length>=3,"The EDIFACT message header is incomplete.");start=i;control=s[1];id=SplitReleased(s[2],component,release);messages++;}
            else if(s[0]=="UNT")
            {
                Require(start>=0&&s.Length>=3&&s[2]==control&&int.TryParse(s[1],out var count)&&count==i-start+1,"The EDIFACT message trailer does not match.");
                var msg=segments[start..(i+1)];var fields=new Dictionary<string,System.Text.Json.JsonElement>{
                    ["message"]=Val(id![0]),["directory"]=Val(string.Join(":",id.Skip(1))),["control"]=Val(control),["segments"]=Val(msg)};
                bool mapped=id.Length>=4&&id[1]=="D"&&id[2]=="02B"&&id[3]=="UN";
                if(mapped&&EdifactDocuments.TryGetValue(id[0],out var kind))
                {
                    fields["documentType"]=Val(kind);fields["claims"]=Val(EdifactClaims(msg,start,component,release));
                    var tagged=msg.FirstOrDefault(seg=>seg[0]==(id[0]=="CONTRL"?"UCI":"BGM"));
                    var refField=tagged?.ElementAtOrDefault(id[0]=="CONTRL"?1:2);
                    if(refField!=null)fields["documentReference"]=Val(Unescape(SplitReleased(refField,component,release)[0],release));
                }
                else issues.Add("The message was parsed. Its directory and trading-partner mapping require qualification.");
                Add(rows,Row($"EDIFACT/UNH[{messages}]",fields,k=>$"segments {start+1}-{i+1}/{k}"));start=-1;
            }
        }
        Require(start<0&&messages>0&&segments[0].Length>5&&segments[^1].Length>2&&segments[^1][2]==segments[0][5]
            &&segments[^1][1]==messages.ToString(CultureInfo.InvariantCulture),"The EDIFACT interchange trailer does not match.");
    }
    private static string[] SplitReleased(string text,char separator,char release)
    {
        var parts=new List<string>();var current=new StringBuilder();bool escaped=false;
        foreach(char c in text)
        {
            if(escaped){current.Append(release).Append(c);escaped=false;}
            else if(c==release)escaped=true;
            else if(c==separator){parts.Add(current.ToString());current.Clear();Require(parts.Count<12000,"The interchange exceeds the segment limit.");}
            else current.Append(c);
        }
        Require(!escaped,"The interchange ends with an incomplete escape.");
        parts.Add(current.ToString());return parts.ToArray();
    }
    private static string Unescape(string text,char release)
    {
        var result=new StringBuilder();for(var i=0;i<text.Length;i++){if(text[i]==release&&i+1<text.Length)i++;result.Append(text[i]);}return result.ToString();
    }
    private static void ReadLabel(string text,List<SourceReaderRow> rows,List<string> issues,ref string state)
    {
        text=text.Trim();if(!text.StartsWith("^XA",StringComparison.Ordinal)){state="unsupported";issues.Add("No supported ZPL label header was found.");return;}
        Require(text.EndsWith("^XZ",StringComparison.Ordinal),"The ZPL label is incomplete.");
        var commands=Regex.Matches(text,@"(?<prefix>[\^~])(?<cmd>[A-Z0-9]{2})(?<data>[^\^~]*)",RegexOptions.CultureInvariant,TimeSpan.FromSeconds(1));
        string? barcode=null;int label=0;
        foreach(Match command in commands)
        {
            var cmd=command.Groups["cmd"].Value;var data=command.Groups["data"].Value;
            if(cmd=="XA")label++;
            if(cmd is "CC" or "CT" or "CD" or "FH"){rows.Clear();state="recognized";issues.Add("This label uses a custom command or field encoding. Its original is retained.");return;}
            if(cmd is "BC" or "B3" or "B8" or "BE" or "BQ" or "BX"){barcode=cmd;continue;}
            if(cmd=="FD")
            {
                Require(data.Length<=MaxCell,"The label field exceeds the size limit.");
                var fields=new Dictionary<string,System.Text.Json.JsonElement>{["fieldData"]=Val(data)};
                if(barcode!=null)fields.Add("barcodeCommand",Val(barcode));
                Add(rows,Row($"label {label}/offset {command.Index}",fields,k=>$"label {label}/offset {command.Index}/{k}"));
            }
            if(cmd is "FS" or "XZ")barcode=null;
        }
        if(rows.Count==0){state="recognized";issues.Add("This label has no supported text or barcode fields.");}
    }
}

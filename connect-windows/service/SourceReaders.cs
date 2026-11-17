using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;

namespace PackProof.Connect;

public sealed record FixedField(string Name, int Start, int Length);
public sealed record FixedRecord(string Prefix, FixedField[] Fields);
public sealed record SourceReaderProfile(
    string? EncodingName = null, char? Delimiter = null, int SkipRows = 0,
    FixedRecord[]? Layout = null, string? RecordElement = null, string? XmlNamespace = null,
    string? JsonCollection = null, string? Sheet = null, string? EmbeddedFormat = null,
    Dictionary<string,string>? Mapping = null, string? Table = null);
public sealed record SourceReaderRow(string Location, Dictionary<string,JsonElement> Fields, Dictionary<string,string> Lineage);
public sealed record SourceReadResult(string Format, string ReaderVersion, string State, string[] Headers,
    IReadOnlyList<SourceReaderRow> Rows, string[] Issues, string ContentSha256, long? CompleteOffset = null);

public static partial class SourceReaders
{
    public const string Version = "packproof.readers/1";
    public const string ProfileId = "packproof.explicit-order-journey/v1";
    public const int MaxBytes = 8 * 1024 * 1024;
    internal const int MaxRows = 2000, MaxFields = 128, MaxCell = 32768;
    internal static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidDataException(message);
    }
    internal static JsonElement Val<T>(T value) => JsonSerializer.SerializeToElement(value);
    internal static SourceReaderRow Row(string location, Dictionary<string,JsonElement> fields, Func<string,string> locator)
    {
        Require(fields.Count <= MaxFields, "The record exceeds the supported field limit.");
        Require(fields.Keys.All(k=>k.Length is >0 and <=256), "A field name is blank or too long.");
        return new(location, fields, fields.Keys.ToDictionary(k=>k,locator,StringComparer.Ordinal));
    }
    internal static void Add(List<SourceReaderRow> rows, SourceReaderRow row)
    {
        Require(rows.Count < MaxRows, "The file exceeds the bounded record limit. Split the report or use an incremental connection.");
        rows.Add(row);
    }
    internal static string Decode(byte[] bytes, string? encoding)
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        var strict = encoding == null ? new UTF8Encoding(false,true) :
            Encoding.GetEncoding(encoding,EncoderFallback.ExceptionFallback,DecoderFallback.ExceptionFallback);
        if(bytes.AsSpan().StartsWith(new byte[]{0xef,0xbb,0xbf})) return new UTF8Encoding(false,true).GetString(bytes,3,bytes.Length-3);
        if(bytes.AsSpan().StartsWith(new byte[]{0xff,0xfe})) return new UnicodeEncoding(false,true,true).GetString(bytes,2,bytes.Length-2);
        if(bytes.AsSpan().StartsWith(new byte[]{0xfe,0xff})) return new UnicodeEncoding(true,true,true).GetString(bytes,2,bytes.Length-2);
        return strict.GetString(bytes);
    }
    public static SourceReadResult Read(string fileName, byte[] bytes, SourceReaderProfile? profile = null)
    {
        var format = Path.GetExtension(fileName).TrimStart('.').ToLowerInvariant();
        var digest = Convert.ToHexStringLower(SHA256.HashData(bytes));
        var rows = new List<SourceReaderRow>();
        var issues = new List<string>();
        var state = "parsed"; long? offset = null;
        profile ??= new();
        try
        {
            Require(bytes.Length <= MaxBytes, "The file exceeds the bounded reader size. Keep the original and select a smaller report.");
            Require(profile.SkipRows is >=0 and <=100, "The approved preamble exceeds the reader limit.");
            if(bytes.Length==0) return new(format,Version,"incomplete",[],[],["Waiting for the first complete report."],digest,0);
            switch(format)
            {
                case "csv": case "tsv": case "psv":
                    ReadDelimited(Decode(bytes,profile.EncodingName),profile,format,rows); break;
                case "txt": case "fixed": case "fw":
                    if (profile.Layout is not null) ReadFixed(Decode(bytes,profile.EncodingName),profile.Layout,rows);
                    else if(profile.Delimiter.HasValue) ReadDelimited(Decode(bytes,profile.EncodingName),profile,format,rows);
                    else {state="ambiguous"; issues.Add("Choose this source's text layout to interpret its records.");} break;
                case "json": case "jsonld":
                    ReadJson(Decode(bytes,profile.EncodingName),profile,"$",rows); break;
                case "jsonl": case "ndjson":
                    Require(profile.EncodingName is null or "utf-8", "The append reader requires UTF-8.");
                    var start=0;
                    for(var i=0;i<bytes.Length;i++) if(bytes[i]==10)
                    {
                        string line=Decode(bytes[start..i],null);
                        if(!string.IsNullOrWhiteSpace(line)) ReadJson(line,profile,$"byte[{start},{i+1})",rows);
                        start=i+1;
                    }
                    offset=start;
                    if(start!=bytes.Length){issues.Add("A final line has not been published with a newline yet."); if(rows.Count==0)state="incomplete";}
                    break;
                case "xml": case "soap": ReadXml(bytes,profile,rows); break;
                case "zip": case "gz": case "gzip": ReadArchive(fileName,bytes,profile,rows,issues); if(issues.Count>0)state="ambiguous"; break;
                case "docx": ReadWordDocument(bytes,rows); break;
                case "xlsx": case "xlsm": ReadOpenWorkbook(bytes,profile,rows); break;
                case "xls": ReadWorkbook(bytes,format,profile,rows,issues); break;
                case "edi": case "x12": case "edifact": ReadEdi(Decode(bytes,profile.EncodingName),rows,issues,ref state); break;
                case "prn": case "zpl": ReadLabel(Decode(bytes,profile.EncodingName),rows,issues,ref state); break;
                case "pdf": case "jpg": case "jpeg": case "png": case "tif": case "tiff": case "webp": case "heic": case "mp4": case "mov":
                    state=InspectDocument(bytes,format,rows,issues); break;
                default: state="unsupported"; issues.Add("No approved reader is available for this file type."); break;
            }
            if(profile.Mapping is not null && state=="parsed") ApplyMapping(rows,profile.Mapping);
        }
        catch(Exception e) when(e is InvalidDataException or IOException or FormatException or XmlException or JsonException or ArgumentException or OverflowException or NotSupportedException)
        {
            rows.Clear(); offset=null; state="invalid";
            issues.Clear();
            // Raw parser exceptions can include source text or local paths.
            issues.Add(e is InvalidDataException ? e.Message : "The file could not be read with the selected format and encoding. Check that the report is complete.");
        }
        return new(format,Version,state,rows.SelectMany(r=>r.Fields.Keys).Distinct(StringComparer.Ordinal).ToArray(),rows,issues.ToArray(),digest,offset);
    }

    private static void ApplyMapping(List<SourceReaderRow> rows, Dictionary<string,string> mapping)
    {
        Require(mapping.Count is >0 and <=MaxFields && mapping.Values.Distinct().Count()==mapping.Count, "Review the approved field mapping.");
        foreach(var row in rows)
        {
            var values=new Dictionary<string,(JsonElement value,string lineage)>();
            foreach(var (destination,source) in mapping)
            {
                Require(row.Fields.ContainsKey(source),"A mapped field is missing. Review the source profile.");
                Require(destination==source || !row.Fields.ContainsKey(destination),"Two source fields would have the same interpretation.");
                values.Add(destination,(row.Fields[source],row.Lineage[source]));
            }
            foreach(var (key,pair) in values){row.Fields[key]=pair.value; row.Lineage[key]=pair.lineage;}
        }
    }
    private static void ReadDelimited(string text, SourceReaderProfile profile,string format,List<SourceReaderRow> rows)
    {
        char separator=profile.Delimiter ?? (format=="tsv"?'\t':format=="psv"?'|':DetectDelimiter(text,profile.SkipRows));
        Require(",;\t|".Contains(separator),"Choose a supported column separator.");
        string[]? headers=null; int record=0,startLine=1,line=1;
        var fields=new List<string>(); var value=new StringBuilder(); bool quoted=false,closed=false;
        for(int i=0;i<=text.Length;i++)
        {
            bool eof=i==text.Length; char c=eof?'\0':text[i];
            if(eof && i>0 && (text[i-1]=='\n'||text[i-1]=='\r') && fields.Count==0 && value.Length==0 && !quoted)break;
            if(quoted)
            {
                Require(!eof,"A quoted field has not been closed. Wait for the completed export.");
                if(c=='"'){if(i+1<text.Length&&text[i+1]=='"'){value.Append('"');i++;}else{quoted=false;closed=true;}}
                else {value.Append(c);if(c=='\n')line++;}
            }
            else if(eof||c=='\r'||c=='\n'||c==separator)
            {
                Require(fields.Count<MaxFields,"A row exceeds the supported field limit.");
                fields.Add(value.ToString()); value.Clear(); closed=false;
                if(c==separator&&!eof)continue;
                if(c=='\r'&&i+1<text.Length&&text[i+1]=='\n')i++;
                if(record++>=profile.SkipRows && !(fields.Count==1&&fields[0].Length==0))
                {
                    if(headers==null){headers=fields.ToArray();ValidateHeaders(headers);}
                    else
                    {
                        Require(fields.Count==headers.Length,"A row differs from the approved column layout. Wait for completion or review the profile.");
                        var data=headers.Select((h,k)=>(h,v:Val(fields[k]))).ToDictionary(p=>p.h,p=>p.v,StringComparer.Ordinal);
                        Add(rows,Row($"line {startLine}",data,k=>$"line {startLine}/column {Array.IndexOf(headers,k)+1}"));
                    }
                }
                fields.Clear();startLine=++line;
            }
            else
            {
                Require(!closed,"Unexpected text follows a quoted field.");
                if(c=='"'){Require(value.Length==0,"An unquoted field contains a quote.");quoted=true;}else value.Append(c);
            }
            Require(value.Length<=MaxCell,"A field exceeds the supported size.");
        }
        Require(headers is not null,"The report does not include a header.");
    }
    private static char DetectDelimiter(string text,int skip)
    {
        using var lines=new StringReader(text);
        for(var i=0;i<skip;i++)lines.ReadLine();
        var header=lines.ReadLine()??"";
        var counts=",;\t|".ToDictionary(c=>c,c=>0); bool quoted=false;
        foreach(char c in header) if(c=='"')quoted=!quoted; else if(!quoted&&counts.ContainsKey(c))counts[c]++;
        int max=counts.Values.Max();
        if(max==0)return ',';
        Require(counts.Values.Count(v=>v==max)==1,"More than one separator fits this header. Choose the source layout.");
        return counts.First(p=>p.Value==max).Key;
    }
    internal static void ValidateHeaders(string[] headers)
    {
        Require(headers.Length is >0 and <=MaxFields && headers.All(k=>!string.IsNullOrWhiteSpace(k)&&k.Length<=256)
            && headers.Distinct(StringComparer.Ordinal).Count()==headers.Length,"The report has blank, duplicate or oversized column names. Choose its header row.");
    }
    private static void ReadFixed(string text,FixedRecord[] layouts,List<SourceReaderRow> rows)
    {
        Require(layouts.Length is >0 and <=32,"Choose a versioned fixed-width record layout.");
        foreach(var layout in layouts)
        {
            ValidateHeaders(layout.Fields.Select(f=>f.Name).ToArray());
            Require(layout.Fields.All(f=>f.Start>=0 && f.Length is >0 and <=MaxCell && f.Start <= MaxCell-f.Length),"A fixed-width field has invalid positions.");
        }
        using var reader=new StringReader(text);string? line;int n=0;
        while((line=reader.ReadLine())!=null)
        {
            n++;var matches=layouts.Where(x=>line.StartsWith(x.Prefix,StringComparison.Ordinal)).ToArray();
            Require(matches.Length==1,"A line does not match exactly one approved record type.");
            var fields=matches[0].Fields;Require(fields.All(f=>line.Length>=f.Start+f.Length),"A fixed-width record ended early.");
            Add(rows,Row($"line {n}",fields.ToDictionary(f=>f.Name,f=>Val(line.Substring(f.Start,f.Length))),
                k=>{var f=fields.Single(v=>v.Name==k);return $"line {n}/characters {f.Start+1}-{f.Start+f.Length}";}));
        }
    }
    private static void ReadJson(string text,SourceReaderProfile profile,string location,List<SourceReaderRow> rows)
    {
        using var document=JsonDocument.Parse(text,new(){MaxDepth=48});
        var root=document.RootElement;
        ValidateJson(root);
        string? collection=profile.JsonCollection;
        if(root.ValueKind==JsonValueKind.Object && root.TryGetProperty("epcisBody",out var body) && body.ValueKind==JsonValueKind.Object && body.TryGetProperty("eventList",out var list))
        {root=list;location+=".epcisBody.eventList";}
        else if(collection is not null || root.ValueKind==JsonValueKind.Object && root.TryGetProperty("records",out _))
        {
            collection??="records";Require(root.ValueKind==JsonValueKind.Object&&root.TryGetProperty(collection,out _),"The approved JSON collection is missing.");
            root=root.GetProperty(collection);location+="["+JsonSerializer.Serialize(collection)+"]";
        }
        void Emit(JsonElement element,string path)
        {
            Require(element.ValueKind==JsonValueKind.Object,"The approved collection must contain records.");
            var fields=element.EnumerateObject().ToDictionary(p=>p.Name,p=>p.Value.Clone(),StringComparer.Ordinal);
            Add(rows,Row(path,fields,k=>path+"["+JsonSerializer.Serialize(k)+"]"));
        }
        if(root.ValueKind==JsonValueKind.Array){int n=0;foreach(var e in root.EnumerateArray())Emit(e,$"{location}[{n++}]");}
        else Emit(root,location);
    }
    private static void ValidateJson(JsonElement value)
    {
        if(value.ValueKind==JsonValueKind.Object)
        {
            var keys=new HashSet<string>(StringComparer.Ordinal);
            foreach(var p in value.EnumerateObject()){Require(keys.Count<MaxFields&&keys.Add(p.Name),"Duplicate or excessive JSON fields require source review.");ValidateJson(p.Value);}
        }
        else if(value.ValueKind==JsonValueKind.Array)
        {
            Require(value.GetArrayLength()<=MaxRows,"A nested array exceeds the bounded record limit.");
            foreach(var item in value.EnumerateArray())ValidateJson(item);
        }
        else if(value.ValueKind==JsonValueKind.String)Require(value.GetString()!.Length<=MaxCell,"A JSON value exceeds the supported size.");
    }
    internal static XDocument LoadXml(Stream stream)
    {
        using var reader=XmlReader.Create(stream,new(){DtdProcessing=DtdProcessing.Prohibit,XmlResolver=null,MaxCharactersInDocument=MaxBytes,MaxCharactersFromEntities=0});
        var doc=XDocument.Load(reader,LoadOptions.SetLineInfo);
        Require(doc.Root is not null && !doc.Descendants().Any(e=>e.Ancestors().Take(49).Count()>48),"The XML report exceeds the supported nesting depth.");
        return doc;
    }
    private static void ReadXml(byte[] bytes,SourceReaderProfile profile,List<SourceReaderRow> rows)
    {
        using var stream=new MemoryStream(bytes,false);var root=LoadXml(stream).Root!;
        var body=root.Name.LocalName=="Envelope" && root.Name.NamespaceName is "http://schemas.xmlsoap.org/soap/envelope/" or "http://www.w3.org/2003/05/soap-envelope"
            ?root.Element(root.Name.Namespace+"Body")??throw new InvalidDataException("The SOAP envelope has no body."):root;
        var selection=body.DescendantsAndSelf().Where(e=>profile.RecordElement!=null
            ?e.Name.LocalName==profile.RecordElement && (profile.XmlNamespace==null || e.Name.NamespaceName==profile.XmlNamespace)
            :e.Name.LocalName is "record" or "ObjectEvent" or "AggregationEvent" or "TransactionEvent" or "TransformationEvent" or "AssociationEvent").Take(MaxRows+1).ToArray();
        if(selection.Length==0 && profile.RecordElement==null)selection=[body];
        Require(selection.Length is >0 and <=MaxRows,"The approved XML record element is missing or exceeds the record limit.");
        foreach(var e in selection)
        {
            string location=XmlLocation(e);
            if(profile.EmbeddedFormat!=null)
            {
                Require(!e.HasElements,"The approved embedded value must be a text field.");
                int initial=rows.Count;
                if(profile.EmbeddedFormat=="json")ReadJson(e.Value,profile,location+"/embedded",rows);
                else if(profile.EmbeddedFormat=="csv")
                {
                    var embedded=new List<SourceReaderRow>();ReadDelimited(e.Value,profile,"csv",embedded);
                    foreach(var inner in embedded)Add(rows,new(location+"/"+inner.Location,inner.Fields,inner.Lineage.ToDictionary(k=>k.Key,k=>location+"/"+k.Value)));
                }
                else throw new InvalidDataException("The embedded format is not supported.");
                Require(rows.Count>=initial,"The embedded record is incomplete.");continue;
            }
            var obj=XmlFields(e);
            Add(rows,Row(location,obj,k=>location+"/"+k));
        }
    }
    private static Dictionary<string,JsonElement> XmlFields(XElement element)
    {
        var fields=new Dictionary<string,JsonElement>(StringComparer.Ordinal);
        foreach(var a in element.Attributes().Where(a=>!a.IsNamespaceDeclaration))fields.Add("@"+a.Name,Val(a.Value));
        foreach(var group in element.Elements().GroupBy(e=>e.Name))
        {
            string k=group.Key.Namespace==element.Name.Namespace?group.Key.LocalName:group.Key.ToString();
            var items=group.Select(e=>e.HasElements||e.Attributes().Any(a=>!a.IsNamespaceDeclaration)?Val(XmlFields(e)):Val(e.Value)).ToArray();
            fields.Add(k,items.Length==1?items[0]:Val(items));
        }
        Require(fields.Count<=MaxFields,"An XML element exceeds the field limit.");return fields;
    }
    private static string XmlLocation(XElement e)=>string.Join("/",e.AncestorsAndSelf().Reverse().Select(n=>
        n.Name+"["+(((IXmlLineInfo)n).LineNumber)+":"+(((IXmlLineInfo)n).LinePosition)+"]"));
}

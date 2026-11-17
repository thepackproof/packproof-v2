using System.Globalization;
using System.IO.Compression;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace PackProof.Connect;

public static partial class SourceReaders
{
    private static readonly XNamespace Spreadsheet="http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    private static readonly XNamespace OfficeRelations="http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    // Read raw XML cell values. Passing a large numeric identifier through a floating-point worksheet API loses digits.
    private static void ReadOpenWorkbook(byte[] bytes,SourceReaderProfile profile,List<SourceReaderRow> rows)
    {
        using var stream=new MemoryStream(bytes,false);
        using var zip=new ZipArchive(stream,ZipArchiveMode.Read);
        Require(zip.Entries.Count is >0 and <=256&&zip.Entries.Sum(p=>p.Length)<=3L*MaxBytes &&
            zip.Entries.All(p=>p.Length<=MaxBytes&&p.Length<=Math.Max(65536,150L*p.CompressedLength)) &&
            zip.Entries.Select(p=>p.FullName).Distinct(StringComparer.Ordinal).Count()==zip.Entries.Count,
            "The workbook package exceeds its supported bounds or repeats a part.");
        XDocument Part(string name)
        {
            var item=zip.GetEntry(name)??throw new InvalidDataException("The workbook refers to a missing worksheet part.");
            using var part=item.Open();return LoadXml(part);
        }
        Dictionary<string,string> Relationships(string parent)
        {
            var dir=parent[..(parent.LastIndexOf('/')+1)];
            var rels=dir+"_rels/"+parent[(parent.LastIndexOf('/')+1)..]+".rels";
            if(zip.GetEntry(rels)==null)return [];
            var result=new Dictionary<string,string>();
            foreach(var rel in Part(rels).Root!.Elements().Where(r=>(string?)r.Attribute("TargetMode")!="External"))
            {
                string target=(string?)rel.Attribute("Target")??"";
                Require(!target.Contains('\\')&&!target.Contains(':')&&!target.Contains('%')&&!target.Contains('?')&&!target.Contains('#'),"A workbook has an invalid internal part.");
                var resolved=new Uri(new Uri("https://package.invalid/"+parent),target);
                Require(resolved.Host=="package.invalid","A worksheet cannot load external parts.");
                result.Add((string)rel.Attribute("Id")!,resolved.AbsolutePath.TrimStart('/'));
            }
            return result;
        }
        const string bookPath="xl/workbook.xml";var book=Part(bookPath);var rel=Relationships(bookPath);
        var sheetList=book.Root!.Element(Spreadsheet+"sheets")?.Elements(Spreadsheet+"sheet").ToArray()??[];
        Require(sheetList.Length is >0 and <=32,"The workbook must contain a bounded collection of sheets.");
        bool epoch1904=(string?)book.Root.Element(Spreadsheet+"workbookPr")?.Attribute("date1904") is "1" or "true";
        var shared=zip.GetEntry("xl/sharedStrings.xml")==null?[]:Part("xl/sharedStrings.xml").Root!.Elements(Spreadsheet+"si")
            .Select(si=>string.Concat(si.Descendants(Spreadsheet+"t").Select(t=>t.Value))).ToArray();
        var styles=zip.GetEntry("xl/styles.xml")==null?null:Part("xl/styles.xml").Root;
        var stylesIds=styles?.Element(Spreadsheet+"cellXfs")?.Elements(Spreadsheet+"xf").Select(x=>(int?)x.Attribute("numFmtId")??0).ToArray()??[];
        var custom=styles?.Element(Spreadsheet+"numFmts")?.Elements(Spreadsheet+"numFmt").ToDictionary(e=>(int)e.Attribute("numFmtId")!,e=>(string)e.Attribute("formatCode")!)??[];
        bool seen=false;
        foreach(var s in sheetList)
        {
            var name=(string)s.Attribute("name")!;
            if(profile.Sheet!=null && name!=profile.Sheet)continue;
            var rid=(string?)s.Attribute(OfficeRelations+"id");
            Require(rid!=null&&rel.ContainsKey(rid),"The workbook has an unresolved worksheet.");
            string partName=rel[rid!];var root=Part(partName).Root!;
            int firstCol=0,lastCol=MaxFields-1,firstRow=1+profile.SkipRows,lastRow=int.MaxValue;
            if(profile.Table!=null)
            {
                var rels=Relationships(partName);
                var tables=root.Descendants(Spreadsheet+"tablePart").Select(t=>(string)t.Attribute(OfficeRelations+"id")!)
                    .Where(rels.ContainsKey).Select(id=>Part(rels[id]).Root!).Where(t=>(string?)t.Attribute("name")==profile.Table || (string?)t.Attribute("displayName")==profile.Table).ToArray();
                if(tables.Length==0)continue;
                Require(tables.Length==1,"More than one matching table was found.");
                var range=((string?)tables[0].Attribute("ref")??"").Split(':');
                Require(range.Length==2,"The table range is missing.");(firstCol,firstRow)=CellReference(range[0]);(lastCol,lastRow)=CellReference(range[1]);
                lastRow-=(int?)tables[0].Attribute("totalsRowCount")??0;
                Require((int?)tables[0].Attribute("headerRowCount")!=0,"The approved table needs a header row.");
            }
            seen=true;
            var header=new Dictionary<int,string>();int rowSequence=0;
            foreach(var row in root.Element(Spreadsheet+"sheetData")?.Elements(Spreadsheet+"row")??[])
            {
                int n=(int?)row.Attribute("r")??rowSequence+1;Require(n>rowSequence,"Worksheet rows are out of order.");rowSequence=n;
                if(n<firstRow||n>lastRow)continue;
                Require(n<=firstRow+MaxRows,"The worksheet exceeds its bounded row limit.");
                var cells=new Dictionary<int,JsonElement>();int previous=-1;
                foreach(var cell in row.Elements(Spreadsheet+"c"))
                {
                    var addr=(string?)cell.Attribute("r");
                    var (col,r)=addr==null?(previous+1,n):CellReference(addr);
                    Require(r==n && col>previous,"Worksheet cells are duplicated or out of order.");previous=col;
                    if(col<firstCol||col>lastCol){Require(profile.Table!=null,"The worksheet exceeds the supported column limit.");continue;}
                    var v=cell.Element(Spreadsheet+"v")?.Value;
                    string type=(string?)cell.Attribute("t")??"n";
                    int style=(int?)cell.Attribute("s")??0;
                    int fmt=style>=0&&style<stylesIds.Length?stylesIds[style]:0;
                    JsonElement value=type switch {
                        "s"=>Val(int.TryParse(v,out int idx)&&idx>=0&&idx<shared.Length?shared[idx]:throw new InvalidDataException("A workbook string reference is missing.")),
                        "inlineStr"=>Val(string.Concat(cell.Descendants(Spreadsheet+"t").Select(t=>t.Value))),
                        "b"=>Val(v switch{"1"=>true,"0"=>false,_=>throw new InvalidDataException("A Boolean cell is malformed.")}),
                        "e"=>Val(new{error=v}),"n"=>Val(WorkbookNumber(v,fmt,custom.GetValueOrDefault(fmt),epoch1904)),
                        "d" or "str"=>Val(v),_=>throw new InvalidDataException("The workbook uses an unknown cell type.")};
                    if(cell.Element(Spreadsheet+"f") is {} formula)value=Val(new{formula=formula.Value,cached=value});
                    cells.Add(col,value);
                }
                if(cells.Count==0)continue;
                if(header.Count==0)
                {
                    header=cells.ToDictionary(p=>p.Key,p=>p.Value.ValueKind==JsonValueKind.String?p.Value.GetString()!:"");
                    ValidateHeaders(header.Values.ToArray());continue;
                }
                Require(cells.Keys.All(header.ContainsKey),"The worksheet contains cells without matching headings.");
                Add(rows,Row($"{name}!row {n}",cells.ToDictionary(p=>header[p.Key],p=>p.Value),
                    k=>$"{partName}/R{n}C{header.Single(p=>p.Value==k).Key+1}"));
            }
        }
        Require(seen, "The approved worksheet or table is missing.");
    }
    private static (int,int) CellReference(string text)
    {
        var m=Regex.Match(text,@"^([A-Z]{1,3})([1-9]\d{0,6})$");
        Require(m.Success,"A workbook cell has an invalid location.");
        int col=0;foreach(var c in m.Groups[1].Value)col=col*26+c-'A'+1;
        return(col-1,int.Parse(m.Groups[2].Value,CultureInfo.InvariantCulture));
    }
    private static string? WorkbookNumber(string? raw,int formatId,string? format,bool epoch1904)
    {
        if(raw==null)return null;
        if(format is not null && Regex.IsMatch(format,@"^0{2,32}$") && Regex.IsMatch(raw,@"^\d+$"))return raw.PadLeft(format.Length,'0');
        bool date=formatId is >=14 and <=22 or >=45 and <=47 || format!=null&&Regex.IsMatch(format,@"(?i)(y{2,4}|d{2,4})");
        if(!date)return raw;
        Require(double.TryParse(raw,NumberStyles.Float,CultureInfo.InvariantCulture,out var serial)&&double.IsFinite(serial),"An Excel date cell is invalid.");
        // Excel's fictitious 1900 leap day has no unambiguous Gregorian timestamp.
        Require(epoch1904 || serial<60 || serial>=61,"The Excel 1900 leap-day value needs source review.");
        double corrected=epoch1904?serial+1462:serial<60?serial+1:serial;
        return DateTime.FromOADate(corrected).ToString("yyyy-MM-ddTHH:mm:ss.fffffff",CultureInfo.InvariantCulture);
    }
}

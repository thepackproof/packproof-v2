using System.IO.Compression;
using System.Text.Json;
using System.Xml.Linq;

namespace PackProof.Connect;

public static partial class SourceReaders
{
    private static void ReadArchive(string name,byte[] data,SourceReaderProfile profile,List<SourceReaderRow> rows,List<string> issues)
    {
        using var input=new MemoryStream(data,false);
        long total=0;
        void Member(string member,Stream stream)
        {
            Require(!Path.IsPathRooted(member)&&!member.Contains(':')&&!member.Contains('\\')&&member.Split('/').All(p=>p is not (".." or "" or ".")),"The archive contains an invalid member name.");
            Require(Path.GetExtension(member).ToLowerInvariant() is not (".zip" or ".gz" or ".gzip"),"Nested archives require a separate approved source.");
            using var buffer=new MemoryStream();byte[] scratch=new byte[8192];int n;
            while((n=stream.Read(scratch))>0){total+=n;Require(total<=MaxBytes && total<=Math.Max(65536,150L*data.Length),"The archive exceeds its decompression limit.");buffer.Write(scratch,0,n);}
            var result=Read(member,buffer.ToArray(),profile);
            if(result.State!="parsed"){issues.Add("An archive member needs its own supported profile.");return;}
            foreach(var row in result.Rows)
            {
                string root=$"member[{JsonSerializer.Serialize(member)}]/{result.ContentSha256}/";
                Add(rows,new(root+row.Location,row.Fields,row.Lineage.ToDictionary(k=>k.Key,k=>root+k.Value)));
            }
            if(result.Issues.Length>0)issues.Add("An archive member has incomplete or unqualified data.");
        }
        if(Path.GetExtension(name).ToLowerInvariant()==".zip")
        {
            using var zip=new ZipArchive(input,ZipArchiveMode.Read);
            Require(zip.Entries.Count<=64,"The archive exceeds the member limit.");
            var seen=new HashSet<string>(StringComparer.Ordinal);
            foreach(var entry in zip.Entries)
            {
                if(entry.Name=="")continue;
                Require(seen.Add(entry.FullName)&&entry.Length<=MaxBytes,"An archive member is oversized or duplicated.");
                using var stream=entry.Open();Member(entry.FullName,stream);
            }
        }
        else
        {
            using var stream=new GZipStream(input,CompressionMode.Decompress);
            Member(Path.GetFileNameWithoutExtension(name),stream);
        }
    }
    private static void ReadWordDocument(byte[] data,List<SourceReaderRow> rows)
    {
        using var input=new MemoryStream(data,false);using var zip=new ZipArchive(input);
        Require(zip.Entries.Count<=256,"The document exceeds its part limit.");
        var entry=zip.GetEntry("word/document.xml")??throw new InvalidDataException("The file is not an Open XML Word document.");
        Require(entry.Length<=MaxBytes&&entry.Length<=Math.Max(65536,150L*entry.CompressedLength),"The document exceeds its decompression limit.");
        using var stream=entry.Open();var doc=LoadXml(stream);
        XNamespace w="http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        int index=0;
        foreach(var p in doc.Descendants(w+"p"))
        {
            string text=string.Concat(p.Descendants(w+"t").Select(v=>v.Value));
            Require(text.Length<=MaxCell,"The paragraph exceeds the extraction limit.");
            string location="word/document.xml/paragraph["+(++index)+"]";Add(rows,Row(location,new(){["text"]=Val(text)},k=>location));
        }
    }
}

using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CsvHelper;
using CsvHelper.Configuration;
namespace PackProof.Connect;

public static partial class FolderSource
{
    internal static T SourceRead<T>(Func<T> action)
    {
        try { return action(); }
        catch (UnauthorizedAccessException) { throw Error(); }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        { throw new ConnectException("SOURCE_NOT_FOUND", "The selected shipment folder or export is no longer available. Choose an existing local export folder. Protected storage and queued records are unchanged."); }
        catch (IOException error)
        {
            if (LocalIo.NativeError(error) is 32 or 33) throw new ConnectException("SOURCE_BUSY", "The shipment export is still open in another program. Close it or wait for the export to finish, then retry. The original has not been changed.");
            throw new ConnectException("SOURCE_READ_FAILED", "The selected shipment folder could not be read. Choose the prepared PackProof Exports folder or check this source with its owner. This is not an instruction to reset PackProof's protected storage.");
        }
    }
    public static string Validate(string input) => SourceRead(() => ValidateCore(input, false));
    internal static string ValidateWorkspaceRoot(string input) => SourceRead(() => ValidateCore(input, true));
    public static IReadOnlyList<object> Inventory(string folder) => SourceRead<IReadOnlyList<object>>(() =>
    {
        folder = Validate(folder); var result = new List<object>(); var examined = 0; foreach (var file in Directory.EnumerateFileSystemEntries(folder, "*", SearchOption.TopDirectoryOnly))
        {
            if (++examined > 10000) throw new ConnectException("SOURCE_CAPACITY_REACHED", "This dedicated export folder contains too many entries. Ask the source owner to apply the agreed export retention policy.");
            if ((File.GetAttributes(file) & FileAttributes.Directory) != 0) continue;
            if (!Path.GetExtension(file).Equals(".csv", StringComparison.OrdinalIgnoreCase)) continue;
            if (result.Count >= 10000) throw new ConnectException("SOURCE_CAPACITY_REACHED", "This source folder contains too many final CSV files. Ask the source owner to apply the agreed export retention policy.");
            var f = new FileInfo(file); result.Add(new { name = f.Name, byteSize = f.Length, lastWriteAt = f.LastWriteTimeUtc.ToString("O",CultureInfo.InvariantCulture) });
        }
        return result;
    });
    public static byte[] Snapshot(string folder, string fileName) => ReadFile(folder, fileName, true);
    internal static byte[] WorkspaceSnapshot(string folder, string fileName) => ReadFile(folder, fileName, false);
    private static byte[] ReadFile(string folder, string fileName, bool csvOnly) => SourceRead(() =>
    {
        folder = csvOnly ? Validate(folder) : ValidateWorkspaceRoot(folder); if (fileName != Path.GetFileName(fileName) || csvOnly && !fileName.EndsWith(".csv", StringComparison.OrdinalIgnoreCase) || fileName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) throw Error();
        using var directory = CreateFile(folder, 0x80000000, 3, IntPtr.Zero, OpenExisting, OpenReparse | BackupSemantics, IntPtr.Zero); if (directory.IsInvalid || !Final(directory).Equals(folder, StringComparison.OrdinalIgnoreCase)) throw Error();
        using var stream = OpenVerifiedFile(Path.Combine(folder, fileName)); if (stream.Length == 0 || stream.Length > MaxCsvBytes) throw new ConnectException(csvOnly ? "CSV_SIZE_UNSUPPORTED" : "SOURCE_SIZE_UNSUPPORTED", "Choose a completed, nonempty report no larger than 2 MiB for this connection.");
        var bytes = new byte[(int)stream.Length]; stream.ReadExactly(bytes); if (stream.ReadByte() != -1) throw new ConnectException("SOURCE_CHANGED", "The export changed during collection. The producer must publish complete immutable files.");
        return bytes;
    });
    private static string Display(string value, int max) => value.Length > max ? value[..max] + "…" : value;
    internal static string[] ScanBatch(IEnumerable<string> paths,string? after)
    {
        var ordered=paths.OrderBy(path=>Path.GetFileName(path),StringComparer.OrdinalIgnoreCase).ToArray();
        if(ordered.Length==0)return [];
        var start=after is null?0:Array.FindIndex(ordered,path=>string.Compare(Path.GetFileName(path),after,StringComparison.OrdinalIgnoreCase)>0);
        if(start<0)start=0;
        return Enumerable.Range(0,Math.Min(100,ordered.Length)).Select(offset=>ordered[(start+offset)%ordered.Length]).ToArray();
    }
    internal sealed record Parsed(string[] Headers,List<Dictionary<string,string>> Rows);
    internal static Parsed Parse(byte[] bytes)
    {
        if(bytes.Length is 0 or >MaxCsvBytes)throw new ConnectException("CSV_SIZE_UNSUPPORTED","Use a nonempty UTF-8 CSV no larger than 2 MiB.");
        string text;try{text=new UTF8Encoding(false,true).GetString(bytes);}catch(DecoderFallbackException){throw new ConnectException("CSV_ENCODING_UNSUPPORTED","Save the export as UTF-8 CSV.");}
        if(text.Contains('\0'))throw new ConnectException("INVALID_CSV","The export contains a null character.");
        var config=new CsvConfiguration(CultureInfo.InvariantCulture){HasHeaderRecord=true,IgnoreBlankLines=false,DetectDelimiter=true,DetectDelimiterValues=[",",";","\t"],MaxFieldSize=10000,ExceptionMessagesContainRawData=false};
        using var reader=new CsvReader(new StringReader(text.TrimStart('\uFEFF')),config);
        try{
            if(!reader.Read())throw new ConnectException("INVALID_CSV","Include a header and at least one shipment row.");reader.ReadHeader();var headers=reader.HeaderRecord??[];
            if(headers.Length is 0 or >50||headers.Any(h=>string.IsNullOrWhiteSpace(h)||h.Length>200)||headers.Select(CsvSemantics.Key).Distinct(StringComparer.Ordinal).Count()!=headers.Length)throw new ConnectException("INVALID_CSV","Use at most 50 unique columns without normalized heading collisions.");
            var rows=new List<Dictionary<string,string>>();
            int physicalRows=0;
            bool trailingEmpty=false;
            while(reader.Read()){
                if(++physicalRows>1000)throw new ConnectException("CSV_ROW_LIMIT","Use at most 1,000 shipment rows per report.");
                if(reader.Parser.Record!.All(string.IsNullOrEmpty)){trailingEmpty=true;continue;}
                if(trailingEmpty)throw new ConnectException("INVALID_CSV","The report contains an empty row between data rows.");
                if(reader.Parser.Count!=headers.Length)throw new ConnectException("INVALID_CSV","A row has a different number of columns from its header.");
                rows.Add(headers.Select((h,i)=>(h,i)).ToDictionary(x=>x.h,x=>reader.GetField(x.i)??""));
            }
            if(rows.Count==0)throw new ConnectException("INVALID_CSV","Include at least one shipment row.");return new(headers,rows);
        }catch(CsvHelperException){throw new ConnectException("INVALID_CSV","The source is not a supported UTF-8 CSV export.");}
    }
    public static object Preview(byte[] bytes)
    {
        var parsed=Parse(bytes);var headers=parsed.Headers;var samples=parsed.Rows.Take(10).Select(row=>row.ToDictionary(x=>x.Key,x=>Display(x.Value,40))).ToList();
        while(samples.Count>0&&Json.Bytes(new{headers,samples}).Length>65536)samples.RemoveAt(samples.Count-1);
        return new{headers,samples,displaySamplesTruncated=parsed.Rows.Count>samples.Count,rowCount=parsed.Rows.Count,fileSha256=Convert.ToHexStringLower(SHA256.HashData(bytes)),byteSize=bytes.Length};
    }
    public static void ValidateContract(byte[] bytes, JsonElement approved)
    {
        CsvSemantics.RequireValid(bytes,approved);
        if(!approved.TryGetProperty("sourceContract",out var contract)||contract.ValueKind==JsonValueKind.Null)return;
        if(contract.GetProperty("schema").GetString() is not("packproof.scheduled-csv/v1" or "packproof.scheduled-csv/v2"))throw new ConnectException("MAPPING_NEEDS_REVIEW","The source contract is not supported by this service version.");
        if(contract.GetProperty("schema").GetString()=="packproof.scheduled-csv/v2" && (contract.GetProperty("rulesVersion").GetString()!=CsvSemantics.Version||contract.GetProperty("profileVersion").GetString()!=CsvSemantics.Profile))throw new ConnectException("SOURCE_CONTRACT_UNSUPPORTED","Install the matching source validation version.");
        var preview=Json.Element(Preview(bytes));
        var actual=preview.GetProperty("headers").EnumerateArray().Select(x=>x.GetString()!).ToArray();
        var expected=contract.GetProperty("expectedHeaders").EnumerateArray().Select(x=>x.GetString()!).ToArray();
        CsvHeaderPolicy.Require(contract,expected,actual,"MAPPING_NEEDS_REVIEW");
        if(!approved.GetProperty("mapping").TryGetProperty("shippedAt",out var field))throw new ConnectException("MAPPING_NEEDS_REVIEW","This source needs an explicit-offset shipment timestamp column.");
        var cutoff=DateTimeOffset.Parse(contract.GetProperty("backfillFrom").GetString()!,CultureInfo.InvariantCulture);
        var config=new CsvConfiguration(CultureInfo.InvariantCulture){HasHeaderRecord=true,DetectDelimiter=true,DetectDelimiterValues=[",",";","\t"],MaxFieldSize=10000,ExceptionMessagesContainRawData=false};
        using var reader=new CsvReader(new StringReader(new UTF8Encoding(false,true).GetString(bytes).TrimStart('\uFEFF')),config);
        try {
            reader.Read();reader.ReadHeader();
            while(reader.Read()){
                var reported=reader.GetField(field.GetString()!)??"";
                if(!System.Text.RegularExpressions.Regex.IsMatch(reported,@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$")||!DateTimeOffset.TryParse(reported,CultureInfo.InvariantCulture,DateTimeStyles.None,out var at))throw new ConnectException("MAPPING_NEEDS_REVIEW","Use explicit-offset shipment timestamps in this source export.");
                if(at<cutoff)throw new ConnectException("SOURCE_BACKFILL_BOUNDARY","This export includes rows before the approved backfill cutoff. Ask the source owner to provide an export within the approved window.");
            }
        } catch(CsvHelperException) {throw new ConnectException("MAPPING_NEEDS_REVIEW","The timestamp column no longer matches the approved source export.");}
    }
}

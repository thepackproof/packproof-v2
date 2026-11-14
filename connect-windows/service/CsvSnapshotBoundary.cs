using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
namespace PackProof.Connect;

public static partial class TypedSourceSemantics
{
    private static ConnectException BoundaryInvalid(string message)=>new("SOURCE_SNAPSHOT_BOUNDARY_INVALID",message);
    // Controls count every physical business record, independently of whether
    // the typed business assertions later validate. No timestamp or total is
    // synthesized from receipt time, filenames, hashes or successful-row counts.
    public static JsonElement Completeness(byte[] bytes,JsonElement config)
    {
        if(!config.TryGetProperty("completenessPolicy",out var policy)||!policy.TryGetProperty("fileBoundary",out var boundary)||boundary.ValueKind==JsonValueKind.Null)return Json.Element(new{kind="unknown"});
        try
        {
            Keys(boundary,"schema","markerColumn","asOfColumn","rowCountColumn");
            if(config.GetProperty("batchSchema").GetString()!=SchemaV2||policy.GetProperty("kind").GetString()!="snapshot"||policy.GetProperty("sourceOwnerQualified").ValueKind!=JsonValueKind.True||string.IsNullOrWhiteSpace(policy.GetProperty("qualificationReference").GetString())||boundary.GetProperty("schema").GetString()!="packproof.csv-snapshot-boundary/v1")throw BoundaryInvalid("Use the explicitly approved qualified snapshot file-boundary contract.");
            var columns=new[]{boundary.GetProperty("markerColumn").GetString()!,boundary.GetProperty("asOfColumn").GetString()!,boundary.GetProperty("rowCountColumn").GetString()!};
            if(columns.Any(c=>string.IsNullOrWhiteSpace(c)||c.Length>200)||columns.Distinct(StringComparer.Ordinal).Count()!=3)throw BoundaryInvalid("Approve three distinct exact snapshot-control headings.");
            if(bytes.Length is 0 or >2097152)throw BoundaryInvalid("The snapshot original exceeds its bounded source size.");
            var source=new UTF8Encoding(false,true).GetString(bytes);if(source.StartsWith('\uFEFF'))source=source[1..];
            var candidates=new List<List<string[]>>();foreach(var delimiter in new[]{',',';','\t'})try{candidates.Add(BoundaryRecords(source,delimiter));}catch(ConnectException){}
            if(candidates.Count==0)throw BoundaryInvalid("The original CSV is malformed.");var rows=candidates.OrderByDescending(r=>r.Count==0?0:r[0].Length).First();
            if(rows.Count<2)throw BoundaryInvalid("Include a header and at least one raw business row.");var headers=rows[0];
            if(headers.Any(h=>string.IsNullOrWhiteSpace(h)||h.Length>200)||headers.Distinct(StringComparer.Ordinal).Count()!=headers.Length||columns.Any(c=>!headers.Contains(c,StringComparer.Ordinal)))throw BoundaryInvalid("The snapshot controls must name exact unique original headers.");
            if(rows.Skip(1).Any(r=>r.Length!=headers.Length))throw BoundaryInvalid("Every raw business row must have the complete header column count.");
            var indexes=columns.Select(c=>Array.IndexOf(headers,c)).ToArray();var first=rows[1];var marker=first[indexes[0]];var asOf=first[indexes[1]];var count=first[indexes[2]];
            if(string.IsNullOrWhiteSpace(marker)||marker.Length>200)throw BoundaryInvalid("Every row needs a nonempty bounded source snapshot marker.");
            if(!BoundaryInstant(asOf))throw BoundaryInvalid("The snapshot as-of control needs its actual explicit-offset source instant.");
            if(!Regex.IsMatch(count,@"^(?:0|[1-9][0-9]*)$")||!int.TryParse(count,NumberStyles.None,CultureInfo.InvariantCulture,out var total)||total>1000||total!=rows.Count-1)throw BoundaryInvalid("The canonical source row-count control must equal all raw business rows.");
            if(rows.Skip(1).Any(r=>r[indexes[0]]!=marker||r[indexes[1]]!=asOf||r[indexes[2]]!=count))throw BoundaryInvalid("Every row must repeat the exact same marker, as-of and row-count controls.");
            return Json.Element(new{kind="snapshot",asOf,marker});
        }
        catch(ConnectException e)when(e.Code!="SOURCE_SNAPSHOT_BOUNDARY_INVALID"){throw BoundaryInvalid(e.Message);}
        catch(Exception e)when(e is KeyNotFoundException or InvalidOperationException or FormatException or DecoderFallbackException){throw BoundaryInvalid("Review the complete source snapshot controls and their explicit source meaning.");}
    }
    public static int RawBusinessRowCount(byte[] bytes)
    {
        if(bytes.Length is 0 or >2097152)throw BoundaryInvalid("The original exceeds its bounded source size.");
        var source=new UTF8Encoding(false,true).GetString(bytes);if(source.StartsWith('\uFEFF'))source=source[1..];var candidates=new List<List<string[]>>();
        foreach(var delimiter in new[]{',',';','\t'})try{candidates.Add(BoundaryRecords(source,delimiter));}catch(ConnectException){}
        if(candidates.Count==0)throw BoundaryInvalid("The original CSV is malformed.");var rows=candidates.OrderByDescending(r=>r.Count==0?0:r[0].Length).First();
        if(rows.Count<2||rows.Skip(1).Any(r=>r.Length!=rows[0].Length))throw BoundaryInvalid("Every raw business row must retain the complete header column count.");return rows.Count-1;
    }
    private static bool BoundaryInstant(string value)
    {
        var match=Regex.Match(value,@"^(?<y>\d{4})-(?<m>\d{2})-(?<d>\d{2})T(?<h>\d{2}):(?<min>\d{2}):(?<s>\d{2})(?:\.\d{1,3})?(?:Z|[+-](?<oh>\d{2}):(?<om>\d{2}))$");if(!match.Success)return false;
        int Part(string name)=>int.Parse(match.Groups[name].Value,CultureInfo.InvariantCulture);
        var year=Part("y");var month=Part("m");var day=Part("d");if(month is <1 or >12||day<1||day>DateTime.DaysInMonth(year==0?400:year,month)||Part("h")>=24||Part("min")>=60||Part("s")>=60)return false;
        return !match.Groups["oh"].Success||Part("oh")<14&&Part("om")<60||Part("oh")==14&&Part("om")==0;
    }
    private static List<string[]> BoundaryRecords(string csv,char delimiter)
    {
        var result=new List<string[]>();var row=new List<string>();var field=new StringBuilder();var quoted=false;var closed=false;
        void Field(){if(field.Length>10000)throw BoundaryInvalid("A source cell exceeds its bound.");row.Add(field.ToString());field.Clear();closed=false;}
        void Row(){Field();if(row.Count>50)throw BoundaryInvalid("The source has too many columns.");result.Add(row.ToArray());row.Clear();if(result.Count>1001)throw BoundaryInvalid("The source exceeds 1,000 business rows.");}
        for(var i=0;i<csv.Length;i++)
        {
            var c=csv[i];if(c=='\0')throw BoundaryInvalid("The source contains a null character.");
            if(quoted){if(c=='"'){if(i+1<csv.Length&&csv[i+1]=='"'){field.Append('"');i++;}else{quoted=false;closed=true;}}else field.Append(c);}
            else if(c==delimiter)Field();else if(c is '\n' or '\r'){if(c=='\r'&&i+1<csv.Length&&csv[i+1]=='\n')i++;Row();}
            else if(c=='"'){if(field.Length>0||closed)throw BoundaryInvalid("The source contains a malformed quote.");quoted=true;}
            else{if(closed)throw BoundaryInvalid("The source contains text after a closing quote.");field.Append(c);}
        }
        if(quoted)throw BoundaryInvalid("The source has an unfinished quoted cell.");if(field.Length>0||row.Count>0||closed)Row();
        while(result.Count>0&&result[^1].All(c=>c.Length==0))result.RemoveAt(result.Count-1);return result;
    }
}

using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PackProof.Connect;

// Runs in the interactive user's bridge. No paths supplied by the renderer are used as search roots.
internal static class WorkspaceDiscovery
{
    private const int EntryLimit = 256, DirectoryLimit = 24, FileLimit = 48, HeaderLimit = 8192;
    private static readonly StringComparer IgnoreCase = StringComparer.OrdinalIgnoreCase;
    private static readonly HashSet<string> Roles = new(["order","picking","packing","shipping","handoff","delivery","returns","evidence"], IgnoreCase);
    private static readonly Regex ExportName = new(@"\b(exports?|reports?|orders?|picking|packing|shipping|shipments?|handoffs?|deliveries|delivery|returns?|fulfillment|dispatch)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly HashSet<string> SystemNames = new(["Shopify","Microsoft Dynamics 365","Dynamics 365","NetSuite","SAP","Odoo","Warehouse","WMS","ERP","TMS"], IgnoreCase);
    private const string DailyShippingProfile = "enterprise-shipper-daily-shipping/v1";
    private static readonly Regex DailyShippingFile = new(@"^DailyShipping-[0-9]{8}\.(csv|pdf)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private const FileAttributes Omitted = FileAttributes.ReparsePoint | FileAttributes.Offline | FileAttributes.Hidden | FileAttributes.System;

    internal sealed record Suggestion(string Folder, string Kind, string Label, string Evidence, string SampleFile);
    internal sealed record Layout(string Label, bool Vendor);
    private static readonly JsonSerializerOptions WebJson = new(JsonSerializerDefaults.Web);

    [DllImport("shell32.dll", ExactSpelling=true)]
    private static extern int SHGetKnownFolderPath(in Guid rfid, uint flags, IntPtr token, out IntPtr path);
    private static string? KnownFolder(Guid id)
    {
        // DONT_VERIFY avoids accessing redirected network locations in the shell API.
        var result = SHGetKnownFolderPath(in id, 0x4000, IntPtr.Zero, out var ptr);
        try { return result == 0 ? Marshal.PtrToStringUni(ptr) : null; }
        finally { Marshal.FreeCoTaskMem(ptr); }
    }

    internal static JsonElement Discover(JsonElement payload, string channel)
    {
        var role = payload.GetProperty("role").GetString() ?? "";
        var excluded = payload.GetProperty("exclude");
        if (!Roles.Contains(role) || excluded.ValueKind != JsonValueKind.Array || excluded.GetArrayLength() > 16)
            throw new InvalidDataException("Invalid discovery options.");
        var exclusions = excluded.EnumerateArray().Select(v=>v.GetString()).OfType<string>()
            .Where(Path.IsPathFullyQualified).Select(Path.GetFullPath).ToArray();
        var documents = KnownFolder(new("FDD39AD0-238F-46AF-ADB4-6C85480369C7"));
        var downloads = KnownFolder(new("374DE290-123F-4565-9164-39C4925E467B"));
        var data = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        var prepared = string.IsNullOrEmpty(data) ? null : Path.Combine(data,"PackProof","Exports",channel=="production"?"live":channel);
        // Window Book documents this configurable report location in the Enterprise Shipper Reports guide.
        // It is only considered when it actually holds the supported DailyShipping reports.
        var commonDocuments = role == "shipping" ? KnownFolder(new("ED4824AF-DCE4-45A8-81E2-FC7965083634")) : null;
        var dailyShipping = commonDocuments == null ? null : Path.Combine(commonDocuments,"Window Book","EnterpriseShipper");
        var matches = Scan(role,[documents,downloads],prepared,exclusions,dailyShipping);
        return JsonSerializer.SerializeToElement(matches, WebJson);
    }

    internal static Suggestion[] Scan(string role, IEnumerable<string?> userRoots, string? prepared, string[] exclude,string? dailyShipping = null)
    {
        var hits = new List<(Suggestion Suggestion,bool Vendor)>();
        var seen = new HashSet<string>(IgnoreCase);
        var roots = userRoots.OfType<string>().Where(p => p.Length > 0).Distinct(IgnoreCase).ToArray();
        var pending = new Queue<(string Folder,int Depth,bool CanSample)>();
        if (role == "shipping" && !string.IsNullOrEmpty(dailyShipping) && !roots.Contains(dailyShipping,IgnoreCase))
            pending.Enqueue((dailyShipping,2,true));
        if (!string.IsNullOrEmpty(prepared) && !roots.Contains(prepared,IgnoreCase)) pending.Enqueue((prepared,1,true));
        foreach (var root in roots) pending.Enqueue((root,0,false));
        int visited = 0, files = 0;
        while (pending.TryDequeue(out var next) && visited < DirectoryLimit && files < FileLimit)
        {
            if (!seen.Add(next.Folder)) continue;
            visited++;
            try
            {
                var path = FolderSource.ValidateCore(next.Folder, allowShare:false, checkListing:false);
                using var pin = new ProofOutputPaths.DirectoryPin(path);
                // Recheck the final path after pinning against renames during lookup.
                FolderSource.ValidateCore(path, allowShare:false, checkListing:false);
                if (IsOutput(path,exclude)) continue;
                var entries = new DirectoryInfo(path).EnumerateFileSystemInfos().Take(EntryLimit+1).ToArray();
                // Do not let arbitrary filesystem enumeration order determine the sample.
                if (entries.Length > EntryLimit)
                {
                    // A busy Downloads root can still have a conventional dedicated export folder.
                    if (next.Depth == 0)
                        foreach (var child in new[] { "Exports", "Reports", "Order exports", RoleLabel(role) })
                            pending.Enqueue((Path.Combine(path,child),1,true));
                    continue;
                }
                bool vendorFolder = IgnoreCase.Equals(path,dailyShipping);
                if (vendorFolder && entries.Any(e=>e is not FileInfo || (e.Attributes & Omitted)!=0 || !DailyShippingFile.IsMatch(e.Name)))
                    continue;
                var ordinary = entries.Where(e => (e.Attributes & Omitted)==0 && !e.Name.StartsWith('~'))
                    .OrderBy(e=>e.Name,IgnoreCase).ToArray();
                if (next.Depth < 2)
                {
                    foreach (var sub in ordinary.OfType<DirectoryInfo>())
                    {
                        if (roots.Contains(sub.FullName,IgnoreCase)) continue;
                        bool dedicated = ExportName.IsMatch(sub.Name.Replace('_',' ').Replace('-',' ')) ||
                            role == "evidence" && WorkspaceEvidenceDiscovery.IsEvidenceFolder(sub.Name);
                        if (dedicated || SystemNames.Contains(sub.Name))
                            pending.Enqueue((sub.FullName,next.Depth+1,dedicated || next.CanSample));
                    }
                }
                if (!next.CanSample || exclude.Any(p=>ProofOutputPaths.Overlaps(path,p))) continue;
                bool evidenceSource = role == "evidence" && WorkspaceEvidenceDiscovery.IsEvidenceFolder(Path.GetFileName(path));
                if (role=="evidence" && !evidenceSource) continue;
                var layouts = new List<(Layout Layout,string File)>();
                var samples = ordinary.OfType<FileInfo>().Where(f=>evidenceSource ?
                    WorkspaceEvidenceDiscovery.CanInspect(f.Extension) : IsDelimited(f.Extension));
                foreach (var file in samples.Take(12))
                {
                    if (files >= FileLimit) break;
                    files++;
                    try
                    {
                        using var stream = FolderSource.OpenVerifiedFile(file.FullName);
                        if (stream.Length is 0 or > FolderSource.MaxCsvBytes) continue;
                        if (evidenceSource)
                        {
                            if (WorkspaceEvidenceDiscovery.Match(stream,file.Extension))
                                layouts.Add((new("Packing or shipping evidence",false),file.Name));
                            continue;
                        }
                        var fields = Header(stream,file.Extension);
                        if (vendorFolder && ExportCatalogue.Match(fields)?.Id != DailyShippingProfile) continue;
                        if (fields.Length > 0 && Classify(role,fields) is { } layout) layouts.Add((layout,file.Name));
                    }
                    catch (Exception e) when (Skippable(e)) { }
                }
                if (layouts.Count == 0) continue;
                var vendors = layouts.Where(v=>v.Layout.Vendor).Select(v=>v.Layout.Label).Distinct(IgnoreCase).ToArray();
                bool oneVendor = vendors.Length == 1;
                var label = evidenceSource ? layouts[0].Layout.Label : oneVendor ? vendors[0] : RoleLabel(role);
                var evidence = evidenceSource ? "Found a supported file. An explicit order link is needed." :
                    layouts.Count == 1 ? "Column names match in one sampled report." : $"Column names match in {layouts.Count} sampled reports.";
                var sample = oneVendor ? layouts.First(v=>v.Layout.Vendor).File : layouts[0].File;
                hits.Add((new(path,"discovered",label,evidence,sample),oneVendor));
            }
            catch (Exception e) when (Skippable(e)) { }
        }
        return hits.OrderByDescending(h=>h.Vendor).ThenBy(h=>h.Suggestion.Folder,IgnoreCase)
            .Take(8).Select(h=>h.Suggestion).ToArray();
    }

    private static bool IsOutput(string path,string[] excluded)
    {
        for (var node=new DirectoryInfo(path);node!=null;node=node.Parent)
        {
            if ((node.Attributes & FileAttributes.Offline)!=0 || excluded.Contains(node.FullName,IgnoreCase) ||
                File.Exists(Path.Combine(node.FullName,".packproof-writer.id"))) return true;
        }
        return false;
    }

    private static bool Skippable(Exception error) => error is IOException or UnauthorizedAccessException or
        ConnectException or ArgumentException or NotSupportedException;

    private static bool IsDelimited(string ext) => ext.Equals(".csv",StringComparison.OrdinalIgnoreCase) ||
        ext.Equals(".tsv",StringComparison.OrdinalIgnoreCase) || ext.Equals(".psv",StringComparison.OrdinalIgnoreCase);

    internal static string[] Header(Stream stream,string extension)
    {
        // Interpret a single physical UTF-8 header only. Multiline, malformed, and oversized headings need manual review.
        using var bytes = new MemoryStream();
        while (bytes.Length <= HeaderLimit)
        {
            var value = stream.ReadByte();
            if (value < 0 || value is 10 or 13) break;
            bytes.WriteByte((byte)value);
        }
        if (bytes.Length is 0 or > HeaderLimit) return [];
        var line = new UTF8Encoding(false,true).GetString(bytes.ToArray()).TrimStart('\uFEFF');
        if (line.IndexOf('\0') >= 0) return [];
        var separators = extension.ToLowerInvariant() switch { ".tsv" => "\t", ".psv" => "|", _ => ",;\t|" };
        var layouts = separators.Select(separator=>SplitHeader(line,separator)).Where(h=>h.Length>1)
            .OrderByDescending(h=>h.Length).ToArray();
        if (layouts.Length==0 || layouts.Length>1 && layouts[0].Length==layouts[1].Length) return [];
        return layouts[0];
    }

    private static string[] SplitHeader(string text,char separator)
    {
        var fields = new List<string>();
        var cell = new StringBuilder();
        bool quoted = false, closed = false;
        for (int i=0;i<=text.Length;i++)
        {
            if (i==text.Length || !quoted && text[i]==separator)
            {
                if (quoted || fields.Count>=128 || cell.Length is 0 or >256) return [];
                fields.Add(cell.ToString().Trim());
                cell.Clear(); closed=false;
            }
            else if (text[i]=='"')
            {
                if (quoted && i+1<text.Length && text[i+1]=='"') { cell.Append('"'); i++; }
                else if (quoted) { quoted=false; closed=true; }
                else if (cell.Length==0 && !closed) quoted=true;
                else return [];
            }
            else if (closed) return [];
            else cell.Append(text[i]);
        }
        if (fields.Any(string.IsNullOrWhiteSpace) || fields.Distinct(IgnoreCase).Count()!=fields.Count) return [];
        return fields.ToArray();
    }

    private static string RoleLabel(string role) => role switch { "returns"=>"Return records",
        "order"=>"Order records", _=>char.ToUpperInvariant(role[0])+role[1..]+" records" };

    internal static Layout? Classify(string role,string[] headers)
    {
        var profile = ExportCatalogue.Match(headers,out var ambiguous);
        if (ambiguous) return null;
        if (profile != null) return role == profile.Role ? new(profile.Label,true) : null;
        var columns = SourceReaders.WorkflowHeaders(headers);
        if (columns == null) return null;
        var roles = SourceReaders.DiscoveryWorkflowRoles(columns).ToList();
        var orderedAmounts = new[] {"orderedquantity","orderedqty","qtyordered","quantityordered","quantity","qty"};
        bool hasOrderAmount = headers.Count(h=>orderedAmounts.Contains(Regex.Replace(h,@"[\s_-]","").ToLowerInvariant()))==1;
        if (hasOrderAmount && columns.ContainsKey("orderId") && columns.ContainsKey("lineId") && columns.ContainsKey("unit") &&
            (columns.ContainsKey("version") || columns.ContainsKey("asOf"))) roles.Add("order");
        return roles.Count==1 && roles[0]==role ? new(RoleLabel(role),false) : null;
    }
}

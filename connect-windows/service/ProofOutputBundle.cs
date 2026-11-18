using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PackProof.Connect;

// Each writer has a durable, service-protected identity. A destination is owned
// by one writer until an explicit recovery, including across network partitions.
internal sealed class ProofOutputBundle : IDisposable
{
    private readonly string root;
    private readonly FileStream fence;
    internal ProofOutputBundle(string root, string writer)
    {
        this.root = root;
        var lockPath = Path.Combine(root, ".packproof-writer.lock");
        ProofOutputPaths.OrdinaryFile(lockPath);
        try { fence = new(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException e) when (LocalIo.NativeError(e) is 32 or 33)
        { throw WriterConflict(); }
        try
        {
            var marker = Path.Combine(root, ".packproof-writer.id");
            ProofOutputPaths.OrdinaryFile(marker);
            if (!File.Exists(marker)) PublishFile(marker, Encoding.UTF8.GetBytes(writer), false);
            if (ReadSmall(marker, 256) != writer) throw WriterConflict();
            // Reject shares that silently accept concurrent writers despite the
            // requested exclusive open. The permanent marker forbids failover.
            bool exclusive = false;
            try { using var other = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) { exclusive = true; }
            if (!exclusive) throw WriterConflict();
        }
        catch { fence.Dispose(); throw; }
    }

    private static ConnectException WriterConflict() => new("OUTPUT_WRITER_CONFLICT",
        "This folder already has a designated writer or cannot enforce exclusive access. Choose a separate proof folder.");
    private static ConnectException Invalid() => new("OUTPUT_REVISION_INVALID",
        "The saved package or committed revision could not be verified. Preserve existing files and retry after checking this order.");
    private static string Digest(byte[] content) => Convert.ToHexStringLower(SHA256.HashData(content));
    private static string ReadSmall(string path, int limit)
    {
        ProofOutputPaths.OrdinaryFile(path);
        using var file = File.OpenRead(path);
        if (file.Length > limit) throw Invalid();
        using var reader = new StreamReader(file, Encoding.UTF8);
        return reader.ReadToEnd();
    }
    private static void WriteNew(string path, byte[] bytes)
    {
        using var f = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 8192, FileOptions.WriteThrough);
        f.Write(bytes); f.Flush(true);
    }
    internal static void Probe(string folder)
    {
        var path = Path.Combine(folder, ".packproof-check-" + Guid.NewGuid().ToString("N"));
        var sample = RandomNumberGenerator.GetBytes(32);
        try
        {
            PublishFile(path,sample,false);
            if (!File.ReadAllBytes(path).SequenceEqual(sample)) throw Invalid();
            var replacement = RandomNumberGenerator.GetBytes(16);
            PublishFile(path,replacement,true);
            if (!File.ReadAllBytes(path).SequenceEqual(replacement)) throw Invalid();
        }
        finally { File.Delete(path); }
    }
    private static void PublishFile(string path, byte[] bytes, bool replace)
    {
        ProofOutputPaths.OrdinaryFile(path);
        var temp = Path.Combine(Path.GetDirectoryName(path)!, ".packproof-write-" + Guid.NewGuid().ToString("N"));
        try
        {
            WriteNew(temp,bytes);
            if (!File.ReadAllBytes(temp).SequenceEqual(bytes)) throw Invalid();
            File.Move(temp,path,replace);
        }
        finally { File.Delete(temp); }
    }
    private static string CreateFolder(string path)
    {
        Directory.CreateDirectory(path);
        using var pin = new ProofOutputPaths.DirectoryPin(path);
        return path;
    }

    private static string FriendlyName(string reference)
    {
        var name = new string(reference.Select(ch => char.IsLetterOrDigit(ch) || ch is '-' or '_' or ' ' ? ch : '_')
            .Take(48).ToArray()).Trim();
        return name.Length == 0 ? "Order" : name;
    }

    private string ProofFolder(string proofId, string reference)
    {
        var key = Digest(Encoding.UTF8.GetBytes(proofId));
        var index = CreateFolder(Path.Combine(root, ".packproof-index"));
        using var indexPin = new ProofOutputPaths.DirectoryPin(index);
        var location = Path.Combine(index,key+".json");
        ProofOutputPaths.OrdinaryFile(location);
        if (!File.Exists(location)) PublishFile(location, Json.Bytes(FriendlyName(reference)), false);
        var label = Json.Read<string>(Encoding.UTF8.GetBytes(ReadSmall(location, 8192)));
        if (label != FriendlyName(label)) throw Invalid();
        return CreateFolder(Path.Combine(root, label + " - " + key[..24]));
    }

    internal sealed record ManifestEntry(string File, string Sha256, string Kind, string? OriginalSha256 = null, string? SourceId = null,
        string? ReceiptId = null, string? LinkedByReceiptId = null, string? SourceFileName = null);
    private static string? Field(JsonElement item, string key) =>
        item.ValueKind == JsonValueKind.Object && item.TryGetProperty(key,out var value) && value.ValueKind is JsonValueKind.String or JsonValueKind.Number ? value.ToString() : null;
    private static IEnumerable<JsonElement> ArrayField(JsonElement obj, string key) =>
        obj.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Array ? value.EnumerateArray() : Enumerable.Empty<JsonElement>();

    private static byte[] HtmlSummary(JsonElement doc,string reference,int revision)
    {
        string E(string? s) => WebUtility.HtmlEncode(s ?? "—");
        var html = new StringBuilder("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Order " + E(reference) + "</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:56rem;margin:2rem auto;padding:0 1rem;color:#172334}table{border-collapse:collapse}th,td{padding:.4rem;text-align:left;border-bottom:1px solid #c2c9d3}section{overflow:auto}small{color:#455871}</style><main>");
        html.Append("<p>PackProof · Saved order</p><h1>Order ").Append(E(reference)).Append("</h1><p>Revision ").Append(revision).Append("</p>");
        var lines = ArrayField(doc,"lines").ToArray();
        if (lines.Length > 0)
        {
            var hasDiscrepancy = lines.Any(line => Field(line,"orderedShippedDiscrepancy") is not null);
            html.Append("<section><h2>Items</h2><table><thead><tr><th>Line</th><th>Item</th><th>Ordered</th><th>Picked</th><th>Packed</th><th>Shipped</th><th>Returned</th><th>Unit</th>");
            if (hasDiscrepancy) html.Append("<th>Quantity difference</th>");
            (string Key,string Label)[] optionalStages = [
                ("loadedQuantity","Loaded"), ("acknowledgedQuantity","Acknowledged"), ("backorderedQuantity","Backordered"),
                ("loadedAcknowledgedDiscrepancy","Load and receipt difference")
            ];
            var presentStages=optionalStages.Where(stage=>lines.Any(line=>Field(line,stage.Key) is not null)).ToArray();
            foreach(var stage in presentStages)html.Append("<th>").Append(stage.Label).Append("</th>");
            html.Append("</tr></thead><tbody>");
            foreach (var line in lines)
            {
                html.Append("<tr>");
                foreach(var field in new[]{"lineId","sku","orderedQuantity","pickedQuantity","packedQuantity","shippedQuantity","returnedQuantity","unit"})
                    html.Append("<td>").Append(E(Field(line,field))).Append("</td>");
                if (hasDiscrepancy) html.Append("<td>").Append(WebUtility.HtmlEncode(Field(line,"orderedShippedDiscrepancy"))).Append("</td>");
                foreach(var stage in presentStages)html.Append("<td>").Append(E(Field(line,stage.Key))).Append("</td>");
                html.Append("</tr>");
            }
            html.Append("</tbody></table></section>");
        }
        var events = ArrayField(doc,"events").ToArray();
        if (events.Length != 0)
        {
            html.Append("<h2>Order history</h2><ul>");
            foreach (var ev in events)
                html.Append("<li>").Append(E(Field(ev,"kind"))).Append(" · ").Append(E(Field(ev,"occurredAt"))).Append(" <small>").Append(E(Field(ev,"sourceId"))).Append("</small></li>");
            html.Append("</ul>");
        }
        html.Append("<p><a href=\"record.json\">View order data</a> · <a href=\"manifest.json\">View evidence manifest</a></p></main></html>");
        return Encoding.UTF8.GetBytes(html.ToString());
    }

    // Immutable revision packages contain the scoped server projection. Shared
    // evidence objects are referenced relative to the package and verified
    // before publishing the current pointer.
    internal ManifestEntry StoreLinkedOriginal(JsonElement doc, string proofId, JsonElement binding, JsonElement response)
    {
        var receipt = Field(binding,"receiptId");
        var sha = Field(binding,"originalSha256");
        var source = Field(binding,"sourceId");
        if (Field(doc,"proofId") != proofId || receipt is null || !string.Equals(receipt,Field(response,"receiptId"),StringComparison.Ordinal) ||
            sha is not { Length:64 } || !sha.All(char.IsAsciiHexDigit)) throw Invalid();
        var kind=Field(response,"kind");
        byte[] bytes;
        string extension;
        if (kind=="derived_excerpt")
        {
            bytes=Json.Bytes(new{receiptId=receipt,originalSha256=sha,sourceId=source,reason=Field(response,"reason")});
            extension=".json";
        }
        else
        {
            if(kind!="original" || Field(response,"originalSha256")!=sha || Field(response,"sourceId")!=source ||
                Field(binding,"mediaType")!=Field(response,"mediaType")) throw Invalid();
            extension=Field(response,"mediaType") switch { "image/jpeg"=>".jpg","image/png"=>".png","application/zpl"=>".zpl",_=>throw Invalid() };
            bytes=response.GetProperty("bytesBase64").GetBytesFromBase64();
            if(bytes.Length>3*1024*1024 || Digest(bytes)!=sha) throw Invalid();
        }
        var folder=ProofFolder(proofId,Field(doc,"orderReference")??proofId);
        using var proofPin=new ProofOutputPaths.DirectoryPin(folder);
        var evidence=CreateFolder(Path.Combine(folder,"evidence"));
        using var evidencePin=new ProofOutputPaths.DirectoryPin(evidence);
        var digest=Digest(bytes);
        var name=digest+extension;
        var path=Path.Combine(evidence,name);
        ProofOutputPaths.OrdinaryFile(path);
        if(!File.Exists(path)) PublishFile(path,bytes,false);
        VerifyFile(path,digest,bytes.Length);
        return new("../evidence/"+name,digest,kind=="original"?"original":"original withheld",sha,source,receipt,
            Field(binding,"linkedByReceiptId"),Field(binding,"fileName"));
    }

    internal string Publish(JsonElement doc, string proofId, int revision,IReadOnlyList<ManifestEntry>? linkedOriginals=null)
    {
        if (revision < 1 || Field(doc,"proofId") != proofId || !doc.TryGetProperty("revision",out var received) ||
            !received.TryGetInt32(out var rev) || rev != revision) throw Invalid();
        var reference = Field(doc,"orderReference") ?? proofId;
        var folder = ProofFolder(proofId,reference);
        using var proofPin = new ProofOutputPaths.DirectoryPin(folder);
        var version = "revision-" + revision.ToString("D8",CultureInfo.InvariantCulture);
        var final = Path.Combine(folder,version);
        var record = Json.Bytes(doc);
        var recordHash = Digest(record);
        var files = new List<ManifestEntry> { new("record.json",recordHash,"derived") };
        var summary = HtmlSummary(doc,reference,revision);
        files.Add(new("summary.html",Digest(summary),"derived"));
        files.AddRange(linkedOriginals??[]);
        foreach (var evidence in ArrayField(doc,"evidence"))
        {
            if (evidence.ValueKind != JsonValueKind.Object) throw Invalid();
            var sourceHash = Field(evidence,"originalSha256");
            var original = Field(evidence,"kind") == "original" && evidence.TryGetProperty("bytesBase64",out _);
            var bytes = original ? evidence.GetProperty("bytesBase64").GetBytesFromBase64() : Json.Bytes(evidence);
            var hash = Digest(bytes);
            if (original && !string.Equals(hash,sourceHash,StringComparison.OrdinalIgnoreCase)) throw Invalid();
            var evidenceFolder = CreateFolder(Path.Combine(folder,"evidence"));
            using var evidencePin = new ProofOutputPaths.DirectoryPin(evidenceFolder);
            var filename = hash + (original ? ".bin" : ".json");
            var objectPath = Path.Combine(evidenceFolder,filename);
            ProofOutputPaths.OrdinaryFile(objectPath);
            if (!File.Exists(objectPath)) PublishFile(objectPath,bytes,false);
            VerifyFile(objectPath, hash,bytes.Length);
            files.Add(new("../evidence/"+filename,hash,original ? "original" : "derived excerpt",sourceHash,Field(evidence,"sourceId")));
        }

        if (!Directory.Exists(final))
        {
            var staging = CreateFolder(Path.Combine(folder,".packproof-staging-"+Guid.NewGuid().ToString("N")));
            try
            {
                WriteNew(Path.Combine(staging,"record.json"),record);
                WriteNew(Path.Combine(staging,"summary.html"),summary);
                var manifest = Json.Bytes(new { schema="packproof.order-output/v1", proofId,revision,orderReference=reference, files,
                    generatedAt=DateTimeOffset.UtcNow, verification="Local file hashes verified against this committed projection" });
                WriteNew(Path.Combine(staging,"manifest.json"),manifest);
                VerifyFile(Path.Combine(staging,"record.json"),recordHash,record.Length);
                VerifyFile(Path.Combine(staging,"summary.html"),Digest(summary),summary.Length);
                VerifyFile(Path.Combine(staging,"manifest.json"),Digest(manifest),manifest.Length);
                Directory.Move(staging,final);
            }
            finally
            {
                // Only our ordinary staging files are eligible for cleanup.
                if (Directory.Exists(staging))
                {
                    using (var stagePin = new ProofOutputPaths.DirectoryPin(staging))
                        foreach (var name in new[]{"record.json","summary.html","manifest.json"})
                        { var path=Path.Combine(staging,name); ProofOutputPaths.OrdinaryFile(path); File.Delete(path); }
                    Directory.Delete(staging,false);
                }
            }
        }
        using var immutable = new ProofOutputPaths.DirectoryPin(final);
        VerifyFile(Path.Combine(final,"record.json"),recordHash,record.Length);
        VerifyFile(Path.Combine(final,"summary.html"),Digest(summary),summary.Length);
        var retained = Json.Read<JsonElement>(Encoding.UTF8.GetBytes(ReadSmall(Path.Combine(final,"manifest.json"),6*1024*1024)));
        if (Field(retained,"proofId")!=proofId || Field(retained,"revision")!=revision.ToString(CultureInfo.InvariantCulture) ||
            !JsonElement.DeepEquals(retained.GetProperty("files"),Json.Element(files))) throw Invalid();
        var pointer = Path.Combine(folder,"current.html");
        ProofOutputPaths.OrdinaryFile(pointer);
        if (File.Exists(pointer))
        {
            var prior = ReadSmall(pointer, 8192);
            if (!prior.StartsWith("<!-- PackProof revision ",StringComparison.Ordinal)) throw Invalid();
            var end = prior.IndexOf(" -->",StringComparison.Ordinal);
            if (end < 24 || !int.TryParse(prior.AsSpan(24,end-24), NumberStyles.None, CultureInfo.InvariantCulture,out var current)) throw Invalid();
            if (current > revision) return folder;
        }
        fence.Flush(true);
        var href = version + "/summary.html";
        PublishFile(pointer,Encoding.UTF8.GetBytes($"<!-- PackProof revision {revision} -->\n<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"0; url={href}\"><title>Order {WebUtility.HtmlEncode(reference)}</title><a href=\"{href}\">Open current order proof</a></html>"),true);
        return folder;
    }

    private static void VerifyFile(string path, string hash, int length)
    {
        ProofOutputPaths.OrdinaryFile(path);
        using var f = File.OpenRead(path);
        if (f.Length != length || Convert.ToHexStringLower(SHA256.HashData(f)) != hash) throw Invalid();
    }

    public void Dispose() => fence.Dispose();
}

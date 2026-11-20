namespace PackProof.Connect;

internal static class WorkspaceEvidenceDiscovery
{
    private static readonly HashSet<string> FolderNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "Packing photos", "Packing evidence", "Shipping photos", "Shipping evidence",
        "Shipment photos", "Shipment evidence"
    };

    internal static bool IsEvidenceFolder(string name) => FolderNames.Contains(name.Replace('-', ' ').Replace('_', ' '));
    internal static bool CanInspect(string extension) => extension.ToLowerInvariant() is ".jpg" or ".jpeg" or ".png" or ".pdf";

    // Inspect only the format signature on the pinned local handle. The collector
    // checks the original after selection; discovery cannot infer an order relationship.
    internal static bool Match(Stream stream, string extension)
    {
        extension = extension.ToLowerInvariant();
        int length = extension switch { ".png" => 16, ".pdf" => 9, ".jpg" or ".jpeg" => 6, _ => 0 };
        if (length == 0 || !stream.CanSeek || stream.Length < length || stream.Length > FolderSource.MaxCsvBytes) return false;
        Span<byte> prefix = stackalloc byte[16];
        if (stream.ReadAtLeast(prefix[..length], length, throwOnEndOfStream: false) < length) return false;
        if (extension == ".png")
            return prefix.StartsWith(new byte[] {137,80,78,71,13,10,26,10,0,0,0,13}) && prefix[12..16].SequenceEqual("IHDR"u8);
        if (extension == ".pdf")
            return prefix.StartsWith("%PDF-"u8) && prefix[6] == '.' && (prefix[8] == '\r' || prefix[8] == '\n') &&
                ((prefix[5] == '1' && prefix[7] >= '0' && prefix[7] <= '7') || (prefix[5] == '2' && prefix[7] == '0'));

        int segmentLength = prefix[4] * 256 + prefix[5];
        return prefix[0] == 0xff && prefix[1] == 0xd8 && prefix[2] == 0xff &&
            prefix[3] is >= 0xc0 and <= 0xfe and not (>= 0xd0 and <= 0xd9) &&
            segmentLength >= 2 && segmentLength <= stream.Length - 4;
    }
}

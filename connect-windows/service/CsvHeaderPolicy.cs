using System.Text.Json;
using System.Text.Json.Nodes;

namespace PackProof.Connect;

internal static class CsvHeaderPolicy
{
    internal const string Reorder = "same_names_any_order/v1";

    private static bool Available(JsonElement? capabilities) =>
        capabilities is {ValueKind: JsonValueKind.Object} available
        && available.TryGetProperty("csvHeaderPolicies", out var supported) && supported.ValueKind == JsonValueKind.Array
        && supported.EnumerateArray().Any(item => item.ValueKind == JsonValueKind.String && item.GetString() == Reorder);

    internal static bool SourceCompatible(JsonElement config, JsonElement? capabilities) =>
        !config.TryGetProperty("sourceContract", out var contract) || contract.ValueKind != JsonValueKind.Object
        || !contract.TryGetProperty("headerPolicy", out var policy)
        || policy.ValueKind == JsonValueKind.String && policy.GetString() == Reorder && Available(capabilities);

    internal static JsonElement WithRequestedPolicy(JsonElement config, JsonElement request, JsonElement? capabilities)
    {
        bool requested = request.TryGetProperty("allowColumnReordering", out var choice);
        if (!requested && !config.GetProperty("sourceContract").TryGetProperty("headerPolicy",out _)) return config;
        if (requested && (choice.ValueKind != JsonValueKind.True || !Available(capabilities)))
            throw new ConnectException("SOURCE_CONTRACT_UNSUPPORTED", "This workspace and collector must support reordered columns before requesting approval.");
        var root = JsonNode.Parse(config.GetRawText())!.AsObject();
        var contract = root["sourceContract"]!.AsObject();
        if (requested) contract["headerPolicy"] = Reorder;
        else contract.Remove("headerPolicy");
        return JsonSerializer.SerializeToElement(root);
    }

    // Only exact name-to-name bindings can move. Raw cells and the original
    // byte sequence stay untouched. Drift messages expose counts only.
    internal static void Require(JsonElement config, IReadOnlyList<string> expected, IReadOnlyList<string> observed, string errorCode)
    {
        var permitsReorder = config.TryGetProperty("headerPolicy", out var policy);
        if (permitsReorder && (policy.ValueKind != JsonValueKind.String || policy.GetString() != Reorder))
            throw new ConnectException("SOURCE_CONTRACT_UNSUPPORTED", "The approved column policy requires a matching collector.");
        if (expected.SequenceEqual(observed, StringComparer.Ordinal)) return;
        var approved = expected.ToHashSet(StringComparer.Ordinal);
        var proposed = observed.ToHashSet(StringComparer.Ordinal);
        var added = proposed.Count(name => !approved.Contains(name));
        var removed = approved.Count(name => !proposed.Contains(name));
        if (added > 0 || removed > 0)
            throw new ConnectException(errorCode, $"The report contains {added} new or renamed and {removed} missing approved columns. Review the full original and field meanings before uploading.");
        if (permitsReorder && expected.Count == observed.Count && proposed.Count == observed.Count
            && expected.Select(CsvSemantics.Key).Distinct(StringComparer.Ordinal).Count() == expected.Count) return;
        throw new ConnectException(errorCode, "The columns differ from the approved order. Ask the source owner to review this report.");
    }
}

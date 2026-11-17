using PackProof.Connect;
using Xunit;

public sealed class SourceReviewBindingTests
{
    private readonly SourceSubscriptionState source = new() { Id = "source", ConfigurationRevision = 3, GrantRevision = 5 };

    [Theory]
    [InlineData(3, 5, "original", true)]
    [InlineData(2, 5, "original", false)]
    [InlineData(3, 4, "original", false)]
    [InlineData(3, 5, "replacement", false)]
    public void ApprovalIsBoundToCurrentRevisionsAndOriginal(int configurationRevision, int grantRevision, string originalSha256, bool accepted)
    {
        var request = Json.Element(new { configurationRevision, grantRevision, originalSha256 });
        if (accepted) AgentRuntime.RequireReviewedSource(request, source, "original");
        else Assert.Equal("SOURCE_REVIEW_CHANGED", Assert.Throws<ConnectException>(() => AgentRuntime.RequireReviewedSource(request, source, "original")).Code);
    }

    [Theory]
    [InlineData("first", "v1", "previewed", true)]
    [InlineData("second", "v1", "previewed", false)]
    [InlineData("first", "v2", "previewed", false)]
    [InlineData("first", "v1", "queued", false)]
    public void BatchConsentIsBoundToDisplayedReceipt(string receiptId, string previewVersion, string state, bool accepted)
    {
        var request = Json.Element(new { receiptId, previewVersion });
        var receipt = Json.Element(new { id = "first", previewVersion = "v1", state });
        if (accepted) AgentRuntime.RequireReviewedReceipt(request, receipt, "first");
        else Assert.Equal("SOURCE_REVIEW_CHANGED", Assert.Throws<ConnectException>(() => AgentRuntime.RequireReviewedReceipt(request, receipt, "first")).Code);
    }
}

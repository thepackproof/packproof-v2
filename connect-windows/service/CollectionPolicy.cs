namespace PackProof.Connect;

public static class CollectionPolicy
{
    public static bool IsWithinApprovedWindow(DateTimeOffset now, DateTimeOffset? policyCheckedAt, DateTimeOffset? credentialExpiresAt, double offlineWindowHours, bool online)
    {
        if (policyCheckedAt is null || credentialExpiresAt is null || credentialExpiresAt <= now || offlineWindowHours is not (0 or 24)) return false;
        var elapsed = now - policyCheckedAt.Value;
        if (elapsed < TimeSpan.Zero) return false;
        return offlineWindowHours == 0 ? online && elapsed <= TimeSpan.FromSeconds(65) : elapsed <= TimeSpan.FromHours(offlineWindowHours);
    }
}

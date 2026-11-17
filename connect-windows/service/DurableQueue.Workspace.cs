using System.Text.Json;

namespace PackProof.Connect;

public sealed partial class DurableQueue
{
    internal static string WorkspaceLane(string sourceId) => "workspace-" + sourceId;

    internal QueueEntry StageWorkspace(byte[] bytes, string fileName, JsonElement body, string installationId,
        string captureId, WorkspaceSource source)
    {
        var wire = Json.Bytes(body);
        var payload = new QueuePayload { FileName = fileName, Csv = "", PreviewBody = Json.Element(new { }),
            PreviewWireBody = wire, PreviewBodySha256 = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(wire)),
            CommitApproved = true };
        return StagePayload(bytes, payload, installationId, captureId,
            new(WorkspaceLane(source.Id), source.ProfileVersion, source.Generation));
    }

    internal QueueEntry? NextWorkspace(WorkspaceSource source, string installationId, DateTimeOffset now)
    {
        using var cmd = db.CreateCommand();
        cmd.CommandText = $"SELECT {Columns} FROM queue WHERE source_id=$id AND grant_revision=$generation AND credential_generation=$installation AND state='staged' AND next_attempt_at<=$now ORDER BY next_attempt_at,rowid LIMIT 1";
        cmd.Parameters.AddWithValue("$id", WorkspaceLane(source.Id));
        cmd.Parameters.AddWithValue("$generation", source.Generation);
        cmd.Parameters.AddWithValue("$installation", installationId);
        cmd.Parameters.AddWithValue("$now", now.ToString("O"));
        return ReadEntries(cmd).FirstOrDefault();
    }
}


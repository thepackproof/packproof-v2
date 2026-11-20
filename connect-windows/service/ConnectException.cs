namespace PackProof.Connect;

public sealed class ConnectException(string code, string message) : Exception(message) { public string Code { get; } = code; }

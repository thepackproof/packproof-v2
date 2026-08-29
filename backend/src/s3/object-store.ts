export interface UploadTarget {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
}

export interface StoredObject {
  body: Buffer;
  contentType: string;
}

export interface ObjectDigest {
  sha256: string;
  byteSize: number;
  contentType: string;
}

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  digest(key: string): Promise<ObjectDigest | null>;
  createUploadTarget(input: {
    key: string;
    contentType: string;
  }): Promise<UploadTarget>;
  putUpload(
    token: string,
    body: Buffer,
    contentType: string | undefined,
  ): Promise<{ key: string }>;
}

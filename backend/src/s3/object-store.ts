export interface UploadTarget {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
}

export interface StoredObject {
  body: Buffer;
  contentType: string;
}

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
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

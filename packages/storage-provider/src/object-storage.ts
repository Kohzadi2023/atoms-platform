import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type ServerSideEncryption,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface ObjectMetadata {
  readonly sizeBytes: number;
  readonly contentType: string | undefined;
  readonly etag: string | undefined;
}

export interface SignedObjectRequest {
  readonly url: string;
  readonly method: "GET" | "PUT";
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface ObjectStorageProvider {
  createUploadRequest(input: {
    readonly key: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly expiresInSeconds: number;
  }): Promise<SignedObjectRequest>;
  createDownloadRequest(input: {
    readonly key: string;
    readonly fileName: string;
    readonly expiresInSeconds: number;
  }): Promise<SignedObjectRequest>;
  headObject(key: string): Promise<ObjectMetadata | null>;
  getObject(key: string, maxBytes: number): Promise<Uint8Array>;
  copyObject(input: {
    readonly sourceKey: string;
    readonly destinationKey: string;
    readonly contentType: string;
  }): Promise<void>;
  deleteObject(key: string): Promise<void>;
}

export interface S3ObjectStorageProviderOptions {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint?: string;
  /**
   * Browser-reachable endpoint used only when producing presigned URLs.
   * Server-side object operations continue to use `endpoint`.
   */
  readonly signingEndpoint?: string;
  readonly forcePathStyle?: boolean;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly kmsKeyId?: string;
  readonly client?: S3Client;
  readonly signingClient?: S3Client;
  readonly now?: () => Date;
}

export class S3ObjectStorageProvider implements ObjectStorageProvider {
  readonly #bucket: string;
  readonly #client: S3Client;
  readonly #signingClient: S3Client;
  readonly #kmsKeyId: string | undefined;
  readonly #now: () => Date;

  constructor(options: S3ObjectStorageProviderOptions) {
    this.#bucket = options.bucket;
    this.#kmsKeyId = options.kmsKeyId;
    this.#now = options.now ?? (() => new Date());
    const clientOptions = {
      region: options.region,
      ...(options.forcePathStyle === undefined
        ? {}
        : { forcePathStyle: options.forcePathStyle }),
      ...(options.accessKeyId === undefined ||
      options.secretAccessKey === undefined
        ? {}
        : {
            credentials: {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey,
            },
          }),
    };
    this.#client =
      options.client ??
      new S3Client({
        ...clientOptions,
        ...(options.endpoint === undefined
          ? {}
          : { endpoint: options.endpoint }),
      });
    this.#signingClient =
      options.signingClient ??
      (options.signingEndpoint === undefined
        ? this.#client
        : new S3Client({
            ...clientOptions,
            endpoint: options.signingEndpoint,
          }));
  }

  async createUploadRequest(input: {
    readonly key: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly expiresInSeconds: number;
  }): Promise<SignedObjectRequest> {
    const encryption = this.#encryption();
    const command = new PutObjectCommand({
      Bucket: this.#bucket,
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.sizeBytes,
      ...encryption.command,
    });
    const url = await getSignedUrl(this.#signingClient, command, {
      expiresIn: input.expiresInSeconds,
    });
    return {
      url,
      method: "PUT",
      headers: {
        "content-type": input.contentType,
        "x-amz-server-side-encryption": encryption.algorithm,
        ...(this.#kmsKeyId === undefined
          ? {}
          : { "x-amz-server-side-encryption-aws-kms-key-id": this.#kmsKeyId }),
      },
      expiresAt: new Date(
        this.#now().getTime() + input.expiresInSeconds * 1_000,
      ),
    };
  }

  async createDownloadRequest(input: {
    readonly key: string;
    readonly fileName: string;
    readonly expiresInSeconds: number;
  }): Promise<SignedObjectRequest> {
    const command = new GetObjectCommand({
      Bucket: this.#bucket,
      Key: input.key,
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(input.fileName)}`,
    });
    return {
      url: await getSignedUrl(this.#signingClient, command, {
        expiresIn: input.expiresInSeconds,
      }),
      method: "GET",
      headers: {},
      expiresAt: new Date(
        this.#now().getTime() + input.expiresInSeconds * 1_000,
      ),
    };
  }

  async headObject(key: string): Promise<ObjectMetadata | null> {
    try {
      const result = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      return {
        sizeBytes: result.ContentLength ?? 0,
        contentType: result.ContentType,
        etag: result.ETag,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getObject(key: string, maxBytes: number): Promise<Uint8Array> {
    const result = await this.#client.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
    );
    if (result.Body === undefined) throw new Error("Object body is missing");
    if ((result.ContentLength ?? 0) > maxBytes) {
      throw new RangeError("Object exceeds the allowed size");
    }
    const bytes = await result.Body.transformToByteArray();
    if (bytes.byteLength > maxBytes) {
      throw new RangeError("Object exceeds the allowed size");
    }
    return bytes;
  }

  async copyObject(input: {
    readonly sourceKey: string;
    readonly destinationKey: string;
    readonly contentType: string;
  }): Promise<void> {
    const encryption = this.#encryption();
    await this.#client.send(
      new CopyObjectCommand({
        Bucket: this.#bucket,
        Key: input.destinationKey,
        CopySource: `${this.#bucket}/${encodeKey(input.sourceKey)}`,
        ContentType: input.contentType,
        MetadataDirective: "REPLACE",
        ...encryption.command,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.#client.send(
      new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }),
    );
  }

  #encryption(): {
    readonly algorithm: ServerSideEncryption;
    readonly command: {
      readonly ServerSideEncryption: ServerSideEncryption;
      readonly SSEKMSKeyId?: string;
    };
  } {
    const algorithm: ServerSideEncryption =
      this.#kmsKeyId === undefined ? "AES256" : "aws:kms";
    return {
      algorithm,
      command: {
        ServerSideEncryption: algorithm,
        ...(this.#kmsKeyId === undefined
          ? {}
          : { SSEKMSKeyId: this.#kmsKeyId }),
      },
    };
  }
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly name?: unknown;
    readonly $metadata?: { readonly httpStatusCode?: unknown };
  };
  return (
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

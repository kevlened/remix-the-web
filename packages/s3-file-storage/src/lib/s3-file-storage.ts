import type { FileStorage, FileMetadata, ListOptions, ListResult } from '@mjackson/file-storage';
import { LazyFile } from '@mjackson/lazy-file';
import type { LazyContent } from '@mjackson/lazy-file';
import { AwsClient } from 'aws4fetch';
import { DOMParser } from '@xmldom/xmldom';
import type { Element } from '@xmldom/xmldom';

/**
 * Type definition for AwsClient constructor parameters
 */
type AwsClientInit = ConstructorParameters<typeof AwsClient>[0];

/**
 * Configuration options for the S3FileStorage client.
 */
export interface S3FileStorageOptions extends Omit<AwsClientInit, 'service'> {
  /**
   * The S3 bucket name to use for storage.
   */
  bucket: string;
  
  /**
   * Optional endpoint for S3-compatible services (e.g., MinIO, DigitalOcean Spaces).
   * If not specified, AWS S3 is used.
   */
  endpoint?: string;

  /**
   * When true, force a path-style endpoint to be used where the bucket name is part of the path. Defaults to false.
   */
  forcePathStyle?: boolean;

  /**
   * Eagerly load the file when calling `get()`. Defaults to false.
   * If true, the file will be retrieved with a GET request immediately.
   */
  eager?: boolean;
}

/**
 * A `FileStorage` that is backed by a bucket on S3.
 *
 * Important: No attempt is made to avoid overwriting existing files.
 */
export class S3FileStorage implements FileStorage {
  private readonly aws: AwsClient;
  private readonly bucket: string;
  private readonly endpoint: string;
  private readonly region: string;
  private readonly forcePathStyle: boolean;
  private readonly bucketUrl: string;
  private readonly eager: boolean;
  
  /**
   * Creates a new S3FileStorage instance.
   * @param options Configuration options for S3
   */
  constructor(options: S3FileStorageOptions) {
    // Clone options and set service to 's3'
    const awsOptions: AwsClientInit = {
      ...options,
      service: 's3'
    };
    
    this.aws = new AwsClient(awsOptions);
    this.bucket = options.bucket;
    this.region = options.region || 'us-east-1';
    this.endpoint = options.endpoint || `https://${this.bucket}.s3.${this.region}.amazonaws.com`;
    
    // This is how the official s3 client determines if it should use path style or virtual hosted style
    // https://github.com/aws/aws-sdk-js-v3/blob/d1501040077b937ef23e591238cda4bbe729c721/lib/lib-storage/src/Upload.ts#L172-L183
    if (options.forcePathStyle) {
      this.forcePathStyle = options.forcePathStyle
    } else {
      const endpointHostnameIncludesBucket = new URL(this.endpoint).hostname.startsWith(this.bucket + '.')
      this.forcePathStyle = !endpointHostnameIncludesBucket
    }

    if (this.forcePathStyle) {
      this.bucketUrl = `${this.endpoint}/${this.bucket}`;
    } else {
      this.bucketUrl = this.endpoint;
    }

    this.eager = options.eager || false;
  }
  
  /**
   * Returns the URL for the given key in the S3 bucket.
   */
  private getObjectUrl(key: string): string {
    return `${this.bucketUrl}/${encodeURIComponent(key)}`;
  }

  /**
   * Returns `true` if a file with the given key exists, `false` otherwise.
   */
  async has(key: string): Promise<boolean> {
    const response = await this.aws.fetch(this.getObjectUrl(key), {
      method: 'HEAD',
    });

    if (response.ok) return true;
    if (response.status === 404) return false;
    throw new Error(`Failed to check existence of file: ${response.statusText}`);
  }

  /**
   * Puts a file in storage at the given key.
   */
  async set(key: string, file: File): Promise<void> {
    const metadataHeaders = {
      'Content-Type': file.type,
      'x-amz-meta-name': encodeURI(file.name),
      'x-amz-meta-lastModified': file.lastModified.toString(),
    };

    let size = null
    try {
      size = file.size;
    } catch (e) {}

    if (size === null || size > 5 * 1024 * 1024 * 1024) {
      // Use multipart upload since we don't know the size or it's too large for a single PUT (5GB)
      return await this.setUsingMultipart(key, file, metadataHeaders);
    }

    // If we're here, we have the file size, so use a simple PUT request
    const response = await this.aws.fetch(this.getObjectUrl(key), {
      method: 'PUT',
      body: file.stream(),
      headers: {
        ...metadataHeaders,
        'Content-Length': size.toString(),
      },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to upload file: ${response.statusText}`);
    }
  }
  
  /**
   * Uploads a file using S3 multipart upload.
   * This is used when the file size is unknown or for large files.
   */
  private async setUsingMultipart(
    key: string, 
    file: File, 
    metadataHeaders: Record<string, string>
  ): Promise<void> {
    // Define chunk size as 8MB (Amazon S3 accepts 5MB minimum except for the last part)
    const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB in bytes
    
    // Start multipart upload
    const initResponse = await this.aws.fetch(`${this.getObjectUrl(key)}?uploads=`, {
      method: 'POST',
      headers: metadataHeaders,
    });
    
    if (!initResponse.ok) {
      throw new Error(`Failed to initiate multipart upload: ${initResponse.statusText}`);
    }
    
    const initXml = await initResponse.text();
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(initXml, 'text/xml');
    
    // Extract the uploadId from the XML response
    const uploadIdElement = xmlDoc.getElementsByTagName('UploadId')[0];
    if (!uploadIdElement || !uploadIdElement.textContent) {
      throw new Error('Failed to get upload ID for multipart upload');
    }
    
    const uploadId = uploadIdElement.textContent;
    
    // Read the stream and upload parts
    const parts: { PartNumber: number; ETag: string }[] = [];
    let partNumber = 1;
    const reader = file.stream().getReader();
    
    try {
      let buffer: Uint8Array[] = [];
      let bufferSize = 0;
      
      while (true) {
        const { done, value } = await reader.read();
        
        if (done && buffer.length === 0) {
          break;
        }
        
        if (value) {
          buffer.push(value);
          bufferSize += value.byteLength;
        }
        
        if (bufferSize >= CHUNK_SIZE || (done && buffer.length > 0)) {
          // Concatenate chunks into one array
          const chunk = new Uint8Array(bufferSize);
          let offset = 0;
          for (const part of buffer) {
            chunk.set(part, offset);
            offset += part.byteLength;
          }
          
          // Upload this part
          const partResponse = await this.aws.fetch(
            `${this.getObjectUrl(key)}?partNumber=${partNumber}&uploadId=${uploadId}`,
            {
              method: 'PUT',
              body: chunk,
              headers: {
                'Content-Length': chunk.byteLength.toString(),
              },
            }
          );
          
          if (!partResponse.ok) {
            throw new Error(`Failed to upload part ${partNumber}: ${partResponse.statusText}`);
          }
          
          // Get the ETag from the response headers
          const etag = partResponse.headers.get('ETag');
          if (!etag) {
            throw new Error(`No ETag returned for part ${partNumber}`);
          }
          
          parts.push({ PartNumber: partNumber, ETag: etag });
          partNumber++;
          
          // Reset buffer
          buffer = [];
          bufferSize = 0;
        }
        
        if (done) {
          break;
        }
      }
      
      // Complete the multipart upload
      const partsXml = parts.map(part => `<Part><PartNumber>${part.PartNumber}</PartNumber><ETag>${part.ETag}</ETag></Part>`).join('');
      const completeXml = `<CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`;
      
      const completeResponse = await this.aws.fetch(
        `${this.getObjectUrl(key)}?uploadId=${uploadId}`,
        {
          method: 'POST',
          body: completeXml,
          headers: {
            'Content-Type': 'application/xml',
            'Content-Length': completeXml.length.toString(),
          },
        }
      );
      
      if (!completeResponse.ok) {
        const errorText = await completeResponse.text();
        throw new Error(`Failed to complete multipart upload: ${completeResponse.statusText}, Details: ${errorText}`);
      }
    } catch (error) {
      // Abort the multipart upload if there's an error
      try {
        await this.aws.fetch(
          `${this.getObjectUrl(key)}?uploadId=${uploadId}`,
          { method: 'DELETE' }
        );
      } catch (abortError) {
        console.error('Error aborting multipart upload:', abortError);
      }
      
      throw error;
    }
  }

  private extractMetadata(key: string, headers: Headers): FileMetadata {
    const metadataLastModified = headers.get('x-amz-meta-lastModified');
    const lastModifiedHeader = headers.get('last-modified')!;
    const lastModified = metadataLastModified ? parseInt(metadataLastModified) : new Date(lastModifiedHeader).getTime();
    
    let name = headers.get('x-amz-meta-name');
    if (name) {
      name = decodeURIComponent(name);
    } else {
      name = key.split('/').pop() || key;
    }
    const type = headers.get('content-type') || '';
    
    return {
      key,
      name,
      lastModified,
      type,
      size: parseInt(headers.get('content-length') || '0'),
    };
  }

  /**
   * Returns the file with the given key, or `null` if no such key exists.
   * If `eager` is true, the file content is fetched immediately.
   * Otherwise, a HEAD request is used to get metadata, and a LazyFile is created
   * that will only fetch the content when its stream is accessed.
   */
  async get(key: string): Promise<File | null> {
    const objectUrl = this.getObjectUrl(key);
    let initialResponse: Response | null = null;
    let responseHeaders: Headers;

    if (this.eager) {
      const eagerResponse = await this.aws.fetch(objectUrl, { method: 'GET' });
      if (!eagerResponse.ok) {
        if (eagerResponse.status === 404) return null;
        throw new Error(`Failed to get file: ${eagerResponse.statusText}`);
      }
      initialResponse = eagerResponse;
      responseHeaders = initialResponse.headers;
    } else {
      const lazyResponse = await this.aws.fetch(objectUrl, { method: 'HEAD' });
      if (!lazyResponse.ok) {
        if (lazyResponse.status === 404) return null;
        throw new Error(`Failed to get file metadata: ${lazyResponse.statusText}`);
      }
      responseHeaders = lazyResponse.headers;
    }

    const {
      name,
      lastModified,
      type,
      size
    } = this.extractMetadata(key, responseHeaders);

    // Store AWS client in a variable that can be captured by the closure
    const aws = this.aws;
    
    const lazyContent: LazyContent = {
      byteLength: size,
      stream(start?: number, end?: number): ReadableStream<Uint8Array> {
        return new ReadableStream({
          async start(controller) {
            const headers: Record<string, string> = {};
            if (start !== undefined || end !== undefined) {
              let range = `bytes=${start ?? 0}-`;
              if (end !== undefined) {
                // Range header is inclusive, so subtract 1 from end if specified
                range += (end - 1);
              }
              headers['Range'] = range;
            }

            try {
              let reader: ReadableStreamDefaultReader<Uint8Array>;
              // If eager loading provided an initial response, no range is requested,
              // and its body hasn't been used, we can use its body.
              if (!headers['Range'] && initialResponse?.body && !initialResponse.bodyUsed) {
                reader = initialResponse.body.getReader();
              } else {
                // Otherwise, fetch the content (or range)
                const response = await aws.fetch(objectUrl, {
                  method: 'GET',
                  headers
                });

                if (!response.ok) {
                  throw new Error(`Failed to fetch file content: ${response.statusText}`);
                }
                if (!response.body) {
                  throw new Error('Response body is null');
                }
                reader = response.body.getReader();
              }
              
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
              
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          }
        });
      }
    };
    
    return new LazyFile(
      lazyContent,
      name,
      {
        type,
        lastModified
      }
    );
  }

  async put(key: string, file: File): Promise<File> {
    await this.set(key, file);
    return (await this.get(key))!;
  }
  
  /**
   * Removes the file with the given key from storage.
   */
  async remove(key: string): Promise<void> {
    await this.aws.fetch(this.getObjectUrl(key), {
      method: 'DELETE',
    });
  }

  /**
   * Lists the files in storage, optionally filtering by prefix.
   * Uses ListObjectsV2 endpoint with XML parsing.
   */
  async list<T extends ListOptions>(options?: T): Promise<ListResult<T>> {
    let { cursor, includeMetadata = false, limit, prefix } = options ?? {};

    const params = new URLSearchParams();
    
    // Use ListObjectsV2 endpoint
    params.set('list-type', '2');

    if (limit !== undefined) {
      params.set('max-keys', limit!.toString());
    }
    
    if (prefix) {
      params.set('prefix', prefix);
    }
    
    if (cursor) {
      params.set('continuation-token', cursor);
    }
    
    const url = `${this.bucketUrl}?${params.toString()}`;
    
    const response = await this.aws.fetch(url, {
      method: 'GET',
    });
    
    if (!response.ok) {
      throw new Error(`Failed to list objects: ${response.statusText}`);
    }
    
    const text = await response.text();
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'text/xml');
    
    const keys: string[] = [];
    const contents = xml.getElementsByTagName('Contents');
    for (let i = 0; i < contents.length; i++) {
      const content = contents.item(i) as Element;
      const keyElements = content.getElementsByTagName('Key');
      const keyElement = keyElements.item(0);
      const keyText = keyElement?.textContent;
      if (keyText) {
        keys.push(keyText);
      }
    }
    
    // Get NextContinuationToken from XML
    const nextTokenElements = xml.getElementsByTagName('NextContinuationToken');
    const nextTokenElement = nextTokenElements.item(0);
    const nextContinuationToken = nextTokenElement?.textContent ?? undefined;
    
    // Create the result based on whether metadata is requested
    if (includeMetadata) {
      const files: FileMetadata[] = [];
      
      // TODO: make many requests in a queue
      for (const key of keys) {
        const head = await this.aws.fetch(this.getObjectUrl(key), {
          method: 'HEAD',
        });
        if (!head.ok) {
          throw new Error(`Failed to fetch metadata for file: ${head.statusText}`);
        }
        files.push(this.extractMetadata(key, head.headers));
      }
      
      return {
        files: files as any,
        cursor: nextContinuationToken || undefined,
      };
    } else {
      const files = keys.map(key => ({ key }));
      
      return {
        files: files as any,
        cursor: nextContinuationToken || undefined,
      };
    }
  }
}

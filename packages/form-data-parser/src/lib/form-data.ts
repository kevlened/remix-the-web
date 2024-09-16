import {
  isMultipartRequest,
  parseMultipartRequest,
  MultipartParserOptions,
  MultipartPart,
} from '@mjackson/multipart-parser';

/**
 * A file that was uploaded as part of a `multipart/form-data` request.
 *
 * This object is intended to be used as an intermediary for handling file uploads. The file should
 * be saved to disk or a cloud storage service as quickly as possible to avoid buffering and
 * backpressure building up in the input stream.
 *
 * Note: Although `FileUpload` implements the `File` interface, its `size` is unknown, so any
 * attempt to access `file.size` or use `file.slice()` will throw an error.
 */
export class FileUpload implements File {
  readonly name: string;
  readonly type: string;
  readonly lastModified: number;
  readonly webkitRelativePath = '';

  #part: MultipartPart;

  constructor(part: MultipartPart) {
    this.name = part.filename ?? '';
    this.type = part.mediaType ?? '';
    this.lastModified = Date.now();
    this.#part = part;
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return this.#part.arrayBuffer();
  }

  bytes(): Promise<Uint8Array> {
    return this.#part.bytes();
  }

  /**
   * The name of the <input> field used to upload the file.
   */
  get fieldName(): string | undefined {
    return this.#part.name;
  }

  get size(): number {
    throw new Error('Cannot get the size of a file upload without buffering the entire file');
  }

  slice(): Blob {
    throw new Error('Cannot slice a file upload without buffering the entire file');
  }

  stream(): ReadableStream<Uint8Array> {
    return this.#part.body;
  }

  text(): Promise<string> {
    return this.#part.text();
  }
}

/**
 * A function used for handling file uploads.
 */
export interface FileUploadHandler {
  (file: FileUpload): void | null | string | File | Promise<void | null | string | File>;
}

async function defaultFileUploadHandler(file: FileUpload): Promise<File> {
  // Do the slow thing and buffer the entire file in memory.
  let buffer = await file.arrayBuffer();
  return new File([buffer], file.name, { type: file.type, lastModified: file.lastModified });
}

/**
 * Parses a `Request` body into a `FormData` object. This is useful for accessing the data contained
 * in a HTTP `POST` request generated by a HTML `<form>` element.
 *
 * The major difference between this function and using the built-in `request.formData()` API is the
 * ability to customize the handling of file uploads. Instead of buffering the entire file in memory,
 * the `uploadHandler` allows you to store the file on disk or in a cloud storage service.
 */
export async function parseFormData(
  request: Request,
  uploadHandler: FileUploadHandler = defaultFileUploadHandler,
  parserOptions?: MultipartParserOptions,
): Promise<FormData> {
  if (isMultipartRequest(request)) {
    let formData = new FormData();

    for await (let part of parseMultipartRequest(request, parserOptions)) {
      if (!part.name) continue;

      if (part.isFile) {
        let file = await uploadHandler(new FileUpload(part));
        if (file != null) {
          formData.append(part.name, file);
        }
      } else {
        formData.append(part.name, await part.text());
      }
    }

    return formData;
  }

  return request.formData();
}

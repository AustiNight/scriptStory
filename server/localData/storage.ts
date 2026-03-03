import fs from "node:fs/promises";
import path from "node:path";
import { LOCAL_DATA_DIR } from "../config/paths.ts";

export interface LocalDataStorageAdapter {
  ensureDocument(documentName: string, initialData: unknown): Promise<boolean>;
  readDocument(documentName: string): Promise<unknown>;
  writeDocument(documentName: string, value: unknown): Promise<void>;
  resolveDocumentPath(documentName: string): string;
}

export interface FileLocalDataStorageAdapterOptions {
  baseDir?: string;
  documentPaths?: Partial<Record<string, string>>;
}

const writeJsonFile = async (targetPath: string, value: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

export class FileLocalDataStorageAdapter implements LocalDataStorageAdapter {
  private readonly baseDir: string;
  private readonly documentPaths: Partial<Record<string, string>>;

  constructor(options: FileLocalDataStorageAdapterOptions = {}) {
    this.baseDir = options.baseDir || LOCAL_DATA_DIR;
    this.documentPaths = options.documentPaths || {};
  }

  public resolveDocumentPath(documentName: string): string {
    const mappedPath = this.documentPaths[documentName];
    if (mappedPath) {
      return mappedPath;
    }

    return path.join(this.baseDir, documentName);
  }

  public async ensureDocument(documentName: string, initialData: unknown): Promise<boolean> {
    const targetPath = this.resolveDocumentPath(documentName);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    try {
      await fs.access(targetPath);
      return false;
    } catch {
      await writeJsonFile(targetPath, initialData);
      return true;
    }
  }

  public async readDocument(documentName: string): Promise<unknown> {
    const targetPath = this.resolveDocumentPath(documentName);
    const raw = await fs.readFile(targetPath, "utf8");
    return JSON.parse(raw) as unknown;
  }

  public async writeDocument(documentName: string, value: unknown): Promise<void> {
    const targetPath = this.resolveDocumentPath(documentName);
    await writeJsonFile(targetPath, value);
  }
}

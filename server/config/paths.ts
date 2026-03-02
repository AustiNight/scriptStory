import path from "node:path";
import { fileURLToPath } from "node:url";

const configDir = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(configDir, "..", "..");
export const LOCAL_DATA_DIR = path.join(PROJECT_ROOT, ".local-data");

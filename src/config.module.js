// ES-module accessor for the central config (for worker.js and popup.js, which
// are modules). It imports config.js for its side-effect (which sets
// globalThis.APPLYIN_CONFIG) and re-exports that object, so module code can do:
//   import { CONFIG } from "../config.module.js";
import "./config.js";
export const CONFIG = globalThis.APPLYIN_CONFIG;

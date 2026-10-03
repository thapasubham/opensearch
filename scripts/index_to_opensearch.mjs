#!/usr/bin/env node
// Loads data/music_library_vectors.json into an OpenSearch k-NN index.
// Config comes from .env (copy .env.example -> .env and fill it in).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadEnv(file) {
  const envPath = path.join(ROOT, file);
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv(".env");

const URL_ = process.env.OPENSEARCH_URL;
const USERNAME = process.env.OPENSEARCH_USERNAME || "";
const PASSWORD = process.env.OPENSEARCH_PASSWORD || "";
const INDEX = process.env.OPENSEARCH_INDEX || "music_vectors";
const INSECURE = (process.env.OPENSEARCH_INSECURE || "false").toLowerCase() === "true";
const DIM = 16;
const BATCH_SIZE = 100;

if (!URL_) {
  console.error("Missing OPENSEARCH_URL. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

if (INSECURE) {
  // Allows self-signed certs on a dev cluster. Do not use against a production endpoint.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const authHeader =
  USERNAME || PASSWORD
    ? { Authorization: "Basic " + Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64") }
    : {};

async function osFetch(pathname, options = {}) {
  const res = await fetch(new URL(pathname, URL_), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...authHeader,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${options.method || "GET"} ${pathname} -> ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function ensureIndex() {
  const exists = await fetch(new URL(`/${INDEX}`, URL_), { method: "HEAD", headers: authHeader });
  if (exists.status === 200) {
    console.log(`Index "${INDEX}" already exists, skipping creation.`);
    return;
  }

  const mapping = {
    settings: {
      index: {
        knn: true,
      },
    },
    mappings: {
      properties: {
        folder: { type: "keyword" },
        artist: { type: "keyword" },
        title: { type: "text" },
        embedding: {
          type: "knn_vector",
          dimension: DIM,
          method: {
            name: "hnsw",
            space_type: "cosinesimil",
            engine: "lucene",
          },
        },
      },
    },
  };

  await osFetch(`/${INDEX}`, { method: "PUT", body: JSON.stringify(mapping) });
  console.log(`Created index "${INDEX}" with knn_vector mapping (dim=${DIM}).`);
}

async function bulkIndex(docs) {
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    const lines = batch.flatMap((doc) => [
      JSON.stringify({ index: { _index: INDEX, _id: doc.id } }),
      JSON.stringify(doc),
    ]);
    const body = lines.join("\n") + "\n";
    const result = await osFetch("/_bulk", { method: "POST", body });
    const errors = (result.items || []).filter((item) => item.index && item.index.error);
    if (errors.length) {
      console.error(`${errors.length} errors in batch starting at ${i}:`, errors.slice(0, 3));
    }
    console.log(`Indexed ${Math.min(i + BATCH_SIZE, docs.length)}/${docs.length}`);
  }
}

const dataPath = path.join(ROOT, "data", "music_library_vectors.json");
const docs = JSON.parse(fs.readFileSync(dataPath, "utf8"));

console.log(`Target: ${URL_}, index: ${INDEX}, docs: ${docs.length}`);
await ensureIndex();
await bulkIndex(docs);
console.log("Done.");

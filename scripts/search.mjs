#!/usr/bin/env node
// Searches the OpenSearch k-NN index for nearest neighbors.
// Config comes from .env (copy .env.example -> .env and fill it in).
//
// Usage:
//   node scripts/search.mjs --id 5 [--k 10] [--artist "AS BLOOD RUNS BLACK"]
//   node scripts/search.mjs --vector "-0.77,-0.15,-0.54,..." [--k 10]

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

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      args[key] = value;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const k = args.k ? Number(args.k) : 10;

let vector;
let excludeId;

if (args.id !== undefined) {
  const dataPath = path.join(ROOT, "data", "music_library_vectors.json");
  const docs = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  const song = docs.find((d) => String(d.id) === String(args.id));
  if (!song) {
    console.error(`No song with id ${args.id} found in data/music_library_vectors.json`);
    process.exit(1);
  }
  vector = song.embedding;
  excludeId = song.id;
  console.log(`Query: id=${song.id} "${song.title}" by ${song.artist}`);
} else if (args.vector) {
  vector = args.vector.split(",").map(Number);
} else {
  console.error('Pass --id <song id> or --vector "v1,v2,...,v16"');
  process.exit(1);
}

const filters = [];
if (args.artist) filters.push({ term: { artist: args.artist } });
if (args.folder) filters.push({ term: { folder: args.folder } });

const query = {
  size: k + (excludeId !== undefined ? 1 : 0),
  query: filters.length
    ? {
        bool: {
          filter: filters,
          must: [{ knn: { embedding: { vector, k } } }],
        },
      }
    : {
        knn: {
          embedding: { vector, k },
        },
      },
};

const res = await fetch(new URL(`/${INDEX}/_search`, URL_), {
  method: "POST",
  headers: { "Content-Type": "application/json", ...authHeader },
  body: JSON.stringify(query),
});

const body = await res.json();

if (!res.ok) {
  console.error(`Search failed: ${res.status}`, JSON.stringify(body));
  process.exit(1);
}

const hits = body.hits.hits.filter((h) => h._id != excludeId);

for (const hit of hits.slice(0, k)) {
  const src = hit._source;
  console.log(`${hit._score.toFixed(4)}  ${src.artist} - ${src.title}  [${src.folder}] (id=${hit._id})`);
}

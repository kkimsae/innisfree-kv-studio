import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureDir } from "./files.js";

export function openDatabase(dataDir: string) {
  ensureDir(dataDir);
  const db = new Database(path.join(dataDir, "studio.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      campaign_month TEXT NOT NULL,
      output_width INTEGER NOT NULL,
      output_height INTEGER NOT NULL,
      brief TEXT NOT NULL DEFAULT '',
      constraints_text TEXT NOT NULL DEFAULT '',
      selected_concept_id TEXT,
      background_asset_id TEXT,
      background_locked INTEGER NOT NULL DEFAULT 0,
      background_generated INTEGER NOT NULL DEFAULT 0,
      lighting_json TEXT NOT NULL,
      pedestal_json TEXT NOT NULL,
      camera_json TEXT NOT NULL,
      demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_sets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      box_template_id TEXT,
      visual_emphasis TEXT NOT NULL DEFAULT 'normal',
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS assortment_rows (
      id TEXT PRIMARY KEY,
      set_id TEXT NOT NULL,
      asset_id TEXT,
      product_name TEXT NOT NULL,
      capacity TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      required_quantity INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      original_filename TEXT NOT NULL,
      source_path TEXT NOT NULL,
      thumbnail_path TEXT,
      media_type TEXT NOT NULL,
      packaging_version TEXT NOT NULL DEFAULT '',
      has_transparency INTEGER,
      pixel_width INTEGER,
      pixel_height INTEGER,
      physical_width_mm REAL,
      physical_height_mm REAL,
      physical_depth_mm REAL,
      viewing_angle TEXT NOT NULL DEFAULT 'unknown',
      lighting_notes TEXT NOT NULL DEFAULT '',
      crop_json TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      demo_fixture INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS box_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      width_mm REAL NOT NULL,
      height_mm REAL NOT NULL,
      depth_mm REAL NOT NULL,
      source_asset_id TEXT,
      source_page INTEGER,
      panels_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scene_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      assortment_row_id TEXT NOT NULL,
      asset_id TEXT,
      box_template_id TEXT,
      x REAL NOT NULL,
      y REAL NOT NULL,
      scale REAL NOT NULL,
      layer INTEGER NOT NULL,
      surface TEXT NOT NULL,
      shadow_json TEXT NOT NULL,
      visible INTEGER NOT NULL,
      rotation_deg REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS concepts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source TEXT NOT NULL,
      name TEXT NOT NULL,
      rationale TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      preview_path TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS revisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      index_num INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      operations_json TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS revision_state (
      project_id TEXT PRIMARY KEY,
      cursor_index INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS validation_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exports (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      format TEXT NOT NULL,
      file_path TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      notes_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  fs.mkdirSync(path.join(dataDir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "renders"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "exports"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "cache"), { recursive: true });
  return db;
}

export type StudioDb = ReturnType<typeof openDatabase>;
